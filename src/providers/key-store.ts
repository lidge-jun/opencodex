import { resolveEnvValue, saveConfigPreservingClaudeCode } from "../config";
import type { OcxConfig, OcxProviderConfig } from "../types";
import type { ProviderRegistryEntry } from "./registry";
import { isGcpCredentialMaterial } from "../lib/gcp-adc";
import {
  KEYCHAIN_REFERENCE_PREFIX,
  GCP_CREDENTIAL_MARKER_PREFIX,
  invalidateResolvedProviderKeyCache,
  isKeychainReference,
  keychainAccount,
  keychainReferenceBelongsToProvider,
  probeProviderKeychain,
  providerKeychainEntry,
} from "./api-key-resolve";

// The read-path (reference predicates, the OS entry factory, resolveProviderApiKey, the probe
// and the kind classification) lives in ./api-key-resolve -- a leaf module that
// reasoning-metadata can also import without pulling the ../config barrel into its
// cycle-sensitive graph. Re-exported here so existing key-store consumers keep working.
export {
  KEYCHAIN_REFERENCE_PREFIX,
  PROVIDER_KEYCHAIN_SERVICE,
  isKeychainReference,
  probeProviderKeychain,
  providerKeyStoreKind,
  resolveProviderApiKey,
  setProviderKeychainEntryFactoryForTests,
} from "./api-key-resolve";
export type {
  ProviderKeychainEntry,
  ProviderKeychainEntryFactory,
  ProviderKeyStoreKind,
} from "./api-key-resolve";

/**
 * Shared with routing: a key-mode override is operator intent, not a credential probe.
 * The configured authMode alone decides the lane; a key that cannot be resolved right now
 * (paused last key, missing env var, disabled pool) fails closed at the transport and must
 * never implicitly reclassify the provider to the registry's OAuth lane, where a stored
 * OAuth account would be billed instead of the operator's key.
 */
export function providerUsesKeyAuthOverride(
  entry: Pick<ProviderRegistryEntry, "authKind" | "allowKeyAuthOverride">,
  provider: Pick<OcxProviderConfig, "authMode">,
): boolean {
  return entry.authKind === "oauth" && entry.allowKeyAuthOverride === true
    && provider.authMode === "key";
}

/**
 * Opt-in OS keychain storage for provider API keys (#1221).
 *
 * `config.json` keeps only a reference (`keychain:<provider>` for the active key,
 * `keychain:<provider>/<pool id>` for pool entries); the secret lives in the OS credential store
 * under one service name. Reads are synchronous on purpose: `routedProviderConfig` and the
 * quota/compaction/catalog callers are all sync, and `@napi-rs/keyring` ships a sync `Entry`.
 *
 * Policy: a reference that cannot be resolved fails closed (no key) and is warned once per
 * account; nothing ever rewrites plaintext into config or its backups. Opting in verifies the
 * keychain by writing and reading back before the config is touched, so an unavailable store
 * (headless service, locked session) refuses rather than half-migrating.
 */

function writeVerified(account: string, secret: string): void {
  const entry = providerKeychainEntry(account);
  entry.setPassword(secret);
  if (entry.getPassword() !== secret) throw new Error(`keychain read-back mismatch for ${account}`);
}

/**
 * Move a provider's active key and every plaintext pool entry into the OS keychain and rewrite
 * config with references. All keychain writes are verified before config changes; on any
 * failure the entries written so far are deleted and config is left untouched.
 */
export function storeProviderKeyInKeychain(config: OcxConfig, name: string): { ok: true; moved: number } | { ok: false; error: string; status: number } {
  const provider = config.providers[name];
  if (!provider) return { ok: false, error: "unknown provider", status: 404 };
  if (provider.authMode === "oauth" || provider.authMode === "forward") {
    return { ok: false, error: "provider does not use API-key auth", status: 400 };
  }
  const probe = probeProviderKeychain();
  if (!probe.available) return { ok: false, error: `OS keychain unavailable: ${probe.reason}`, status: 503 };

  const written: string[] = [];
  const planned: Array<() => void> = [];
  const pool = provider.apiKeyPool ?? [];
  try {
    for (const entry of pool) {
      if (entry.key.startsWith(GCP_CREDENTIAL_MARKER_PREFIX) || isKeychainReference(entry.key)) continue;
      const secret = resolveEnvValue(entry.key);
      if (!secret) continue; // unresolved env reference stays as-is
      const account = `${name}/${entry.id}`;
      writeVerified(account, secret);
      written.push(account);
      planned.push(() => { entry.key = `${KEYCHAIN_REFERENCE_PREFIX}${account}`; });
    }
    if (provider.apiKey && !provider.apiKey.startsWith(GCP_CREDENTIAL_MARKER_PREFIX) && !isKeychainReference(provider.apiKey)) {
      const active = pool.find(e => e.key === provider.apiKey || (isKeychainReference(e.key) && false));
      const secret = resolveEnvValue(provider.apiKey);
      if (secret) {
        if (active) {
          // Mirror the pool reference so failover keeps comparing equal strings.
          planned.push(() => { provider.apiKey = `${KEYCHAIN_REFERENCE_PREFIX}${name}/${active.id}`; });
        } else {
          writeVerified(name, secret);
          written.push(name);
          planned.push(() => { provider.apiKey = `${KEYCHAIN_REFERENCE_PREFIX}${name}`; });
        }
      }
    }
  } catch (error) {
    for (const account of written) {
      try { providerKeychainEntry(account).deletePassword(); } catch { /* best effort */ }
    }
    return { ok: false, error: `OS keychain write failed: ${error instanceof Error ? error.message : "unknown"}`, status: 503 };
  }
  for (const apply of planned) apply();
  invalidateResolvedProviderKeyCache();
  saveConfigPreservingClaudeCode(config);
  return { ok: true, moved: written.length };
}

/**
 * Reverse of `storeProviderKeyInKeychain`: read every reference back, persist plaintext, then delete
 * the items. The config loses its references before any OS entry is removed, so a failed save
 * deletes nothing and a deletion never races a reference that is still on disk.
 */
export function restoreProviderKeyFromKeychain(config: OcxConfig, name: string): { ok: true; restored: number } | { ok: false; error: string; status: number } {
  const provider = config.providers[name];
  if (!provider) return { ok: false, error: "unknown provider", status: 404 };
  const pool = provider.apiKeyPool ?? [];
  const resolved = new Map<string, string>();
  const refs = [provider.apiKey, ...pool.map(e => e.key)].filter(isKeychainReference);
  // Restore reads a secret out of the keychain, writes it back to config as plaintext, and then
  // DELETES the keychain item. Following a reference to another provider's account would both
  // disclose that secret through this provider's config and destroy the real owner's credential,
  // so refuse before anything is read or removed.
  const foreign = refs.filter(ref => !keychainReferenceBelongsToProvider(ref, name));
  if (foreign.length > 0) {
    return {
      ok: false,
      error: `provider "${name}" references a keychain account it does not own (${foreign.length} reference(s)); config left unchanged`,
      status: 400,
    };
  }
  for (const ref of refs) {
    const account = keychainAccount(ref);
    if (resolved.has(account)) continue;
    let value: string | null = null;
    try { value = providerKeychainEntry(account).getPassword(); } catch { value = null; }
    if (!value) return { ok: false, error: `OS keychain has no readable secret for ${ref}; config left unchanged`, status: 503 };
    if (isGcpCredentialMaterial(value)) {
      return { ok: false, error: "GCP credentials must remain in the OS store; use a gcp-sa reference. Config left unchanged", status: 400 };
    }
    resolved.set(account, value);
  }
  for (const entry of pool) {
    if (isKeychainReference(entry.key)) entry.key = resolved.get(keychainAccount(entry.key))!;
  }
  if (isKeychainReference(provider.apiKey)) provider.apiKey = resolved.get(keychainAccount(provider.apiKey))!;
  invalidateResolvedProviderKeyCache();
  saveConfigPreservingClaudeCode(config);
  for (const account of resolved.keys()) {
    try { providerKeychainEntry(account).deletePassword(); } catch { /* best effort */ }
  }
  invalidateResolvedProviderKeyCache();
  return { ok: true, restored: resolved.size };
}
