import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir, atomicWriteFile, hardenConfigDir, hardenExistingSecret } from "./config";
import type { CodexAccountCredentials } from "./types";

type CodexAccountStore = Record<string, CodexAccountCredentials>;

const REFRESH_SKEW_MS = 60_000;

function getCodexAccountsPath(): string {
  return join(getConfigDir(), "codex-accounts.json");
}

export function loadCodexAccountStore(): CodexAccountStore {
  const path = getCodexAccountsPath();
  hardenConfigDir();
  hardenExistingSecret(path);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as CodexAccountStore;
  } catch {
    return {};
  }
}

function persist(store: CodexAccountStore): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWriteFile(getCodexAccountsPath(), JSON.stringify(store, null, 2) + "\n");
}

export function getCodexAccountCredential(id: string): CodexAccountCredentials | null {
  return loadCodexAccountStore()[id] ?? null;
}

export function saveCodexAccountCredential(id: string, cred: CodexAccountCredentials): void {
  const store = loadCodexAccountStore();
  store[id] = cred;
  persist(store);
}

export function removeCodexAccountCredential(id: string): void {
  const store = loadCodexAccountStore();
  delete store[id];
  persist(store);
}

export function listCodexAccountIds(): string[] {
  return Object.keys(loadCodexAccountStore());
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

type CodexTokenResult = { accessToken: string; chatgptAccountId: string };
const refreshLocks = new Map<string, Promise<CodexTokenResult>>();

export async function getValidCodexToken(id: string): Promise<CodexTokenResult> {
  const existing = refreshLocks.get(id);
  if (existing) return existing;

  const cred = getCodexAccountCredential(id);
  if (!cred) throw new Error(`Codex account not found: ${id}`);

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
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        const reason = errBody.includes("invalidated") || errBody.includes("revoked") ? "revoked" as const
          : errBody.includes("expired") ? "expired" as const
          : "unknown" as const;
        throw new TokenRefreshError(reason, `Token refresh failed for ${id}: ${res.status} ${errBody}`);
      }
      const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };

      const updated: CodexAccountCredentials = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? cred.refreshToken,
        expiresAt: Date.now() + data.expires_in * 1000,
        chatgptAccountId: cred.chatgptAccountId,
      };
      saveCodexAccountCredential(id, updated);
      return { accessToken: updated.accessToken, chatgptAccountId: updated.chatgptAccountId };
    } finally {
      refreshLocks.delete(id);
    }
  })();

  refreshLocks.set(id, refreshPromise);
  return refreshPromise;
}
