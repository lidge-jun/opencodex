/**
 * OAuth token store at ~/.opencodex/auth.json, keyed by provider name.
 *
 * Multiauth shape (260706): each provider value is a ProviderAccountSet
 * `{ activeAccountId, accounts: [{ id, credential, needsReauth?, addedAt? }] }`.
 * Legacy single-credential values (`{ access, refresh, expires, ... }`) normalize on load,
 * and the first new-shape persist writes a one-time `auth.json.pre-multiauth` backup so a
 * downgraded loader (which silently drops unknown shapes) cannot destroy refresh tokens.
 *
 * Exceptions:
 * - `chatgpt` stays single-slot (always replaced): codex-auth-api uses it as a scratch slot
 *   for Codex pool logins, which have their own ledger (codex-accounts.json).
 * - Credentials without identity (no accountId/email — kimi, kiro) replace the active slot
 *   instead of appending: their refresh tokens rotate, so a derived id would duplicate the
 *   same human on every re-login. Cursor login extracts JWT `sub` as accountId so multiauth
 *   can append distinct accounts.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir, atomicWriteFile, backupInvalidConfig, hardenConfigDir, hardenExistingSecret } from "../config";
import type { OAuthCredentialSource, OAuthCredentials, ProviderAccount, ProviderAccountSet } from "./types";

type AuthStore = Record<string, ProviderAccountSet>;

/** Providers whose account set is pinned to a single slot (see module doc). */
const SINGLE_SLOT_PROVIDERS = new Set(["chatgpt"]);

function authPath(): string {
  return join(getConfigDir(), "auth.json");
}

function loadAuthStoreInternal(): { store: AuthStore; hadLegacy: boolean } {
  const path = authPath();
  hardenConfigDir();
  hardenExistingSecret(path);
  if (!existsSync(path)) return { store: {}, hadLegacy: false };
  try {
    return normalizeAuthStore(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    backupInvalidConfig(path);
    return { store: {}, hadLegacy: false };
  }
}

export function loadAuthStore(): AuthStore {
  return loadAuthStoreInternal().store;
}

function persist(store: AuthStore): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    try { chmodSync(dir, 0o700); } catch { /* best-effort on existing dir */ }
  }
  atomicWriteFile(authPath(), JSON.stringify(store, null, 2) + "\n");
}

/**
 * One-time downgrade safety net: the first time we persist the NEW shape over a file that
 * still contains legacy single-credential entries, keep a pristine copy. An older opencodex
 * would silently drop the new shape (normalizeCredential -> null) and then persist an empty
 * store, destroying refresh tokens; the backup makes that recoverable.
 */
function backupLegacyOnce(): void {
  const path = authPath();
  const backup = `${path}.pre-multiauth`;
  if (!existsSync(path) || existsSync(backup)) return;
  try {
    copyFileSync(path, backup);
    try { chmodSync(backup, 0o600); } catch { /* best-effort */ }
  } catch { /* best-effort */ }
}

function isCredentialSource(value: unknown): value is OAuthCredentialSource {
  return value === "oauth" || value === "local-cli" || value === "credential-file" || value === "environment" || value === "manual";
}

function normalizeCredential(cred: unknown): OAuthCredentials | null {
  if (!cred || typeof cred !== "object") return null;
  const candidate = cred as Partial<OAuthCredentials>;
  if (typeof candidate.access !== "string" || typeof candidate.refresh !== "string" || typeof candidate.expires !== "number") {
    return null;
  }
  const normalized: OAuthCredentials = {
    access: candidate.access,
    refresh: candidate.refresh,
    expires: candidate.expires,
  };
  if (typeof candidate.email === "string" && candidate.email.length > 0) normalized.email = candidate.email;
  if (typeof candidate.accountId === "string" && candidate.accountId.length > 0) normalized.accountId = candidate.accountId;
  if (isCredentialSource(candidate.source)) normalized.source = candidate.source;
  if (typeof candidate.projectId === "string" && candidate.projectId.length > 0) normalized.projectId = candidate.projectId;
  return normalized;
}

/**
 * Stable short account id. MUST be deterministic for a given credential: legacy
 * single-credential stores are re-normalized on EVERY load without being persisted,
 * so a time-salted id would differ between two loads (getAccountSet vs
 * getAccountCredential), surfacing as a spurious OAuthLoginRequiredError and making
 * refresh persists silently miss the account (rotated refresh token lost).
 */
function newAccountId(cred: OAuthCredentials): string {
  const identity = cred.accountId ?? cred.email ?? cred.refresh;
  return createHash("sha256").update(identity).digest("hex").slice(0, 8);
}

function normalizeAccount(value: unknown): ProviderAccount | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ProviderAccount>;
  if (typeof candidate.id !== "string" || candidate.id.length === 0) return null;
  const credential = normalizeCredential(candidate.credential);
  if (!credential) return null;
  const account: ProviderAccount = { id: candidate.id, credential };
  if (candidate.needsReauth === true) account.needsReauth = true;
  if (typeof candidate.addedAt === "number") account.addedAt = candidate.addedAt;
  return account;
}

function normalizeAccountSet(raw: unknown): { set: ProviderAccountSet | null; wasLegacy: boolean } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { set: null, wasLegacy: false };
  const candidate = raw as Partial<ProviderAccountSet>;
  if (Array.isArray(candidate.accounts)) {
    const accounts = candidate.accounts.map(normalizeAccount).filter((a): a is ProviderAccount => a !== null);
    if (accounts.length === 0) return { set: null, wasLegacy: false };
    const active = typeof candidate.activeAccountId === "string" && accounts.some(a => a.id === candidate.activeAccountId)
      ? candidate.activeAccountId
      : accounts[0]!.id;
    return { set: { activeAccountId: active, accounts }, wasLegacy: false };
  }
  // Legacy single-credential value.
  const cred = normalizeCredential(raw);
  if (!cred) return { set: null, wasLegacy: false };
  const id = newAccountId(cred);
  return { set: { activeAccountId: id, accounts: [{ id, credential: cred }] }, wasLegacy: true };
}

function normalizeAuthStore(raw: unknown): { store: AuthStore; hadLegacy: boolean } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { store: {}, hadLegacy: false };
  const normalized: AuthStore = {};
  let hadLegacy = false;
  for (const [provider, value] of Object.entries(raw)) {
    const { set, wasLegacy } = normalizeAccountSet(value);
    if (set) normalized[provider] = set;
    if (wasLegacy) hadLegacy = true;
  }
  return { store: normalized, hadLegacy };
}

/**
 * In-process write serialization: every mutation runs load-modify-persist under this queue so
 * a guardian refresh persisting a non-active account cannot roll back a concurrent
 * active-account switch (lost update). Cross-process races are accepted (single proxy).
 */
let writeQueue: Promise<unknown> = Promise.resolve();
function enqueueWrite<T>(fn: () => T): T {
  // Synchronous mutations: chain onto the queue for ordering, but run eagerly since all
  // current callers are sync. The queue exists so future async mutators serialize too.
  const result = fn();
  writeQueue = writeQueue.then(() => result);
  return result;
}

function mutateStore<T>(fn: (store: AuthStore) => T): T {
  return enqueueWrite(() => {
    const { store, hadLegacy } = loadAuthStoreInternal();
    if (hadLegacy) backupLegacyOnce();
    const result = fn(store);
    persist(store);
    return result;
  });
}

/** The ACTIVE account's credential for a provider (what requests should use). */
export function getCredential(provider: string): OAuthCredentials | null {
  const set = loadAuthStore()[provider];
  if (!set) return null;
  return set.accounts.find(a => a.id === set.activeAccountId)?.credential ?? null;
}

/**
 * Persist a credential as the ACTIVE account. Identity-matching (accountId ?? email) upserts
 * the same human's slot; a new identity appends a new account. Credentials without identity
 * (rotating refresh tokens would fabricate duplicates) and single-slot providers replace the
 * active slot / whole set instead.
 */
export function saveCredential(provider: string, cred: OAuthCredentials): void {
  const safe = normalizeCredential(cred);
  if (!safe) return;
  mutateStore(store => {
    const set = store[provider];
    const identity = safe.accountId ?? safe.email;
    if (!set || SINGLE_SLOT_PROVIDERS.has(provider)) {
      const id = newAccountId(safe);
      store[provider] = { activeAccountId: id, accounts: [{ id, credential: safe, addedAt: Date.now() }] };
      return;
    }
    if (identity) {
      const existing = set.accounts.find(a => (a.credential.accountId ?? a.credential.email) === identity);
      if (existing) {
        existing.credential = safe;
        delete existing.needsReauth;
        set.activeAccountId = existing.id;
        return;
      }
      const id = newAccountId(safe);
      set.accounts.push({ id, credential: safe, addedAt: Date.now() });
      set.activeAccountId = id;
      return;
    }
    // No identity: replace the active slot in place (single-account semantics).
    const active = set.accounts.find(a => a.id === set.activeAccountId);
    if (active) {
      active.credential = safe;
      delete active.needsReauth;
    } else {
      const id = newAccountId(safe);
      set.accounts.push({ id, credential: safe, addedAt: Date.now() });
      set.activeAccountId = id;
    }
  });
}

/** Remove the ACTIVE account; remaining accounts promote the first one. */
export function removeCredential(provider: string): void {
  mutateStore(store => {
    const set = store[provider];
    if (!set) return;
    set.accounts = set.accounts.filter(a => a.id !== set.activeAccountId);
    if (set.accounts.length === 0) {
      delete store[provider];
      return;
    }
    set.activeAccountId = set.accounts[0]!.id;
  });
}

// ---------------------------------------------------------------------------
// Multi-account API
// ---------------------------------------------------------------------------

export function getAccountSet(provider: string): ProviderAccountSet | null {
  return loadAuthStore()[provider] ?? null;
}

export function listAccounts(provider: string): ProviderAccount[] {
  return loadAuthStore()[provider]?.accounts ?? [];
}

export function getAccountCredential(provider: string, accountId: string): OAuthCredentials | null {
  return loadAuthStore()[provider]?.accounts.find(a => a.id === accountId)?.credential ?? null;
}

/** Persist a refreshed credential for a SPECIFIC account without touching activeAccountId. */
export function saveAccountCredential(provider: string, accountId: string, cred: OAuthCredentials): void {
  const safe = normalizeCredential(cred);
  if (!safe) return;
  mutateStore(store => {
    const account = store[provider]?.accounts.find(a => a.id === accountId);
    if (!account) return;
    account.credential = safe;
    delete account.needsReauth;
  });
}

export function setActiveAccount(provider: string, accountId: string): boolean {
  return mutateStore(store => {
    const set = store[provider];
    if (!set || !set.accounts.some(a => a.id === accountId)) return false;
    set.activeAccountId = accountId;
    return true;
  });
}

/** Remove one account by id; active removal promotes the first remaining account. */
export function removeAccount(provider: string, accountId: string): boolean {
  return mutateStore(store => {
    const set = store[provider];
    if (!set) return false;
    const before = set.accounts.length;
    set.accounts = set.accounts.filter(a => a.id !== accountId);
    if (set.accounts.length === before) return false;
    if (set.accounts.length === 0) {
      delete store[provider];
      return true;
    }
    if (set.activeAccountId === accountId) set.activeAccountId = set.accounts[0]!.id;
    return true;
  });
}

export function markAccountNeedsReauth(provider: string, accountId: string, needsReauth: boolean): void {
  mutateStore(store => {
    const account = store[provider]?.accounts.find(a => a.id === accountId);
    if (!account) return;
    if (needsReauth) account.needsReauth = true;
    else delete account.needsReauth;
  });
}
