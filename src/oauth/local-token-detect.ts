/**
 * Local token auto-detection — reads an existing Grok CLI credential (~/.grok/auth.json).
 * Read-only: never writes to external credential stores.
 * Ported from jawcode packages/ai/src/utils/oauth/local-token-detect.ts (xAI portion).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthCredentials } from "./types";
import { claudeKeychain } from "../lib/claude-keychain";

const XAI_AUTH_KEY_PREFIX = "https://auth.x.ai::";

export function detectGrokCliToken(): OAuthCredentials | null {
  const authPath = join(process.env.HOME ?? homedir(), ".grok", "auth.json");
  if (!existsSync(authPath)) return null;

  try {
    const raw = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, Record<string, unknown>>;

    const entry = Object.entries(raw).find(([key]) => key.startsWith(XAI_AUTH_KEY_PREFIX))?.[1];
    if (!entry?.key || !entry?.refresh_token) return null;

    const accessToken = entry.key as string;
    const refreshToken = entry.refresh_token as string;
    const parsedExpiresAt = entry.expires_at ? new Date(entry.expires_at as string).getTime() : 0;
    // Guard against unparseable/NaN expiries: a non-finite value must never be treated as
    // "valid forever". Unknown → 0, which forces the refresh-validation path downstream.
    const expiresAt = Number.isFinite(parsedExpiresAt) ? parsedExpiresAt : 0;

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
  // A non-finite disk expiry means we cannot reason about the generation: the credential is
  // either garbage or unknown. Treat it as requiring refresh validation, never as an upgrade.
  if (!Number.isFinite(disk.expires)) return false;
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

/**
 * Read the Claude Code credential file (`<config-dir>/.credentials.json`).
 * Claude Code writes this on Linux/Windows (and on macOS when the Keychain is
 * unavailable); it carries the same `claudeAiOauth` payload as the Keychain item.
 * Exported for tests.
 */
export function readClaudeCredentialsFile(): string | null {
  return readClaudeCredentialsFileAt(claudeConfigDir());
}

function readClaudeCredentialsFileAt(configDir: string): string | null {
  const path = join(configDir, ".credentials.json");
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

export type ClaudeTokenObservation =
  | { kind: "present"; credential: OAuthCredentials; sourceKey: string }
  | { kind: "absent" }
  | { kind: "unavailable" };

/** Preserve source precedence while retaining unavailable as distinct from absence. */
export async function observeClaudeCodeToken(options: { fresh?: boolean } = {}): Promise<ClaudeTokenObservation> {
  const profile = process.env.CLAUDE_CONFIG_DIR?.trim() ?? "";
  const profilePath = claudeConfigDir();
  const fromFile = (): ClaudeTokenObservation | null => {
    let raw: string;
    try {
      raw = readFileSync(join(profilePath, ".credentials.json"), "utf8").trim();
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : { kind: "unavailable" };
    }
    const credential = parseClaudeOauthPayload(raw);
    return credential ? { kind: "present", credential, sourceKey: `file:${profilePath}` } : { kind: "absent" };
  };
  const preferredFile = profile ? fromFile() : null;
  if (preferredFile?.kind === "present" || preferredFile?.kind === "unavailable") return preferredFile;
  const keychain = await claudeKeychain.read(options);
  if ((process.env.CLAUDE_CONFIG_DIR?.trim() ?? "") !== profile || claudeConfigDir() !== profilePath) return { kind: "unavailable" };
  if (profile && fromFile()?.kind !== preferredFile?.kind) return { kind: "unavailable" };
  if (preferredFile) return keychain.status === "unavailable" ? { kind: "unavailable" } : preferredFile;
  if (keychain.status === "unavailable") return { kind: "unavailable" };
  if (keychain.status === "present" && keychain.value.trim()) {
    const credential = parseClaudeOauthPayload(keychain.value.trim());
    return credential ? { kind: "present", credential, sourceKey: `keychain:${profilePath}` } : { kind: "absent" };
  }
  const fallback = fromFile();
  if (fallback?.kind === "present") return fallback;
  return fallback ?? { kind: "absent" };
}

export async function detectClaudeCodeTokenAsync(): Promise<OAuthCredentials | null> {
  const observation = await observeClaudeCodeToken();
  return observation.kind === "present" ? observation.credential : null;
}

export function parseClaudeOauthPayload(raw: string): OAuthCredentials | null {
  try {
    const data = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string; refreshToken?: string; expiresAt?: number } };
    const o = data.claudeAiOauth;
    if (!o?.accessToken || !o?.refreshToken) return null;
    // Number.isFinite guard: a string/NaN expiresAt must not flow into downstream time
    // comparisons as a "valid forever" value. Unknown → 0 (refresh-validation path).
    const expires = typeof o.expiresAt === "number" && Number.isFinite(o.expiresAt) ? o.expiresAt : 0;
    return { access: o.accessToken, refresh: o.refreshToken, expires, source: "local-cli" };
  } catch {
    return null;
  }
}

/** Shared-token continuity for opaque Claude tokens; fully rotated pairs need authenticated account proof. */
export function hasClaudeCredentialContinuity(stored: OAuthCredentials, disk: OAuthCredentials): boolean {
  const sameToken = (left: string, right: string): boolean =>
    typeof left === "string" && left.trim().length > 0 && left === right;
  return sameToken(stored.refresh, disk.refresh) || sameToken(stored.access, disk.access);
}
