import { closeSync, linkSync, lstatSync, openSync, readSync, realpathSync, renameSync, unlinkSync } from "node:fs";
import { posix, sep, win32 } from "node:path";
import { SHIM_MARKER } from "./shim-templates";
import { fileErrorCode, type ShimFileState } from "./shim-state-file";

type PlatformPath = typeof win32;

/**
 * Validation for the legacy Codex shim record (codex-shim.json without schema/mode), which
 * Windows installs still write. Every path a restore acts on is derived from the layout
 * OpenCodex itself writes: launchers with fixed names, a backup that is the
 * `.opencodex-real` sibling of the original, and all of them in one directory. The checks are
 * pure functions over an injected path flavor so every OS can test them.
 */

/** Path flavor of the host filesystem; independent of a test-overridden process.platform. */
export function hostShimPathApi(): PlatformPath {
  return sep === "\\" ? win32 : posix;
}

/** The backup name OpenCodex gives an original launcher: the suffix goes before the extension. */
export function legacyShimBackupPath(path: string, api: PlatformPath = hostShimPathApi()): string {
  const ext = api.extname(path);
  return ext ? `${path.slice(0, -ext.length)}.opencodex-real${ext}` : `${path}.opencodex-real`;
}

/** In-place wrappers: the launcher npm writes is replaced by the shim at the same path. */
const IN_PLACE_LAUNCHERS = new Set(["codex.cmd", "codex.ps1", "codex"]);
/** The earliest Windows installs wrote codex.cmd next to the original launcher. */
const SIDE_BY_SIDE_ORIGINAL = /^codex(\.(exe|com|bat|cmd|ps1))?$/i;
const MAX_LEGACY_ENTRIES = 3;
const BACKUP_MARKER_SCAN_BYTES = 16 * 1024;

export type LegacyShimRecordVerdict =
  | { ok: true; files: ShimFileState[]; directory: string }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function pathProblem(path: unknown, api: PlatformPath): string | null {
  if (typeof path !== "string" || path.length === 0) return "a launcher path is missing";
  if (/[\x00-\x1f\x7f]/.test(path)) return "a launcher path contains control characters";
  if (api === win32) {
    if (!/^[A-Za-z]:\\/.test(path)) return "a launcher path is not an absolute drive path";
    if (path.indexOf(":", 2) !== -1 || /[<>"|?*/]/.test(path)) return "a launcher path contains reserved characters";
    if (path.slice(3).split("\\").some(segment => segment.length === 0 || /[. ]$/.test(segment))) {
      return "a launcher path is not normalized";
    }
  } else if (!path.startsWith("/")) {
    return "a launcher path is not absolute";
  }
  if (api.normalize(path) !== path || path.endsWith(api.sep)) return "a launcher path is not normalized";
  return null;
}

function nameKey(path: string, api: PlatformPath): string {
  return api.basename(path).toLowerCase();
}

/** Lexical validation: shape, platform, and the exact layout an OpenCodex install writes. */
export function validateLegacyWindowsShimRecord(value: unknown, api: PlatformPath = hostShimPathApi()): LegacyShimRecordVerdict {
  const fail = (reason: string): LegacyShimRecordVerdict => ({ ok: false, reason });
  if (!isRecord(value)) return fail("the shim record is not an object");
  if (value.schema !== undefined || value.mode !== undefined) return fail("the shim record is not a Windows install record");
  if (value.platform !== "win32") return fail("the shim record was not written by a Windows install");
  const entries: unknown = value.wrappers !== undefined ? value.wrappers : [value];
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_LEGACY_ENTRIES) {
    return fail("the shim record lists an unexpected number of launchers");
  }
  const files: ShimFileState[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) return fail("a shim record entry is not an object");
    for (const key of ["wrapperPath", "originalPath", "backupPath"] as const) {
      const problem = pathProblem(entry[key], api);
      if (problem) return fail(problem);
    }
    const file = { wrapperPath: entry.wrapperPath as string, originalPath: entry.originalPath as string, backupPath: entry.backupPath as string };
    if (entry.realPath !== undefined && entry.realPath !== file.backupPath) return fail("a launcher points at an unexpected backing file");
    if (entry.preserveOnly !== undefined && entry.preserveOnly !== false) return fail("a launcher entry has an unexpected mode");
    const directory = api.dirname(file.wrapperPath);
    if (api.dirname(file.originalPath) !== directory || api.dirname(file.backupPath) !== directory) {
      return fail("the launcher, its original and its backup are not in one directory");
    }
    if (file.wrapperPath === file.originalPath) {
      if (!IN_PLACE_LAUNCHERS.has(nameKey(file.wrapperPath, api))) return fail("a launcher has an unexpected name");
    } else if (entries.length !== 1 || nameKey(file.wrapperPath, api) !== "codex.cmd"
      || !SIDE_BY_SIDE_ORIGINAL.test(api.basename(file.originalPath)) || nameKey(file.originalPath, api) === "codex.cmd") {
      return fail("a launcher has an unexpected name");
    }
    if (file.backupPath !== legacyShimBackupPath(file.originalPath, api)) return fail("a backup is not the expected sibling of its original");
    files.push(file);
  }
  if (value.wrappers !== undefined) {
    const first = files[0]!;
    for (const key of ["wrapperPath", "originalPath", "backupPath"] as const) {
      if (value[key] !== undefined && value[key] !== first[key]) return fail("the shim record summary disagrees with its launcher list");
    }
  }
  const directory = api.dirname(files[0]!.wrapperPath);
  // Exact spelling: Windows directories can be case-sensitive, so differently cased names may differ.
  if (files.some(file => api.dirname(file.wrapperPath) !== directory)) {
    return fail("the launchers are not in one directory");
  }
  if (new Set(files.map(file => nameKey(file.wrapperPath, api))).size !== files.length) return fail("a launcher is listed twice");
  return { ok: true, files, directory };
}

export interface LegacyShimDiskDeps {
  lstat?: (path: string) => { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; size: number | bigint; nlink?: number | bigint; dev?: number | bigint; ino?: number | bigint };
  realpath?: (path: string) => string;
  readPrefix?: (path: string, bytes: number) => string;
}

export type LegacyShimDirectoryVerdict =
  /** `resolved` is null when the recorded directory no longer exists: nothing to act on. */
  | { ok: true; resolved: string | null; identity: string | null }
  | { ok: false; reason: string };

function defaultReadPrefix(path: string, bytes: number): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    let total = 0;
    while (total < bytes) {
      const count = readSync(fd, buffer, total, bytes - total, total);
      if (count === 0) break;
      total += count;
    }
    return buffer.subarray(0, total).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Resolves the recorded directory once and requires the resolved chain to hold only real
 * directories. A link in the recorded spelling (an nvm-windows or scoop prefix) is accepted:
 * it can only select a directory the record could name directly, and callers act on the
 * resolved directory.
 */
const defaultLstat = (path: string) => lstatSync(path, { bigint: true });

export function resolveLegacyShimDirectory(recordedDirectory: string, api: PlatformPath = hostShimPathApi(), deps: LegacyShimDiskDeps = {}): LegacyShimDirectoryVerdict {
  const lstat = deps.lstat ?? defaultLstat;
  const realpath = deps.realpath ?? realpathSync.native;
  let resolved: string;
  try {
    resolved = realpath(recordedDirectory);
  } catch (error) {
    const code = fileErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: true, resolved: null, identity: null };
    return { ok: false, reason: "the launcher directory could not be resolved" };
  }
  if (!api.isAbsolute(resolved)) return { ok: false, reason: "the launcher directory could not be resolved" };
  let identity: string | null = null;
  try {
    for (let current = resolved; ; current = api.dirname(current)) {
      const entry = lstat(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) return { ok: false, reason: "the launcher directory resolves through a link" };
      // Device and inode: a directory replaced at the same path is a different directory.
      if (current === resolved) identity = `${entry.dev}:${entry.ino}`;
      if (api.dirname(current) === current) break;
    }
  } catch {
    return { ok: false, reason: "the launcher directory could not be inspected" };
  }
  return { ok: true, resolved, identity };
}

type EntryShape = "absent" | "file" | "shared" | "other";

function entryShape(path: string, lstat: NonNullable<LegacyShimDiskDeps["lstat"]>): { shape: EntryShape; size: number } {
  try {
    const entry = lstat(path);
    if (entry.isSymbolicLink() || !entry.isFile()) return { shape: "other", size: 0 };
    if (Number(entry.nlink ?? 1) > 1) return { shape: "shared", size: Number(entry.size) };
    return { shape: "file", size: Number(entry.size) };
  } catch (error) {
    if (fileErrorCode(error) === "ENOENT") return { shape: "absent", size: 0 };
    return { shape: "other", size: 0 };
  }
}

/** File shapes inside the resolved directory: launchers are regular files, a backup is a non-empty non-shim file. */
export function legacyShimFilesProblem(files: readonly ShimFileState[], resolvedDirectory: string, api: PlatformPath = hostShimPathApi(), deps: LegacyShimDiskDeps = {}): string | null {
  const lstat = deps.lstat ?? defaultLstat;
  const readPrefix = deps.readPrefix ?? defaultReadPrefix;
  for (const file of files) {
    for (const launcher of new Set([file.wrapperPath, file.originalPath])) {
      const shape = entryShape(api.join(resolvedDirectory, api.basename(launcher)), lstat).shape;
      if (shape === "other") return "a launcher is not a regular file";
      if (shape === "shared") return "a launcher shares its file with another path";
    }
    const backupPath = api.join(resolvedDirectory, api.basename(file.backupPath));
    const backup = entryShape(backupPath, lstat);
    if (backup.shape === "absent") continue;
    if (backup.shape !== "file" || backup.size === 0) return "a backup is not a non-empty regular file";
    try {
      if (readPrefix(backupPath, BACKUP_MARKER_SCAN_BYTES).includes(SHIM_MARKER)) return "a backup is itself a shim";
    } catch {
      return "a backup could not be read";
    }
  }
  return null;
}

export type LegacyShimCheck =
  | { ok: true; files: ShimFileState[]; recordedDirectory: string; resolvedDirectory: string | null; directoryIdentity: string | null }
  | { ok: false; reason: string };

/** Lexical layout, resolved directory, and file shapes, in that order. */
export function checkLegacyShimRecord(value: unknown, api: PlatformPath = hostShimPathApi(), deps: LegacyShimDiskDeps = {}): LegacyShimCheck {
  const record = validateLegacyWindowsShimRecord(value, api);
  if (!record.ok) return record;
  const directory = resolveLegacyShimDirectory(record.directory, api, deps);
  if (!directory.ok) return directory;
  if (directory.resolved !== null) {
    const problem = legacyShimFilesProblem(record.files, directory.resolved, api, deps);
    if (problem) return { ok: false, reason: problem };
  }
  return { ok: true, files: record.files, recordedDirectory: record.directory, resolvedDirectory: directory.resolved, directoryIdentity: directory.identity };
}

/** A launcher a fresh install backs up must be a non-empty file; an empty backup is refused by every later restore. */
export function legacyShimFreshLaunchersProblem(files: readonly ShimFileState[], resolvedDirectory: string | null, api: PlatformPath = hostShimPathApi(), deps: LegacyShimDiskDeps = {}): string | null {
  if (resolvedDirectory === null) return "the launcher directory is missing";
  const lstat = deps.lstat ?? defaultLstat;
  for (const file of files) {
    const original = entryShape(api.join(resolvedDirectory, api.basename(file.originalPath)), lstat);
    if (original.shape !== "file" || original.size === 0) return "a launcher is empty or not a regular file";
  }
  return null;
}

/** True when the recorded directory still resolves to the same link-free directory, by path and identity. */
export function legacyShimDirectoryUnchanged(recordedDirectory: string, resolvedDirectory: string | null, identity: string | null, api: PlatformPath = hostShimPathApi(), deps: LegacyShimDiskDeps = {}): boolean {
  const now = resolveLegacyShimDirectory(recordedDirectory, api, deps);
  return now.ok && now.resolved === resolvedDirectory && now.identity === identity;
}

let mutationGuard: (() => void) | null = null;

/**
 * Binds every later Windows shim mutation to a validated record until the returned release runs:
 * each rename, link, unlink and write first checks that the recorded directory still resolves to
 * the directory that was validated.
 */
export function setLegacyShimMutationGuard(check: Extract<LegacyShimCheck, { ok: true }> | null): () => void {
  const previous = mutationGuard;
  mutationGuard = check && (() => {
    if (!legacyShimDirectoryUnchanged(check.recordedDirectory, check.resolvedDirectory, check.directoryIdentity)) {
      throw new Error("Codex shim launcher directory changed after validation; refusing to modify it");
    }
  });
  return () => { mutationGuard = previous; };
}

/** Throws when a guarded Windows shim operation would act outside its validated directory. */
export function assertLegacyShimMutationAllowed(): void {
  mutationGuard?.();
}

/*
 * The Windows shim modules import these instead of the node:fs calls, so every rename, unlink and
 * link they make checks the active guard immediately before it runs. Without a guard they are the
 * plain calls.
 */
export function guardedRenameSync(from: string, to: string): void {
  assertLegacyShimMutationAllowed();
  renameSync(from, to);
}

export function guardedUnlinkSync(path: string): void {
  assertLegacyShimMutationAllowed();
  unlinkSync(path);
}

export function guardedLinkSync(from: string, to: string): void {
  assertLegacyShimMutationAllowed();
  linkSync(from, to);
}

export function legacyShimManualRestoreMessage(reason: string, statePath: string, partial = false): string {
  const changed = partial
    ? "The remaining launcher files were left as they are."
    : "No launcher file was renamed or deleted.";
  return `Codex autostart shim needs manual restore: ${reason}. ${changed} If Codex no longer starts, rename the launcher backup that carries the ".opencodex-real" suffix back to its original name, then delete ${statePath} and rerun.`;
}
