/**
 * Local token auto-detection — reads an existing Grok CLI credential (~/.grok/auth.json).
 * Read-only: never writes to external credential stores.
 * Ported from jawcode packages/ai/src/utils/oauth/local-token-detect.ts (xAI portion).
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthCredentials } from "./types";

const XAI_AUTH_KEY_PREFIX = "https://auth.x.ai::";
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

export function detectGrokCliToken(): OAuthCredentials | null {
  const authPath = join(process.env.HOME ?? homedir(), ".grok", "auth.json");
  if (!existsSync(authPath)) return null;

  try {
    const raw = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, Record<string, unknown>>;

    const entry = Object.entries(raw).find(([key]) => key.startsWith(XAI_AUTH_KEY_PREFIX))?.[1];
    if (!entry?.key || !entry?.refresh_token) return null;

    const accessToken = entry.key as string;
    const refreshToken = entry.refresh_token as string;
    const expiresAt = entry.expires_at ? new Date(entry.expires_at as string).getTime() : 0;

    return {
      refresh: refreshToken,
      access: accessToken,
      expires: expiresAt,
      accountId: entry.user_id as string | undefined,
      email: entry.email as string | undefined,
      source: "local-cli",
    };
  } catch {
    return null;
  }
}

export function hasComparableGrokIdentity(stored: OAuthCredentials, disk: OAuthCredentials): boolean {
  return Boolean((stored.accountId && disk.accountId) || (stored.email && disk.email));
}

export function isSameGrokIdentity(stored: OAuthCredentials, disk: OAuthCredentials): boolean {
  if (stored.accountId && disk.accountId) return stored.accountId === disk.accountId;
  if (stored.email && disk.email) return stored.email.toLowerCase() === disk.email.toLowerCase();
  return false;
}

export function shouldAdoptGrokGeneration(
  stored: OAuthCredentials,
  disk: OAuthCredentials,
  now = Date.now(),
  refreshSkewMs = 60_000,
): boolean {
  if (disk.expires <= now + refreshSkewMs) return false;
  const bothExpiriesExist = stored.expires > 0 && disk.expires > 0;
  if (bothExpiriesExist) return disk.expires >= stored.expires;
  return true;
}

/** Claude Code config dir: `CLAUDE_CONFIG_DIR` override, else `~/.claude`. */
function claudeConfigDir(): string {
  const explicit = process.env.CLAUDE_CONFIG_DIR?.trim();
  return explicit ? explicit : join(homedir(), ".claude");
}

/** Read the Claude Code OAuth credential from the macOS Keychain (darwin only). */
function readClaudeKeychain(): string | null {
  if (process.platform !== "darwin") return null;
  try {
    return execSync(`security find-generic-password -s "${CLAUDE_KEYCHAIN_SERVICE}" -w`, {
      encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Read the Claude Code credential file (`<config-dir>/.credentials.json`).
 * Claude Code writes this on Linux/Windows (and on macOS when the Keychain is
 * unavailable); it carries the same `claudeAiOauth` payload as the Keychain item.
 * Exported for tests.
 */
export function readClaudeCredentialsFile(): string | null {
  const path = join(claudeConfigDir(), ".credentials.json");
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

/** Keychain first on macOS, then the cross-platform credentials file. */
function readClaudeSecureStorage(): string | null {
  return readClaudeKeychain() ?? readClaudeCredentialsFile();
}

export function parseClaudeOauthPayload(raw: string): OAuthCredentials | null {
  try {
    const data = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string; refreshToken?: string; expiresAt?: number } };
    const o = data.claudeAiOauth;
    if (!o?.accessToken || !o?.refreshToken) return null;
    return { access: o.accessToken, refresh: o.refreshToken, expires: o.expiresAt ?? 0, source: "local-cli" };
  } catch {
    return null;
  }
}

export function detectClaudeCodeToken(): OAuthCredentials | null {
  const raw = readClaudeSecureStorage();
  if (!raw) return null;
  return parseClaudeOauthPayload(raw);
}
