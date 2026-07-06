import { createHash } from "node:crypto";
import { closeSync, existsSync, readFileSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir, atomicWriteFile, backupInvalidConfig, hardenConfigDir, hardenExistingSecret } from "../config";
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
    && (value.replacedAt === undefined || typeof value.replacedAt === "number");
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
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWriteFile(codexAccountsPath(), JSON.stringify(store, null, 2) + "\n");
}

export function getCodexAccountCredential(id: string): CodexAccountCredentials | null {
  const record = readCodexAccountRecord(id);
  if (!record || record.deletedAt != null) return null;
  return record.credential ?? null;
}

export function saveCodexAccountCredential(id: string, cred: CodexAccountCredentials): void {
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
  };
  persist(store);
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
  };
  persist(store);
  return true;
}

export function tombstoneCodexAccount(id: string): number {
  const store = loadCodexAccountRecordStore();
  const current = store[id];
  const generation = (current?.generation ?? 0) + 1;
  store[id] = { generation, deletedAt: Date.now() };
  persist(store);
  return generation;
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

type CodexTokenResult = { accessToken: string; chatgptAccountId: string; generation: number };
type CodexRefreshResult = CodexTokenResult & { credential?: CodexAccountCredentials };
const refreshLocks = new Map<string, Promise<CodexRefreshResult>>();

function codexRefreshLockPath(lockKey: string): string {
  const digest = createHash("sha256").update(lockKey).digest("hex").slice(0, 32);
  return join(getConfigDir(), `codex-refresh-${digest}.lock`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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

async function withCodexRefreshFileLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
  hardenConfigDir();
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const path = codexRefreshLockPath(lockKey);
  const deadline = Date.now() + REFRESH_LOCK_WAIT_MS;
  let fd: number | null = null;
  while (fd == null) {
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
      await sleep(REFRESH_LOCK_POLL_MS);
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
): CodexAccountCredentials | null {
  const now = Date.now();
  const records = loadCodexAccountRecordStore();
  for (const [candidateId, candidate] of Object.entries(records)) {
    if (candidateId === excludeId || candidate.deletedAt != null || !candidate.credential) continue;
    if (recordGrantFingerprint(candidate) !== refreshGrantFingerprint) continue;
    if (candidate.credential.expiresAt > now + REFRESH_SKEW_MS) return candidate.credential;
  }
  return null;
}

export async function getValidCodexToken(id: string): Promise<CodexTokenResult> {
  const record = readCodexAccountRecord(id);
  const cred = record?.deletedAt == null ? record?.credential : undefined;
  if (!record || !cred) throw new Error("Codex account credential is unavailable; reauthenticate the account.");
  const refreshGrantFingerprint = recordGrantFingerprint(record);
  if (!refreshGrantFingerprint) throw new Error("Codex account credential is unavailable; reauthenticate the account.");

  if (cred.expiresAt > Date.now() + REFRESH_SKEW_MS) {
    return { accessToken: cred.accessToken, chatgptAccountId: cred.chatgptAccountId, generation: record.generation };
  }

  const existing = refreshLocks.get(refreshGrantFingerprint);
  if (existing) {
    const refreshed = await existing;
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
      return {
        accessToken: refreshed.credential.accessToken,
        chatgptAccountId: refreshed.credential.chatgptAccountId,
        generation: current.generation + 1,
      };
    }
    return getValidCodexToken(id);
  }

  const refreshPromise = withCodexRefreshFileLock(refreshGrantFingerprint, async (): Promise<CodexRefreshResult> => {
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
        };
      }
      throw new CodexCredentialGenerationConflictError();
    }
    if (lockedCred.expiresAt > Date.now() + REFRESH_SKEW_MS) {
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
    const res = await fetch(CHATGPT_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CHATGPT_CLIENT_ID,
        refresh_token: lockedCred.refreshToken,
      }).toString(),
      signal: AbortSignal.timeout(30_000),
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

    const updated: CodexAccountCredentials = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? lockedCred.refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000,
      chatgptAccountId: lockedCred.chatgptAccountId,
    };
    if (!saveCodexAccountCredentialIfGeneration(id, startGeneration, updated)) {
      throw new CodexCredentialGenerationConflictError();
    }
    return { accessToken: updated.accessToken, chatgptAccountId: updated.chatgptAccountId, generation: startGeneration + 1, credential: updated };
  }).finally(() => {
    refreshLocks.delete(refreshGrantFingerprint);
  });

  refreshLocks.set(refreshGrantFingerprint, refreshPromise);
  const result = await refreshPromise;
  return {
    accessToken: result.accessToken,
    chatgptAccountId: result.chatgptAccountId,
    generation: result.generation,
  };
}
