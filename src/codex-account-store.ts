import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir, atomicWriteFile, hardenConfigDir, hardenExistingSecret } from "./config";
import type { CodexAccountCredentialRecord, CodexAccountCredentials } from "./types";

type LegacyCodexAccountStore = Record<string, CodexAccountCredentials>;
type CodexAccountStore = Record<string, CodexAccountCredentialRecord>;
type RawCodexAccountStore = Record<string, CodexAccountCredentials | CodexAccountCredentialRecord>;

const REFRESH_SKEW_MS = 60_000;

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
    && (value.deletedAt === undefined || typeof value.deletedAt === "number")
    && (value.replacedAt === undefined || typeof value.replacedAt === "number");
}

function normalizeRecord(value: CodexAccountCredentials | CodexAccountCredentialRecord | undefined): CodexAccountCredentialRecord | undefined {
  if (!value) return undefined;
  if (isCredentialRecord(value)) return value;
  if (isCredential(value)) return { credential: value, generation: 0 };
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
  store[id] = {
    credential: cred,
    generation: (current?.generation ?? 0) + 1,
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
  store[id] = {
    credential: cred,
    generation: generation + 1,
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

type CodexTokenResult = { accessToken: string; chatgptAccountId: string };
const refreshLocks = new Map<string, Promise<CodexTokenResult>>();

export async function getValidCodexToken(id: string): Promise<CodexTokenResult> {
  const existing = refreshLocks.get(id);
  if (existing) return existing;

  const record = readCodexAccountRecord(id);
  const cred = record?.deletedAt == null ? record?.credential : undefined;
  if (!record || !cred) throw new Error(`Codex account not found: ${id}`);
  const startGeneration = record.generation;

  if (cred.expiresAt > Date.now() + REFRESH_SKEW_MS) {
    return { accessToken: cred.accessToken, chatgptAccountId: cred.chatgptAccountId };
  }

  const refreshPromise = (async (): Promise<CodexTokenResult> => {
    try {
      const res = await fetch(CHATGPT_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: CHATGPT_CLIENT_ID,
          refresh_token: cred.refreshToken,
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
        throw new TokenRefreshError(reason, `Token refresh failed for ${id}: ${errDesc}`);
      }
      const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };

      const updated: CodexAccountCredentials = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? cred.refreshToken,
        expiresAt: Date.now() + data.expires_in * 1000,
        chatgptAccountId: cred.chatgptAccountId,
      };
      if (!saveCodexAccountCredentialIfGeneration(id, startGeneration, updated)) {
        throw new CodexCredentialGenerationConflictError();
      }
      return { accessToken: updated.accessToken, chatgptAccountId: updated.chatgptAccountId };
    } finally {
      refreshLocks.delete(id);
    }
  })();

  refreshLocks.set(id, refreshPromise);
  return refreshPromise;
}
