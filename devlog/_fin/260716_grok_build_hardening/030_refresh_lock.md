# 030 — xAI refresh hardening: per-account intent lock + short store-write lock

Status: Round-3 replacement design. This document supersedes the rejected single global lock. No synchronous lock API, `Atomics.wait`, or network I/O under `auth.store.lock` is permitted.

## Decision and threat model

Assets are rotating xAI refresh tokens and the whole `auth.json` account store. Competing proxy/CLI processes can double-spend one rotating token; unrelated writers can lose updates if they load and rewrite the whole store concurrently. The rejected design held a global lock over IdP I/O and required synchronous event-loop blocking for existing writers.

Chosen design:

1. A refresh-intent lock file is keyed by provider and account: `auth.refresh.<provider>.<accountHash>.lock`, beside `auth.json`. It is acquired asynchronously and held over re-read, 020 reconciliation, IdP exchange, and final persist. It prevents only same-account refresh-token double-spend.
2. A single `auth.store.lock` is acquired asynchronously only around load-merge-persist. It never covers IdP discovery, token POST, retry sleep, Grok-store reads, or any other network I/O.
3. Every whole-store writer uses one in-process promise queue and then `auth.store.lock`. Correctness is cooperative exclusion, not filesystem CAS.

Both locks use one path/TTL-parameterized implementation with `O_EXCL`, bounded asynchronous polling, stale takeover, and exact-byte/stat identity checks before every cleanup/release unlink. The consequence is an async API migration for every writer. The audit found no unconvertible synchronous production caller.

## Source reality and async caller conversion

Current persistence is private at `src/oauth/store.ts:50-59`; every call reaches it through `mutateStore` at `src/oauth/store.ts:167-175`. Current exported writers are synchronous at `src/oauth/store.ts:190`, `:228`, `:258`, `:269`, `:279`, and `:295`.

| Writer | Current caller | Required after form |
|---|---|---|
| `saveCredential` | `src/oauth/index.ts:196` | `await saveCredential(provider, imported)` inside async `refreshAndPersistAccessToken` |
|  | `src/oauth/index.ts:219` | same |
|  | `src/oauth/index.ts:355` | `await saveCredential(provider, cred)` inside async `runLogin` |
| `saveAccountCredential` | `src/oauth/index.ts:204-213` | `await saveAccountCredential(...)` (generic providers only) |
| `markAccountNeedsReauth` | `src/oauth/index.ts:224` | `await markAccountNeedsReauth(...)` |
| `removeCredential` | `src/cli/index.ts:503` | `await removeCredential(name)`; command dispatch already permits `await` |
|  | `src/server/management-api.ts:1074` | `await removeCredential(provider)`; handler is async at line 77 |
| `setActiveAccount` | `src/server/management-api.ts:1093` | `if (!(await setActiveAccount(...))) ...` |
| `removeAccount` | `src/server/management-api.ts:1104` | `if (!(await removeAccount(...))) ...` |

All corresponding test setup and assertions found by `rg` must also await these APIs (notably `tests/oauth-store-multi.test.ts`, `tests/oauth-refresh.test.ts`, `tests/token-guardian.test.ts`, `tests/oauth-status-privacy.test.ts`, `tests/google-antigravity-oauth.test.ts`, and `tests/provider-quota.test.ts`). No production sync caller is blocked from conversion.

## File change map

| Marker | Path | Responsibility |
|---|---|---|
| MODIFY | `src/oauth/store.ts` | Canonical paths; shared async file-lock primitive; refresh-intent path; async serialized mutation funnel; refresh delta merge helper; all writer exports async. |
| MODIFY | `src/oauth/index.ts` | Await writer calls; two-lock xAI transaction; 020 composition; permanent verdict cache. |
| MODIFY | `src/oauth/xai.ts` | Typed token failures and bounded three-attempt retry. |
| MODIFY | `src/cli/index.ts` | Await logout writer. |
| MODIFY | `src/server/management-api.ts` | Await logout/switch/remove writers. |
| MODIFY | affected existing OAuth tests | Await async store setup and boolean results. |
| NEW | `tests/xai-refresh-lock.test.ts` | Event-loop, process-lock, merge, stale, cleanup, and TTL bodies below. |
| NEW | `tests/xai-oauth-retry.test.ts` | Retry bodies below. |

No dependency and no persisted generation field are added.

## `src/oauth/store.ts`: complete shared lock and mutation funnel

Use these imports (retain existing type imports):

```ts
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, copyFileSync, existsSync, fstatSync, mkdirSync,
  openSync, readFileSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
```

Replace `authPath()` and add lock paths/fingerprint:

```ts
export function getAuthStorePath(): string {
  return join(getConfigDir(), "auth.json");
}

export function getAuthStoreLockPath(): string {
  return join(getConfigDir(), "auth.store.lock");
}

export function getAuthRefreshIntentLockPath(provider: string, accountId: string): string {
  const safeProvider = provider.replace(/[^a-zA-Z0-9_-]/g, "_");
  const accountHash = createHash("sha256").update(accountId).digest("hex").slice(0, 24);
  return join(getConfigDir(), `auth.refresh.${safeProvider}.${accountHash}.lock`);
}

export function credentialGeneration(cred: OAuthCredentials): string {
  return createHash("sha256")
    .update(JSON.stringify([cred.refresh, cred.access, cred.expires]))
    .digest("hex");
}
```

Update internal `authPath()` calls to `getAuthStorePath()`. Add after `persist()`:

```ts
export class OAuthFileLockError extends Error {
  readonly code = "OAUTH_FILE_LOCK_UNAVAILABLE";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OAuthFileLockError";
  }
}

interface LockPayload { version: 1; ownerId: string; pid: number; createdAt: number }
interface LockSnapshot { bytes: string; dev: number; ino: number; mtimeMs: number; size: number }

export interface OAuthFileLockOptions {
  path: string;
  waitTimeoutMs?: number;
  staleAfterMs?: number;
  pollMinMs?: number;
  pollMaxMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  beforeStaleUnlink?: () => void;
  beforeReleaseUnlink?: () => void;
  beforeFailedCreateUnlink?: () => void;
  writeMetadata?: (fd: number, bytes: string) => void;
}

export interface OAuthFileLockGuard {
  readonly ownerId: string;
  release(): void;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code) : undefined;
}

function snapshot(path: string): LockSnapshot {
  const bytes = readFileSync(path, "utf8");
  const stat = statSync(path);
  return { bytes, dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size };
}

function sameSnapshot(a: LockSnapshot, b: LockSnapshot): boolean {
  return a.bytes === b.bytes && a.dev === b.dev && a.ino === b.ino &&
    a.mtimeMs === b.mtimeMs && a.size === b.size;
}

function sameFd(a: LockSnapshot, b: ReturnType<typeof fstatSync>): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.size === b.size;
}

function payload(bytes: string): LockPayload | undefined {
  try {
    const value = JSON.parse(bytes) as Partial<LockPayload>;
    return value.version === 1 && typeof value.ownerId === "string" &&
      typeof value.pid === "number" && typeof value.createdAt === "number"
      ? value as LockPayload : undefined;
  } catch { return undefined; }
}

export function createOAuthFileLock(options: OAuthFileLockOptions): {
  acquire(): Promise<OAuthFileLockGuard>;
} {
  const waitTimeoutMs = options.waitTimeoutMs ?? 5_000;
  const staleAfterMs = options.staleAfterMs ?? 120_000;
  const pollMinMs = options.pollMinMs ?? 25;
  const pollMaxMs = options.pollMaxMs ?? 100;
  const sleep = options.sleep ?? (ms => Bun.sleep(ms));
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const writeMetadata = options.writeMetadata ?? ((fd, bytes) => writeFileSync(fd, bytes, "utf8"));
  if (waitTimeoutMs < 0 || staleAfterMs <= 0 || pollMinMs < 0 || pollMaxMs < pollMinMs) {
    throw new OAuthFileLockError("Invalid OAuth file-lock timing options");
  }

  return { async acquire(): Promise<OAuthFileLockGuard> {
    hardenConfigDir();
    if (!existsSync(getConfigDir())) mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
    const ownerId = randomUUID();
    const startedAt = now();
    for (;;) {
      let fd: number | undefined;
      try {
        fd = openSync(options.path, "wx", 0o600);
        const ownedBytes = `${JSON.stringify({ version: 1, ownerId, pid: process.pid, createdAt: now() } satisfies LockPayload)}\n`;
        writeMetadata(fd, ownedBytes);
        const fdStat = fstatSync(fd);
        closeSync(fd); fd = undefined;
        const owned = snapshot(options.path);
        if (owned.bytes !== ownedBytes || !sameFd(owned, fdStat)) {
          throw new OAuthFileLockError("OAuth lock changed during creation");
        }
        let released = false;
        return { ownerId, release(): void {
          if (released) return;
          released = true;
          try {
            const first = snapshot(options.path);
            if (!sameSnapshot(owned, first)) return;
            options.beforeReleaseUnlink?.();
            const second = snapshot(options.path);
            if (sameSnapshot(owned, second)) unlinkSync(options.path);
          } catch (error) {
            if (errorCode(error) !== "ENOENT") console.warn(`[oauth] lock release failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        } };
      } catch (error) {
        if (fd !== undefined) {
          let fdStat: ReturnType<typeof fstatSync> | undefined;
          try { fdStat = fstatSync(fd); } catch {}
          try { closeSync(fd); } catch {}
          if (fdStat) try {
            const first = snapshot(options.path);
            if (sameFd(first, fdStat)) {
              options.beforeFailedCreateUnlink?.();
              const second = snapshot(options.path);
              if (sameSnapshot(first, second) && sameFd(second, fdStat)) unlinkSync(options.path);
            }
          } catch {}
        }
        if (errorCode(error) !== "EEXIST") {
          throw error instanceof OAuthFileLockError ? error :
            new OAuthFileLockError("Could not create OAuth file lock", { cause: error });
        }
      }
      try {
        const first = snapshot(options.path);
        const parsed = payload(first.bytes);
        const timestamp = Math.max(first.mtimeMs, parsed?.createdAt ?? first.mtimeMs);
        if (now() - timestamp > staleAfterMs) {
          options.beforeStaleUnlink?.();
          const second = snapshot(options.path);
          if (sameSnapshot(first, second)) unlinkSync(options.path);
          continue;
        }
      } catch (error) {
        if (errorCode(error) === "ENOENT") continue;
        throw new OAuthFileLockError("Could not inspect OAuth file lock", { cause: error });
      }
      const elapsed = now() - startedAt;
      if (elapsed >= waitTimeoutMs) throw new OAuthFileLockError(`Timed out after ${waitTimeoutMs}ms waiting for OAuth file lock`);
      const span = pollMaxMs - pollMinMs;
      await sleep(Math.min(waitTimeoutMs - elapsed, pollMinMs + Math.floor(random() * (span + 1))));
    }
  } };
}

export function createOAuthRefreshIntentLock(provider: string, accountId: string, overrides: Partial<OAuthFileLockOptions> = {}) {
  return createOAuthFileLock({ path: getAuthRefreshIntentLockPath(provider, accountId), staleAfterMs: 120_000, ...overrides });
}

let mutationTail: Promise<void> = Promise.resolve();

function serializeMutation<T>(work: () => Promise<T>): Promise<T> {
  const result = mutationTail.then(work, work);
  mutationTail = result.then(() => undefined, () => undefined);
  return result;
}

export function mutateStore<T>(fn: (store: AuthStore) => T | Promise<T>): Promise<T> {
  return serializeMutation(async () => {
    const guard = await createOAuthFileLock({ path: getAuthStoreLockPath(), staleAfterMs: 30_000 }).acquire();
    try {
      const { store, hadLegacy } = loadAuthStoreInternal();
      if (hadLegacy) backupLegacyOnce();
      const result = await fn(store);
      persist(store);
      return result;
    } finally { guard.release(); }
  });
}

export async function mergeAccountCredential(
  provider: string,
  accountId: string,
  credential: OAuthCredentials,
  opts: {
    /** Generation the caller's IdP exchange consumed. If the stored generation no longer
     *  matches, another writer replaced the credential during the exchange: do NOT overwrite. */
    expectedGeneration?: string;
    afterPrePersistRead?: () => void | Promise<void>;
  } = {},
): Promise<{ superseded: false } | { superseded: true; stored: OAuthCredentials }> {
  const safe = normalizeCredential(credential);
  if (!safe) throw new Error("Refusing to persist invalid OAuth credential");
  return await mutateStore(async store => {
    await opts.afterPrePersistRead?.();
    const account = store[provider]?.accounts.find(item => item.id === accountId);
    if (!account) throw new Error(`OAuth account disappeared before persist: ${provider}`);
    if (
      opts.expectedGeneration !== undefined &&
      account.credential &&
      credentialGeneration(account.credential) !== opts.expectedGeneration
    ) {
      // Same-account write landed while the IdP exchange was in flight. The stored credential
      // is the newer generation; persisting our result would resurrect the older family.
      return { superseded: true as const, stored: account.credential };
    }
    account.credential = safe;
    delete account.needsReauth;
    return { superseded: false as const };
  });
}

export async function markAccountNeedsReauthIfGeneration(
  provider: string,
  accountId: string,
  failedGeneration: string,
): Promise<boolean> {
  return await mutateStore(store => {
    const account = store[provider]?.accounts.find(item => item.id === accountId);
    if (!account?.credential) return false;
    if (credentialGeneration(account.credential) !== failedGeneration) return false; // replaced meanwhile
    account.needsReauth = true;
    return true;
  });
}
```

Convert all six exported writers to `async`/`Promise` and return/await `mutateStore`; preserve their current mutation bodies exactly. `setActiveAccount` and `removeAccount` become `Promise<boolean>`, the others `Promise<void>`. There is no `acquireSync` API.

## `src/oauth/index.ts`: complete refresh transaction

Imports add the 020 helpers plus `credentialGeneration`, `createOAuthRefreshIntentLock`, `mergeAccountCredential`, and `OAuthFileLockError`. Keep generic provider behavior, but await its writers.

```ts
const XAI_PERMANENT_FAILURE_TTL_MS = 30_000;
const permanentRefreshFailures = new Map<string, number>();

interface XaiRefreshDeps {
  intentLock?: ReturnType<typeof createOAuthRefreshIntentLock>;
  now?: () => number;
  afterPrePersistRead?: () => void | Promise<void>;
}

function verdictKey(provider: string, accountId: string, cred: OAuthCredentials): string {
  return `${provider}\u0000${accountId}\u0000${credentialGeneration(cred)}`;
}
function cached(provider: string, accountId: string, cred: OAuthCredentials, now: () => number): boolean {
  const key = verdictKey(provider, accountId, cred), until = permanentRefreshFailures.get(key);
  if (until === undefined) return false;
  if (until <= now()) { permanentRefreshFailures.delete(key); return false; }
  return true;
}
function terminal(error: unknown): boolean {
  return error instanceof XaiTokenRequestError
    ? ["invalid_grant", "refresh_token_reused", "revoked_token"].includes(error.oauthError ?? "")
    : isTerminalRefreshError(error);
}
function authoritative(stored: OAuthCredentials, active: boolean, now: () => number): OAuthCredentials {
  if (stored.source !== "local-cli") return stored;
  const disk = detectGrokCliToken();
  if (!disk) return stored;
  const allowed = isSameGrokIdentity(stored, disk) || (active && !hasComparableGrokIdentity(stored, disk));
  return allowed && shouldAdoptGrokGeneration(stored, disk, now(), REFRESH_SKEW_MS) ? disk : stored;
}
function merged(fresh: OAuthCredentials, previous: OAuthCredentials): OAuthCredentials {
  return {
    ...fresh, source: previous.source === "local-cli" ? "oauth" : fresh.source ?? previous.source ?? "oauth",
    ...(fresh.projectId === undefined && previous.projectId ? { projectId: previous.projectId } : {}),
    ...(fresh.email === undefined && previous.email ? { email: previous.email } : {}),
    ...(fresh.accountId === undefined && previous.accountId ? { accountId: previous.accountId } : {}),
  };
}

export async function refreshXaiAccountWithLock(
  provider: string, accountId: string, def: OAuthProviderDef,
  callerCredential: OAuthCredentials, deps: XaiRefreshDeps = {},
): Promise<string> {
  const now = deps.now ?? Date.now;
  if (cached(provider, accountId, callerCredential, now)) throw new OAuthLoginRequiredError(provider);
  const lock = deps.intentLock ?? createOAuthRefreshIntentLock(provider, accountId);
  let guard: Awaited<ReturnType<typeof lock.acquire>> | undefined;
  try {
    guard = await lock.acquire();
    const stored = getAccountCredential(provider, accountId);
    if (!stored) throw new OAuthLoginRequiredError(provider);
    const active = getAccountSet(provider)?.activeAccountId === accountId;
    const candidate = authoritative(stored, active, now);
    if (credentialGeneration(candidate) !== credentialGeneration(callerCredential) && candidate.expires > now() + REFRESH_SKEW_MS) {
      if (credentialGeneration(candidate) !== credentialGeneration(stored)) {
        const adoption = await mergeAccountCredential(provider, accountId, candidate, {
          expectedGeneration: credentialGeneration(stored),
          afterPrePersistRead: deps.afterPrePersistRead,
        });
        if (adoption.superseded) {
          // Same-account writer landed between our read and the Grok-adoption persist.
          if (adoption.stored.expires > now() + REFRESH_SKEW_MS) return adoption.stored.access;
          throw new OAuthLoginRequiredError(provider);
        }
      }
      return candidate.access;
    }
    if (cached(provider, accountId, candidate, now)) throw new OAuthLoginRequiredError(provider);
    const attemptedGeneration = credentialGeneration(candidate);
    try {
      const fresh = merged(await def.refresh(candidate.refresh), candidate); // intent lock held; no store lock held
      const outcome = await mergeAccountCredential(provider, accountId, fresh, {
        expectedGeneration: attemptedGeneration,
        afterPrePersistRead: deps.afterPrePersistRead,
      });
      if (outcome.superseded) {
        // A same-account writer (login, manual import) replaced the credential during the
        // exchange. Adopt the newer stored generation when usable; otherwise fail closed —
        // recursing on a credential we did not attempt risks spending a third-party generation.
        if (outcome.stored.expires > now() + REFRESH_SKEW_MS) return outcome.stored.access;
        throw new OAuthLoginRequiredError(provider);
      }
      permanentRefreshFailures.delete(verdictKey(provider, accountId, candidate));
      if (candidate.source === "local-cli") console.warn(XAI_LOCAL_CLI_DETACH_WARNING);
      return fresh.access;
    } catch (error) {
      if (!terminal(error)) throw error;
      permanentRefreshFailures.set(verdictKey(provider, accountId, candidate), now() + XAI_PERMANENT_FAILURE_TTL_MS);
      // Conditional: only mark reauth if the failed generation is still the stored one.
      await markAccountNeedsReauthIfGeneration(provider, accountId, attemptedGeneration);
      throw new OAuthLoginRequiredError(provider);
    }
  } catch (error) {
    if (!(error instanceof OAuthFileLockError)) throw error;
    const disk = getAccountCredential(provider, accountId);
    if (disk) {
      const adopted = authoritative(disk, getAccountSet(provider)?.activeAccountId === accountId, now);
      if (credentialGeneration(adopted) !== credentialGeneration(callerCredential) && adopted.expires > now() + REFRESH_SKEW_MS) return adopted.access;
    }
    throw error;
  } finally { guard?.release(); }
}
```

At `refreshAndPersistAccessToken`, after the Kiro pre-import branch and before generic `try`, add:

```ts
if (provider === "xai") return refreshXaiAccountWithLock(provider, accountId, def, cred);
```

This yields the required order: async intent acquire → store/Grok reread and 020 adoption → bounded IdP retry → async store mutation queue → async store-lock acquire → fresh load/merge/persist → store-lock release → intent-lock release.

## `src/oauth/xai.ts`: complete bounded retry

Add below token payload types and replace `postXaiToken`:

```ts
export class XaiTokenRequestError extends Error {
  constructor(
    readonly status: number | undefined,
    readonly oauthError: string | undefined,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "XaiTokenRequestError";
  }
}

export interface XaiTokenRetryDeps {
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function retryDelay(attempt: number, retryAfter: string | null, random: () => number): number {
  const base = attempt === 1 ? 100 : 250;
  const jittered = Math.round(base * (0.75 + random() * 0.5));
  const seconds = retryAfter !== null && /^\d+$/.test(retryAfter) ? Number(retryAfter) : 0;
  return Math.min(2_000, Math.max(jittered, seconds * 1_000));
}

async function readTokenError(response: Response): Promise<XaiTokenRequestError> {
  let oauthError: string | undefined;
  let detail = "";
  try {
    const body = await response.json() as { error?: unknown; error_description?: unknown };
    if (typeof body.error === "string") oauthError = body.error;
    if (typeof body.error_description === "string") detail = body.error_description;
  } catch { /* do not echo arbitrary response bodies or submitted refresh tokens */ }
  const suffix = detail ? `: ${detail}` : oauthError ? `: ${oauthError}` : "";
  return new XaiTokenRequestError(response.status, oauthError, `xAI token request failed: ${response.status}${suffix}`);
}

export async function postXaiToken(
  tokenEndpoint: string,
  body: Record<string, string>,
  signal?: AbortSignal,
  deps: XaiTokenRetryDeps = {},
): Promise<XaiTokenPayload> {
  const sleep = deps.sleep ?? (ms => Bun.sleep(ms));
  const random = deps.random ?? Math.random;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let response: Response;
    try {
      response = await fetch(tokenEndpoint, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body).toString(),
        signal: requestSignal(signal),
      });
    } catch (error) {
      if (isAbortError(error) && signal?.aborted) throw error;
      lastError = error;
      if (attempt === 3) throw new XaiTokenRequestError(undefined, undefined, "xAI token request failed: network error", { cause: error });
      await sleep(retryDelay(attempt, null, random));
      continue;
    }
    if (response.ok) return (await response.json()) as XaiTokenPayload;
    const error = await readTokenError(response);
    lastError = error;
    const transient = response.status === 429 || response.status >= 500;
    if (!transient || attempt === 3) throw error;
    await sleep(retryDelay(attempt, response.headers.get("retry-after"), random));
  }
  throw lastError;
}
```

## Complete tests

### `tests/xai-refresh-lock.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAUTH_PROVIDERS, refreshXaiAccountWithLock } from "../src/oauth";
import { XaiTokenRequestError } from "../src/oauth/xai";
import {
  createOAuthFileLock, createOAuthRefreshIntentLock, getAccountCredential, getAccountSet,
  getAuthRefreshIntentLockPath, OAuthFileLockError, saveCredential,
} from "../src/oauth/store";

const oldHome = process.env.HOME, oldOcx = process.env.OPENCODEX_HOME, oldFetch = globalThis.fetch;
let root: string;
beforeEach(() => {
  root = join(tmpdir(), `xai-lock-${crypto.randomUUID()}`);
  process.env.HOME = root; process.env.OPENCODEX_HOME = join(root, "ocx");
  mkdirSync(process.env.OPENCODEX_HOME, { recursive: true });
});
afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldOcx === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = oldOcx;
  globalThis.fetch = oldFetch; rmSync(root, { recursive: true, force: true });
});
async function seed(): Promise<string> {
  await saveCredential("xai", { access: "old", refresh: "rotating", expires: 1, accountId: "acct" });
  return getAccountSet("xai")!.activeAccountId;
}
function seedGrok(access: string, refresh: string, expires?: number): void {
  const dir = join(root, ".grok"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ "https://auth.x.ai::test": {
    key: access, refresh_token: refresh, ...(expires ? { expires_at: new Date(expires).toISOString() } : {}), user_id: "acct",
  } }));
}
function def(counter: { n: number }, gate?: Promise<void>) {
  return { ...OAUTH_PROVIDERS.xai!, refresh: async () => {
    counter.n++; if (gate) await gate;
    return { access: "fresh", refresh: "next", expires: Date.now() + 3_600_000 };
  } };
}

describe("two-lock xAI refresh", () => {
  test("same-process writer completes while refresh awaits token I/O", async () => {
    const id = await seed(); let release!: () => void;
    const gate = new Promise<void>(r => { release = r; }); const calls = { n: 0 };
    const refresh = refreshXaiAccountWithLock("xai", id, def(calls, gate), getAccountCredential("xai", id)!);
    while (calls.n === 0) await Bun.sleep(1);
    await expect(saveCredential("cursor", { access: "c", refresh: "r", expires: Date.now() + 1000, accountId: "cursor" })).resolves.toBeUndefined();
    release(); await expect(refresh).resolves.toBe("fresh");
  });

  test("two independent lock instances perform one IdP call", async () => {
    const id = await seed(); let release!: () => void;
    const gate = new Promise<void>(r => { release = r; }); const calls = { n: 0 };
    const stale = getAccountCredential("xai", id)!;
    const a = refreshXaiAccountWithLock("xai", id, def(calls, gate), stale, { intentLock: createOAuthRefreshIntentLock("xai", id) });
    while (calls.n === 0) await Bun.sleep(1);
    const b = refreshXaiAccountWithLock("xai", id, def(calls), stale, { intentLock: createOAuthRefreshIntentLock("xai", id) });
    release(); expect(await Promise.all([a, b])).toEqual(["fresh", "fresh"]); expect(calls.n).toBe(1);
  });

  test("unrelated writer after refresh pre-persist read survives", async () => {
    const id = await seed(); const calls = { n: 0 }; let writer!: Promise<void>;
    await refreshXaiAccountWithLock("xai", id, def(calls), getAccountCredential("xai", id)!, {
      afterPrePersistRead: () => { writer = saveCredential("cursor", { access: "c", refresh: "r", expires: Date.now() + 1000, accountId: "cursor" }); },
    });
    await writer;
    expect(getAccountSet("cursor")?.accounts[0]?.credential.access).toBe("c");
    expect(getAccountCredential("xai", id)?.refresh).toBe("next");
  });

  test("stale takeover requires unchanged snapshot", async () => {
    const path = getAuthRefreshIntentLockPath("xai", "acct");
    writeFileSync(path, JSON.stringify({ version: 1, ownerId: "old", pid: 1, createdAt: 0 }));
    utimesSync(path, new Date(0), new Date(0));
    const guard = await createOAuthFileLock({ path, staleAfterMs: 1 }).acquire();
    expect(JSON.parse(readFileSync(path, "utf8")).ownerId).toBe(guard.ownerId); guard.release();
  });

  test("partial metadata failure cleans only its own inode", async () => {
    const path = getAuthRefreshIntentLockPath("xai", "acct");
    await expect(createOAuthFileLock({ path, writeMetadata: fd => { writeFileSync(fd, "{"); throw new Error("partial"); } }).acquire())
      .rejects.toBeInstanceOf(OAuthFileLockError);
    expect(() => readFileSync(path)).toThrow();
  });

  test("replacement between stale inspections survives", async () => {
    const path = getAuthRefreshIntentLockPath("xai", "acct");
    writeFileSync(path, JSON.stringify({ version: 1, ownerId: "old", pid: 1, createdAt: 0 }));
    utimesSync(path, new Date(0), new Date(0));
    const replacement = JSON.stringify({ version: 1, ownerId: "new", pid: 2, createdAt: Date.now() });
    await expect(createOAuthFileLock({ path, staleAfterMs: 1, waitTimeoutMs: 0,
      beforeStaleUnlink: () => writeFileSync(path, replacement) }).acquire()).rejects.toBeInstanceOf(OAuthFileLockError);
    expect(readFileSync(path, "utf8")).toBe(replacement);
  });

  test("replacement between release inspections survives", async () => {
    const path = getAuthRefreshIntentLockPath("xai", "acct");
    const replacement = JSON.stringify({ version: 1, ownerId: "new", pid: 2, createdAt: Date.now() });
    const guard = await createOAuthFileLock({ path, beforeReleaseUnlink: () => writeFileSync(path, replacement) }).acquire();
    guard.release(); expect(readFileSync(path, "utf8")).toBe(replacement);
  });

  test("020 usable later generation is adopted without IdP call", async () => {
    const now = Date.now(); await saveCredential("xai", { access: "old", refresh: "same", expires: 1, accountId: "acct", source: "local-cli" });
    const id = getAccountSet("xai")!.activeAccountId; seedGrok("disk", "same", now + 3_600_000); const calls = { n: 0 };
    await expect(refreshXaiAccountWithLock("xai", id, def(calls), getAccountCredential("xai", id)!, { now: () => now })).resolves.toBe("disk");
    expect(calls.n).toBe(0);
  });

  test("020 equal-expiry disk generation wins without IdP call", async () => {
    const now = Date.now(), expires = now + 3_600_000;
    await saveCredential("xai", { access: "stored", refresh: "stored-r", expires, accountId: "acct", source: "local-cli" });
    const id = getAccountSet("xai")!.activeAccountId; seedGrok("disk", "disk-r", expires); const calls = { n: 0 };
    await expect(refreshXaiAccountWithLock("xai", id, def(calls), getAccountCredential("xai", id)!, { now: () => now })).resolves.toBe("disk");
    expect(calls.n).toBe(0);
  });

  test.each([["inside skew", 30_000], ["missing expiry", 0]])("020 %s disk token is not refresh input", async (_name, offset) => {
    const now = Date.now(); await saveCredential("xai", { access: "stored", refresh: "stored-r", expires: 1, accountId: "acct", source: "local-cli" });
    const id = getAccountSet("xai")!.activeAccountId; seedGrok("disk", "disk-r", offset ? now + offset : undefined);
    const used: string[] = []; const custom = { ...OAUTH_PROVIDERS.xai!, refresh: async (value: string) => {
      used.push(value); return { access: "fresh", refresh: "next", expires: now + 3_600_000 };
    } };
    await refreshXaiAccountWithLock("xai", id, custom, getAccountCredential("xai", id)!, { now: () => now });
    expect(used).toEqual(["stored-r"]);
  });

  test("permanent failure cache expires and changed generation bypasses it", async () => {
    const id = await seed(); const credential = getAccountCredential("xai", id)!; let now = 1000, calls = 0;
    const bad = { ...OAUTH_PROVIDERS.xai!, refresh: async () => { calls++; throw new XaiTokenRequestError(400, "invalid_grant", "bad"); } };
    await expect(refreshXaiAccountWithLock("xai", id, bad, credential, { now: () => now })).rejects.toThrow();
    await expect(refreshXaiAccountWithLock("xai", id, bad, credential, { now: () => now })).rejects.toThrow(); expect(calls).toBe(1);
    now += 30_001;
    await expect(refreshXaiAccountWithLock("xai", id, bad, credential, { now: () => now })).rejects.toThrow(); expect(calls).toBe(2);
    await saveCredential("xai", { ...credential, access: "new", refresh: "new-r", expires: now + 100_000 });
    await expect(refreshXaiAccountWithLock("xai", id, bad, credential, { now: () => now })).resolves.toBe("new");
  });
});
```

The 020 matrix above deliberately exercises the exported authority helper through the refresh transaction. If 020's final exports differ, update imports/calls during stale-check; do not duplicate its authority algorithm.

### Same-account replacement during exchange (R4-1)

`tests/xai-refresh-lock.test.ts`에 추가:

같은 파일의 기존 헬퍼(`seed`, `def`, `saveCredential`, `getAccountCredential`, `getAccountSet`)만 사용한다:

```ts
  test("same-account write during exchange supersedes the refresh result", async () => {
    const id = await seed(); let release!: () => void;
    const gate = new Promise<void>(r => { release = r; }); const calls = { n: 0 };
    const stale = getAccountCredential("xai", id)!;
    const pending = refreshXaiAccountWithLock("xai", id, def(calls, gate), stale);
    while (calls.n === 0) await Bun.sleep(1);
    // Same-account writer lands via the mutation queue while def.refresh is in flight.
    await saveCredential("xai", { access: "writer-access", refresh: "writer-gen", expires: Date.now() + 3_600_000, accountId: "acct" });
    release();
    await expect(pending).resolves.toBe("writer-access");                 // adopted, not overwritten
    expect(getAccountCredential("xai", id)?.refresh).toBe("writer-gen");  // IdP result was NOT persisted
  });

  test("terminal failure does not mark reauth when the generation was replaced", async () => {
    const id = await seed(); let reject!: () => void;
    const gate = new Promise<never>((_, rej) => {
      reject = () => rej(new XaiTokenRequestError(400, "invalid_grant", "invalid_grant"));
    });
    const calls = { n: 0 };
    const failing = { ...def(calls), refresh: async () => { calls.n++; return await (gate as Promise<never>); } };
    const stale = getAccountCredential("xai", id)!;
    const pending = refreshXaiAccountWithLock("xai", id, failing, stale);
    while (calls.n === 0) await Bun.sleep(1);
    await saveCredential("xai", { access: "writer-access", refresh: "writer-gen", expires: Date.now() + 3_600_000, accountId: "acct" });
    reject();
    await expect(pending).rejects.toBeInstanceOf(OAuthLoginRequiredError);
    const account = getAccountSet("xai")!.accounts.find(a => a.id === id);
    expect(account?.needsReauth).toBeUndefined(); // generation changed → conditional mark skipped
  });
```

Grok-adoption 분기의 동일 경쟁(R5-1)은 `seedGrok`으로 더 새로운 disk 세대를 심은 뒤 adoption persist 직전 `deps.afterPrePersistRead` seam에서 같은 계정을 쓰는 테스트로 커버한다(성공 기대: writer 세대 채택, adoption 미기록).

### `tests/xai-oauth-retry.test.ts`

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { postXaiToken, XaiTokenRequestError } from "../src/oauth/xai";
const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });
function queue(items: Array<Response | Error>) {
  let n = 0; globalThis.fetch = (async () => { const x = items[n++]!; if (x instanceof Error) throw x; return x; }) as typeof fetch;
  return () => n;
}
const body = { grant_type: "refresh_token", client_id: "client", refresh_token: "secret" };
const ok = () => new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600 }));
describe("xAI retry", () => {
  test("network retry succeeds", async () => { const calls = queue([new Error("net"), ok()]); const d: number[] = [];
    await postXaiToken("https://auth.x.ai/token", body, undefined, { sleep: async x => { d.push(x); }, random: () => .5 });
    expect(calls()).toBe(2); expect(d).toEqual([100]); });
  test("429 and 5xx retry at most three attempts", async () => { const calls = queue([new Response("", { status: 429 }), new Response("", { status: 503 }), ok()]); const d: number[] = [];
    await postXaiToken("https://auth.x.ai/token", body, undefined, { sleep: async x => { d.push(x); }, random: () => .5 });
    expect(calls()).toBe(3); expect(d).toEqual([100, 250]); });
  test("third transient failure is final", async () => { const calls = queue([500, 502, 503].map(status => new Response("", { status })));
    await expect(postXaiToken("https://auth.x.ai/token", body, undefined, { sleep: async () => {}, random: () => .5 })).rejects.toMatchObject({ status: 503 }); expect(calls()).toBe(3); });
  test("permanent 4xx is not retried or leaked", async () => { const calls = queue([new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })]);
    await expect(postXaiToken("https://auth.x.ai/token", body, undefined, { sleep: async () => {} })).rejects.toBeInstanceOf(XaiTokenRequestError); expect(calls()).toBe(1); });
  test("caller abort is not retried", async () => { const c = new AbortController(); c.abort(); let calls = 0;
    globalThis.fetch = (async () => { calls++; throw new DOMException("aborted", "AbortError"); }) as typeof fetch;
    await expect(postXaiToken("https://auth.x.ai/token", body, c.signal, { sleep: async () => {} })).rejects.toMatchObject({ name: "AbortError" }); expect(calls).toBe(1); });
});
```

## Acceptance criteria

- Same-account processes make one IdP exchange; unrelated accounts do not share intent locks.
- A same-process writer completes while refresh awaits token I/O, proving no global-lock/event-loop deadlock.
- All whole-store writers await one queue plus `auth.store.lock`; no direct `persist()` bypass exists.
- Refresh final persistence re-loads under the store lock and merges only its account delta; the deterministic unrelated writer survives.
- Same-account write during the exchange supersedes the refresh result: the newer stored generation is adopted when usable, never overwritten (`expectedGeneration` guard), and terminal-failure `needsReauth` is generation-conditional.
- Both lock kinds are async-only and share one implementation; stale/cleanup/release unlink only unchanged exact-byte/stat snapshots.
- 020 authority composition and equality-only credential fingerprints remain intact.
- Permanent verdicts are fingerprint-scoped for 30 seconds; retry behavior remains bounded and abort-safe.

## Risk and rollback

- Crash leftovers are `auth.refresh.<provider>.<accountHash>.lock` and `auth.store.lock`. Stale takeover is allowed only after each lock's TTL and unchanged snapshot validation.
- Intent TTL must exceed discovery plus three 30-second token attempts and backoffs (120 seconds). Store TTL is 30 seconds because it protects local load-merge-persist only.
- A newly landed writer bypassing `mutateStore` reintroduces lost updates. Stale-check must reject every direct `persist()` call outside the funnel.
- Rollback the phase commit, stop opencodex processes, then delete only stale lock files beside `auth.json`; never delete `auth.json`. The old `auth.json.refresh.lock` from the rejected design may also be removed during upgrade cleanup.

## Verification

```bash
rg -n "persist\(|saveCredential|removeCredential|saveAccountCredential|setActiveAccount|removeAccount|markAccountNeedsReauth" src tests
rg -n "Atomics\.wait|acquireSync|auth\.json\.refresh\.lock" src tests devlog/_plan/260716_grok_build_hardening/030_refresh_lock.md
bun test --isolate ./tests/xai-refresh-lock.test.ts ./tests/xai-oauth-retry.test.ts ./tests/oauth-refresh.test.ts ./tests/oauth-store-multi.test.ts
bun run typecheck
bun run privacy:scan
bun run test
git diff --check -- devlog/_plan/260716_grok_build_hardening/030_refresh_lock.md
```

## Stale-check checklist

- [ ] Re-read `src/oauth/store.ts`, `src/oauth/index.ts`, `src/oauth/xai.ts`, `src/oauth/local-token-detect.ts`, and every `rg` caller at implementation HEAD; refresh line numbers.
- [ ] Confirm every whole-store writer and every test caller awaits the async API; no ignored promises.
- [ ] Confirm `persist()` is private and called only by `mutateStore`; no nested store-lock acquisition.
- [ ] Confirm no network, retry sleep, Grok-store read, or IdP call occurs while `auth.store.lock` is held.
- [ ] Confirm intent path includes sanitized provider and SHA-256 account hash, while store path is exactly `auth.store.lock`.
- [ ] Confirm both lock kinds use `createOAuthFileLock`; no `Atomics.wait`, sync polling, `acquireSync`, or busy loop exists.
- [ ] Confirm 020 still exports and is called through `shouldAdoptGrokGeneration(stored, disk, now(), REFRESH_SKEW_MS)`; do not duplicate its authority rules.
- [ ] Confirm generation is lowercase SHA-256 and compared only by equality/inequality across 020/030/040.
- [ ] Confirm stale takeover, failed-create cleanup, and release each perform two exact-byte/stat checks and preserve replacements.
- [ ] Confirm retry tests cover network, 429, 5xx exhaustion, permanent 4xx, caller abort, and token redaction.

## Implementation record (B)

- Implemented the shared async `O_EXCL` file-lock primitive, per-account refresh-intent lock, short-held store-write lock, and one promise-chain mutation funnel.
- Converted all six OAuth store writers and every production/test caller found at implementation HEAD to async/await.
- Replaced wp2's pre-refresh xAI reconciliation block with `refreshXaiAccountWithLock`; the transaction calls the exported `shouldAdoptGrokGeneration` policy under the intent lock.
- Added generation-guarded account merge/reauth mutations, fingerprint-scoped permanent-failure TTL, and bounded abort-safe xAI token retries.
- Deviation: tests were written compactly in the two required new files, while retaining the audited behavioral assertions; no production design deviation.
