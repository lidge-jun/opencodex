import { randomBytes } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TOKEN_FILE = "proxy-token";

export function claudeInterceptProxyTokenPath(configDir: string): string {
  return join(configDir, "claude-intercept", TOKEN_FILE);
}

/** The persisted CONNECT credential, or `null` when none was ever created. Never writes. */
export function readClaudeInterceptProxyToken(configDir: string): string | null {
  try {
    const token = readFileSync(claudeInterceptProxyTokenPath(configDir), "utf8").trim();
    return token.length > 0 ? token : null;
  } catch (error) { // no-excuse-ok: catch -- a missing token is the fresh-install state.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}

/**
 * Return the per-install CONNECT credential, creating it with owner-only permissions.
 * The file publishes through an atomic no-replace link, so concurrent creators (a server
 * start racing an apply) all return the single committed value instead of splitting a
 * generated token from the one clients were told.
 */
export function ensureClaudeInterceptProxyToken(configDir: string): string {
  const existing = readClaudeInterceptProxyToken(configDir);
  if (existing) return existing;
  const dir = join(configDir, "claude-intercept");
  const path = join(dir, TOKEN_FILE);
  mkdirSync(dir, { recursive: true });
  const token = randomBytes(32).toString("base64url");
  const tmp = join(dir, `.${TOKEN_FILE}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  try {
    try {
      linkSync(tmp, path); // atomic no-replace publish; EEXIST means a peer committed first
      return token;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        const committed = readClaudeInterceptProxyToken(configDir);
        if (committed) return committed;
        renameSync(tmp, path); // an empty placeholder is corruption, not a winner
        return token;
      }
      if (code === "EPERM" || code === "EXDEV" || code === "ENOSYS") {
        // Filesystem without hard links: rename still publishes, then the reread
        // resolves a concurrent overwrite to the committed file rather than our lost write.
        renameSync(tmp, path);
        return readClaudeInterceptProxyToken(configDir) ?? token;
      }
      throw error;
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch { // no-excuse-ok: catch -- the publish above already consumed the temp file.
    }
  }
}
