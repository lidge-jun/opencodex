import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { atomicWriteFile, atomicWriteFileNoFollow } from "../config/atomic-write";

const MAX_SERVICE_API_TOKEN_BYTES = 4096;

export interface PersistedServiceApiToken {
  path: string;
  fingerprint: string;
}

export type ServiceApiTokenState =
  | { kind: "absent" }
  | { kind: "present"; token: string; fingerprint: string }
  | { kind: "unsafe"; reason: string };

export function serviceApiTokenFilePath(): string {
  return join(getConfigDir(), "service-api-token");
}

export function serviceApiTokenBackupPath(): string {
  return `${serviceApiTokenFilePath()}.prev`;
}

export function serviceApiTokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function readServiceApiTokenState(): ServiceApiTokenState {
  const path = serviceApiTokenFilePath();
  if (!existsSync(path)) return { kind: "absent" };
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return { kind: "unsafe", reason: "service token path could not be inspected" };
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_SERVICE_API_TOKEN_BYTES) {
    return { kind: "unsafe", reason: "service token path is not a bounded regular file" };
  }
  try {
    const token = readFileSync(path, "utf8").trim();
    if (!token) return { kind: "unsafe", reason: "service token file is empty" };
    return { kind: "present", token, fingerprint: serviceApiTokenFingerprint(token) };
  } catch {
    return { kind: "unsafe", reason: "service token file could not be read" };
  }
}

/**
 * Validate and tighten a reused service token without applying permissions to a
 * pathname that may have been replaced since validation.
 *
 * The token is read off the opened descriptor — never off the path a second
 * time — and once it validates, it is REPUBLISHED through the no-follow atomic
 * writer rather than hardened in place. Windows ACL tooling is pathname-based,
 * so an in-place harden there could still land on a substituted entry; the
 * republish instead replaces whatever entry sits at the path with a freshly
 * hardened owner-only file holding the same token. On return the path names
 * that file, which is the contract `origin: "file"` reports. On POSIX the
 * opened descriptor is also fchmod'd first, so a token-bearing inode a race
 * moved aside is still tightened wherever its entry ended up.
 *
 *
 * Return contract vs `readServiceApiTokenState`: an empty or malformed token file
 * reports `unsafe` here and is never written — the path-based pre-check may still
 * pass the install on loopback while this writer deliberately leaves the file
 * untouched. Only `absent` permits a fresh write; anything unreadable stays as-is.
 *
 * Callers must run this under `withConfigMutationLockSync`: client-key rotation
 * replaces the token under that lock, and a republish outside it could rename a
 * stale token back over a committed rotation.
 */
export function hardenReusedServiceApiToken(
  validate: (token: string) => void,
): ServiceApiTokenState {
  const path = serviceApiTokenFilePath();
  // O_NOFOLLOW refuses a symlinked entry and O_NONBLOCK keeps a FIFO (or other
  // blocking node) from stalling the open before fstat can reject it. Windows
  // omits both flags, so there the descriptor is bound to its entry by the
  // lstat/fstat identity comparison below.
  const flags = process.platform === "win32"
    ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let fd: number | undefined;
  try {
    fd = openSync(path, flags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "absent" };
    if (code === "ELOOP") return { kind: "unsafe", reason: "service token path is not a bounded regular file" };
    return { kind: "unsafe", reason: "service token path could not be inspected" };
  }
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(MAX_SERVICE_API_TOKEN_BYTES)) {
      return { kind: "unsafe", reason: "service token path is not a bounded regular file" };
    }
    if (process.platform === "win32") {
      let entry;
      try {
        entry = lstatSync(path, { bigint: true });
      } catch {
        return { kind: "unsafe", reason: "service token path could not be inspected" };
      }
      if (entry.isSymbolicLink() || !entry.isFile() || entry.dev !== stat.dev || entry.ino !== stat.ino) {
        return { kind: "unsafe", reason: "service token path is not a bounded regular file" };
      }
    }
    // Bound the read as well as the stat: a file that grows past the cap after
    // fstat is unsafe, not something to buffer whole.
    const bytes = Buffer.alloc(MAX_SERVICE_API_TOKEN_BYTES + 1);
    let length = 0;
    try {
      while (length < bytes.length) {
        const count = readSync(fd, bytes, length, bytes.length - length, null);
        if (!count) break;
        length += count;
      }
    } catch {
      return { kind: "unsafe", reason: "service token file could not be read" };
    }
    if (length > MAX_SERVICE_API_TOKEN_BYTES) {
      return { kind: "unsafe", reason: "service token path is not a bounded regular file" };
    }
    const token = bytes.subarray(0, length).toString("utf8").trim();
    if (!token) return { kind: "unsafe", reason: "service token file is empty" };
    validate(token);
    if (process.platform !== "win32") {
      // Best-effort matches the previous repair behavior: the descriptor binds
      // the chmod to the regular file opened above even if its directory entry
      // moved, so the validated inode is never left loose under another name.
      try { fchmodSync(fd, 0o600); } catch { /* best-effort */ }
    }
    // The descriptor's work ends here — and must: Windows refuses to rename over
    // a file this process still holds open, so the republish cannot run while it
    // is held.
    closeSync(fd);
    fd = undefined;
    atomicWriteFileNoFollow(path, `${token}\n`);
    return { kind: "present", token, fingerprint: serviceApiTokenFingerprint(token) };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function writeServiceApiTokenFile(token: string): PersistedServiceApiToken {
  const value = token.trim();
  if (!value || /[\r\n\0]/.test(value) || Buffer.byteLength(value) > MAX_SERVICE_API_TOKEN_BYTES) {
    throw new Error("refusing to persist an invalid service API token");
  }
  const path = serviceApiTokenFilePath();
  const existing = readServiceApiTokenState();
  if (existing.kind !== "absent") {
    throw new Error(existing.kind === "unsafe"
      ? existing.reason
      : "refusing to replace a pre-existing service API token");
  }
  atomicWriteFile(path, `${value}\n`);
  return { path, fingerprint: serviceApiTokenFingerprint(value) };
}

function fsyncRegularFile(path: string): void {
  // "r+", not "r": Windows rejects fsync on a read-only handle with EPERM, so a read-only
  // open turned every token backup/replace/restore into a hard failure there.
  const fd = openSync(path, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function validatedTokenValue(token: string): string {
  const value = token.trim();
  if (!value || /[\r\n\0]/.test(value) || Buffer.byteLength(value) > MAX_SERVICE_API_TOKEN_BYTES) {
    throw new Error("refusing to persist an invalid service API token");
  }
  return value;
}

export function replaceServiceApiTokenFile(token: string): PersistedServiceApiToken {
  const value = validatedTokenValue(token);
  const current = readServiceApiTokenState();
  if (current.kind !== "present") {
    throw new Error(current.kind === "unsafe" ? current.reason : "service token file is missing");
  }
  const path = serviceApiTokenFilePath();
  atomicWriteFile(path, `${value}\n`);
  fsyncRegularFile(path);
  return { path, fingerprint: serviceApiTokenFingerprint(value) };
}

export function readTokenBackupState(): ServiceApiTokenState {
  const path = serviceApiTokenBackupPath();
  if (!existsSync(path)) return { kind: "absent" };
  let stat;
  try { stat = lstatSync(path); }
  catch { return { kind: "unsafe", reason: "service token backup could not be inspected" }; }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_SERVICE_API_TOKEN_BYTES
    || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
    return { kind: "unsafe", reason: "service token backup is not an owner-only bounded regular file" };
  }
  try {
    const token = readFileSync(path, "utf8").trim();
    if (!token || /[\r\n\0]/.test(token)) return { kind: "unsafe", reason: "service token backup is invalid" };
    return { kind: "present", token, fingerprint: serviceApiTokenFingerprint(token) };
  } catch {
    return { kind: "unsafe", reason: "service token backup could not be read" };
  }
}

export function writeTokenBackup(expectedFingerprint: string): PersistedServiceApiToken {
  const current = readServiceApiTokenState();
  if (current.kind !== "present" || current.fingerprint !== expectedFingerprint) {
    throw new Error(current.kind === "unsafe" ? current.reason : "service token ownership changed before backup");
  }
  const existing = readTokenBackupState();
  if (existing.kind !== "absent") {
    throw new Error(existing.kind === "unsafe" ? existing.reason : "service token backup already exists");
  }
  const path = serviceApiTokenBackupPath();
  atomicWriteFile(path, `${current.token}\n`);
  fsyncRegularFile(path);
  return { path, fingerprint: current.fingerprint };
}

export function restoreTokenBackup(expectedPath: string): PersistedServiceApiToken {
  if (expectedPath !== serviceApiTokenBackupPath()) throw new Error("service token backup path mismatch");
  const backup = readTokenBackupState();
  if (backup.kind !== "present") {
    throw new Error(backup.kind === "unsafe" ? backup.reason : "service token backup is missing");
  }
  const path = serviceApiTokenFilePath();
  atomicWriteFile(path, `${backup.token}\n`);
  fsyncRegularFile(path);
  return { path, fingerprint: backup.fingerprint };
}

export function removeOrphanTokenBackup(): "removed" | "absent" {
  const backup = readTokenBackupState();
  if (backup.kind === "absent") return "absent";
  if (backup.kind === "unsafe") throw new Error(backup.reason);
  try {
    unlinkSync(serviceApiTokenBackupPath());
    return "removed";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw new Error("service token backup could not be removed", { cause: error });
  }
}

export function removeServiceApiTokenFileIfOwned(
  expectedFingerprint: string,
): "removed" | "absent" | "changed" {
  const state = readServiceApiTokenState();
  if (state.kind === "absent") return "absent";
  if (state.kind !== "present" || state.fingerprint !== expectedFingerprint) return "changed";
  try {
    unlinkSync(serviceApiTokenFilePath());
    return "removed";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw new Error("owned service API token could not be removed", { cause: error });
  }
}

/**
 * App-side service token loading (WinSW native mode has no batch wrapper to read the
 * token file into the environment). Pure: returns the token or null — the CALLER
 * assigns it to process.env.OPENCODEX_API_AUTH_TOKEN. Loads only when the env token
 * is empty and OCX_API_TOKEN_FILE names a readable file.
 */
export function loadServiceTokenFromFile(env: Record<string, string | undefined>): string | null {
  if (env.OPENCODEX_API_AUTH_TOKEN?.trim()) return null;
  const file = env.OCX_API_TOKEN_FILE?.trim();
  if (!file) return null;
  try {
    const token = readFileSync(file, "utf8").trim();
    return token || null;
  } catch {
    return null;
  }
}

/**
 * The data-plane token a boot should export, or null when the environment already has one
 * (or there is nothing to export).
 *
 * The launchd plist and the systemd unit `cat` the token file into the environment before
 * exec'ing the proxy, and WinSW native mode names it through `OCX_API_TOKEN_FILE` — so under
 * a service the server has always seen `OPENCODEX_API_AUTH_TOKEN` regardless of the calling
 * shell. A FOREGROUND `ocx start` on the same machine had neither, so `assertServerAuthConfig`
 * refused to bind a non-loopback hostname that the installed service was serving happily.
 * This closes that gap with the same precedence the wrappers use, in one place.
 *
 * `authRequired` is the caller's admission decision (`isApiAuthRequired`), passed in rather
 * than recomputed: this module must not load config, and the installed file is deliberately
 * NOT consulted on a loopback bind — on a machine connected to a hub it holds that hub's
 * issued client key, which is not this proxy's admission secret.
 */
export function startupDataPlaneToken(
  env: Record<string, string | undefined>,
  options: { authRequired: boolean },
): string | null {
  if (env.OPENCODEX_API_AUTH_TOKEN?.trim()) return null;
  const named = loadServiceTokenFromFile(env);
  if (named) return named;
  if (!options.authRequired) return null;
  const state = readServiceApiTokenState();
  return state.kind === "present" ? state.token : null;
}

/**
 * Contents of the installed service token file. The launch wrapper always re-exports
 * this file as OPENCODEX_API_AUTH_TOKEN, so doctor and start must inspect it even
 * when the calling shell has no data-plane env var.
 * Returns the token or null — never throws, never logs the value.
 */
export function readInstalledServiceToken(): string | null {
  try {
    const token = readFileSync(serviceApiTokenFilePath(), "utf8").trim();
    return token || null;
  } catch {
    return null;
  }
}
