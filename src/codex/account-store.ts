import { createHash } from "node:crypto";
import { closeSync, existsSync, readFileSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ConfigMutationLockError,
  getConfigDir,
  atomicWriteFile,
  backupInvalidConfig,
  hardenConfigDir,
  hardenExistingSecret,
  withConfigMutationLockSync,
} from "../config";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import type { CodexAccountCredentialRecord, CodexAccountCredentials } from "../types";

type LegacyCodexAccountStore = Record<string, CodexAccountCredentials>;
type CodexAccountStore = Record<string, CodexAccountCredentialRecord>;
type RawCodexAccountStore = Record<string, CodexAccountCredentials | CodexAccountCredentialRecord>;

const REFRESH_SKEW_MS = 60_000;
const REFRESH_LOCK_STALE_MS = 60_000;
const REFRESH_LOCK_WAIT_MS = REFRESH_LOCK_STALE_MS + 5_000;
const REFRESH_LOCK_POLL_MS = 50;

function codexAccountsPath(): string {
  return join(getConfigDir(), "codex-accounts.json");
}

export function loadCodexAccountStore(): LegacyCodexAccountStore {
  const records = loadCodexAccountRecordStore();
  const credentials: LegacyCodexAccountStore = {};
  for (const [id, record] of Object.entries(records)) {
    if (record.deletedAt == null && record.credential) credentials[id] = record.credential;
  }
  return credentials;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isCredential(value: unknown): value is CodexAccountCredentials {
  return isObject(value)
    && typeof value.accessToken === "string"
    && typeof value.refreshToken === "string"
    && typeof value.expiresAt === "number"
    && typeof value.chatgptAccountId === "string";
}

function isCredentialRecord(value: unknown): value is CodexAccountCredentialRecord {
  return isObject(value)
    && typeof value.generation === "number"
    && (value.credential === undefined || isCredential(value.credential))
    && (value.refreshGrantFingerprint === undefined || typeof value.refreshGrantFingerprint === "string")
    && (value.deletedAt === undefined || typeof value.deletedAt === "number")
    && (value.replacedAt === undefined || typeof value.replacedAt === "number")
    && (value.lastCodexValidatedAt === undefined || typeof value.lastCodexValidatedAt === "number")
    && (value.lastCodexValidationStatus === undefined || value.lastCodexValidationStatus === "ok" || value.lastCodexValidationStatus === "failed")
    && (value.lastCodexValidationError === undefined || typeof value.lastCodexValidationError === "string");
}

export function refreshGrantFingerprintForToken(refreshToken: string): string {
  return createHash("sha256").update(`codex-refresh-grant:${refreshToken}`).digest("hex");
}

function recordGrantFingerprint(record: CodexAccountCredentialRecord): string | undefined {
  return record.refreshGrantFingerprint ?? (
    record.credential ? refreshGrantFingerprintForToken(record.credential.refreshToken) : undefined
  );
}

function normalizeRecord(value: CodexAccountCredentials | CodexAccountCredentialRecord | undefined): CodexAccountCredentialRecord | undefined {
  if (!value) return undefined;
  if (isCredentialRecord(value)) {
    const refreshGrantFingerprint = recordGrantFingerprint(value);
    return refreshGrantFingerprint ? { ...value, refreshGrantFingerprint } : value;
  }
  if (isCredential(value)) {
    return {
      credential: value,
      generation: 0,
      refreshGrantFingerprint: refreshGrantFingerprintForToken(value.refreshToken),
    };
  }
  return undefined;
}

function loadCodexAccountRecordStore(): CodexAccountStore {
  const path = codexAccountsPath();
  hardenConfigDir();
  hardenExistingSecret(path);
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as RawCodexAccountStore;
    const normalized: CodexAccountStore = {};
    for (const [id, value] of Object.entries(raw)) {
      const record = normalizeRecord(value);
      if (record) normalized[id] = record;
    }
    return normalized;
  } catch {
    backupInvalidConfig(path);
    return {};
  }
}

function persist(store: CodexAccountStore): void {
  const dir = getConfigDir();
  assertNotRealHomeUnderTest(dir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWriteFile(codexAccountsPath(), JSON.stringify(store, null, 2) + "\n");
}

function preservedValidationMetadata(record: CodexAccountCredentialRecord | undefined): Pick<
  CodexAccountCredentialRecord,
  "lastCodexValidatedAt" | "lastCodexValidationStatus" | "lastCodexValidationError"
> {
  return {
    ...(record?.lastCodexValidatedAt !== undefined ? { lastCodexValidatedAt: record.lastCodexValidatedAt } : {}),
    ...(record?.lastCodexValidationStatus !== undefined ? { lastCodexValidationStatus: record.lastCodexValidationStatus } : {}),
    ...(record?.lastCodexValidationError !== undefined ? { lastCodexValidationError: record.lastCodexValidationError } : {}),
  };
}

export function getCodexAccountCredential(id: string): CodexAccountCredentials | null {
  const record = readCodexAccountRecord(id);
  if (!record || record.deletedAt != null) return null;
  return record.credential ?? null;
}

export function saveCodexAccountCredential(id: string, cred: CodexAccountCredentials): void {
  withCredentialMutationLockSync(() => {
    const store = loadCodexAccountRecordStore();
    const current = store[id];
    const refreshGrantFingerprint = current?.credential?.refreshToken === cred.refreshToken
      ? current.refreshGrantFingerprint ?? refreshGrantFingerprintForToken(cred.refreshToken)
      : refreshGrantFingerprintForToken(cred.refreshToken);
    store[id] = {
      credential: cred,
      generation: (current?.generation ?? 0) + 1,
      refreshGrantFingerprint,
      replacedAt: current ? Date.now() : undefined,
      ...preservedValidationMetadata(current),
    };
    persist(store);
  });
}

export function markCodexAccountValidated(id: string, atMs: number = Date.now()): void {
  withCredentialMutationLockSync(() => {
    const store = loadCodexAccountRecordStore();
    const current = store[id];
    if (!current || current.deletedAt != null || !current.credential) return;
    store[id] = {
      ...current,
      lastCodexValidatedAt: atMs,
      lastCodexValidationStatus: "ok",
      lastCodexValidationError: undefined,
    };
    persist(store);
  });
}

export function markCodexAccountValidationFailed(id: string, reason: string): void {
  withCredentialMutationLockSync(() => {
    const store = loadCodexAccountRecordStore();
    const current = store[id];
    if (!current || current.deletedAt != null || !current.credential) return;
    store[id] = {
      ...current,
      lastCodexValidationStatus: "failed",
      lastCodexValidationError: reason,
    };
    persist(store);
  });
}

export function removeCodexAccountCredential(id: string): void {
  tombstoneCodexAccount(id);
}

export function listCodexAccountIds(): string[] {
  return Object.keys(loadCodexAccountStore());
}

export function readCodexAccountRecord(id: string): CodexAccountCredentialRecord | null {
  return loadCodexAccountRecordStore()[id] ?? null;
}

export function isCodexAccountGenerationLive(id: string, generation: number): boolean {
  const record = readCodexAccountRecord(id);
  return !!record?.credential && record.deletedAt == null && record.generation === generation;
}

export function saveCodexAccountCredentialIfGeneration(
  id: string,
  generation: number,
  cred: CodexAccountCredentials,
): boolean {
  return withCredentialMutationLockSync(() => {
    const store = loadCodexAccountRecordStore();
    const current = store[id];
    if (!current || current.generation !== generation || current.deletedAt != null || !current.credential) {
      return false;
    }
    const refreshGrantFingerprint = current.credential.refreshToken === cred.refreshToken
      ? current.refreshGrantFingerprint ?? refreshGrantFingerprintForToken(cred.refreshToken)
      : refreshGrantFingerprintForToken(cred.refreshToken);
    store[id] = {
      credential: cred,
      generation: generation + 1,
      refreshGrantFingerprint,
      replacedAt: current.replacedAt,
      ...preservedValidationMetadata(current),
    };
    persist(store);
    return true;
  });
}

export function tombstoneCodexAccount(id: string): number {
  return withCredentialMutationLockSync(() => {
    const store = loadCodexAccountRecordStore();
    const current = store[id];
    const generation = (current?.generation ?? 0) + 1;
    store[id] = { generation, deletedAt: Date.now() };
    persist(store);
    return generation;
  });
}

/** One alias whose stored refresh grant was replaced by a rotation it did not drive. */
export type RotatedGrantFanoutResult = {
  id: string;
  fromGeneration: number;
  toGeneration: number;
  /** The access token that alias holds after the merge; used for plan reconciliation. */
  accessToken: string;
  /**
   * `full` replaced the whole credential; `grant-only` spliced just the refresh grant
   * onto an access credential someone else had already made newer.
   */
  mode: "full" | "grant-only";
};

/**
 * Propagate a rotated refresh grant to same-account aliases that still hold the OLD grant.
 *
 * Upstream rotates the refresh grant for the ACCOUNT, not for the alias that happened to
 * drive the refresh. Only the flight owner and the aliases actively waiting on it learn
 * about the rotation, so an alias that was idle keeps a grant upstream has already
 * invalidated: its next refresh returns `invalid_grant` and the alias is retired even
 * though the account is healthy (#2892 gap 3).
 *
 * Membership is `(exact non-empty chatgptAccountId, exact old grant fingerprint)`. The
 * alias STRING is display-only and never establishes identity, and generations are
 * per-alias: a generation captured for one alias is meaningless for another and is never
 * compared or assigned across them.
 *
 * Everything happens under one credential mutation lock with a single persist, so a
 * partial write cannot leave some aliases on a dead grant. Aliases that were deleted,
 * changed identity, or already moved off the old grant are skipped rather than forced.
 */
export function fanOutRotatedRefreshGrant(options: {
  excludeId: string;
  chatgptAccountId: string;
  previousRefreshGrantFingerprint: string;
  rotated: CodexAccountCredentials;
}): RotatedGrantFanoutResult[] {
  const { excludeId, chatgptAccountId, previousRefreshGrantFingerprint, rotated } = options;
  // Fail closed: without an exact upstream identity there is no safe membership test, and
  // a rotation that did not actually change the grant has nothing to propagate.
  if (!chatgptAccountId || !previousRefreshGrantFingerprint) return [];
  const rotatedFingerprint = refreshGrantFingerprintForToken(rotated.refreshToken);
  if (rotatedFingerprint === previousRefreshGrantFingerprint) return [];

  return withCredentialMutationLockSync(() => {
    const store = loadCodexAccountRecordStore();
    const applied: RotatedGrantFanoutResult[] = [];
    for (const [candidateId, candidate] of Object.entries(store)) {
      if (candidateId === excludeId) continue;
      if (candidate.deletedAt != null || !candidate.credential) continue;
      if (candidate.credential.chatgptAccountId !== chatgptAccountId) continue;
      if (recordGrantFingerprint(candidate) !== previousRefreshGrantFingerprint) continue;

      const fromGeneration = candidate.generation;
      // An alias whose access credential is already newer than the rotation must keep it:
      // overwriting would retire a credential someone else just committed. Only the dead
      // grant is replaced, so the alias can still refresh when its own token expires.
      const keepsOwnAccess = candidate.credential.expiresAt > rotated.expiresAt;
      const merged: CodexAccountCredentials = keepsOwnAccess
        ? { ...candidate.credential, refreshToken: rotated.refreshToken }
        : { ...rotated };
      store[candidateId] = {
        credential: merged,
        generation: fromGeneration + 1,
        refreshGrantFingerprint: rotatedFingerprint,
        replacedAt: candidate.replacedAt,
        ...preservedValidationMetadata(candidate),
      };
      applied.push({
        id: candidateId,
        fromGeneration,
        toGeneration: fromGeneration + 1,
        accessToken: merged.accessToken,
        mode: keepsOwnAccess ? "grant-only" : "full",
      });
    }
    // One write for the whole fan-out: a crash between aliases must not leave part of the
    // account on an invalidated grant.
    if (applied.length > 0) persist(store);
    return applied;
  });
}

const CHATGPT_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export class TokenRefreshError extends Error {
  reason: "expired" | "revoked" | "unknown";
  constructor(reason: "expired" | "revoked" | "unknown", message: string) {
    super(message);
    this.name = "TokenRefreshError";
    this.reason = reason;
  }
}

export class CodexCredentialGenerationConflictError extends Error {
  constructor(message = "Codex account changed during refresh") {
    super(message);
    this.name = "CodexCredentialGenerationConflictError";
  }
}

export class CodexCredentialRefreshLockTimeoutError extends Error {
  constructor(message = "Timed out waiting for Codex account refresh lock") {
    super(message);
    this.name = "CodexCredentialRefreshLockTimeoutError";
  }
}

export class CodexCredentialRefreshBusyError extends Error {
  readonly code = "CODEX_REFRESH_BUSY";
  readonly retryable = true;

  constructor() {
    super("Codex credential refresh capacity reached");
    this.name = "CodexCredentialRefreshBusyError";
  }
}

export class CodexCredentialRefreshStaleError extends Error {
  readonly code = "CODEX_REFRESH_STALE";
  readonly retryable = true;

  constructor() {
    super("Codex credential refresh owner became stale");
    this.name = "CodexCredentialRefreshStaleError";
  }
}

/** Credential writers share the config mutation coordinator; contention is transient, not reauth. */
function withCredentialMutationLockSync<T>(fn: () => T): T {
  try {
    return withConfigMutationLockSync(fn);
  } catch (error) {
    if (error instanceof ConfigMutationLockError) throw new CodexCredentialRefreshLockTimeoutError();
    throw error;
  }
}

type CodexTokenResult = { accessToken: string; chatgptAccountId: string; generation: number };
type CodexRefreshResult = CodexTokenResult & {
  credential?: CodexAccountCredentials;
  /**
   * Grant the returned credential actually belongs to.
   *
   * Flights are keyed by refresh grant and shared across every account holding that
   * grant, but a flight can resolve to a credential from a DIFFERENT grant: the
   * owner's credential may be externally replaced while it waits for the file lock,
   * and the grant-mismatch branch then hands back that replacement. A joiner that
   * only checks its own current grant would CAS-write another account's access and
   * refresh tokens onto itself. The result therefore carries its own provenance.
   */
  resolvedGrantFingerprint?: string;
  /**
   * True when this call's own CAS write produced `generation` — the credential is a
   * refresh of the one the caller was holding, not somebody else's replacement.
   */
  selfRefreshed?: boolean;
  /**
   * Same-account aliases that were carried onto the rotated grant by this flight.
   * Reported so plan reconciliation runs against each alias's own token and generation;
   * never used to establish this caller's own lineage.
   */
  fannedOutAliases?: RotatedGrantFanoutResult[];
};
const MAX_CODEX_REFRESH_FLIGHTS = 32;
const CODEX_REFRESH_FLIGHT_STALE_MS = 120_000;
interface RefreshFlight {
  promise: Promise<CodexRefreshResult>;
  startedAt: number;
  abort: AbortController;
}
const refreshLocks = new Map<string, RefreshFlight>();

function codexRefreshLockPath(lockKey: string): string {
  const digest = createHash("sha256").update(lockKey).digest("hex").slice(0, 32);
  return join(getConfigDir(), `codex-refresh-${digest}.lock`);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise(resolve => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function errCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : undefined;
}

function isRefreshLockStale(path: string): boolean {
  try {
    hardenExistingSecret(path);
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { acquiredAt?: unknown };
    return typeof parsed.acquiredAt !== "number" || Date.now() - parsed.acquiredAt > REFRESH_LOCK_STALE_MS;
  } catch {
    return true;
  }
}

export async function withCodexRefreshFileLock<T>(lockKey: string, signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  hardenConfigDir();
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const path = codexRefreshLockPath(lockKey);
  const deadline = Date.now() + REFRESH_LOCK_WAIT_MS;
  let fd: number | null = null;
  while (fd == null) {
    if (signal.aborted) throw signal.reason;
    try {
      fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ acquiredAt: Date.now(), pid: process.pid }) + "\n");
      break;
    } catch (err) {
      if (errCode(err) !== "EEXIST") throw err;
      if (isRefreshLockStale(path)) {
        try {
          unlinkSync(path);
        } catch (unlinkErr) {
          if (errCode(unlinkErr) !== "ENOENT") throw unlinkErr;
        }
        continue;
      }
      if (Date.now() >= deadline) throw new CodexCredentialRefreshLockTimeoutError();
      await sleep(REFRESH_LOCK_POLL_MS, signal);
    }
  }

  try {
    return await fn();
  } finally {
    if (fd != null) closeSync(fd);
    try {
      unlinkSync(path);
    } catch (err) {
      if (errCode(err) !== "ENOENT") throw err;
    }
  }
}

function findFreshCredentialForGrant(
  refreshGrantFingerprint: string,
  excludeId: string,
  chatgptAccountId: string,
  rejectedAccessToken?: string,
): CodexAccountCredentials | null {
  const now = Date.now();
  // A grant fingerprint alone does not establish WHOSE credential this is. Adopting a
  // sibling record that shares the grant but reports a different upstream identity would
  // silently send one account's requests under another account's bearer, so identity is
  // required and an empty identity fails closed on both sides.
  if (!chatgptAccountId) return null;
  const records = loadCodexAccountRecordStore();
  for (const [candidateId, candidate] of Object.entries(records)) {
    if (candidateId === excludeId || candidate.deletedAt != null || !candidate.credential) continue;
    if (recordGrantFingerprint(candidate) !== refreshGrantFingerprint) continue;
    if (candidate.credential.chatgptAccountId !== chatgptAccountId) continue;
    // A sibling alias can hold a still-unexpired copy of the exact token upstream
    // just rejected. Reusing it would bump the generation and replay the identical
    // bearer — a second 401 dressed up as recovery.
    if (rejectedAccessToken !== undefined && candidate.credential.accessToken === rejectedAccessToken) continue;
    if (candidate.credential.expiresAt > now + REFRESH_SKEW_MS) return candidate.credential;
  }
  return null;
}

async function notePlanFromRefreshedAccessToken(
  id: string,
  accessToken: string,
  generation: number,
): Promise<void> {
  try {
    const { noteCodexAccountAccessToken } = await import("./plan-from-token");
    noteCodexAccountAccessToken(id, accessToken, generation);
  } catch {
    // Derived plan metadata must not fail credential refresh.
  }
}

/**
 * A forced refresh raised by a rejected bearer. Carries the generation the 401 was
 * observed under so a credential someone else already replaced is never refreshed
 * again, and the rejected token so a sibling alias holding that same token cannot
 * satisfy the refresh.
 */
type ForcedRefreshFence = { rejectedGeneration: number; rejectedAccessToken: string };

/** True once the stored credential has moved off the generation the 401 belongs to. */
function forcedFenceSuperseded(recordGeneration: number, forced: ForcedRefreshFence | undefined): boolean {
  return forced !== undefined && recordGeneration !== forced.rejectedGeneration;
}

/**
 * Wait for a SHARED promise while honoring only the calling request's cancellation.
 *
 * The awaited work is not the caller's to cancel — other requests are waiting on the
 * same promise — so an aborted caller stops waiting and the work continues to
 * completion for them (#2892 gap 2). The rejection handler prevents an unhandled
 * rejection from the promise this caller walked away from.
 */
function awaitOwnCancellation<T>(work: Promise<T>, callerSignal?: AbortSignal): Promise<T> {
  if (!callerSignal) return work;
  if (callerSignal.aborted) {
    work.catch(() => {});
    return Promise.reject(callerSignal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      work.catch(() => {});
      reject(callerSignal.reason);
    };
    callerSignal.addEventListener("abort", onAbort, { once: true });
    work.then(
      value => { callerSignal.removeEventListener("abort", onAbort); resolve(value); },
      err => { callerSignal.removeEventListener("abort", onAbort); reject(err); },
    );
  });
}

/**
 * Refresh a stored pool credential that upstream rejected with a 401, even though its
 * `expiresAt` still looks valid. Ordinary callers must keep using
 * {@link getValidCodexToken}: only a proven rejection justifies spending a refresh.
 *
 * `rotated` is false when the resolved token is byte-identical to the rejected one,
 * which means replaying would earn the same 401 and the caller must not try. That can
 * happen even on a SUCCESSFUL token response: upstream may rotate the refresh grant
 * while returning the same access token. The generation has moved by then, so
 * `generation` reports where the credential actually is — a caller that quarantines
 * on `rotated === false` must fence on the returned value, not on the one it rejected.
 */
export async function forceRefreshCodexPoolToken(
  id: string,
  options: { rejectedGeneration: number; rejectedAccessToken: string; signal?: AbortSignal },
): Promise<CodexTokenResult & { rotated: boolean; selfRefreshed: boolean }> {
  const result = await resolveCodexToken(
    id,
    { rejectedGeneration: options.rejectedGeneration, rejectedAccessToken: options.rejectedAccessToken },
    options.signal,
  );
  return {
    accessToken: result.accessToken,
    chatgptAccountId: result.chatgptAccountId,
    generation: result.generation,
    rotated: result.accessToken !== options.rejectedAccessToken,
    // Only a CAS this call performed itself proves the new credential descends from the
    // rejected one; anything else is somebody else's replacement and must not be treated
    // as this request's own lineage.
    selfRefreshed: result.selfRefreshed === true,
  };
}

export async function getValidCodexToken(id: string): Promise<CodexTokenResult> {
  const result = await resolveCodexToken(id);
  return {
    accessToken: result.accessToken,
    chatgptAccountId: result.chatgptAccountId,
    generation: result.generation,
  };
}

async function resolveCodexToken(
  id: string,
  forced?: ForcedRefreshFence,
  callerSignal?: AbortSignal,
): Promise<CodexRefreshResult> {
  if (callerSignal?.aborted) throw callerSignal.reason;
  const record = readCodexAccountRecord(id);
  const cred = record?.deletedAt == null ? record?.credential : undefined;
  if (!record || !cred) throw new Error("Codex account credential is unavailable; reauthenticate the account.");
  const refreshGrantFingerprint = recordGrantFingerprint(record);
  if (!refreshGrantFingerprint) throw new Error("Codex account credential is unavailable; reauthenticate the account.");

  // The freshness shortcut is exactly what makes a 401 on a time-valid token
  // unrecoverable, so a forced caller skips it — but only while the stored credential
  // is still the one that was rejected. Once it has been replaced, the shortcut is
  // correct again and refreshing would burn a rotation for nothing.
  const forcedTargetsStoredCredential = forced !== undefined && !forcedFenceSuperseded(record.generation, forced);
  if (cred.expiresAt > Date.now() + REFRESH_SKEW_MS && !forcedTargetsStoredCredential) {
    return { accessToken: cred.accessToken, chatgptAccountId: cred.chatgptAccountId, generation: record.generation };
  }

  const existing = refreshLocks.get(refreshGrantFingerprint);
  if (existing) {
    if (Date.now() - existing.startedAt > CODEX_REFRESH_FLIGHT_STALE_MS) {
      existing.abort.abort(new CodexCredentialRefreshStaleError());
      if (refreshLocks.get(refreshGrantFingerprint) === existing) refreshLocks.delete(refreshGrantFingerprint);
    } else {
      const refreshed = await awaitOwnCancellation(existing.promise, callerSignal);
      const current = readCodexAccountRecord(id);
      const currentCred = current?.deletedAt == null ? current?.credential : undefined;
      // The flight owner already committed this credential, and it is the one stored
      // for this account: adopt the stored state instead of CAS-writing the identical
      // bytes, which would bump the generation a second time and invalidate the
      // affinity handoff the owner performed against generation+1.
      if (current && currentCred && refreshed.credential
        && currentCred.accessToken === refreshed.credential.accessToken
        && currentCred.refreshToken === refreshed.credential.refreshToken) {
        // A forced caller must still not accept the bearer upstream rejected.
        if (!(forced !== undefined && currentCred.accessToken === forced.rejectedAccessToken)) {
          return {
            accessToken: currentCred.accessToken,
            chatgptAccountId: currentCred.chatgptAccountId,
            generation: current.generation,
          };
        }
      }
      // Flights are keyed by refresh grant, not by account or generation, so this
      // credential may belong to a flight started for a different generation of the
      // same grant. Writing it onto a replacement would undo that replacement.
      //
      // The rejected-token test comes FIRST: a joined flight that resolved back to the
      // bearer upstream rejected proves nothing, and reporting the replacement as
      // "superseded" would hand the caller a token it must not replay.
      //
      // Freshness is tested here too. Supersession says only that SOMEONE replaced the
      // credential — not that what they wrote is usable. An expired G+1 satisfies the
      // generation test and the rejected-bearer test while being certain to earn
      // another 401, and because the caller treats this return as a successful
      // recovery it spends its one replay on it (#2892 gap 1). A stale winner must
      // fall through to a real refresh instead.
      //
      // Stated honestly: this guard is NOT covered by a red-proven test. Reaching this
      // branch needs a live flight that RESOLVES, a stored credential differing from
      // what the flight produced, and that stored credential expired — three attempted
      // interleavings each landed elsewhere (own flight, first adopt-stored branch, or
      // a CAS conflict that rejects for both callers). The guard is one comparison on a
      // path that otherwise returns a known-dead token, and its only effect is to
      // divert to the refresh the caller would have needed anyway.
      if (
        current && currentCred
        && forcedFenceSuperseded(current.generation, forced)
        && currentCred.expiresAt > Date.now() + REFRESH_SKEW_MS
        && !(forced !== undefined && currentCred.accessToken === forced.rejectedAccessToken)
      ) {
        return {
          accessToken: currentCred.accessToken,
          chatgptAccountId: currentCred.chatgptAccountId,
          generation: current.generation,
        };
      }
      if (
        current &&
        currentCred &&
        refreshed.credential &&
        // Provenance: a flight can resolve to a credential from a DIFFERENT grant when
        // the owner's own credential was replaced while it waited for the lock. Adopting
        // that would copy another account's access and refresh tokens onto this one.
        refreshed.resolvedGrantFingerprint === refreshGrantFingerprint &&
        // A joined flight that resolved to the rejected token proves nothing; fall
        // through and open a real refresh instead of bumping the generation.
        !(forced !== undefined && refreshed.credential.accessToken === forced.rejectedAccessToken) &&
        recordGrantFingerprint(current) === refreshGrantFingerprint
      ) {
        if (!saveCodexAccountCredentialIfGeneration(id, current.generation, refreshed.credential)) {
          throw new CodexCredentialGenerationConflictError();
        }
        const generation = current.generation + 1;
        await notePlanFromRefreshedAccessToken(id, refreshed.credential.accessToken, generation);
        return {
          accessToken: refreshed.credential.accessToken,
          chatgptAccountId: refreshed.credential.chatgptAccountId,
          generation,
          // This joiner performed its own CAS onto its own record, so the resulting
          // generation is its own lineage even though another caller drove the fetch.
          selfRefreshed: true,
          resolvedGrantFingerprint: refreshGrantFingerprint,
        };
      }
      return resolveCodexToken(id, forced, callerSignal);
    }
  }

  if (refreshLocks.size >= MAX_CODEX_REFRESH_FLIGHTS) throw new CodexCredentialRefreshBusyError();

  /*
   * The flight's lifetime belongs to the FLIGHT, not to whichever caller happened to
   * open it (#2892 gap 2).
   *
   * Flights are shared: later callers on the same grant join `existing.promise` rather
   * than starting their own. Folding `callerSignal` into the flight's signal therefore
   * gave one arbitrary waiter the power to abort the token request out from under every
   * other waiter — and the joiners have no way to distinguish that from a genuine
   * upstream failure, so a cancelled Codex tab could retire a healthy account for a
   * request that was still running.
   *
   * The initiating caller still gets cancellation: it is waiting on its own await, and
   * `awaitOwnCancellation` below races its wait against its own signal. What it no
   * longer gets is the ability to cancel work other callers depend on: the flight keeps
   * running for the joiners, and its result is still committed. `abort` (stale-flight
   * eviction) and the 30s ceiling remain, because those bound the flight itself.
   */
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]);
  let flight!: RefreshFlight;
  const fetchPromise = withCodexRefreshFileLock(refreshGrantFingerprint, signal, async (): Promise<CodexRefreshResult> => {
    const current = readCodexAccountRecord(id);
    const lockedRecord = readCodexAccountRecord(id);
    const lockedCred = lockedRecord?.deletedAt == null ? lockedRecord?.credential : undefined;
    if (!lockedRecord || !lockedCred) throw new CodexCredentialGenerationConflictError();
    const startGeneration = lockedRecord.generation;
    const lockedRefreshGrantFingerprint = recordGrantFingerprint(lockedRecord);
    if (lockedRefreshGrantFingerprint !== refreshGrantFingerprint) {
      if (lockedCred.expiresAt > Date.now() + REFRESH_SKEW_MS) {
        return {
          accessToken: lockedCred.accessToken,
          chatgptAccountId: lockedCred.chatgptAccountId,
          generation: startGeneration,
          credential: lockedCred,
          // This credential belongs to a DIFFERENT grant than the flight was opened
          // for. Tagging it keeps a joiner from adopting it as its own.
          ...(lockedRefreshGrantFingerprint !== undefined
            ? { resolvedGrantFingerprint: lockedRefreshGrantFingerprint }
            : {}),
        };
      }
      throw new CodexCredentialGenerationConflictError();
    }
    // Third fence point: waiting for the lock can take long enough for another
    // writer to replace the credential. Under the lock the stored generation is
    // authoritative, so a superseded forced refresh stops here rather than
    // spending a rotation on a credential nobody rejected.
    const forcedStillTargetsStored = forced !== undefined && !forcedFenceSuperseded(startGeneration, forced);
    if (lockedCred.expiresAt > Date.now() + REFRESH_SKEW_MS && !forcedStillTargetsStored) {
      return {
        accessToken: lockedCred.accessToken,
        chatgptAccountId: lockedCred.chatgptAccountId,
        generation: startGeneration,
        credential: lockedCred,
        resolvedGrantFingerprint: refreshGrantFingerprint,
      };
    }
    const sameGrantFreshCredential = findFreshCredentialForGrant(
      refreshGrantFingerprint,
      id,
      lockedCred.chatgptAccountId,
      forced?.rejectedAccessToken,
    );
    if (sameGrantFreshCredential) {
      if (!saveCodexAccountCredentialIfGeneration(id, startGeneration, sameGrantFreshCredential)) {
        throw new CodexCredentialGenerationConflictError();
      }
      return {
        accessToken: sameGrantFreshCredential.accessToken,
        chatgptAccountId: sameGrantFreshCredential.chatgptAccountId,
        generation: startGeneration + 1,
        credential: sameGrantFreshCredential,
        resolvedGrantFingerprint: refreshGrantFingerprint,
        selfRefreshed: true,
      };
    }
    const res = await fetch(CHATGPT_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CHATGPT_CLIENT_ID,
        refresh_token: lockedCred.refreshToken,
      }).toString(),
      signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      let errDesc: string;
      let errCodeExact: string | undefined;
      try {
        const parsed = JSON.parse(errText) as { error?: string; error_description?: string };
        errCodeExact = typeof parsed.error === "string" ? parsed.error.trim() : undefined;
        errDesc = [parsed.error, parsed.error_description].filter(Boolean).join(": ") || `HTTP ${res.status}`;
      } catch { errDesc = `HTTP ${res.status}`; }
      // `invalid_grant` is the standard OAuth code for a refresh token that is no longer
      // usable, and upstream sends it bare with no description. Without it here the dead
      // grant is classified "unknown", which callers treat as transient — so the account
      // is never retired and every request repeats the same doomed refresh (#2887).
      //
      // Matched on the exact `error` CODE, not anywhere in the combined text: a transient
      // `server_error` whose description happens to mention invalid_grant would otherwise
      // retire a healthy account, which is the failure this whole change exists to remove.
      const reason = errCodeExact === "invalid_grant"
          || errDesc.includes("invalidated") || errDesc.includes("revoked") ? "revoked" as const
        : errDesc.includes("expired") ? "expired" as const
        : "unknown" as const;
      throw new TokenRefreshError(reason, `Codex token refresh failed (${reason}); reauthenticate the account.`);
    }
    const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    // Guard against a missing/non-finite/negative expires_in (malformed upstream
    // response): a NaN expiry would never compare as expired, and a negative
    // duration would stamp an already-past expiry — both block refresh semantics.
    const expiresIn =
      typeof data.expires_in === "number" && Number.isFinite(data.expires_in) && data.expires_in >= 0
        ? data.expires_in
        : 3600;
    // The computed timestamp itself must stay finite: Number.MAX_VALUE passes
    // Number.isFinite but overflows to Infinity once multiplied by 1000.
    const expiresAt = Date.now() + expiresIn * 1000;
    const safeExpiresAt = Number.isFinite(expiresAt) ? expiresAt : Date.now() + 3600 * 1000;

    const updated: CodexAccountCredentials = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? lockedCred.refreshToken,
      expiresAt: safeExpiresAt,
      chatgptAccountId: lockedCred.chatgptAccountId,
    };
    if (!saveCodexAccountCredentialIfGeneration(id, startGeneration, updated)) {
      throw new CodexCredentialGenerationConflictError();
    }
    // The grant belongs to the ACCOUNT. Aliases that were idle during this flight still
    // hold the grant upstream has now invalidated, so carry the rotation to them under
    // their own generations before anyone tries to refresh with a dead token.
    const fannedOut = fanOutRotatedRefreshGrant({
      excludeId: id,
      chatgptAccountId: updated.chatgptAccountId,
      previousRefreshGrantFingerprint: refreshGrantFingerprint,
      rotated: updated,
    });
    return {
      accessToken: updated.accessToken,
      chatgptAccountId: updated.chatgptAccountId,
      generation: startGeneration + 1,
      credential: updated,
      // The grant this flight was OPENED for, not the rotated one it produced. Joiners
      // are waiting on that key, and a successful refresh normally rotates the refresh
      // token — tagging the new grant would make every legitimate joiner look foreign.
      resolvedGrantFingerprint: refreshGrantFingerprint,
      selfRefreshed: true,
      ...(fannedOut.length > 0 ? { fannedOutAliases: fannedOut } : {}),
    };
  });
  /*
   * Plan reconciliation belongs to the FLIGHT, not to whichever caller opened it.
   *
   * The flight outlives its initiating caller by design (gap 2): an aborted owner stops
   * waiting while the shared work still runs and still commits the rotated credential.
   * Reconciling the plan only after the owner's caller-scoped wait therefore dropped it
   * whenever that owner walked away, and a same-account joiner returning through the
   * adopt-stored branch does not reconcile either — so a changed `chatgpt_plan_type`
   * stayed invisible in `codexAccounts[].plan` for the life of the process and skewed
   * plan-selected quota projection. Attaching it to the flight runs it exactly once per
   * committed result, for every waiter, including none.
   */
  const refreshPromise = fetchPromise.then(async (result): Promise<CodexRefreshResult> => {
    await notePlanFromRefreshedAccessToken(id, result.accessToken, result.generation);
    // Each alias carried onto the rotated grant reconciles under ITS OWN token and its
    // own generation. Generations are per-alias, so the owner's value must never be
    // reused here.
    for (const alias of result.fannedOutAliases ?? []) {
      await notePlanFromRefreshedAccessToken(alias.id, alias.accessToken, alias.toGeneration);
    }
    return result;
  }).finally(() => {
    if (refreshLocks.get(refreshGrantFingerprint) === flight) refreshLocks.delete(refreshGrantFingerprint);
  });

  flight = { promise: refreshPromise, startedAt: Date.now(), abort };
  refreshLocks.set(refreshGrantFingerprint, flight);
  // The owner waits under its own cancellation too: the flight it opened is already
  // registered, so a joiner that arrives after this caller walks away still receives
  // the committed result.
  const result = await awaitOwnCancellation(refreshPromise, callerSignal);
  return {
    accessToken: result.accessToken,
    chatgptAccountId: result.chatgptAccountId,
    generation: result.generation,
    // Carry the flight's provenance out to the caller: the owner is the one whose CAS
    // produced this generation, and a forced caller needs that to know whether the new
    // credential descends from the one it was holding.
    ...(result.selfRefreshed !== undefined ? { selfRefreshed: result.selfRefreshed } : {}),
    ...(result.resolvedGrantFingerprint !== undefined
      ? { resolvedGrantFingerprint: result.resolvedGrantFingerprint }
      : {}),
  };
}
