/**
 * OAuth token store at ~/.opencodex/auth.json, keyed by provider name.
 *
 * Multiauth shape (260706): each provider value is a ProviderAccountSet
 * `{ activeAccountId, accounts: [{ id, credential, addedAt? }] }`.
 * Legacy single-credential values (`{ access, refresh, expires, ... }`) normalize on load,
 * and the first new-shape persist writes a one-time `auth.json.pre-multiauth` backup so a
 * downgraded loader (which silently drops unknown shapes) cannot destroy refresh tokens.
 *
 * Exceptions:
 * - `chatgpt` stays single-slot (always replaced): codex-auth-api uses it as a scratch slot
 *   for Codex pool logins, which have their own ledger (codex-accounts.json).
 * - Credentials without identity (no accountId/email — e.g. kiro) replace the active slot
 *   instead of appending: their refresh tokens rotate, so a derived id would duplicate the
 *   same human on every re-login. Kimi extracts JWT `user_id`/`sub` as accountId; Cursor
 *   extracts JWT `sub` — both append distinct accounts under multiauth.
 */
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir, atomicWriteFile, backupInvalidConfig, hardenConfigDir, hardenExistingSecret } from "../config";
import { validateCopilotApiBaseUrl } from "./github-copilot";
import type { OAuthCredentialSource, OAuthCredentials, ProviderAccount, ProviderAccountSet } from "./types";

type AuthStore = Record<string, ProviderAccountSet>;

/**
 * In-memory-only set of accounts currently marked needsReauth.
 * Intentionally NOT persisted across process restarts: a transient failure at boot time
 * (network not yet up on Windows, brief Anthropic outage, etc.) must not permanently lock
 * an account that has a valid refresh token (#209). The mark is re-established within a
 * session if a terminal refresh failure is confirmed.
 */
const inMemoryNeedsReauth = new Set<string>();
function needsReauthKey(provider: string, accountId: string): string { return `${provider}\x00${accountId}`; }

/** Providers whose account set is pinned to a single slot (see module doc). */
const SINGLE_SLOT_PROVIDERS = new Set(["chatgpt"]);

export function getAuthStorePath(): string {
  return join(getConfigDir(), "auth.json");
}
export function getAuthStoreLockPath(): string { return join(getConfigDir(), "auth.store.lock"); }
export function getAuthRefreshIntentLockPath(provider: string, accountId: string): string {
  const safeProvider = provider.replace(/[^a-zA-Z0-9_-]/g, "_");
  const accountHash = createHash("sha256").update(accountId).digest("hex").slice(0, 24);
  return join(getConfigDir(), `auth.refresh.${safeProvider}.${accountHash}.lock`);
}
export function getAuthRefreshIntentPath(provider: string, accountId: string): string {
  return `${getAuthRefreshIntentLockPath(provider, accountId)}.json`;
}
export interface OAuthRefreshIntent { version: 1; provider: string; accountId: string; generation: string; createdAt: number; uncertain?: true }
export function readOAuthRefreshIntent(provider: string, accountId: string): OAuthRefreshIntent | undefined {
  const path = getAuthRefreshIntentPath(provider, accountId);
  try {
    hardenConfigDir();
    hardenExistingSecret(path);
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<OAuthRefreshIntent>;
    if (value.version !== 1 || value.provider !== provider || value.accountId !== accountId || typeof value.generation !== "string" || typeof value.createdAt !== "number") {
      return { version: 1, provider, accountId, generation: "", createdAt: 0, uncertain: true };
    }
    return value as OAuthRefreshIntent;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    return { version: 1, provider, accountId, generation: "", createdAt: 0, uncertain: true };
  }
}
export function writeOAuthRefreshIntent(provider: string, accountId: string, generation: string, createdAt = Date.now()): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  hardenConfigDir();
  const intent: OAuthRefreshIntent = { version: 1, provider, accountId, generation, createdAt };
  atomicWriteFile(getAuthRefreshIntentPath(provider, accountId), `${JSON.stringify(intent)}\n`);
}
export function clearOAuthRefreshIntent(provider: string, accountId: string, generation: string): boolean {
  const current = readOAuthRefreshIntent(provider, accountId);
  if (!current || current.generation !== generation) return false;
  try { unlinkSync(getAuthRefreshIntentPath(provider, accountId)); return true; }
  catch (error) { if (errorCode(error) === "ENOENT") return false; throw error; }
}
export function credentialGeneration(cred: OAuthCredentials): string {
  return createHash("sha256").update(JSON.stringify([cred.refresh, cred.access, cred.expires])).digest("hex");
}

function loadAuthStoreInternal(): { store: AuthStore; hadLegacy: boolean } {
  const path = getAuthStorePath();
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
  hardenConfigDir();
  atomicWriteFile(getAuthStorePath(), JSON.stringify(store, null, 2) + "\n");
}

export class OAuthFileLockError extends Error { readonly code = "OAUTH_FILE_LOCK_UNAVAILABLE"; constructor(message: string, options?: { cause?: unknown }) { super(message, options); this.name = "OAuthFileLockError"; } }
interface LockSnapshot { bytes: string; dev: number; ino: number; mtimeMs: number; size: number }
export interface OAuthFileLockOptions { path: string; waitTimeoutMs?: number; staleAfterMs?: number; pollMinMs?: number; pollMaxMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number; random?: () => number; beforeStaleUnlink?: () => void; beforeReleaseUnlink?: () => void; beforeFailedCreateUnlink?: () => void; writeMetadata?: (fd: number, bytes: string) => void }
export interface OAuthFileLockGuard { readonly ownerId: string; release(): void }
function errorCode(error: unknown): string | undefined { return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : undefined; }
function snapshot(path: string): LockSnapshot { const bytes = readFileSync(path, "utf8"); const s = statSync(path); return { bytes, dev:s.dev, ino:s.ino, mtimeMs:s.mtimeMs, size:s.size }; }
function sameSnapshot(a: LockSnapshot,b: LockSnapshot): boolean { return a.bytes===b.bytes&&a.dev===b.dev&&a.ino===b.ino&&a.mtimeMs===b.mtimeMs&&a.size===b.size; }
function sameFd(a: LockSnapshot,b: ReturnType<typeof fstatSync>): boolean { return a.dev===b.dev&&a.ino===b.ino&&a.mtimeMs===b.mtimeMs&&a.size===b.size; }
export function createOAuthFileLock(options: OAuthFileLockOptions): { acquire(): Promise<OAuthFileLockGuard> } {
 const wait=options.waitTimeoutMs??5000, stale=options.staleAfterMs??120000, min=options.pollMinMs??25,max=options.pollMaxMs??100,sleep=options.sleep??(ms=>Bun.sleep(ms)),now=options.now??Date.now,random=options.random??Math.random,write=options.writeMetadata??((fd,b)=>writeFileSync(fd,b,"utf8"));
 if(wait<0||stale<=0||min<0||max<min) throw new OAuthFileLockError("Invalid OAuth file-lock timing options");
 return { async acquire() { hardenConfigDir(); if(!existsSync(getConfigDir())) mkdirSync(getConfigDir(),{recursive:true,mode:0o700}); const ownerId=randomUUID(),started=now(); for(;;){ let fd:number|undefined; try { fd=openSync(options.path,"wx",0o600); const bytes=`${JSON.stringify({version:1,ownerId,pid:process.pid,createdAt:now()})}\n`; write(fd,bytes); const fs=fstatSync(fd); closeSync(fd); fd=undefined; const owned=snapshot(options.path); if(owned.bytes!==bytes||!sameFd(owned,fs)) throw new OAuthFileLockError("OAuth lock changed during creation"); let released=false; return {ownerId,release(){if(released)return;released=true;try{const a=snapshot(options.path);if(!sameSnapshot(owned,a))return;options.beforeReleaseUnlink?.();const b=snapshot(options.path);if(sameSnapshot(owned,b))unlinkSync(options.path);}catch(e){if(errorCode(e)!=="ENOENT")console.warn(`[oauth] lock release failed: ${e instanceof Error?e.message:String(e)}`);}}}; } catch(e) { if(fd!==undefined){let fs;try{fs=fstatSync(fd);}catch{}try{closeSync(fd);}catch{}if(fs)try{const a=snapshot(options.path);if(sameFd(a,fs)){options.beforeFailedCreateUnlink?.();const b=snapshot(options.path);if(sameSnapshot(a,b)&&sameFd(b,fs))unlinkSync(options.path);}}catch{}} if(errorCode(e)!=="EEXIST")throw e instanceof OAuthFileLockError?e:new OAuthFileLockError("Could not create OAuth file lock",{cause:e}); }
 try{const a=snapshot(options.path);let created=a.mtimeMs;try{const p=JSON.parse(a.bytes);if(typeof p.createdAt==="number")created=Math.max(created,p.createdAt);}catch{}if(now()-created>stale){options.beforeStaleUnlink?.();const b=snapshot(options.path);if(sameSnapshot(a,b))unlinkSync(options.path);continue;}}catch(e){if(errorCode(e)==="ENOENT")continue;throw new OAuthFileLockError("Could not inspect OAuth file lock",{cause:e});} const elapsed=now()-started;if(elapsed>=wait)throw new OAuthFileLockError(`Timed out after ${wait}ms waiting for OAuth file lock`);await sleep(Math.min(wait-elapsed,min+Math.floor(random()*(max-min+1)))); } } };
}
export function createOAuthRefreshIntentLock(provider:string,accountId:string,overrides:Partial<OAuthFileLockOptions>={}) { return createOAuthFileLock({path:getAuthRefreshIntentLockPath(provider,accountId),staleAfterMs:120000,...overrides}); }

/**
 * One-time downgrade safety net: the first time we persist the NEW shape over a file that
 * still contains legacy single-credential entries, keep a pristine copy. An older opencodex
 * would silently drop the new shape (normalizeCredential -> null) and then persist an empty
 * store, destroying refresh tokens; the backup makes that recoverable.
 */
function backupLegacyOnce(): void {
  const path = getAuthStorePath();
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
  if (typeof candidate.apiBaseUrl === "string" && candidate.apiBaseUrl.length > 0) {
    // Persist only allowlisted Copilot origins; drop anything else so auth.json cannot
    // become an SSRF springboard across reloads.
    const validated = validateCopilotApiBaseUrl(candidate.apiBaseUrl);
    if (validated) normalized.apiBaseUrl = validated;
  }
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
  // needsReauth is NOT loaded from disk — see inMemoryNeedsReauth above.
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
let mutationTail: Promise<void> = Promise.resolve();
function serializeMutation<T>(work:()=>Promise<T>):Promise<T>{const result=mutationTail.then(work,work);mutationTail=result.then(()=>undefined,()=>undefined);return result;}
export function mutateStore<T>(fn:(store:AuthStore)=>T|Promise<T>):Promise<T>{return serializeMutation(async()=>{const guard=await createOAuthFileLock({path:getAuthStoreLockPath(),staleAfterMs:30000}).acquire();try{
    const { store, hadLegacy } = loadAuthStoreInternal();
    if (hadLegacy) backupLegacyOnce();
    const result = await fn(store);
    persist(store);
    return result;
  }finally{guard.release();}});
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
export async function saveCredential(provider: string, cred: OAuthCredentials): Promise<void> {
  const safe = normalizeCredential(cred);
  if (!safe) return;
  await mutateStore(store => {
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
        inMemoryNeedsReauth.delete(needsReauthKey(provider, existing.id));
        set.activeAccountId = existing.id;
        return;
      }
      // Legacy migration: a pre-identity row (no accountId/email) for this provider is the
      // SAME human re-logging in after the identity extraction shipped — upgrading the
      // active identity-less row in place prevents a stale duplicate that stays selectable
      // and would re-refresh into a second row with the same identity.
      const active = set.accounts.find(a => a.id === set.activeAccountId);
      if (active && active.credential.accountId === undefined && active.credential.email === undefined) {
        active.credential = safe;
        inMemoryNeedsReauth.delete(needsReauthKey(provider, active.id));
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
      inMemoryNeedsReauth.delete(needsReauthKey(provider, active.id));
    } else {
      const id = newAccountId(safe);
      set.accounts.push({ id, credential: safe, addedAt: Date.now() });
      set.activeAccountId = id;
    }
  });
}

/** Remove the ACTIVE account; remaining accounts promote the first one. */
export async function removeCredential(provider: string): Promise<void> {
  await mutateStore(store => {
    const set = store[provider];
    if (!set) return;
    inMemoryNeedsReauth.delete(needsReauthKey(provider, set.activeAccountId));
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
  const set = loadAuthStore()[provider];
  if (!set) return null;
  // Fast path: skip allocation when nothing is marked for this provider.
  if (inMemoryNeedsReauth.size === 0) return set;
  const markedInProvider = set.accounts.some(a => inMemoryNeedsReauth.has(needsReauthKey(provider, a.id)));
  if (!markedInProvider) return set;
  // Overlay in-memory needsReauth markers onto the loaded accounts (only allocates when needed).
  const accounts = set.accounts.map(a =>
    inMemoryNeedsReauth.has(needsReauthKey(provider, a.id))
      ? { ...a, needsReauth: true as const }
      : a,
  );
  return { ...set, accounts };
}

export function listAccounts(provider: string): ProviderAccount[] {
  return getAccountSet(provider)?.accounts ?? [];
}

export function getAccountCredential(provider: string, accountId: string): OAuthCredentials | null {
  return loadAuthStore()[provider]?.accounts.find(a => a.id === accountId)?.credential ?? null;
}

/** Persist a refreshed credential for a SPECIFIC account without touching activeAccountId. */
export async function saveAccountCredential(provider: string, accountId: string, cred: OAuthCredentials): Promise<void> {
  const safe = normalizeCredential(cred);
  if (!safe) return;
  await mutateStore(store => {
    const account = store[provider]?.accounts.find(a => a.id === accountId);
    if (!account) return;
    account.credential = safe;
    inMemoryNeedsReauth.delete(needsReauthKey(provider, accountId));
  });
}

export async function setActiveAccount(provider: string, accountId: string): Promise<boolean> {
  return await mutateStore(store => {
    const set = store[provider];
    if (!set || !set.accounts.some(a => a.id === accountId)) return false;
    set.activeAccountId = accountId;
    return true;
  });
}

/** Remove one account by id; active removal promotes the first remaining account. */
export async function removeAccount(provider: string, accountId: string): Promise<boolean> {
  return await mutateStore(store => {
    const set = store[provider];
    if (!set) return false;
    const before = set.accounts.length;
    inMemoryNeedsReauth.delete(needsReauthKey(provider, accountId));
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
  // Update in-memory marker (survives until process exit or credential save).
  const key = needsReauthKey(provider, accountId);
  if (needsReauth) inMemoryNeedsReauth.add(key);
  else inMemoryNeedsReauth.delete(key);
}

export async function mergeAccountCredential(provider:string,accountId:string,credential:OAuthCredentials,opts:{expectedGeneration?:string;afterPrePersistRead?:()=>void|Promise<void>}={}):Promise<{superseded:false}|{superseded:true;stored:OAuthCredentials}>{const safe=normalizeCredential(credential);if(!safe)throw new Error("Refusing to persist invalid OAuth credential");return await mutateStore(async store=>{await opts.afterPrePersistRead?.();const account=store[provider]?.accounts.find(x=>x.id===accountId);if(!account)throw new Error(`OAuth account disappeared before persist: ${provider}`);if(opts.expectedGeneration!==undefined&&credentialGeneration(account.credential)!==opts.expectedGeneration)return{superseded:true,stored:account.credential};account.credential=safe;inMemoryNeedsReauth.delete(needsReauthKey(provider,accountId));return{superseded:false};});}
export function markAccountNeedsReauthIfGeneration(provider: string, accountId: string, generation: string): boolean {
  // Read the current credential generation without mutateStore: we only need to compare
  // the generation to guard against a concurrent rotation replacing the credential between
  // the refresh attempt and this mark. A plain store read is sufficient — if the generation
  // has already moved on (concurrent refresh won), the mark is intentionally skipped.
  const cred = getAccountCredential(provider, accountId);
  if (!cred || credentialGeneration(cred) !== generation) return false;
  inMemoryNeedsReauth.add(needsReauthKey(provider, accountId));
  return true;
}
