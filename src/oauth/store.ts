/** OAuth token store at ~/.opencodex/auth.json, keyed by provider name. */
import { existsSync, mkdirSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir, atomicWriteFile, backupInvalidConfig, hardenConfigDir, hardenExistingSecret } from "../config";
import type { OAuthCredentialSource, OAuthCredentials } from "./types";

type AuthStore = Record<string, OAuthCredentials>;

function authPath(): string {
  return join(getConfigDir(), "auth.json");
}

export function loadAuthStore(): AuthStore {
  const path = authPath();
  hardenConfigDir();
  hardenExistingSecret(path);
  if (!existsSync(path)) return {};
  try {
    return normalizeAuthStore(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    backupInvalidConfig(path);
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
  atomicWriteFile(authPath(), JSON.stringify(store, null, 2) + "\n");
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
  return normalized;
}

function normalizeAuthStore(raw: unknown): AuthStore {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const normalized: AuthStore = {};
  for (const [provider, cred] of Object.entries(raw)) {
    const safe = normalizeCredential(cred);
    if (safe) normalized[provider] = safe;
  }
  return normalized;
}

export function getCredential(provider: string): OAuthCredentials | null {
  return loadAuthStore()[provider] ?? null;
}

export function saveCredential(provider: string, cred: OAuthCredentials): void {
  const store = loadAuthStore();
  const safe = normalizeCredential(cred);
  if (!safe) return;
  store[provider] = safe;
  persist(store);
}

export function removeCredential(provider: string): void {
  const store = loadAuthStore();
  delete store[provider];
  persist(store);
}
