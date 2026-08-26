import { chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { hardenSecretDir } from "../lib/windows-secret-acl";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";

/**
 * Expand a leading `~` in user-supplied paths without interpreting shell
 * variables or `~user` forms that belong to the caller's shell.
 */
export function expandUserPath(raw: string): string {
  if (raw === "~") return homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return join(homedir(), raw.slice(2));
  return raw;
}
let resolvedConfigDirCache: { raw: string | undefined; path: string } | null = null;

export function getConfigDir(): string {
  const raw = process.env["OPENCODEX_HOME"]?.trim() || undefined;
  if (resolvedConfigDirCache && resolvedConfigDirCache.raw === raw) return resolvedConfigDirCache.path;
  const path = raw ? resolve(expandUserPath(raw)) : join(homedir(), ".opencodex");
  resolvedConfigDirCache = { raw, path };
  return path;
}

export function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

export function hardenConfigDir(): void {
  const dir = getConfigDir();
  // The guard runs before any mutation: refusing after chmod/ACL would already
  // have changed the protected directory used by the test-home boundary.
  assertNotRealHomeUnderTest(dir);
  if (!existsSync(dir)) return;
  try { chmodSync(dir, 0o700); } catch { /* best-effort */ }
  if (process.platform === "win32") {
    hardenSecretDir(dir, { required: false });
  }
}
