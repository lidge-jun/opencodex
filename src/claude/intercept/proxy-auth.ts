import { randomBytes } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMissingPathError } from "../../config/atomic-write";
import { hardenSecretDir, hardenSecretPath } from "../../lib/windows-secret-acl";

const TOKEN_FILE = "proxy-token";

export function claudeInterceptProxyTokenPath(configDir: string): string {
  return join(configDir, "claude-intercept", TOKEN_FILE);
}

/**
 * The persisted CONNECT credential, or `null` when none is usable. Never writes:
 * read-only inspection paths call this, so missing, empty, and unreadable files
 * all collapse to "no token" and classify as stale rather than throwing.
 */
export function readClaudeInterceptProxyToken(configDir: string): string | null {
  try {
    const token = readFileSync(claudeInterceptProxyTokenPath(configDir), "utf8").trim();
    return token.length > 0 ? token : null;
  } catch { // no-excuse-ok: catch -- every read failure means no usable credential; write paths surface real errors when minting.
    return null;
  }
}

/**
 * Return the per-install CONNECT credential, creating it with owner-only permissions.
 * The file publishes through an atomic no-replace link, so concurrent creators (a server
 * start racing an apply) all return the single committed value instead of splitting a
 * generated token from the one clients were told. On Windows, `chmod` is a no-op against
 * inherited NTFS grants, so the directory and file go through the repo's icacls hardener.
 */
export function ensureClaudeInterceptProxyToken(configDir: string): string {
  const path = claudeInterceptProxyTokenPath(configDir);
  const existing = readClaudeInterceptProxyToken(configDir);
  if (existing) {
    try {
      // A restored or hand-edited file may carry broader permissions than the
      // writer left; re-pin owner-only before trusting the credential again.
      if (process.platform === "win32") hardenSecretPath(path, { required: true });
      else if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
      return existing;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      // Vanished between read and stat — mint a fresh one below rather than
      // returning a token that is no longer persisted anywhere.
    }
  }
  const dir = join(configDir, "claude-intercept");
  mkdirSync(dir, { recursive: true });
  try { chmodSync(dir, 0o700); } catch { // no-excuse-ok: catch -- non-POSIX filesystems may ignore chmod.
  }
  if (process.platform === "win32") hardenSecretDir(dir, { required: true });
  const token = randomBytes(32).toString("base64url");
  const tmp = join(dir, `.${TOKEN_FILE}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { // no-excuse-ok: catch -- non-POSIX filesystems may ignore chmod.
  }
  if (process.platform === "win32") hardenSecretPath(tmp, { required: true, timeoutMemoKey: path });
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
