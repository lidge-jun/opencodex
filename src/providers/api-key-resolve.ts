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
import { createRequire } from "node:module";
import { resolveEnvValue } from "../config/proxy-env";
import type { OcxProviderConfig } from "../types";

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

/** Write-path seam: a store/restore mutated secrets, so cached reads and warnings are stale. */
export function invalidateResolvedProviderKeyCache(): void {
  resolvedCache.clear();
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
  return entryFactory(PROVIDER_KEYCHAIN_SERVICE, account);
}

function readKeychain(account: string): string | undefined {
  const cached = resolvedCache.get(account);
  if (cached !== undefined) return cached;
  try {
    const value = providerKeychainEntry(account).getPassword();
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
    const entry = providerKeychainEntry(account);
    entry.setPassword("ok");
    const back = entry.getPassword();
    try { entry.deletePassword(); } catch { /* best effort */ }
    if (back !== "ok") return { available: false, reason: "keychain read-back did not match" };
    return { available: true };
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : "keychain unavailable" };
  }
}
