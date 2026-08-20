import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, readFileSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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

export const CODEX_REFRESH_SKEW_MS = 60_000;
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
    const refreshGrantFingerprint = current.refreshGrantFingerprint
      ?? refreshGrantFingerprintForToken(current.credential.refreshToken);
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
type CodexRefreshResult = CodexTokenResult & { credential?: CodexAccountCredentials };
export interface CodexAccountStoreRefreshDependencies {
  readonly fetch?: typeof fetch;
}
const MAX_CODEX_REFRESH_FLIGHTS = 32;
const CODEX_REFRESH_FLIGHT_STALE_MS = 120_000;
interface RefreshFlight {
  promise: Promise<CodexRefreshResult>;
  startedAt: number;
  abort: AbortController;
}
const refreshLocks = new Map<string, RefreshFlight>();
const abandonedRefreshLockOwners = new Set<string>();

function codexRefreshLockPath(lockKey: string, directory = getConfigDir()): string {
  const digest = createHash("sha256").update(lockKey).digest("hex").slice(0, 32);
  return join(directory, `codex-refresh-${digest}.lock`);
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

interface RefreshLockOwner {
  readonly owner: string;
  readonly pid: number;
  readonly acquiredAt: number;
  readonly abandonedAt?: number;
}

function refreshLockOwner(path: string): RefreshLockOwner | undefined {
  try {
    hardenExistingSecret(path);
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<RefreshLockOwner>;
    if (typeof parsed.owner !== "string" || typeof parsed.pid !== "number" || typeof parsed.acquiredAt !== "number") {
      return undefined;
    }
    return {
      owner: parsed.owner,
      pid: parsed.pid,
      acquiredAt: parsed.acquiredAt,
      ...(typeof parsed.abandonedAt === "number" ? { abandonedAt: parsed.abandonedAt } : {}),
    };
  } catch {
    return undefined;
  }
}

function refreshLockOwnerIsLive(owner: RefreshLockOwner): boolean {
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return errCode(error) === "EPERM";
  }
}

function refreshLockIsStale(path: string): boolean {
  const owner = refreshLockOwner(path);
  if (owner?.abandonedAt !== undefined || (owner && abandonedRefreshLockOwners.has(owner.owner))) return true;
  if (!owner) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as { acquiredAt?: unknown };
      // Pre-owner lock records remain live for their bounded lease. This preserves
      // rolling-upgrade compatibility; malformed records without a timestamp are reclaimable.
      return typeof parsed.acquiredAt !== "number" || Date.now() - parsed.acquiredAt > REFRESH_LOCK_STALE_MS;
    } catch {
      return true;
    }
  }
  return Date.now() - owner.acquiredAt > REFRESH_LOCK_STALE_MS && !refreshLockOwnerIsLive(owner);
}

function abandonRefreshLock(path: string, owner: string): void {
  abandonedRefreshLockOwners.add(owner);
  const current = refreshLockOwner(path);
  if (!current || current.owner !== owner) return;
  writeFileSync(path, JSON.stringify({ ...current, abandonedAt: Date.now() }) + "\n");
}

function quarantineStaleRefreshLock(path: string): void {
  const retiredPath = `${path}.stale-${randomUUID()}`;
  const owner = refreshLockOwner(path);
  try {
    if (!refreshLockIsStale(path)) return;
    // Acquirers hold the reclaim lock while creating the lock file, so this
    // rename can only retire the stale entry that was just inspected.
    renameSync(path, retiredPath);
  } catch (error) {
    if (errCode(error) !== "ENOENT") throw error;
  } finally {
    try {
      unlinkSync(retiredPath);
    } catch (error) {
      if (errCode(error) !== "ENOENT") throw error;
    }
    if (owner) abandonedRefreshLockOwners.delete(owner.owner);
  }
}

async function acquireRefreshReclaimLock(path: string, signal?: AbortSignal): Promise<{ fd: number; owner: RefreshLockOwner }> {
  const reclaimPath = `${path}.reclaim`;
  const deadline = Date.now() + REFRESH_LOCK_WAIT_MS;
  const reclaimOwner: RefreshLockOwner = { owner: randomUUID(), pid: process.pid, acquiredAt: Date.now() };
  while (true) {
    if (signal?.aborted) throw signal.reason;
    if (Date.now() >= deadline) throw new CodexCredentialRefreshLockTimeoutError();
    try {
      const fd = openSync(reclaimPath, "wx", 0o600);
      writeFileSync(fd, JSON.stringify(reclaimOwner) + "\n");
      return { fd, owner: reclaimOwner };
    } catch (error) {
      if (errCode(error) !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new CodexCredentialRefreshLockTimeoutError();
      await sleep(REFRESH_LOCK_POLL_MS, signal);
    }
  }
}

function tryAcquireRefreshReclaimLock(path: string): { fd: number; owner: RefreshLockOwner } | null {
  const reclaimPath = `${path}.reclaim`;
  const reclaimOwner: RefreshLockOwner = { owner: randomUUID(), pid: process.pid, acquiredAt: Date.now() };
  try {
    const fd = openSync(reclaimPath, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(reclaimOwner) + "\n");
    return { fd, owner: reclaimOwner };
  } catch (error) {
    if (errCode(error) === "EEXIST") return null;
    throw error;
  }
}

function releaseRefreshReclaimLock(path: string, reclaim: { fd: number; owner: RefreshLockOwner }): void {
  closeSync(reclaim.fd);
  const reclaimPath = `${path}.reclaim`;
  try {
    if (refreshLockOwner(reclaimPath)?.owner !== reclaim.owner.owner) return;
    unlinkSync(reclaimPath);
  } catch (error) {
    if (errCode(error) !== "ENOENT") throw error;
  }
}

async function releaseRefreshLockOnce(path: string, owner: string, signal: AbortSignal): Promise<boolean> {
  const reclaim = await acquireRefreshReclaimLock(path, signal);
  try {
    if (refreshLockOwner(path)?.owner !== owner) return true;
    unlinkSync(path);
    abandonedRefreshLockOwners.delete(owner);
    return true;
  } catch (error) {
    if (errCode(error) !== "ENOENT") throw error;
    return true;
  } finally {
    releaseRefreshReclaimLock(path, reclaim);
  }
}

async function releaseRefreshLock(path: string, owner: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    const reclaim = tryAcquireRefreshReclaimLock(path);
    if (!reclaim) {
      abandonRefreshLock(path, owner);
      throw signal.reason;
    }
    try {
      if (refreshLockOwner(path)?.owner !== owner) return;
      unlinkSync(path);
    } catch (error) {
      if (errCode(error) !== "ENOENT") throw error;
    } finally {
      releaseRefreshReclaimLock(path, reclaim);
    }
    return;
  }
  await releaseRefreshLockOnce(path, owner, AbortSignal.any([signal, AbortSignal.timeout(1_000)]));
}

export async function withCodexRefreshFileLock<T>(args: {
  lockKey: string;
  signal: AbortSignal;
  run: () => Promise<T>;
  directory?: string;
}): Promise<T> {
  const dir = args.directory ?? getConfigDir();
  if (!args.directory) hardenConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const path = codexRefreshLockPath(args.lockKey, dir);
  const deadline = Date.now() + REFRESH_LOCK_WAIT_MS;
  const owner = randomUUID();
  let fd: number | null = null;
  while (fd == null) {
    if (args.signal.aborted) throw args.signal.reason;
    const reclaim = await acquireRefreshReclaimLock(path, args.signal);
    try {
      try {
        fd = openSync(path, "wx", 0o600);
        writeFileSync(fd, JSON.stringify({ acquiredAt: Date.now(), pid: process.pid, owner }) + "\n");
      } catch (err) {
        if (errCode(err) !== "EEXIST") throw err;
        quarantineStaleRefreshLock(path);
      }
    } finally {
      releaseRefreshReclaimLock(path, reclaim);
    }
    if (fd == null && Date.now() >= deadline) throw new CodexCredentialRefreshLockTimeoutError();
    if (fd == null) await sleep(REFRESH_LOCK_POLL_MS, args.signal);
  }

  try {
    return await args.run();
  } finally {
    if (fd != null) closeSync(fd);
    await releaseRefreshLock(path, owner, args.signal);
  }
}

export function findFreshCredentialForGrant(
  refreshGrantFingerprint: string,
  excludeId: string,
): CodexAccountCredentials | null {
  const now = Date.now();
  const records = loadCodexAccountRecordStore();
  for (const [candidateId, candidate] of Object.entries(records)) {
    if (candidateId === excludeId || candidate.deletedAt != null || !candidate.credential) continue;
    if (recordGrantFingerprint(candidate) !== refreshGrantFingerprint) continue;
    if (candidate.credential.expiresAt > now + CODEX_REFRESH_SKEW_MS) return candidate.credential;
  }
  return null;
}

export function publishFreshCredentialForGrant(
  args: {
    refreshGrantFingerprint: string;
    credential: CodexAccountCredentials;
    excludeId: string;
    replaceAccessToken?: string;
  },
): void {
  withCredentialMutationLockSync(() => {
    const now = Date.now();
    const store = loadCodexAccountRecordStore();
    let changed = false;
    for (const [candidateId, candidate] of Object.entries(store)) {
      if (candidateId === args.excludeId || candidate.deletedAt != null || !candidate.credential) continue;
      if (recordGrantFingerprint(candidate) !== args.refreshGrantFingerprint) continue;
      if (
        candidate.credential.expiresAt > now + CODEX_REFRESH_SKEW_MS
        && candidate.credential.accessToken !== args.replaceAccessToken
      ) continue;
      store[candidateId] = {
        ...candidate,
        credential: args.credential,
        generation: candidate.generation + 1,
        refreshGrantFingerprint: args.refreshGrantFingerprint,
        replacedAt: Date.now(),
        ...preservedValidationMetadata(candidate),
      };
      changed = true;
    }
    if (changed) persist(store);
  });
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

export async function getValidCodexToken(
  id: string,
  dependencies: CodexAccountStoreRefreshDependencies = {},
): Promise<CodexTokenResult> {
  const record = readCodexAccountRecord(id);
  const cred = record?.deletedAt == null ? record?.credential : undefined;
  if (!record || !cred) throw new Error("Codex account credential is unavailable; reauthenticate the account.");
  const refreshGrantFingerprint = recordGrantFingerprint(record);
  if (!refreshGrantFingerprint) throw new Error("Codex account credential is unavailable; reauthenticate the account.");

  if (cred.expiresAt > Date.now() + CODEX_REFRESH_SKEW_MS) {
    return { accessToken: cred.accessToken, chatgptAccountId: cred.chatgptAccountId, generation: record.generation };
  }

  const existing = refreshLocks.get(refreshGrantFingerprint);
  if (existing) {
    if (Date.now() - existing.startedAt > CODEX_REFRESH_FLIGHT_STALE_MS) {
      existing.abort.abort(new CodexCredentialRefreshStaleError());
      if (refreshLocks.get(refreshGrantFingerprint) === existing) refreshLocks.delete(refreshGrantFingerprint);
    } else {
      const refreshed = await existing.promise;
      const current = readCodexAccountRecord(id);
      const currentCred = current?.deletedAt == null ? current?.credential : undefined;
      if (
        current &&
        currentCred &&
        refreshed.credential &&
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
        };
      }
      return getValidCodexToken(id, dependencies);
    }
  }

  if (refreshLocks.size >= MAX_CODEX_REFRESH_FLIGHTS) throw new CodexCredentialRefreshBusyError();

  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]);
  let flight!: RefreshFlight;
  const refreshPromise = withCodexRefreshFileLock({
    lockKey: refreshGrantFingerprint,
    signal,
    run: async (): Promise<CodexRefreshResult> => {
      const current = readCodexAccountRecord(id);
      const lockedRecord = readCodexAccountRecord(id);
      const lockedCred = lockedRecord?.deletedAt == null ? lockedRecord?.credential : undefined;
      if (!lockedRecord || !lockedCred) throw new CodexCredentialGenerationConflictError();
      const startGeneration = lockedRecord.generation;
      const lockedRefreshGrantFingerprint = recordGrantFingerprint(lockedRecord);
      if (lockedRefreshGrantFingerprint !== refreshGrantFingerprint) {
        if (lockedCred.expiresAt > Date.now() + CODEX_REFRESH_SKEW_MS) {
          return {
            accessToken: lockedCred.accessToken,
            chatgptAccountId: lockedCred.chatgptAccountId,
            generation: startGeneration,
            credential: lockedCred,
          };
        }
        throw new CodexCredentialGenerationConflictError();
      }
      if (lockedCred.expiresAt > Date.now() + CODEX_REFRESH_SKEW_MS) {
        return {
          accessToken: lockedCred.accessToken,
          chatgptAccountId: lockedCred.chatgptAccountId,
          generation: startGeneration,
          credential: lockedCred,
        };
      }
      const sameGrantFreshCredential = findFreshCredentialForGrant(refreshGrantFingerprint, id);
      if (sameGrantFreshCredential) {
        if (!saveCodexAccountCredentialIfGeneration(id, startGeneration, sameGrantFreshCredential)) {
          throw new CodexCredentialGenerationConflictError();
        }
        return {
          accessToken: sameGrantFreshCredential.accessToken,
          chatgptAccountId: sameGrantFreshCredential.chatgptAccountId,
          generation: startGeneration + 1,
          credential: sameGrantFreshCredential,
        };
      }
    const res = await (dependencies.fetch ?? fetch)(CHATGPT_TOKEN_URL, {
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
        try {
          const parsed = JSON.parse(errText) as { error?: string; error_description?: string };
          errDesc = [parsed.error, parsed.error_description].filter(Boolean).join(": ") || `HTTP ${res.status}`;
        } catch { errDesc = `HTTP ${res.status}`; }
        const reason = errDesc.includes("invalidated") || errDesc.includes("revoked") ? "revoked" as const
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
      return { accessToken: updated.accessToken, chatgptAccountId: updated.chatgptAccountId, generation: startGeneration + 1, credential: updated };
    },
  }).finally(() => {
    if (refreshLocks.get(refreshGrantFingerprint) === flight) refreshLocks.delete(refreshGrantFingerprint);
  });

  flight = { promise: refreshPromise, startedAt: Date.now(), abort };
  refreshLocks.set(refreshGrantFingerprint, flight);
  const result = await refreshPromise;
  await notePlanFromRefreshedAccessToken(id, result.accessToken, result.generation);
  return {
    accessToken: result.accessToken,
    chatgptAccountId: result.chatgptAccountId,
    generation: result.generation,
  };
}
