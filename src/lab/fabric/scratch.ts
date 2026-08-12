import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  writeSync,
  type Stats,
} from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { ensureLabDirs, ensureRestrictedDir, labRoot, labScratchDir } from "../paths";
import { FABRIC_LIMITS, SYNTHETIC_BEFORE_UTF8, SYNTHETIC_VALUE_PATH } from "./constants";
import { FabricTaskError } from "./types";

/** CL-07 restricted scratch tree IO for the synthetic-patch fabric task. */

const O_DIRECTORY = (fsConstants as { O_DIRECTORY?: number }).O_DIRECTORY;
const O_NOFOLLOW = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW;
const FILE_MODE = 0o600;

interface TrustedScratchDir {
  path: string;
  fd: number;
  identity: string;
}

/** Require stats to describe a regular file, not a symlink or special node. */
function assertRegularFile(stats: Stats, label: string): void {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.isDirectory() || stats.isFIFO() || stats.isSocket() || stats.isCharacterDevice() || stats.isBlockDevice()) {
    throw new FabricTaskError(`${label} must be a regular file`, "sandbox_violation", "harness");
  }
}

/** Require stats to describe a real directory, not a symlink. */
function assertRealDirectory(stats: Stats, label: string): void {
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new FabricTaskError(`${label} must be a real directory`, "sandbox_violation", "harness");
  }
}

/** Stable device/inode identity string for a filesystem node. */
function identityOf(stats: Stats): string {
  return `${stats.dev}:${stats.ino}`;
}

/** Whether the host supports O_NOFOLLOW for scratch open operations. */
function platformSupportsNoFollow(): boolean {
  return typeof O_NOFOLLOW === "number" && O_NOFOLLOW !== 0;
}

/** Compose open flags, optionally adding O_NOFOLLOW when supported. */
function openFlags(base: number, noFollow = true): number {
  if (noFollow && platformSupportsNoFollow()) return base | O_NOFOLLOW!;
  return base;
}

/** Reject scratch relative names that traverse or embed forbidden characters. */
function assertScratchName(name: string): void {
  if (name.includes("/") || name.includes("\\") || name.includes("..") || name.includes("\0")) {
    throw new FabricTaskError("invalid scratch relative name", "sandbox_violation", "harness");
  }
}

/** Confirm the scratch root path still refers to the same directory inode. */
function revalidateScratchDir(dir: TrustedScratchDir): void {
  const stats = lstatSync(dir.path);
  assertRealDirectory(stats, "scratch dir");
  if (identityOf(stats) !== dir.identity) {
    throw new FabricTaskError("scratch directory identity changed", "sandbox_violation", "harness");
  }
}

/** Resolve a single path segment under a trusted scratch directory. */
function childScratchPath(dir: TrustedScratchDir, name: string): string {
  revalidateScratchDir(dir);
  assertScratchName(name);
  return join(dir.path, name);
}

/** Open a single name relative to a trusted scratch directory using pinned paths. */
function openAtScratch(dir: TrustedScratchDir, name: string, flags: number, mode = 0, expectDirectory = false): number {
  revalidateScratchDir(dir);
  assertScratchName(name);
  const path = childScratchPath(dir, name);
  const fd = openSync(path, openFlags(flags), mode);
  const opened = fstatSync(fd);
  if (expectDirectory) {
    assertRealDirectory(opened, name);
  } else {
    assertRegularFile(opened, name);
    const pathEntry = lstatSync(path);
    if (identityOf(opened) !== identityOf(pathEntry)) {
      throw new FabricTaskError("scratch path redirection detected", "sandbox_violation", "harness");
    }
  }
  return fd;
}

/** Pin an absolute scratch root path into a trusted directory handle. */
function openTrustedScratchRoot(scratchRoot: string): TrustedScratchDir {
  const abs = resolve(scratchRoot);
  let fd: number;
  if (typeof O_DIRECTORY === "number") {
    fd = openSync(abs, openFlags(fsConstants.O_RDONLY | O_DIRECTORY, true));
  } else {
    fd = openSync(abs, fsConstants.O_RDONLY);
  }
  const stats = fstatSync(fd);
  assertRealDirectory(stats, "scratch root");
  return { path: abs, fd, identity: identityOf(stats) };
}

/** Close a trusted scratch directory handle. */
function closeTrustedScratchRoot(dir: TrustedScratchDir): void {
  try {
    closeSync(dir.fd);
  } catch {
    /* ignore */
  }
}

/** Open a relative scratch path by walking trusted directory handles. */
function openScratchRelativePath(
  root: TrustedScratchDir,
  relativePath: string,
  flags: number,
  mode: number,
): number {
  const parts = assertSafeRelativePosixPath(relativePath).split("/");
  let current = root;
  const intermediateFds: number[] = [];
  try {
    for (let i = 0; i < parts.length; i++) {
      const isFinal = i === parts.length - 1;
      const part = parts[i]!;
      if (!isFinal) {
        const dirFlags = typeof O_DIRECTORY === "number"
          ? openFlags(fsConstants.O_RDONLY | O_DIRECTORY, true)
          : openFlags(fsConstants.O_RDONLY, true);
        const subFd = openAtScratch(current, part, dirFlags, 0, true);
        intermediateFds.push(subFd);
        const subStats = fstatSync(subFd);
        assertRealDirectory(subStats, part);
        current = { path: join(current.path, part), fd: subFd, identity: identityOf(subStats) };
        continue;
      }
      return openAtScratch(current, part, flags, mode);
    }
    throw new FabricTaskError("empty scratch path", "sandbox_violation", "harness");
  } finally {
    for (const fd of intermediateFds) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Read exactly size bytes from an open scratch file descriptor. */
function readAllFromFd(fd: number, size: number): string {
  const buf = Buffer.alloc(size);
  let offset = 0;
  while (offset < buf.length) {
    const n = readSync(fd, buf, offset, buf.length - offset, offset);
    if (n <= 0) break;
    offset += n;
  }
  if (offset !== size) {
    throw new FabricTaskError("short read from scratch file", "sandbox_violation", "harness");
  }
  return buf.toString("utf8");
}

/** Normalize and reject traversal / absolute / Windows drive / NUL paths. */
export function assertSafeRelativePosixPath(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new FabricTaskError("path required", "sandbox_violation", "harness");
  }
  if (raw.includes("\0") || raw.includes("\\")) {
    throw new FabricTaskError("path contains forbidden characters", "sandbox_violation", "harness");
  }
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
    throw new FabricTaskError("absolute paths are forbidden", "sandbox_violation", "harness");
  }
  const normalized = posix.normalize(raw);
  if (normalized === "." || normalized.startsWith("../") || normalized === ".." || normalized.includes("/../")) {
    throw new FabricTaskError("path traversal is forbidden", "sandbox_violation", "harness");
  }
  if (normalized.split("/").some((part) => part === ".." || part === "")) {
    throw new FabricTaskError("invalid path segments", "sandbox_violation", "harness");
  }
  return normalized;
}

/** Prove a resolved path remains under the scratch root prefix. */
function assertUnderScratchRoot(root: string, target: string): void {
  if (target !== root && !target.startsWith(root + sep)) {
    throw new FabricTaskError("path escapes scratch root", "sandbox_violation", "harness");
  }
}

/**
 * Resolve a relative path under scratch without following intermediate symlinks.
 * Missing final component is allowed (for create); intermediate components must exist.
 */
export function resolveInsideScratch(scratchRoot: string, relativePath: string, opts: { allowMissingFinal?: boolean } = {}): string {
  const safe = assertSafeRelativePosixPath(relativePath);
  const root = resolve(scratchRoot);
  const rootStats = lstatSync(root);
  assertRealDirectory(rootStats, "scratch root");

  let current = root;
  const parts = safe.split("/");
  for (let i = 0; i < parts.length; i++) {
    const next = join(current, parts[i]!);
    assertUnderScratchRoot(root, next);
    const isFinal = i === parts.length - 1;
    if (!existsSync(next)) {
      if (isFinal && opts.allowMissingFinal) return next;
      throw new FabricTaskError(isFinal ? `missing file ${relativePath}` : "missing intermediate directory", "sandbox_violation", "harness");
    }
    const stats = lstatSync(next);
    if (stats.isSymbolicLink()) {
      throw new FabricTaskError("symlink rejected", "sandbox_violation", "harness");
    }
    if (!isFinal) {
      assertRealDirectory(stats, next);
    }
    current = next;
  }
  return current;
}

/** Create a relative directory tree under scratch without following symlink components. */
function ensureScratchRelativeDir(scratchRoot: string, relativeDir: string): void {
  const safe = assertSafeRelativePosixPath(relativeDir);
  const root = resolve(scratchRoot);
  const rootStats = lstatSync(root);
  assertRealDirectory(rootStats, "scratch root");
  let current = root;
  for (const part of safe.split("/")) {
    const next = join(current, part);
    assertUnderScratchRoot(root, next);
    if (!existsSync(next)) {
      try {
        mkdirSync(next, { mode: 0o700 });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
      }
    }
    const stats = lstatSync(next);
    if (stats.isSymbolicLink()) {
      throw new FabricTaskError("symlink rejected", "sandbox_violation", "harness");
    }
    assertRealDirectory(stats, next);
    current = next;
  }
}

/** Handle for a fabric scratch tree and its best-effort cleanup callback. */
export interface ScratchTree {
  root: string;
  cleanup: () => void;
}

/** Create an isolated scratch tree with the frozen synthetic-patch fixture file. */
export function createSyntheticScratch(configDir?: string): ScratchTree {
  ensureLabDirs(configDir);
  const labBoundary = labRoot(configDir);
  const base = labScratchDir(configDir);
  ensureRestrictedDir(base, labBoundary);
  const root = join(base, `fabric-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`);
  let trusted: TrustedScratchDir | undefined;
  try {
    ensureRestrictedDir(root, labBoundary);
    ensureRestrictedDir(join(root, dirname(SYNTHETIC_VALUE_PATH)), labBoundary);
    trusted = openTrustedScratchRoot(root);
    const bytes = Buffer.from(SYNTHETIC_BEFORE_UTF8, "utf8");
    if (bytes.byteLength > FABRIC_LIMITS.maxAggregateIoBytes) {
      throw new FabricTaskError("fixture exceeds io budget", "budget_exhausted", "harness");
    }
    const fd = openScratchRelativePath(
      trusted,
      SYNTHETIC_VALUE_PATH,
      openFlags(fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, true),
      FILE_MODE,
    );
    try {
      writeSync(fd, bytes);
    } finally {
      closeSync(fd);
    }
    const trustedForCleanup = trusted;
    return {
      root,
      cleanup: () => {
        closeTrustedScratchRoot(trustedForCleanup);
        try {
          rmSync(root, { recursive: true, force: true, maxRetries: 3 });
        } catch {
          // best-effort cleanup
        }
      },
    };
  } catch (error) {
    if (trusted) closeTrustedScratchRoot(trusted);
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* best-effort */
    }
    throw error;
  }
}

/** One regular file discovered during a bounded scratch tree walk. */
export interface WalkedFile {
  relativePosix: string;
  absolute: string;
  byteLength: number;
}

/** No-follow walk; rejects symlinks and special files; enforces file/byte budgets. */
export function walkScratchFiles(scratchRoot: string): WalkedFile[] {
  const root = resolve(scratchRoot);
  const rootStats = lstatSync(root);
  assertRealDirectory(rootStats, "scratch root");
  const out: WalkedFile[] = [];
  const stack: string[] = [root];
  let aggregateBytes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    const stats = lstatSync(current);
    if (stats.isSymbolicLink()) {
      throw new FabricTaskError("symlink rejected", "sandbox_violation", "harness");
    }
    if (stats.isDirectory()) {
      const entries = readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        stack.push(join(current, entry.name));
      }
      continue;
    }
    assertRegularFile(stats, current);
    if (out.length >= FABRIC_LIMITS.maxScratchFiles) {
      throw new FabricTaskError("scratch file count exceeds budget", "budget_exhausted", "harness");
    }
    aggregateBytes += stats.size;
    if (aggregateBytes > FABRIC_LIMITS.maxAggregateIoBytes) {
      throw new FabricTaskError("scratch aggregate bytes exceed budget", "budget_exhausted", "harness");
    }
    const rel = relative(root, current).split(sep).join("/");
    const safe = assertSafeRelativePosixPath(rel);
    out.push({ relativePosix: safe, absolute: current, byteLength: stats.size });
  }
  out.sort((a, b) => {
    const left = Buffer.from(a.relativePosix, "utf8");
    const right = Buffer.from(b.relativePosix, "utf8");
    const n = Math.min(left.length, right.length);
    for (let i = 0; i < n; i++) {
      const d = left[i]! - right[i]!;
      if (d !== 0) return d;
    }
    return left.length - right.length;
  });
  return out;
}

/** Read a scratch file as UTF-8 text under a byte budget. */
export function readScratchFileUtf8(scratchRoot: string, relativePath: string, maxBytes: number): string {
  resolveInsideScratch(scratchRoot, relativePath);
  const trusted = openTrustedScratchRoot(scratchRoot);
  try {
    const fd = openScratchRelativePath(trusted, relativePath, openFlags(fsConstants.O_RDONLY, true), 0);
    try {
      const stats = fstatSync(fd);
      assertRegularFile(stats, relativePath);
      if (stats.size > maxBytes) {
        throw new FabricTaskError("file exceeds io budget", "budget_exhausted", "environment");
      }
      return readAllFromFd(fd, stats.size);
    } finally {
      closeSync(fd);
    }
  } finally {
    closeTrustedScratchRoot(trusted);
  }
}

/** Write UTF-8 content to a scratch file, replacing any existing bytes. */
export function writeScratchFileUtf8(scratchRoot: string, relativePath: string, contentUtf8: string, maxBytes: number): number {
  const bytes = Buffer.from(contentUtf8, "utf8");
  if (bytes.byteLength > maxBytes) {
    throw new FabricTaskError("write exceeds io budget", "budget_exhausted", "environment");
  }
  const safe = assertSafeRelativePosixPath(relativePath);
  const parentPath = safe.includes("/") ? safe.slice(0, safe.lastIndexOf("/")) : "";
  resolveInsideScratch(scratchRoot, relativePath, { allowMissingFinal: true });
  if (parentPath) {
    ensureScratchRelativeDir(scratchRoot, parentPath);
  }
  const trusted = openTrustedScratchRoot(scratchRoot);
  try {
    const fd = openScratchRelativePath(
      trusted,
      relativePath,
      openFlags(fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC, true),
      FILE_MODE,
    );
    try {
      const stats = fstatSync(fd);
      assertRegularFile(stats, relativePath);
      writeSync(fd, bytes);
    } finally {
      closeSync(fd);
    }
  } finally {
    closeTrustedScratchRoot(trusted);
  }
  return bytes.byteLength;
}

/** Prove the resolved path cannot escape into a caller-provided user repository root. */
export function assertNotUnderUserRepo(scratchRoot: string, userRepoRoot: string): void {
  const scratch = resolve(scratchRoot);
  const repo = resolve(userRepoRoot);
  if (scratch === repo || scratch.startsWith(repo + sep)) {
    throw new FabricTaskError("scratch must not live inside user repository", "sandbox_violation", "harness");
  }
}
