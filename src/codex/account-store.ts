import { readOrcaAuthSource } from "./orca-auth-source";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, readFileSync, mkdirSync, openSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
import { isValidCodexAccountId } from "./account-id";
import type { PoolQuotaWriter } from "./quota-types";
import { CODEX_REFRESH_FLIGHT_CEILING_MS } from "./quota-recovery-timing";

import {
  CodexPoolRefreshCooldownError,
  clearCodexPoolRefreshFailure,
  codexPoolRefreshFence,
  isCodexPoolRefreshCooling,
  noteCodexPoolRefreshFailure,
} from "./pool-refresh-backoff";

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
  const hasNoSource = isObject(value)
    && value.sourceAuthPath === undefined
    && value.sourceSubject === undefined;
  const hasCompleteSource = isObject(value)
    && typeof value.sourceAuthPath === "string"
    && value.sourceAuthPath.length > 0
    && typeof value.sourceSubject === "string"
    && value.sourceSubject.length > 0;
  return isObject(value)
    && typeof value.accessToken === "string"
    && typeof value.refreshToken === "string"
    && typeof value.expiresAt === "number"
    && typeof value.chatgptAccountId === "string"
    && (hasNoSource || hasCompleteSource);
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
    && (value.lastCodexValidationError === undefined || typeof value.lastCodexValidationError === "string")
    && (value.codexValidationPending === undefined || typeof value.codexValidationPending === "boolean")
    && (value.lastCodexValidationTerminal === undefined || typeof value.lastCodexValidationTerminal === "boolean");
}

export function refreshGrantFingerprintForToken(refreshToken: string): string {
  return createHash("sha256").update(`codex-refresh-grant:${refreshToken}`).digest("hex");
}

function recordGrantFingerprint(record: CodexAccountCredentialRecord): string | undefined {
  if (record.credential?.sourceAuthPath) return undefined;
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

/**
 * Validation metadata that survives a credential write.
 *
 * `lastCodexValidationTerminal` is deliberately NOT in this list. Every credential write —
 * re-login, the CAS refresh commit, same-grant alias propagation — rebuilds the record from this
 * pick list, so leaving the marker out is what makes a successful refresh or a re-authentication
 * erase a terminal verdict. Both events disprove "the grant was revoked", and a verdict that
 * could only ever be set would brand an account dead forever on one spurious `invalid_grant`.
 */
function preservedValidationMetadata(record: CodexAccountCredentialRecord | undefined): Pick<
  CodexAccountCredentialRecord,
  "lastCodexValidatedAt" | "lastCodexValidationStatus" | "lastCodexValidationError" | "codexValidationPending"
> {
  return {
    ...(record?.codexValidationPending === true ? { codexValidationPending: true } : {}),
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

export function saveCodexAccountCredential(
  id: string,
  cred: CodexAccountCredentials,
  options: { validationPending?: boolean } = {},
): number {
  return withCredentialMutationLockSync(() => {
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
      quotaHistoryIdentity: crypto.randomUUID(),
      ...preservedValidationMetadata(current),
      ...(options.validationPending ? {
        codexValidationPending: true,
        lastCodexValidatedAt: undefined,
        lastCodexValidationStatus: undefined,
        lastCodexValidationError: undefined,
      } : {}),
    };
    persistCredentialMutation(store);
    return store[id].generation;
  });
}

export function markCodexAccountValidated(id: string, atMs: number = Date.now(), generation?: number): void {
  withCredentialMutationLockSync(() => {
    const store = loadCodexAccountRecordStore();
    const current = store[id];
    if (!current || current.deletedAt != null || !current.credential) return;
    if (current.codexValidationPending && generation === undefined) return;
    if (generation !== undefined && current.generation !== generation) return;
    store[id] = {
      ...current,
      lastCodexValidatedAt: atMs,
      lastCodexValidationStatus: "ok",
      lastCodexValidationError: undefined,
      codexValidationPending: undefined,
      // A completed validation is the direct refutation of a terminal verdict, and this
      // spread would otherwise carry the old marker forward.
      lastCodexValidationTerminal: undefined,
    };
    // Becoming routable invalidates credential-derived caches; a timestamp-only
    // update on an already validated account preserves the existing epoch policy.
    if (current.codexValidationPending) persistCredentialMutation(store);
    else persist(store);
  });
}

export interface MarkCodexAccountValidationFailedOptions {
  /**
   * Write only while the stored record is still at this generation.
   *
   * A validation attempt is not atomic with the store: an operator can re-authenticate the
   * account, or another writer can commit a refresh, while a probe is still in flight. Without
   * this fence the late failure lands on whatever credential happens to be there and brands a
   * freshly installed one dead. Declining to write is the safe direction — the failure cannot be
   * attributed to a credential the caller never observed.
   */
  expectedGeneration?: number;
  /** The grant itself is revoked or expired; only a re-login clears it. */
  terminal?: boolean;
}

/** Returns whether the verdict was actually persisted (false when the fence declined it). */
export function markCodexAccountValidationFailed(
  id: string,
  reason: string,
  options: MarkCodexAccountValidationFailedOptions = {},
): boolean {
  return withCredentialMutationLockSync(() => {
    const store = loadCodexAccountRecordStore();
    const current = store[id];
    if (!current || current.deletedAt != null || !current.credential) return false;
    // Deferred validation is settled only by a caller that names the generation it observed.
    // An unfenced write must never resolve a pending account, whichever verdict it carries.
    if (current.codexValidationPending && options.expectedGeneration === undefined) return false;
    if (options.expectedGeneration !== undefined && current.generation !== options.expectedGeneration) {
      return false;
    }
    store[id] = {
      ...current,
      lastCodexValidationStatus: "failed",
      lastCodexValidationError: reason,
      // Only ever set here. A transient failure must not clear a terminal marker set earlier,
      // and it must not invent one either, so the flag is written only when the caller proves
      // the grant is dead.
      ...(options.terminal ? { lastCodexValidationTerminal: true } : {}),
    };
    persist(store);
    return true;
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

/**
 * One store load, every record, for a caller that resolves MANY ids in a single synchronous pass.
 *
 * `readCodexAccountRecord` reloads, reparses and renormalizes the whole file per id. That is the
 * right shape for one lookup and the wrong shape for a loop: the entitlement denial reader holds
 * up to 64 accounts with four client versions each, so scoring one warm flagship request could
 * perform up to 256 full-store reads on the request path.
 *
 * These are the same normalized records `readCodexAccountRecord` hands out, tombstones included,
 * so the caller keeps its own `deletedAt` and `generation` checks instead of trusting a filtered
 * view. That is the difference from `loadCodexAccountStore`, which drops both and cannot answer a
 * question about credential generation.
 */
export function loadCodexAccountRecordSnapshot(): Readonly<Record<string, CodexAccountCredentialRecord>> {
  return loadCodexAccountRecordStore();
}

const QUOTA_HISTORY_IDENTITY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function validQuotaHistoryIdentity(value: unknown): value is string {
  return typeof value === "string" && QUOTA_HISTORY_IDENTITY_RE.test(value);
}

type DispatchedPoolCredential = Pick<CodexAccountCredentials, "accessToken" | "chatgptAccountId"> & { generation: number };

function matchesDispatchedPoolCredential(record: CodexAccountCredentialRecord | undefined | null, dispatched: DispatchedPoolCredential): record is CodexAccountCredentialRecord & { credential: CodexAccountCredentials } {
  return !!record?.credential && record.deletedAt == null
    && dispatched.accessToken.length > 0 && dispatched.chatgptAccountId.length > 0
    && Number.isSafeInteger(dispatched.generation) && dispatched.generation >= 0
    && record.generation === dispatched.generation
    && record.credential.accessToken === dispatched.accessToken
    && record.credential.chatgptAccountId === dispatched.chatgptAccountId;
}

/** Optional evidence capture; a stale credential or unavailable store never gains a new writer. */
export function capturePoolQuotaWriter(accountId: string, dispatched: DispatchedPoolCredential): PoolQuotaWriter | undefined {
  if (!isValidCodexAccountId(accountId)) return undefined;
  try {
    const current = readCodexAccountRecord(accountId);
    if (!matchesDispatchedPoolCredential(current, dispatched)) return undefined;
    if (validQuotaHistoryIdentity(current.quotaHistoryIdentity)) {
      return { accountId, credentialGeneration: dispatched.generation, historyIdentity: current.quotaHistoryIdentity };
    }
    return withCredentialMutationLockSync(() => {
      const store = loadCodexAccountRecordStore();
      const locked = store[accountId];
      if (!matchesDispatchedPoolCredential(locked, dispatched)) return undefined;
      if (!validQuotaHistoryIdentity(locked.quotaHistoryIdentity)) {
        locked.quotaHistoryIdentity = crypto.randomUUID();
        // Identity metadata is not a new credential; preserve generation and mutation epoch.
        persist(store);
      }
      return { accountId, credentialGeneration: dispatched.generation, historyIdentity: locked.quotaHistoryIdentity };
    });
  } catch {
    // History is optional evidence. Permission, lock and disk errors cannot fail inference.
    return undefined;
  }
}

/** Read-only retention identity; unlike capture this never initializes legacy metadata. */
export function poolQuotaHistoryIdentity(accountId: string): string | undefined {
  if (!isValidCodexAccountId(accountId)) return undefined;
  try {
    const record = readCodexAccountRecord(accountId);
    return record?.credential && record.deletedAt == null && validQuotaHistoryIdentity(record.quotaHistoryIdentity)
      ? record.quotaHistoryIdentity : undefined;
  } catch {
    return undefined;
  }
}

/** Recheck append admission after upstream I/O; refresh may retire a writer without erasing history. */
export function isPoolQuotaWriterLive(writer: PoolQuotaWriter): boolean {
  if (!isValidCodexAccountId(writer.accountId)) return false;
  try {
    const record = readCodexAccountRecord(writer.accountId);
    return !!record?.credential && record.deletedAt == null
      && record.generation === writer.credentialGeneration
      && validQuotaHistoryIdentity(writer.historyIdentity)
      && record.quotaHistoryIdentity === writer.historyIdentity;
  } catch {
    return false;
  }
}

export function isCodexAccountGenerationLive(id: string, generation: number): boolean {
  const record = readCodexAccountRecord(id);
  return !!record?.credential && record.deletedAt == null && record.generation === generation;
}

/**
 * The same verdict as {@link isCodexAccountGenerationLive}, over ONE store load.
 *
 * `readCodexAccountRecord` is `loadCodexAccountRecordStore()[id]`, so asking it per row
 * reloads, reparses and renormalizes the whole file per row — the exact shape
 * {@link loadCodexAccountRecordSnapshot} was added to avoid. The denial reader resolves
 * several accounts in one synchronous pass on the request path, so it opens one checker and
 * closes over the snapshot instead.
 */
export function beginCodexAccountGenerationLiveCheck(): (id: string, generation: number) => boolean {
  const snapshot = loadCodexAccountRecordSnapshot();
  return (id, generation) => {
    const record = snapshot[id];
    return !!record?.credential && record.deletedAt == null && record.generation === generation;
  };
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
      quotaHistoryIdentity: current.credential.chatgptAccountId === cred.chatgptAccountId
        ? current.quotaHistoryIdentity : crypto.randomUUID(),
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
    if (!current || current.generation !== generation || current.deletedAt != null || !current.credential || current.credential.sourceAuthPath) {
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
      quotaHistoryIdentity: current.credential.chatgptAccountId === cred.chatgptAccountId
        ? current.quotaHistoryIdentity : crypto.randomUUID(),
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
      && priorCredential.chatgptAccountId === cred.chatgptAccountId
    ) {
      for (const [aliasId, alias] of Object.entries(store)) {
        if (aliasId === id || alias.deletedAt != null || !alias.credential || alias.credential.sourceAuthPath) continue;
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
          quotaHistoryIdentity: alias.quotaHistoryIdentity,
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

/**
 * The stored record or its refresh-grant fingerprint is gone. Retrying cannot
 * conjure a missing credential, so callers must treat this as terminal.
 */
export class CodexCredentialUnavailableError extends Error {
  constructor(message = "Codex account credential is unavailable; reauthenticate the account.") {
    super(message);
    this.name = "CodexCredentialUnavailableError";
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

/**
 * Terminal means the grant itself is dead, or there is no grant to refresh.
 * Token-endpoint 5xx (`unknown`) and a generation CAS loss stay transient
 * because those genuinely may clear (#2887).
 */
export function isTerminalCodexPoolRefreshFailure(error: unknown): boolean {
  return (error instanceof TokenRefreshError && (error.reason === "revoked" || error.reason === "expired"))
    || error instanceof CodexCredentialUnavailableError;
}

function isOperationalCodexPoolRefreshFailure(error: unknown): boolean {
  if (error instanceof CodexPoolRefreshCooldownError) return true;
  if (error instanceof CodexCredentialRefreshBusyError) return true;
  if (error instanceof CodexCredentialRefreshStaleError) return true;
  if (error instanceof CodexCredentialRefreshLockTimeoutError) return true;
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function classifyCodexPoolRefreshFailureReason(error: unknown): string {
  if (error instanceof TokenRefreshError) return error.reason;
  if (error instanceof CodexCredentialGenerationConflictError) return "generation_conflict";
  return "network";
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
type CodexRefreshGenerationHandoff = (accountId: string, fromGeneration: number, toGeneration: number) => void;
// var (hoisted, initialized to undefined) rather than const: a registrar reached
// through an import cycle can register while this module body is still evaluating,
// and the lazily created Set must be reachable rather than in the temporal dead zone.
var refreshGenerationHandoffs: Set<CodexRefreshGenerationHandoff> | undefined;
function refreshHandoffs(): Set<CodexRefreshGenerationHandoff> {
  return refreshGenerationHandoffs ??= new Set();
}

/** Register process-local state that must follow a credential refresh generation. */
export function registerCodexRefreshGenerationHandoff(handoff: CodexRefreshGenerationHandoff): () => void {
  const set = refreshHandoffs();
  set.add(handoff);
  return () => set.delete(handoff);
}

/**
 * Invoke every registered handoff for one committed `fromGeneration` to `toGeneration` move.
 *
 * Each listener runs independently and a throw is contained: by the time handoffs run the
 * rotated credential is already persisted, so a failing listener must not reject the shared
 * refresh promise (surviving waiters would see a refresh failure that never happened), must
 * not starve the remaining listeners, and must not block plan reconciliation. The warning
 * carries no account id or token material — the same scrub refresh error messages get.
 */
function dispatchRefreshGenerationHandoffs(accountId: string, fromGeneration: number, toGeneration: number): void {
  for (const handoff of refreshHandoffs()) {
    try {
      handoff(accountId, fromGeneration, toGeneration);
    } catch (error) {
      console.warn("[codex-auth] a refresh generation handoff listener failed", error);
    }
  }
}

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
  | {
      kind: "resolved";
      provenance: CodexRefreshProvenance;
      generation: number;
      rotated: boolean;
      /** Same-grant records advanced by this refresh, at their committed generations. */
      propagatedAliases?: { id: string; generation: number }[];
    }
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
    // The owner creates the file and writes its metadata in two steps, so a live lock is
    // briefly unreadable. Age the file itself instead of calling that window stale, which
    // let a waiter delete a lock whose owner was still inside its critical section.
    try {
      return Date.now() - statSync(path).mtimeMs > REFRESH_LOCK_STALE_MS;
    } catch {
      return false;
    }
  }
}

function releaseCodexRefreshFileLock(path: string, fd: number): void {
  let owned: { dev: bigint; ino: bigint } | null = null;
  try {
    const info = fstatSync(fd, { bigint: true });
    if (info.dev >= 0n && info.ino > 0n) owned = { dev: info.dev, ino: info.ino };
  } catch { /* Unknown descriptor identity never authorizes unlink. */ }
  try {
    withConfigMutationLockSync(() => {
      let current: { dev: bigint; ino: bigint } | null = null;
      try {
        const info = statSync(path, { bigint: true });
        if (info.dev >= 0n && info.ino > 0n) current = { dev: info.dev, ino: info.ino };
      } catch { /* Keep the lock and the callback outcome when the path probe fails. */ }
      if (owned && current && current.dev === owned.dev && current.ino === owned.ino) {
        try { unlinkSync(path); } catch (err) {
          if (errCode(err) !== "ENOENT") throw err;
        }
      }
    });
  } catch (err) {
    // Keep the descriptor alive through comparison/unlink so its inode cannot be recycled.
    // Unavailable coordination leaves the path without masking the completed refresh.
    if (!(err instanceof ConfigMutationLockError)) throw err;
  } finally { closeSync(fd); }
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
      // Serialize only metadata operations, never the async refresh callback. Cooperating
      // contenders cannot reclaim a successor between stale observation and path mutation.
      withConfigMutationLockSync(() => {
        try {
          fd = openSync(path, "wx", 0o600);
          writeFileSync(fd, JSON.stringify({ acquiredAt: Date.now(), pid: process.pid }) + "\n");
        } catch (err) {
          if (fd != null) {
            const failedFd = fd;
            fd = null;
            try { releaseCodexRefreshFileLock(path, failedFd); } catch { /* Preserve write failure. */ }
            throw err;
          }
          if (errCode(err) !== "EEXIST") throw err;
          if (isRefreshLockStale(path)) {
            try { unlinkSync(path); } catch (unlinkErr) {
              if (errCode(unlinkErr) !== "ENOENT") throw unlinkErr;
            }
          }
        }
      });
    } catch (err) {
      // A failed SQLite commit can follow successful file creation; it still owns an fd.
      if (fd != null) {
        const failedFd = fd;
        fd = null;
        try { releaseCodexRefreshFileLock(path, failedFd); } catch { /* Preserve admission failure. */ }
      }
      if (!(err instanceof ConfigMutationLockError)) throw err;
    }
    if (fd != null) break;
    if (Date.now() >= deadline) throw new CodexCredentialRefreshLockTimeoutError();
    await sleep(REFRESH_LOCK_POLL_MS, signal);
  }

  try {
    return await fn();
  } finally {
    releaseCodexRefreshFileLock(path, fd);
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
    if (candidateId === excludeId || candidate.deletedAt != null || !candidate.credential || candidate.credential.sourceAuthPath) continue;
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
  if (isCodexPoolRefreshCooling(id)) {
    const error = new CodexPoolRefreshCooldownError();
    settle({ kind: "failed", error });
    throw error;
  }
  const completion = resolveCodexToken(
    id,
    { rejectedGeneration: options.rejectedGeneration, rejectedAccessToken: options.rejectedAccessToken },
    // Deliberately no caller signal: the flight is shared and this settlement speaks for
    // the credential, not for whoever happened to be waiting.
    undefined,
  );
  // Captured before the flight settles, spent only if it fails. A reauthentication that lands
  // while this is in the air replaces the grant and clears its failures; this fence is how the
  // late failure knows it is talking about a credential that no longer exists.
  const refreshFence = codexPoolRefreshFence(id);
  completion.then(
    resolved => {
      clearCodexPoolRefreshFailure(id);
      settle({
        kind: "resolved",
        provenance: classify(resolved),
        generation: resolved.generation,
        rotated: resolved.accessToken !== options.rejectedAccessToken,
        ...(resolved.propagatedAliases?.length
          ? { propagatedAliases: resolved.propagatedAliases }
          : {}),
      });
    },
    error => {
      if (isTerminalCodexPoolRefreshFailure(error) || isOperationalCodexPoolRefreshFailure(error)) {
        if (isTerminalCodexPoolRefreshFailure(error)) clearCodexPoolRefreshFailure(id);
      } else {
        noteCodexPoolRefreshFailure(id, classifyCodexPoolRefreshFailureReason(error), undefined, refreshFence);
      }
      settle({ kind: "failed", error });
    },
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

export async function getValidCodexToken(
  id: string,
  options: { signal?: AbortSignal } = {},
): Promise<CodexTokenResult> {
  // Cancellation ends THIS caller's wait. A shared refresh already in flight keeps running for
  // whoever else awaits it, which is what `awaitOwnCancellation` inside the resolver preserves.
  const result = await resolveCodexToken(id, undefined, options.signal);
  return {
    accessToken: result.accessToken,
    chatgptAccountId: result.chatgptAccountId,
    generation: result.generation,
  };
}

/** Source credentials never join refresh flights or spend a refresh grant, including after 401. */
function resolveOrcaSourceToken(id: string, forced?: ForcedRefreshFence): CodexRefreshResult {
  const initial = readCodexAccountRecord(id);
  const initialCredential = initial?.credential;
  if (!initial || initial.deletedAt != null || !initialCredential?.sourceAuthPath || !initialCredential.sourceSubject) {
    throw new CodexCredentialGenerationConflictError();
  }
  const sourceCredential = readOrcaAuthSource(initialCredential.sourceAuthPath);
  if (sourceCredential.chatgptAccountId !== initialCredential.chatgptAccountId
    || sourceCredential.sourceSubject !== initialCredential.sourceSubject) {
    throw new Error("Orca credential identity changed; reimport the account explicitly.");
  }
  if (sourceCredential.accessToken === initialCredential.accessToken
    && sourceCredential.expiresAt === initialCredential.expiresAt) {
    if (forced?.rejectedAccessToken === sourceCredential.accessToken) {
      throw new Error("Orca bearer was rejected; update the account in Orca and retry.");
    }
    return { accessToken: sourceCredential.accessToken, chatgptAccountId: sourceCredential.chatgptAccountId,
      generation: initial.generation, provenance: "external-replacement" };
  }

  return withCredentialMutationLockSync(() => {
    const store = loadCodexAccountRecordStore();
    const record = store[id];
    const prior = record?.credential;
    if (!record || record.deletedAt != null || !prior?.sourceAuthPath || !prior.sourceSubject) {
      throw new CodexCredentialGenerationConflictError();
    }
    if (record.generation !== initial.generation) throw new CodexCredentialGenerationConflictError();
    const credential = readOrcaAuthSource(prior.sourceAuthPath);
    if (credential.chatgptAccountId !== prior.chatgptAccountId || credential.sourceSubject !== prior.sourceSubject) {
      throw new Error("Orca credential identity changed; reimport the account explicitly.");
    }
    if (credential.accessToken !== prior.accessToken || credential.expiresAt !== prior.expiresAt) {
      store[id] = {
        credential, generation: record.generation + 1, replacedAt: Date.now(),
        // The source identity was checked above. Retire old-generation writers without
        // splitting this same account's retained quota history on every source rotation.
        quotaHistoryIdentity: record.quotaHistoryIdentity,
        ...preservedValidationMetadata(record),
      };
      persistCredentialMutation(store);
    }
    if (forced?.rejectedAccessToken === credential.accessToken) {
      throw new Error("Orca bearer was rejected; update the account in Orca and retry.");
    }
    return { accessToken: credential.accessToken, chatgptAccountId: credential.chatgptAccountId,
      generation: store[id]!.generation, provenance: "external-replacement" };
  });
}

async function resolveCodexToken(
  id: string,
  forced?: ForcedRefreshFence,
  callerSignal?: AbortSignal,
): Promise<CodexRefreshResult> {
  if (callerSignal?.aborted) throw callerSignal.reason;
  const record = readCodexAccountRecord(id);
  const cred = record?.deletedAt == null ? record?.credential : undefined;
  if (!record || !cred) throw new CodexCredentialUnavailableError();
  if (cred.sourceAuthPath) return resolveOrcaSourceToken(id, forced);
  const refreshGrantFingerprint = recordGrantFingerprint(record);
  if (!refreshGrantFingerprint) throw new CodexCredentialUnavailableError();

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
      if (currentCred?.sourceAuthPath) return resolveOrcaSourceToken(id, forced);
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
    if (lockedCred.sourceAuthPath) return resolveOrcaSourceToken(id, forced);
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
        const parsed = JSON.parse(errText) as {
          error?: string | { code?: string; message?: string };
          error_description?: string;
        };
        if (typeof parsed.error === "string") {
          errCodeExact = parsed.error.trim();
          errDesc = [parsed.error, parsed.error_description].filter(Boolean).join(": ");
        } else if (parsed.error && typeof parsed.error === "object") {
          errCodeExact = typeof parsed.error.code === "string" ? parsed.error.code.trim() : undefined;
          errDesc = [parsed.error.code, parsed.error.message, parsed.error_description].filter(Boolean).join(": ");
        } else {
          errDesc = parsed.error_description || `HTTP ${res.status}`;
        }
        if (!errDesc) errDesc = `HTTP ${res.status}`;
      } catch { errDesc = `HTTP ${res.status}`; }
      // `invalid_grant` is the standard OAuth code for a refresh token that is no longer
      // usable, and upstream sends it bare with no description. Without it here the dead
      // grant is classified "unknown", which callers treat as transient — so the account
      // is never retired and every request repeats the same doomed refresh (#2887).
      //
      // Matched on the exact `error` CODE, not anywhere in the combined text: a transient
      // `server_error` whose description happens to mention invalid_grant would otherwise
      // retire a healthy account, which is the failure this whole change exists to remove.
      //
      // That rule binds the DESCRIPTION words too. "invalidated", "revoked" and "expired" read
      // as terminal prose, but upstream puts arbitrary text there: a `server_error` whose
      // description says "token was revoked" or "session expired" is still a 5xx blip, and
      // retiring the account on it is exactly the false quarantine #2887 exists to prevent.
      // So a body that carries a structured code is classified by that code ALONE. The
      // substring fallback survives only where there is no structured code to read at all --
      // a description-only body, or one this parser could not decode -- because there the
      // prose is the only signal upstream gave us.
      const structuredCode = errCodeExact ? errCodeExact : undefined;
      const proseIsOnlySignal = structuredCode === undefined;
      const reason = structuredCode === "invalid_grant"
          || structuredCode === "refresh_token_invalidated"
          || (proseIsOnlySignal
            && (errDesc.includes("invalidated") || errDesc.includes("revoked"))) ? "revoked" as const
        : structuredCode === "refresh_token_expired"
          || (proseIsOnlySignal && errDesc.includes("expired")) ? "expired" as const
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
    // Generation-dependent completion belongs to the flight, not to its initiating
    // request. The owner may stop waiting after a disconnect while this detached work
    // still commits G+1; advance process-local affinities before any waiter observes
    // the result (and even when there are no surviving waiters).
    if (result.selfRefreshed) {
      dispatchRefreshGenerationHandoffs(id, result.generation - 1, result.generation);
      // A propagated alias committed at its OWN generation, so its affinities sit at
      // alias.generation - 1: without this handoff they fail the exact-generation
      // liveness check on the very next request that reads them.
      for (const alias of result.propagatedAliases ?? []) {
        dispatchRefreshGenerationHandoffs(alias.id, alias.generation - 1, alias.generation);
      }
    }
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
    ...(result.propagatedAliases?.length ? { propagatedAliases: result.propagatedAliases } : {}),
    ...(result.resolvedGrantFingerprint !== undefined
      ? { resolvedGrantFingerprint: result.resolvedGrantFingerprint }
      : {}),
  };
}
