import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { labInstallationSaltPath, labRoot } from "../paths";

const SALT_BYTES = 32;
export const INSTALLATION_SALT_CACHE_MAX_ENTRIES = 16;
export const installationSaltCache = new Map<string, Uint8Array>();
const UNSUPPORTED_DIRECTORY_FSYNC_CODES = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);

export function rememberInstallationSalt(path: string, salt: Uint8Array): void {
  installationSaltCache.delete(path);
  installationSaltCache.set(path, salt);
  while (installationSaltCache.size > INSTALLATION_SALT_CACHE_MAX_ENTRIES) {
    const oldest = installationSaltCache.keys().next().value;
    if (oldest === undefined) break;
    installationSaltCache.delete(oldest);
  }
}

function readSaltFile(path: string): Uint8Array {
  const bytes = readFileSync(path);
  if (bytes.byteLength !== SALT_BYTES) {
    throw new Error("harness_failure: invalid installation salt length");
  }
  return new Uint8Array(bytes);
}

function cacheSalt(path: string, salt: Uint8Array): Uint8Array {
  const cached = new Uint8Array(salt);
  rememberInstallationSalt(path, cached);
  return new Uint8Array(cached);
}

/** Read the existing local fingerprint salt without creating Lab state. */
export function readExistingInstallationSalt(configDir?: string): Uint8Array | null {
  const path = labInstallationSaltPath(configDir);
  const cached = installationSaltCache.get(path);
  if (cached) return new Uint8Array(cached);
  try {
    return cacheSalt(path, readSaltFile(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function removeStagingFile(path: string): void {
  try { unlinkSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function fsyncDirectory(path: string): void {
  // Windows has no portable directory-fsync primitive. Some POSIX-backed
  // filesystems (notably virtual/shared filesystems) report directory fsync as
  // unsupported. In those cases the fsync'd staging inode plus atomic same-dir
  // hard-link publication is the supported durability fallback. Unexpected I/O
  // errors remain fatal.
  if (process.platform === "win32") return;
  const dirFd = openSync(path, "r");
  try {
    try { fsyncSync(dirFd); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code && UNSUPPORTED_DIRECTORY_FSYNC_CODES.has(code)) return;
      throw error;
    }
  } finally { closeSync(dirFd); }
}

/** Read or atomically publish the per-installation salt used for local fingerprinting. */
export function readInstallationSalt(configDir?: string): Uint8Array {
  const path = labInstallationSaltPath(configDir);
  const root = labRoot(configDir);
  mkdirSync(root, { recursive: true, mode: 0o700 });

  try { return cacheSalt(path, readSaltFile(path)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  // The final pathname must never become visible before all 32 bytes are durable in the
  // staging inode. A hard-link publish is atomic and fails with EEXIST when another process won.
  const stagingPath = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  if (dirname(stagingPath) !== dirname(path)) throw new Error("harness_failure: installation salt staging path escaped directory");
  const salt = randomBytes(SALT_BYTES);
  let fd: number | undefined;
  try {
    fd = openSync(stagingPath, "wx", 0o600);
    writeFileSync(fd, salt);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    try {
      linkSync(stagingPath, path);
      try { fsyncDirectory(dirname(path)); }
      catch { throw new Error("harness_failure: installation salt directory fsync failed"); }
      return cacheSalt(path, salt);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return cacheSalt(path, readSaltFile(path));
    }
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort close before cleanup */ }
    }
    removeStagingFile(stagingPath);
  }
}
