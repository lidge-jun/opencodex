/** OAuth token store at ~/.opencodex/auth.json, keyed by provider name. */
import { existsSync, mkdirSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir, atomicWriteFile, hardenConfigDir, hardenExistingSecret } from "../config";
import type { OAuthCredentials } from "./types";

const AUTH_PATH = join(getConfigDir(), "auth.json");
type AuthStore = Record<string, OAuthCredentials>;

export function loadAuthStore(): AuthStore {
  hardenConfigDir();
  hardenExistingSecret(AUTH_PATH);
  if (!existsSync(AUTH_PATH)) return {};
  try {
    return JSON.parse(readFileSync(AUTH_PATH, "utf-8")) as AuthStore;
  } catch {
    return {};
  }
}

function persist(store: AuthStore): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    try { chmodSync(dir, 0o700); } catch { /* best-effort on existing dir */ }
  }
  atomicWriteFile(AUTH_PATH, JSON.stringify(store, null, 2) + "\n");
}

export function getCredential(provider: string): OAuthCredentials | null {
  return loadAuthStore()[provider] ?? null;
}

export function saveCredential(provider: string, cred: OAuthCredentials): void {
  const store = loadAuthStore();
  store[provider] = cred;
  persist(store);
}

export function removeCredential(provider: string): void {
  const store = loadAuthStore();
  delete store[provider];
  persist(store);
}
