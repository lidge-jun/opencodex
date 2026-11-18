import { closeSync, lstatSync, openSync } from "node:fs";

/** The files SQLite opens next to a database: the rollback journal, and the WAL and its index. */
export const SQLITE_SIDECAR_SUFFIXES = ["-journal", "-wal", "-shm"] as const;

/** A database or sidecar name holds something other than a private regular file. Carries no path. */
export class UnsafeSqlitePathError extends Error {
  constructor() {
    super("SQLite storage path is not a private regular file");
    this.name = "UnsafeSqlitePathError";
  }
}

const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const INVALID_FILE_ATTRIBUTES = 0xffffffff;
type ReparseProbe = (path: string) => boolean;
let nativeAttributes: ((path: string) => number) | undefined;
let probeForTests: ReparseProbe | null = null;
/**
 * Whether the native attribute query runs: on Windows, except ARM64, whose Bun build cannot execute
 * `bun:ffi` (the limitation src/lib/windows-user-principal.ts works around). There `lstat` still
 * reports symbolic links, junctions and app execution aliases as links; other reparse tags are not
 * visible without native code.
 */
export function nativeReparseProbeApplies(platform: string, arch: string): boolean {
  return platform === "win32" && arch !== "arm64";
}
// Read once at load: tests replace `process.platform` to drive Windows-only branches on POSIX, and
// the native query must follow the system the process actually runs on.
const NATIVE_ATTRIBUTES = nativeReparseProbeApplies(process.platform, process.arch);

function errorCode(error: unknown): unknown {
  return error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
}

/**
 * Whether the entry at `path` itself is a Windows reparse point: a symbolic link, a junction, or any
 * other tag. `GetFileAttributesW` reports the named entry rather than what it points to, so this
 * sees what `lstat` cannot classify. Throws when the attribute cannot be read.
 */
export function isWindowsReparsePoint(path: string): boolean {
  if (!nativeAttributes) {
    // Loaded on first use, only on Windows; the repository's other Windows file checks use the same call.
    const ffi = require("bun:ffi") as typeof import("bun:ffi");
    const kernel = ffi.dlopen("kernel32.dll", {
      GetFileAttributesW: { args: [ffi.FFIType.ptr], returns: ffi.FFIType.u32 },
    });
    nativeAttributes = (name: string) => {
      const wide = Buffer.from(`${name}\0`, "utf16le");
      return kernel.symbols.GetFileAttributesW(ffi.ptr(wide)) >>> 0;
    };
  }
  const attributes = nativeAttributes(path);
  if (attributes === INVALID_FILE_ATTRIBUTES) throw new Error("file attributes unavailable");
  return (attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0;
}

/** Test seam: replace the reparse-point probe on every platform; null restores the default. */
export function setSqlitePathReparseProbeForTests(probe: ReparseProbe | null): void {
  probeForTests = probe;
}

function isReparsePoint(path: string): boolean {
  if (probeForTests) return probeForTests(path);
  return NATIVE_ATTRIBUTES && isWindowsReparsePoint(path);
}

/**
 * Refuse unless nothing is at `path` or it is a private regular file: not a link or other reparse
 * point, not a directory, a single directory entry, and on POSIX owned by this user. Returns
 * whether an entry exists. A probe that cannot answer refuses.
 */
export function assertPrivateSqliteEntryOrMissing(path: string): boolean {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
  let reparse: boolean;
  try {
    reparse = isReparsePoint(path);
  } catch {
    throw new UnsafeSqlitePathError();
  }
  if (
    reparse
    || !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || (process.platform !== "win32" && stat.uid !== process.getuid!())
  ) throw new UnsafeSqlitePathError();
  return true;
}

/**
 * Refuse unless every sidecar of `databasePath` is absent or a private regular file. SQLite's POSIX
 * VFS opens them with O_NOFOLLOW; its Windows VFS opens them by name with CreateFileW, which follows
 * a link planted there. Check before opening the database and before every write transaction: the
 * rollback journal is created and deleted per transaction. Something planted after the check, while
 * SQLite opens the file, is outside what this can see.
 */
export function assertPrivateSqliteSidecars(databasePath: string): void {
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) assertPrivateSqliteEntryOrMissing(databasePath + suffix);
}

/**
 * Make sure `databasePath` is a private regular file without creating anything through a link at
 * its name or at a sidecar's. POSIX O_CREAT|O_EXCL refuses a link at the final component, but
 * Windows CREATE_NEW follows a dangling file symlink and creates its target, so every entry is
 * checked before the create. An entry planted between the check and the create is not covered;
 * callers check the file again after hardening it.
 */
export function preparePrivateSqliteDatabase(databasePath: string): void {
  assertPrivateSqliteSidecars(databasePath);
  if (assertPrivateSqliteEntryOrMissing(databasePath)) return;
  try {
    closeSync(openSync(databasePath, "wx", 0o600));
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  if (!assertPrivateSqliteEntryOrMissing(databasePath)) throw new UnsafeSqlitePathError();
}
