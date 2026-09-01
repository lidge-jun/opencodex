import { createRequire } from "node:module";
import { resolveEnvValue, saveConfigPreservingClaudeCode } from "../config";
import type { OcxConfig, OcxProviderConfig } from "../types";

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

export const KEYCHAIN_REFERENCE_PREFIX = "keychain:";
export const PROVIDER_KEYCHAIN_SERVICE = "opencodex.provider-api-key.v1";

export interface ProviderKeychainEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

export type ProviderKeychainEntryFactory = (service: string, account: string) => ProviderKeychainEntry;

const nodeRequire = createRequire(import.meta.url);

function defaultEntryFactory(service: string, account: string): ProviderKeychainEntry {
  const { Entry } = nodeRequire("@napi-rs/keyring") as { Entry: new (s: string, a: string) => ProviderKeychainEntry };
  return new Entry(service, account);
}

let entryFactory: ProviderKeychainEntryFactory = defaultEntryFactory;
const resolvedCache = new Map<string, string>();
const warnedAccounts = new Set<string>();

/** Test seam: swap the OS entry for an in-memory one and drop caches. */
export function setProviderKeychainEntryFactoryForTests(factory: ProviderKeychainEntryFactory | null): void {
  entryFactory = factory ?? defaultEntryFactory;
  resolvedCache.clear();
  warnedAccounts.clear();
}

export function isKeychainReference(value: string | undefined): value is string {
  return typeof value === "string" && value.startsWith(KEYCHAIN_REFERENCE_PREFIX) && value.length > KEYCHAIN_REFERENCE_PREFIX.length;
}

function keychainAccount(reference: string): string {
  return reference.slice(KEYCHAIN_REFERENCE_PREFIX.length);
}

function readKeychain(account: string): string | undefined {
  const cached = resolvedCache.get(account);
  if (cached !== undefined) return cached;
  try {
    const value = entryFactory(PROVIDER_KEYCHAIN_SERVICE, account).getPassword();
    if (typeof value === "string" && value.trim()) {
      resolvedCache.set(account, value);
      return value;
    }
  } catch {
    // fall through to the single warning below
  }
  if (!warnedAccounts.has(account)) {
    warnedAccounts.add(account);
    console.warn(`[opencodex] provider key reference keychain:${account} could not be read from the OS keychain; requests for this provider have no credential until the keychain is available (no plaintext fallback)`);
  }
  return undefined;
}

/**
 * Single resolver for provider key material: env references, keychain references, or the
 * literal value. Every request-time read of `apiKey` goes through here.
 */
export function resolveProviderApiKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (isKeychainReference(value)) return readKeychain(keychainAccount(value));
  return resolveEnvValue(value);
}

export type ProviderKeyStoreKind = "keychain" | "env" | "file" | "none";

export function providerKeyStoreKind(provider: Pick<OcxProviderConfig, "apiKey"> | undefined): ProviderKeyStoreKind {
  const key = provider?.apiKey;
  if (!key) return "none";
  if (isKeychainReference(key)) return "keychain";
  if (/^\$\{?\w+\}?$/.test(key)) return "env";
  return "file";
}

/** Probe the OS keychain with a throwaway account: write, read back, delete. */
export function probeProviderKeychain(): { available: true } | { available: false; reason: string } {
  const account = `probe-${process.pid}-${Date.now()}`;
  try {
    const entry = entryFactory(PROVIDER_KEYCHAIN_SERVICE, account);
    entry.setPassword("ok");
    const back = entry.getPassword();
    try { entry.deletePassword(); } catch { /* best effort */ }
    if (back !== "ok") return { available: false, reason: "keychain read-back did not match" };
    return { available: true };
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : "keychain unavailable" };
  }
}

function writeVerified(account: string, secret: string): void {
  const entry = entryFactory(PROVIDER_KEYCHAIN_SERVICE, account);
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
      if (isKeychainReference(entry.key)) continue;
      const secret = resolveEnvValue(entry.key);
      if (!secret) continue; // unresolved env reference stays as-is
      const account = `${name}/${entry.id}`;
      writeVerified(account, secret);
      written.push(account);
      planned.push(() => { entry.key = `${KEYCHAIN_REFERENCE_PREFIX}${account}`; });
    }
    if (provider.apiKey && !isKeychainReference(provider.apiKey)) {
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
      try { entryFactory(PROVIDER_KEYCHAIN_SERVICE, account).deletePassword(); } catch { /* best effort */ }
    }
    return { ok: false, error: `OS keychain write failed: ${error instanceof Error ? error.message : "unknown"}`, status: 503 };
  }
  for (const apply of planned) apply();
  resolvedCache.clear();
  warnedAccounts.clear();
  saveConfigPreservingClaudeCode(config);
  return { ok: true, moved: written.length };
}

/** Reverse of `storeProviderKeyInKeychain`: read every reference back, write plaintext, delete items. */
export function restoreProviderKeyFromKeychain(config: OcxConfig, name: string): { ok: true; restored: number } | { ok: false; error: string; status: number } {
  const provider = config.providers[name];
  if (!provider) return { ok: false, error: "unknown provider", status: 404 };
  const pool = provider.apiKeyPool ?? [];
  const resolved = new Map<string, string>();
  const refs = [provider.apiKey, ...pool.map(e => e.key)].filter(isKeychainReference);
  for (const ref of refs) {
    const account = keychainAccount(ref);
    if (resolved.has(account)) continue;
    let value: string | null = null;
    try { value = entryFactory(PROVIDER_KEYCHAIN_SERVICE, account).getPassword(); } catch { value = null; }
    if (!value) return { ok: false, error: `OS keychain has no readable secret for ${ref}; config left unchanged`, status: 503 };
    resolved.set(account, value);
  }
  for (const entry of pool) {
    if (isKeychainReference(entry.key)) entry.key = resolved.get(keychainAccount(entry.key))!;
  }
  if (isKeychainReference(provider.apiKey)) provider.apiKey = resolved.get(keychainAccount(provider.apiKey))!;
  for (const account of resolved.keys()) {
    try { entryFactory(PROVIDER_KEYCHAIN_SERVICE, account).deletePassword(); } catch { /* best effort */ }
  }
  resolvedCache.clear();
  warnedAccounts.clear();
  saveConfigPreservingClaudeCode(config);
  return { ok: true, restored: resolved.size };
}

