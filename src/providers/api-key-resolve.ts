import { publishCredentialSync } from "../local-credentials/generation";
/**
 * Read-path for provider key material: env references, keychain references, or the literal
 * value.
 *
 * Leaf module on purpose: reasoning-metadata.ts imports resolveProviderApiKey() here so a
 * learned-refusal identity can hash the same credential the wire sends. key-store.ts needs
 * the ../config barrel for the write path (saveConfigPreservingClaudeCode), and importing it
 * from reasoning-metadata would close the cycle the reasoning-metadata header warns about.
 * resolveEnvValue comes from ../config/proxy-env for the same reason.
 *
 * `config.json` keeps only a reference (`keychain:<provider>` for the active key,
 * `keychain:<provider>/<pool id>` for pool entries); the secret lives in the OS credential store
 * under one service name. Reads are synchronous on purpose: `routedProviderConfig` and the
 * quota/compaction/catalog callers are all sync, and `@napi-rs/keyring` ships a sync `Entry`.
 *
 * Policy: a reference that cannot be resolved fails closed (no key) and is warned once per
 * account; nothing ever rewrites plaintext into config or its backups.
 */
import { invalidateDecisionKeyQuotas, observeDecisionKeyCredential } from "../lib/decision-quota-sink";
import { resolveEnvValue } from "../config/proxy-env";
import { loadKeyringBinding } from "../lib/keyring-native";
import { isGcpCredentialMaterial } from "../lib/gcp-credential-input";
import type { OcxProviderConfig } from "../types";

export const KEYCHAIN_REFERENCE_PREFIX = "keychain:";
/** Stored GCP JSON uses the same OS service, but must never be restored as a literal API key. */
export const GCP_CREDENTIAL_MARKER_PREFIX = "gcp-sa:";
export const PROVIDER_KEYCHAIN_SERVICE = "opencodex.provider-api-key.v1";

export interface ProviderKeychainEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

export type ProviderKeychainEntryFactory = (service: string, account: string) => ProviderKeychainEntry;

function defaultEntryFactory(service: string, account: string): ProviderKeychainEntry {
  const { Entry } = loadKeyringBinding() as { Entry: new (s: string, a: string) => ProviderKeychainEntry };
  return new Entry(service, account);
}

let entryFactory: ProviderKeychainEntryFactory = defaultEntryFactory;
const resolvedCache = new Map<string, string>();
const warnedAccounts = new Set<string>();
let resolutionGeneration = 0;
// A digest and incarnation token retain passive ownership without retaining another secret copy.
// Only a routing read can establish this proof; passive paths never read or populate the keychain.
const passiveProofs = new Map<string, { digest: string; generation: number }>();
let nextPassiveGeneration = 0;
const MAX_PASSIVE_PROOFS = 512;

function credentialDigest(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

/** Return the observed account incarnation, optionally requiring a match to the wire key. */
export function passiveKeychainGeneration(reference: string, key?: string): number | undefined {
  if (!isKeychainReference(reference)) return undefined;
  const account = keychainAccount(reference);
  const proof = passiveProofs.get(account);
  if (!resolvedCache.has(account)) return undefined;
  return proof && (key === undefined || proof.digest === credentialDigest(key)) ? proof.generation : undefined;
}

function rememberPassiveProof(account: string, value: string): void {
  const digest = credentialDigest(value), previous = passiveProofs.get(account);
  passiveProofs.delete(account);
  passiveProofs.set(account, previous?.digest === digest ? previous : { digest, generation: ++nextPassiveGeneration });
  if (passiveProofs.size > MAX_PASSIVE_PROOFS) passiveProofs.delete(passiveProofs.keys().next().value!);
}

/** Advances whenever cached secrets may have changed, so derived snapshots can rebuild. */
export function providerKeyResolutionGeneration(): number {
  return resolutionGeneration;
}

/** Inspect a resolved routing credential without reading the OS, modifying the cache or publishing evidence. */
export function peekResolvedProviderKey(value: string): string | undefined {
  return isKeychainReference(value) ? resolvedCache.get(keychainAccount(value)) : undefined;
}

/** Test seam: swap the OS entry for an in-memory one and drop caches. */
export function setProviderKeychainEntryFactoryForTests(factory: ProviderKeychainEntryFactory | null): void {
  entryFactory = factory ?? defaultEntryFactory;
  invalidateDecisionKeyQuotas();
  resolvedCache.clear();
  passiveProofs.clear();
  resolutionGeneration++;
  warnedAccounts.clear();
}

/** Write-path seam: a store/restore mutated secrets, so cached reads and warnings are stale. */
export function invalidateResolvedProviderKeyCache(options?: { preservePassiveKeychainProofs: true }): void {
  invalidateDecisionKeyQuotas();
  resolvedCache.clear();
  if (!options?.preservePassiveKeychainProofs) passiveProofs.clear();
  resolutionGeneration++;
  warnedAccounts.clear();
}

export function isKeychainReference(value: string | undefined): value is string {
  return typeof value === "string" && value.startsWith(KEYCHAIN_REFERENCE_PREFIX) && value.length > KEYCHAIN_REFERENCE_PREFIX.length;
}

export function keychainAccount(reference: string): string {
  return reference.slice(KEYCHAIN_REFERENCE_PREFIX.length);
}

/**
 * A reference belongs to `name` only when its account is that provider's own active account
 * or one of its pool accounts. `storeProviderKeyInKeychain` writes exactly those two shapes,
 * so anything else in a provider's config names another provider's secret.
 */
export function keychainReferenceBelongsToProvider(reference: string, name: string): boolean {
  const account = keychainAccount(reference);
  return account === name || account.startsWith(`${name}/`);
}

/** Entry for `account` under the provider-key service; read and write paths share the factory. */
export function providerKeychainEntry(account: string): ProviderKeychainEntry {
  const entry = entryFactory(PROVIDER_KEYCHAIN_SERVICE, account);
  // A failed or unverifiable write keeps its account counted as a local credential.
  const absent = (): readonly string[] => {
    try { return entry.getPassword() === null ? [account] : []; } catch { return []; }
  };
  return {
    getPassword: () => entry.getPassword(),
    setPassword: password => publishCredentialSync(() => { passiveProofs.delete(account); entry.setPassword(password); }, {
      accounts: [account], absent: completed => completed ? [] : absent(),
    }),
    // Registered before the attempt, so a deletion that fails keeps the secret counted.
    deletePassword: () => publishCredentialSync(() => { passiveProofs.delete(account); return entry.deletePassword(); }, { accounts: [account], absent }),
  };
}

function readKeychain(account: string, quiet = false, useCache = true): string | undefined {
  const cached = useCache ? resolvedCache.get(account) : undefined;
  if (cached !== undefined) return cached;
  let value: string | null = null;
  try {
    value = providerKeychainEntry(account).getPassword();
  } catch {
    // fall through to the single warning below
  }
  if (typeof value === "string" && value.trim()) {
    if (isGcpCredentialMaterial(value)) {
      if (useCache) passiveProofs.delete(account);
      throw new Error("GCP credential JSON cannot be used as a literal API key; select a gcp-sa reference");
    }
    if (useCache) { resolvedCache.set(account, value); rememberPassiveProof(account, value); }
    return value;
  }
  if (useCache) passiveProofs.delete(account);
  if (!quiet && !warnedAccounts.has(account)) {
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
  const resolved = isKeychainReference(value) ? readKeychain(keychainAccount(value)) : resolveEnvValue(value);
  observeDecisionKeyCredential(value, resolved);
  return resolved;
}

/** Resolve current display ownership without touching routing's cache, evidence, or warnings. */
export function resolveProviderApiKeyPassively(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return isKeychainReference(value) ? readKeychain(keychainAccount(value), true, false) : resolveEnvValue(value);
}

/** The same resolution without the unreadable-reference warning, for observe-only callers. */
export function resolveProviderApiKeyQuietly(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const resolved = isKeychainReference(value) ? readKeychain(keychainAccount(value), true) : resolveEnvValue(value);
  // A quiet read still sees a replaced secret; advisory key evidence published under the old one must not outlive it.
  observeDecisionKeyCredential(value, resolved);
  return resolved;
}

export type ProviderKeyStoreKind = "keychain" | "env" | "file" | "none";

export function providerKeyStoreKind(provider: Pick<OcxProviderConfig, "apiKey"> | undefined): ProviderKeyStoreKind {
  const key = provider?.apiKey;
  if (!key) return "none";
  if (key.startsWith(GCP_CREDENTIAL_MARKER_PREFIX) || isKeychainReference(key)) return "keychain";
  if (/^\$\{?\w+\}?$/.test(key)) return "env";
  return "file";
}

/** Probe the OS keychain with a throwaway account: write, read back, delete. It stores no credential. */
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
