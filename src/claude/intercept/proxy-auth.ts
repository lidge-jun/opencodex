import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TOKEN_FILE = "proxy-token";

export function claudeInterceptProxyTokenPath(configDir: string): string {
  return join(configDir, "claude-intercept", TOKEN_FILE);
}

/** Return the per-install CONNECT credential, creating it with owner-only permissions. */
export function ensureClaudeInterceptProxyToken(configDir: string): string {
  const path = claudeInterceptProxyTokenPath(configDir);
  try {
    return readFileSync(path, "utf8").trim();
  } catch (error) { // no-excuse-ok: catch -- a missing token is the fresh-install state.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  mkdirSync(join(configDir, "claude-intercept"), { recursive: true });
  const token = randomBytes(32).toString("base64url");
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return token;
}
