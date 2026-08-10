import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  type Stats,
} from "node:fs";

import { hardenSecretPathAsync } from "../lib/windows-secret-acl";

export interface StableLockFile {
  readonly fd: number;
  readonly dev: number;
  readonly ino: number;
  close(): void;
}

export class StableLockPathUnsafeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StableLockPathUnsafeError";
  }
}

interface StableLockEntry {
  readonly fd: number;
  readonly dev: number;
  readonly ino: number;
  refs: number;
}

// POSIX fcntl locks are process-associated: closing any raw descriptor for an
// inode can release SQLite locks held through a different descriptor in this
// process. Keep one side descriptor per canonical lock path and close it only
// after every SQLite user has closed its connection and released its reference.
const stableLockEntries = new Map<string, StableLockEntry>();

function reference(path: string, entry: StableLockEntry): StableLockFile {
  let closed = false;
  return {
    fd: entry.fd,
    dev: entry.dev,
    ino: entry.ino,
    close() {
      if (closed) return;
      closed = true;
      entry.refs = Math.max(0, entry.refs - 1);
      if (entry.refs !== 0) return;
      if (stableLockEntries.get(path) === entry) stableLockEntries.delete(path);
      closeSync(entry.fd);
    },
  };
}

function assertRegular(stats: Stats, path: string): void {
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new StableLockPathUnsafeError(`unsafe SQLite lock path: ${path}`);
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function matches(handle: StableLockFile, stats: Stats): boolean {
  return handle.dev === stats.dev && handle.ino === stats.ino;
}

export function openStableLockFile(path: string, platform: NodeJS.Platform = process.platform): StableLockFile {
  const retained = stableLockEntries.get(path);
  if (retained) {
    retained.refs += 1;
    const handle = reference(path, retained);
    try {
      assertStableLockFile(path, handle);
      return handle;
    } catch (error) {
      handle.close();
      throw error;
    }
  }
  if (existsSync(path)) assertRegular(lstatSync(path), path);
  const noFollow = platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | noFollow, 0o600);
  try {
    const descriptor = fstatSync(fd);
    assertRegular(descriptor, path);
    const entry: StableLockEntry = {
      fd,
      dev: descriptor.dev,
      ino: descriptor.ino,
      refs: 1,
    };
    stableLockEntries.set(path, entry);
    const handle = reference(path, entry);
    assertStableLockFile(path, handle);
    return handle;
  } catch (error) {
    const entry = stableLockEntries.get(path);
    if (entry?.fd === fd) stableLockEntries.delete(path);
    closeSync(fd);
    throw error;
  }
}

export function assertStableLockFile(path: string, handle: StableLockFile): void {
  let pathStats: Stats;
  try {
    pathStats = lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new StableLockPathUnsafeError(`SQLite lock path identity changed: ${path}`);
    }
    throw error;
  }
  assertRegular(pathStats, path);
  if (!matches(handle, pathStats)) {
    throw new StableLockPathUnsafeError(`SQLite lock path identity changed: ${path}`);
  }
}

/**
 * Harden the stable lock file: chmod everywhere, per-user NTFS ACLs on Windows.
 *
 * The platform is a parameter rather than a direct `process.platform` read so the
 * Windows branch is reachable from a test. It was not, and an audit deleted the
 * whole ACL delegation without a single test noticing — the primitive underneath
 * had 73 tests while the call edge that activates it had none. That is the same
 * absence-as-guarantee defect one layer up: proving a mechanism works says nothing
 * about whether production still calls it.
 *
 * `required: true` is deliberate: a failure to apply the ACL must reject rather
 * than leave a coordinator database readable by other accounts.
 */
export async function hardenStableLockFile(
  path: string,
  platform: NodeJS.Platform = process.platform,
  options: { retryTimedOutOnce?: boolean } = {},
): Promise<void> {
  if (platform === "win32") {
    // Best-effort here: POSIX modes are not authoritative on NTFS, and the
    // required ACL hardening below is what actually decides.
    try { chmodSync(path, 0o600); } catch { /* ACL below is authoritative. */ }
    await hardenSecretPathAsync(path, {
      required: true,
      retryTimedOutOnce: options.retryTimedOutOnce,
    });
    return;
  }
  // On POSIX the mode IS the mechanism, so a failure may not be swallowed.
  //
  // The previous unconditional catch was a real fail-open: a coordinator
  // database that already existed with permissive bits stayed permissive, and
  // the caller was told the lock file had been hardened. Creation mode 0600 does
  // not repair an existing file, and there is no ACL fallback outside Windows.
  chmodSync(path, 0o600);
}
