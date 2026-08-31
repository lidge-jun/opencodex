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
import { advanceCodexCredentialMutationEpoch } from "./credential-mutation-epoch";
import { CODEX_REFRESH_FLIGHT_CEILING_MS } from "./quota-recovery-timing";

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

function persistCredentialMutation(store: CodexAccountStore): void {
  persist(store);
  advanceCodexCredentialMutationEpoch();
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
    persistCredentialMutation(store);
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
    persistCredentialMutation(store);
    return true;
  });
}

/**
 * Commit a refreshed credential to its owner AND to any record that is provably an untouched
 * duplicate of the pre-refresh credential (#2892 gap 3).
 *
 * A refresh normally rotates the refresh token, and the owner CAS above changes only the owner's
 * record. A second non-deleted record holding the same grant that is not participating in the
 * flight therefore keeps a refresh token upstream has just rotated away. Its next refresh sends a
 * dead grant, and `invalid_grant` classifies as `revoked` — retiring a healthy account because we
 * rotated its grant and never told it.
 *
 * Eligibility is deliberately narrow, and each condition earns its place:
 *
 * - Same pre-refresh grant fingerprint, access token, AND expiry. Anything else means the alias was
 *   updated concurrently, and repairing only its grant while keeping its own access token would
 *   advance a generation without advancing the access-token JWT. `plan-from-token` reads a higher
 *   generation as proof of a newer JWT (that is how JWT plan claims supersede a WHAM observation),
 *   so that combination lets a stale JWT overwrite an authoritative plan. It would also hand a live
 *   forced-refresh joiner back its own 401-rejected bearer: flights are keyed by grant and do not
 *   record participants, so a scan cannot tell a dormant alias from a joiner, and the recursion's
 *   freshness shortcut does not re-compare against the rejected token.
 * - Same `chatgptAccountId` as the owner. A fingerprint is `sha256` of the refresh token and
 *   carries no identity claim; no invariant here guarantees one grant cannot span two account ids,
 *   so identity is compared rather than assumed.
 *
 * The rotated access token, refresh token, and expiry move together, keeping a generation bump
 * meaning what every fence already assumes. `replacedAt` and the validation metadata survive
 * because the probe-lease settlement check accepts only an intact `G → G+1` lineage.
 *
 * One lock acquisition and one `persist` for the owner and every alias: `persist` writes the whole
 * store, so a second pass would open a window in which some records hold the dead grant.
 */
export function commitRefreshedCodexCredentialWithAliases(
  id: string,
  generation: number,
  cred: CodexAccountCredentials,
): { committed: boolean; propagatedAliases: { id: string; generation: number }[] } {
  return withCredentialMutationLockSync(() => {
    const store = loadCodexAccountRecordStore();
    const current = store[id];
    if (!current || current.generation !== generation || current.deletedAt != null || !current.credential) {
      return { committed: false, propagatedAliases: [] };
    }
    const priorCredential = current.credential;
    const priorFingerprint = recordGrantFingerprint(current);
    const refreshGrantFingerprint = priorCredential.refreshToken === cred.refreshToken
      ? current.refreshGrantFingerprint ?? refreshGrantFingerprintForToken(cred.refreshToken)
      : refreshGrantFingerprintForToken(cred.refreshToken);
    store[id] = {
      credential: cred,
      generation: generation + 1,
      refreshGrantFingerprint,
      replacedAt: current.replacedAt,
      ...preservedValidationMetadata(current),
    };

    // Each alias carries its OWN committed generation: aliases need not share one, and the plan
    // reconciliation below is generation-fenced, so an id alone would be reconciled at the wrong fence.
    const propagatedAliases: { id: string; generation: number }[] = [];
    // Nothing to propagate when the grant did not actually rotate: the aliases already hold it.
    // An absent owner identity fails closed: two empty strings compare equal but prove nothing about
    // which upstream account either record was meant to use, and a matching bearer snapshot only
    // shows they copied the same token once. Leave those dormant records alone.
    if (
      priorFingerprint !== undefined
      && priorCredential.refreshToken !== cred.refreshToken
      && !!priorCredential.chatgptAccountId
    ) {
      for (const [aliasId, alias] of Object.entries(store)) {
        if (aliasId === id || alias.deletedAt != null || !alias.credential) continue;
        if (recordGrantFingerprint(alias) !== priorFingerprint) continue;
        if (alias.credential.accessToken !== priorCredential.accessToken) continue;
        if (alias.credential.expiresAt !== priorCredential.expiresAt) continue;
        if (!alias.credential.chatgptAccountId) continue;
        if (alias.credential.chatgptAccountId !== priorCredential.chatgptAccountId) continue;
        const aliasGeneration = alias.generation + 1;
        store[aliasId] = {
          // The alias keeps its OWN chatgptAccountId value, which the guard above proved equal.
          credential: { ...cred, chatgptAccountId: alias.credential.chatgptAccountId },
          generation: aliasGeneration,
          refreshGrantFingerprint,
          replacedAt: alias.replacedAt,
          ...preservedValidationMetadata(alias),
        };
        propagatedAliases.push({ id: aliasId, generation: aliasGeneration });
      }
    }
    persistCredentialMutation(store);
    return { committed: true, propagatedAliases };
  });
}

export function tombstoneCodexAccount(id: string): number {
  return withCredentialMutationLockSync(() => {
    const store = loadCodexAccountRecordStore();
    const current = store[id];
    const generation = (current?.generation ?? 0) + 1;
    store[id] = { generation, deletedAt: Date.now() };
    persistCredentialMutation(store);
    return generation;
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
   * Records that adopted this refresh's rotated credential through same-grant propagation, each
   * with its own committed generation (#2892 gap 3). Carried on the result so the flight settles
   * every plan in one place rather than the commit doing its own (#2933).
   */
  propagatedAliases?: { id: string; generation: number }[];
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
   * Three-way form of {@link selfRefreshed}, kept alongside it so existing callers are
   * unaffected (#3019). `selfRefreshed` is `provenance === "self-refresh"`.
   */
  provenance?: CodexRefreshProvenance;
};

/**
 * How THIS caller arrived at the credential it is returning (#3019).
 *
 * `selfRefreshed` is a boolean, and a boolean cannot carry three cases. Its `false` means
 * both "somebody else replaced the credential" and "I joined an in-flight refresh of the
 * same grant and adopted its result" — and a recovery budget has to treat those opposite
 * ways. Joining is the same lineage getting its one refresh; replacement is a NEW lineage
 * that has not had one yet, and charging it for somebody else's attempt would deny the
 * fresh credential the recovery this exists to grant.
 */
export type CodexRefreshProvenance = "self-refresh" | "joined-lineage" | "external-replacement";

/** Terminal outcome of one forced refresh, as seen by the caller that requested it. */
export type ForcedRefreshOutcome =
  | { kind: "resolved"; provenance: CodexRefreshProvenance; generation: number; rotated: boolean }
  | { kind: "failed"; error: unknown };
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
  rejectedAccessToken?: string,
  expectedChatgptAccountId?: string,
): CodexAccountCredentials | null {
  const now = Date.now();
  const records = loadCodexAccountRecordStore();
  // Adoption copies another record's access AND refresh tokens onto the caller, so the two records
  // must be the same upstream identity. A grant fingerprint is `sha256` of the refresh token and
  // carries no identity claim, and nothing here guarantees one grant cannot span two accounts, so
  // require both ids to be present and exactly equal rather than inferring identity from the grant.
  if (!expectedChatgptAccountId) return null;
  for (const [candidateId, candidate] of Object.entries(records)) {
    if (candidateId === excludeId || candidate.deletedAt != null || !candidate.credential) continue;
    if (recordGrantFingerprint(candidate) !== refreshGrantFingerprint) continue;
    if (!candidate.credential.chatgptAccountId) continue;
    if (candidate.credential.chatgptAccountId !== expectedChatgptAccountId) continue;
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
  options: {
    rejectedGeneration: number;
    rejectedAccessToken: string;
    signal?: AbortSignal;
    /**
     * Fires with THIS caller's classified outcome, regardless of `signal` (#3019).
     *
     * Cancellation rejects what the caller awaits; the shared flight keeps running and
     * commits. A recovery budget claimed before the refresh therefore has no one left to
     * settle it — the claim expires and the already-refreshed lineage gets a second
     * refresh, which is the loop the budget exists to close. This callback is attached to
     * the resolution itself, so it fires with no waiter present.
     *
     * It is called exactly once per call, for both success and failure, and its own
     * failures are swallowed: settlement bookkeeping must never reject a credential the
     * caller successfully obtained, nor disturb another waiter on the same flight.
     */
    onSettled?: (outcome: ForcedRefreshOutcome) => void | Promise<void>;
  },
): Promise<CodexTokenResult & { rotated: boolean; selfRefreshed: boolean; provenance: CodexRefreshProvenance }> {
  const settle = (outcome: ForcedRefreshOutcome) => {
    // Both halves matter: a synchronous throw and a rejected thenable are equally capable
    // of turning settlement bookkeeping into an unhandled rejection that fails the process.
    try { void Promise.resolve(options.onSettled?.(outcome)).catch(() => {}); } catch { /* ignore */ }
  };
  const classify = (result: CodexRefreshResult): CodexRefreshProvenance =>
    // Default to the conservative reading. A path that did not classify itself is not
    // assumed to be this caller's own lineage: charging a replacement for somebody else's
    // attempt is the failure mode, so an unlabelled path leaves the returned lineage its
    // own budget.
    result.provenance ?? (result.selfRefreshed === true ? "self-refresh" : "external-replacement");

  // The completion is NOT the caller's await.
  //
  // `options.signal` cancels what this function returns, while the shared flight keeps
  // running and commits. Settling from the cancelled await therefore reported "failed" for
  // a refresh that was about to succeed — releasing the budget, and letting the newly
  // refreshed lineage claim again moments later. So the settlement rides an uncancelled
  // resolution and the caller's cancellation is layered on top of it.
  // A caller that is already gone must not start work. `resolveCodexToken` is called
  // without the caller signal below, which bypasses its own pre-abort guard, so a
  // pre-aborted request would otherwise rotate a credential nobody is waiting for.
  if (options.signal?.aborted) {
    settle({ kind: "failed", error: options.signal.reason });
    throw options.signal.reason;
  }
  const completion = resolveCodexToken(
    id,
    { rejectedGeneration: options.rejectedGeneration, rejectedAccessToken: options.rejectedAccessToken },
    // Deliberately no caller signal: the flight is shared and this settlement speaks for
    // the credential, not for whoever happened to be waiting.
    undefined,
  );
  completion.then(
    resolved => settle({
      kind: "resolved",
      provenance: classify(resolved),
      generation: resolved.generation,
      rotated: resolved.accessToken !== options.rejectedAccessToken,
    }),
    error => settle({ kind: "failed", error }),
  );
  const result = await awaitOwnCancellation(completion, options.signal);
  const provenance = classify(result);
  const rotated = result.accessToken !== options.rejectedAccessToken;
  return {
    accessToken: result.accessToken,
    chatgptAccountId: result.chatgptAccountId,
    generation: result.generation,
    rotated,
    // Only a CAS this call performed itself proves the new credential descends from the
    // rejected one; anything else is somebody else's replacement and must not be treated
    // as this request's own lineage.
    selfRefreshed: provenance === "self-refresh",
    provenance,
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
    // The freshness shortcut: nothing was refreshed and nothing was adopted. A forced
    // caller reaches it only once its fence was superseded, which is a replacement by
    // definition; an ordinary caller does not read this field.
    return {
      accessToken: cred.accessToken,
      chatgptAccountId: cred.chatgptAccountId,
      generation: record.generation,
      provenance: "external-replacement",
    };
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
            // Adopted the stored result of a flight this caller joined: same grant, same
            // lineage. Not a replacement — that distinction is the whole point of #3019.
            //
            // Only `external-replacement` is inherited. The flight's own success is tagged
            // `self-refresh` for the caller that performed the CAS, and copying that here
            // would tell a caller that did no CAS that the credential is its own lineage.
            // Everything this branch adopts is, by definition, a join.
            provenance: refreshed.provenance === "external-replacement" ? "external-replacement" : "joined-lineage",
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
          // `forcedFenceSuperseded` is exactly "somebody else moved this credential past
          // the generation I was holding" — a new lineage, entitled to its own budget.
          provenance: "external-replacement",
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
          provenance: "self-refresh",
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
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(CODEX_REFRESH_FLIGHT_CEILING_MS)]);
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
          // It is also somebody else's credential by definition, so a joiner that ends up
          // adopting it must not charge it to this lineage's budget (#3019).
          provenance: "external-replacement",
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
        // The stored credential is fresh and no forced fence still targets it: whoever
        // wrote it, it was not this call. A joiner adopting it inherits that provenance.
        provenance: "external-replacement",
        resolvedGrantFingerprint: refreshGrantFingerprint,
      };
    }
    const sameGrantFreshCredential = findFreshCredentialForGrant(
      refreshGrantFingerprint,
      id,
      forced?.rejectedAccessToken,
      lockedCred.chatgptAccountId,
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
        provenance: "self-refresh",
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
    // Commit to the owner and, in the same write, to any record that is still an untouched
    // duplicate of the credential this flight started from (#2892 gap 3). Without this the rotated
    // grant reaches only the owner and live joiners, and a dormant same-grant record is left
    // holding a refresh token upstream has invalidated.
    const commit = commitRefreshedCodexCredentialWithAliases(id, startGeneration, updated);
    if (!commit.committed) {
      throw new CodexCredentialGenerationConflictError();
    }
    if (commit.propagatedAliases.length > 0) {
      console.warn(`[codex-auth] rotated refresh grant propagated to ${commit.propagatedAliases.length} dormant same-grant account record(s)`);
    }
    return {
      accessToken: updated.accessToken,
      chatgptAccountId: updated.chatgptAccountId,
      generation: startGeneration + 1,
      credential: updated,
      // Aliases that adopted this rotated credential travel on the result so the FLIGHT settles
      // their plans in the same single place as the owner's (#2933). Each carries its own committed
      // generation because the plan note is generation-fenced.
      ...(commit.propagatedAliases.length > 0 ? { propagatedAliases: commit.propagatedAliases } : {}),
      // The grant this flight was OPENED for, not the rotated one it produced. Joiners
      // are waiting on that key, and a successful refresh normally rotates the refresh
      // token — tagging the new grant would make every legitimate joiner look foreign.
      resolvedGrantFingerprint: refreshGrantFingerprint,
      selfRefreshed: true,
      provenance: "self-refresh",
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
    // One settlement path for the whole flight: the refreshing account, then any dormant alias that
    // adopted the same rotated JWT. An alias holds the identical access token, so a changed
    // `chatgpt_plan_type` applies to it too, and its cached-token fast path would never reconcile it.
    for (const alias of result.propagatedAliases ?? []) {
      await notePlanFromRefreshedAccessToken(alias.id, result.accessToken, alias.generation);
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
    // Provenance rides out with the rest: a joiner that adopts this result needs the
    // flight's own classification, not a guess made at the adoption site (#3019).
    ...(result.provenance !== undefined ? { provenance: result.provenance } : {}),
    ...(result.resolvedGrantFingerprint !== undefined
      ? { resolvedGrantFingerprint: result.resolvedGrantFingerprint }
      : {}),
  };
}
