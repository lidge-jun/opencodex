/**
 * Descriptor/handle-bound, no-follow artifact I/O for the Compatibility Lab store.
 *
 * POSIX runtimes use directory-relative `dir` opens. Windows uses the same pinned
 * directory identity checks as other reviewed OpenCodex bounded readers, because
 * directory-relative child opens are not durable there.
 */
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import {
  ARTIFACT_FILENAME_EXT,
  MAX_BYTES_PER_ARTIFACT,
} from "../constants";
import { artifactBytesDigest, isSha256Hex } from "../digest";

export class ArtifactFsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ArtifactFsError";
    this.code = code;
  }
}

export function harnessFailure(message: string, code = "harness_failure"): never {
  throw new ArtifactFsError(code, message);
}

const O_RDONLY = fsConstants.O_RDONLY;
const O_RDWR = fsConstants.O_RDWR;
const O_CREAT = fsConstants.O_CREAT;
const O_EXCL = fsConstants.O_EXCL;
const O_NOFOLLOW = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW;
const O_DIRECTORY = (fsConstants as { O_DIRECTORY?: number }).O_DIRECTORY;

type ArtifactIoMode = "dirfd" | "win32_pinned";

let artifactIoMode: ArtifactIoMode | null = null;

export function assertDigestName(digest: string): string {
  if (!isSha256Hex(digest)) harnessFailure("artifact digest must be lowercase sha256 hex");
  if (digest.includes("/") || digest.includes("\\") || digest.includes(":") || digest.includes("..")) {
    harnessFailure("artifact digest must not contain path separators");
  }
  return digest;
}

export function digestFileName(digest: string): string {
  return `${assertDigestName(digest)}${ARTIFACT_FILENAME_EXT}`;
}

function platformSupportsNoFollow(): boolean {
  return typeof O_NOFOLLOW === "number" && O_NOFOLLOW !== 0;
}

function openFlags(base: number, noFollow: boolean): number {
  if (noFollow && platformSupportsNoFollow()) return base | O_NOFOLLOW!;
  return base;
}

function assertRegularFileStats(stats: Stats, label: string): void {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.isDirectory() ||
    stats.isFIFO() ||
    stats.isSocket() ||
    stats.isCharacterDevice() ||
    stats.isBlockDevice()
  ) {
    harnessFailure(`${label}: not a regular file`, "artifact_unsafe_target");
  }
  if (stats.nlink !== 1) {
    harnessFailure(`${label}: hard links prohibited (nlink=${stats.nlink})`, "artifact_unsafe_target");
  }
}

function assertDirectoryStats(stats: Stats, label: string): void {
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    harnessFailure(`${label}: must be a real directory (no symlink/reparse redirection)`, "artifact_unsafe_target");
  }
}

function identityOf(stats: Stats): string {
  return `${stats.dev}:${stats.ino}`;
}

function assertRelativeName(name: string): void {
  if (name.includes("..") || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    harnessFailure("invalid relative artifact name", "artifact_unsafe_target");
  }
}

export interface TrustedArtifactDir {
  path: string;
  fd: number;
  identity: string;
}

type OpenSyncWithDir = (
  path: string,
  flags: number,
  mode: number,
  options: { dir: number },
) => number;

type RenameSyncWithDir = (from: string, to: string, options: { dir: number }) => void;
type UnlinkSyncWithDir = (path: string, options: { dir: number }) => void;

function detectArtifactIoMode(dir: TrustedArtifactDir): ArtifactIoMode {
  if (artifactIoMode !== null) return artifactIoMode;
  if (process.platform === "win32") {
    artifactIoMode = "win32_pinned";
    return artifactIoMode;
  }
  const probe = `.dirfd-probe-${process.pid}`;
  const finalName = `${probe}.ok`;
  try {
    const openWithDir = openSync as unknown as OpenSyncWithDir;
    const fd = openWithDir(probe, O_CREAT | O_EXCL | O_RDWR, 0o600, { dir: dir.fd });
    closeSync(fd);
    (renameSync as unknown as RenameSyncWithDir)(probe, finalName, { dir: dir.fd });
    if (!existsSync(join(dir.path, finalName))) {
      artifactIoMode = "win32_pinned";
      return artifactIoMode;
    }
    (unlinkSync as unknown as UnlinkSyncWithDir)(finalName, { dir: dir.fd });
    artifactIoMode = "dirfd";
  } catch {
    artifactIoMode = "win32_pinned";
  }
  return artifactIoMode;
}

function childPath(dir: TrustedArtifactDir, name: string): string {
  revalidateDir(dir);
  assertRelativeName(name);
  return join(dir.path, name);
}

function assertOpenedPathMatchesDescriptor(dir: TrustedArtifactDir, name: string, fd: number): void {
  if (detectArtifactIoMode(dir) !== "win32_pinned") return;
  const opened = fstatSync(fd);
  assertRegularFileStats(opened, "artifact fd");
  const pathEntry = lstatSync(childPath(dir, name));
  if (
    !pathEntry.isFile() ||
    pathEntry.isSymbolicLink() ||
    pathEntry.dev !== opened.dev ||
    pathEntry.ino !== opened.ino
  ) {
    closeSync(fd);
    harnessFailure("artifact path identity mismatch after open", "artifact_unsafe_target");
  }
}

function openAtDir(dir: TrustedArtifactDir, name: string, flags: number, mode = 0): number {
  revalidateDir(dir);
  assertRelativeName(name);
  const mode_ = detectArtifactIoMode(dir);
  if (mode_ === "dirfd") {
    return (openSync as unknown as OpenSyncWithDir)(name, flags, mode, { dir: dir.fd });
  }
  const fd = openSync(childPath(dir, name), flags, mode);
  assertOpenedPathMatchesDescriptor(dir, name, fd);
  return fd;
}

function renameAtDir(dir: TrustedArtifactDir, from: string, to: string): void {
  revalidateDir(dir);
  assertRelativeName(from);
  assertRelativeName(to);
  if (detectArtifactIoMode(dir) === "dirfd") {
    (renameSync as unknown as RenameSyncWithDir)(from, to, { dir: dir.fd });
    return;
  }
  renameSync(childPath(dir, from), childPath(dir, to));
}

function unlinkAtDir(dir: TrustedArtifactDir, name: string): void {
  revalidateDir(dir);
  assertRelativeName(name);
  if (detectArtifactIoMode(dir) === "dirfd") {
    (unlinkSync as unknown as UnlinkSyncWithDir)(name, { dir: dir.fd });
    return;
  }
  unlinkSync(childPath(dir, name));
}

function revalidateDir(dir: TrustedArtifactDir): void {
  const stats = fstatSync(dir.fd);
  assertDirectoryStats(stats, "artifacts dir");
  if (identityOf(stats) !== dir.identity) {
    harnessFailure("artifacts directory identity changed", "artifact_unsafe_target");
  }
}

export function openTrustedArtifactDir(artifactsDir: string): TrustedArtifactDir {
  const abs = artifactsDir.replace(/[\\/]+$/, "");
  if (abs.includes("\0")) harnessFailure("NUL in artifacts path", "artifact_unsafe_target");
  mkdirSync(abs, { recursive: true, mode: 0o700 });

  let fd: number;
  if (typeof O_DIRECTORY === "number") {
    try {
      fd = openSync(abs, openFlags(O_RDONLY | O_DIRECTORY, true));
    } catch {
      harnessFailure("failed to open artifacts directory with O_DIRECTORY", "artifact_unsafe_target");
    }
  } else {
    fd = openSync(abs, O_RDONLY);
  }

  const stats = fstatSync(fd);
  assertDirectoryStats(stats, "artifacts dir");
  const trusted = { path: abs, fd, identity: identityOf(stats) };
  detectArtifactIoMode(trusted);
  return trusted;
}

export function closeTrustedArtifactDir(dir: TrustedArtifactDir): void {
  try {
    closeSync(dir.fd);
  } catch {
    /* ignore */
  }
}

export interface StoredArtifactBytes {
  digest: string;
  bytes: Uint8Array;
  byteCount: number;
}

export interface ReadArtifactOptions {
  expectedByteCount?: number;
  contentDigest?: (bytes: Uint8Array) => string;
}

function readAllFromFd(fd: number, size: number): Buffer {
  const buf = Buffer.alloc(size);
  let offset = 0;
  while (offset < buf.length) {
    const n = readSync(fd, buf, offset, buf.length - offset, offset);
    if (n <= 0) break;
    offset += n;
  }
  if (offset !== size) harnessFailure("short read from artifact descriptor", "artifact_mismatch");
  return buf;
}

function isRawMissingError(err: unknown): boolean {
  return !!err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOENT";
}

function isMissingArtifactError(err: unknown): boolean {
  return isRawMissingError(err) || (err instanceof ArtifactFsError && err.code === "artifact_missing");
}

/**
 * Returns true when a clean regular digest target appeared after the caller's
 * missing read. The final readback still verifies byte count and digest, so a
 * concurrent or hostile wrong-content regular file fails closed.
 */
function artifactTargetAlreadyPublished(dir: TrustedArtifactDir, name: string): boolean {
  revalidateDir(dir);
  assertRelativeName(name);
  try {
    const stats = lstatSync(childPath(dir, name));
    if (stats.isSymbolicLink()) {
      harnessFailure("artifact target is a symbolic link", "artifact_unsafe_target");
    }
    assertRegularFileStats(stats, "artifact create target");
    return true;
  } catch (err) {
    if (isRawMissingError(err)) return false;
    if (err instanceof ArtifactFsError) throw err;
    harnessFailure(
      `artifact create target check failed: ${err instanceof Error ? err.message : String(err)}`,
      "artifact_unsafe_target",
    );
  }
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const n = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (n <= 0) harnessFailure("artifact write made no progress", "artifact_mismatch");
    offset += n;
  }
}

function writeTempArtifact(
  dir: TrustedArtifactDir,
  tmpName: string,
  bytes: Uint8Array,
  digest: string,
  contentDigest: (b: Uint8Array) => string,
): void {
  let fd: number | null = null;
  try {
    fd = openAtDir(dir, tmpName, openFlags(O_RDWR | O_CREAT | O_EXCL, true), 0o600);
    writeAll(fd, bytes);
    fsyncSync(fd);
    const stats = fstatSync(fd);
    assertRegularFileStats(stats, "artifact temp");
    if (stats.size !== bytes.byteLength) {
      harnessFailure("size mismatch after write", "artifact_mismatch");
    }
    const buf = readAllFromFd(fd, bytes.byteLength);
    if (contentDigest(buf) !== digest) {
      harnessFailure("digest mismatch on same descriptor", "artifact_mismatch");
    }
    closeSync(fd);
    fd = null;
    renameAtDir(dir, tmpName, digestFileName(digest));
  } catch (err) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    try {
      unlinkAtDir(dir, tmpName);
    } catch {
      /* ignore cleanup */
    }
    if (err instanceof ArtifactFsError) throw err;
    harnessFailure(`artifact write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function readArtifactBytes(
  dir: TrustedArtifactDir,
  digest: string,
  expectedByteCountOrOpts?: number | ReadArtifactOptions,
): StoredArtifactBytes {
  const opts: ReadArtifactOptions =
    typeof expectedByteCountOrOpts === "number"
      ? { expectedByteCount: expectedByteCountOrOpts }
      : expectedByteCountOrOpts ?? {};
  const contentDigest = opts.contentDigest ?? artifactBytesDigest;
  revalidateDir(dir);
  assertDigestName(digest);
  const name = digestFileName(digest);

  let fd: number | null = null;
  try {
    fd = openAtDir(dir, name, openFlags(O_RDONLY, true));
    const stats = fstatSync(fd);
    assertRegularFileStats(stats, "artifact fd");
    if (opts.expectedByteCount !== undefined && stats.size !== opts.expectedByteCount) {
      harnessFailure("artifact size mismatch on descriptor", "artifact_mismatch");
    }
    if (stats.size > MAX_BYTES_PER_ARTIFACT) {
      harnessFailure("artifact exceeds ceiling", "artifact_mismatch");
    }
    const buf = readAllFromFd(fd, stats.size);
    const got = contentDigest(buf);
    if (got !== digest) harnessFailure("artifact digest mismatch on descriptor", "artifact_mismatch");
    return { digest, bytes: new Uint8Array(buf), byteCount: stats.size };
  } catch (err) {
    if (isRawMissingError(err)) {
      harnessFailure(`artifact missing: ${digest}`, "artifact_missing");
    }
    if (err instanceof ArtifactFsError) throw err;
    harnessFailure(`artifact read failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (fd !== null) closeSync(fd);
  }
  harnessFailure("artifact read failed");
}

export function putArtifactBytes(
  dir: TrustedArtifactDir,
  bytes: Uint8Array,
  expectedDigest?: string,
): StoredArtifactBytes {
  revalidateDir(dir);
  if (bytes.byteLength > MAX_BYTES_PER_ARTIFACT) {
    harnessFailure(`artifact exceeds ${MAX_BYTES_PER_ARTIFACT} bytes`);
  }
  const digest = artifactBytesDigest(bytes);
  if (expectedDigest !== undefined) {
    assertDigestName(expectedDigest);
    if (digest !== expectedDigest) {
      harnessFailure("artifact digest mismatch before write", "artifact_mismatch");
    }
  }

  try {
    return readArtifactBytes(dir, digest, bytes.byteLength);
  } catch (err) {
    if (!isMissingArtifactError(err)) throw err;
  }

  if (!artifactTargetAlreadyPublished(dir, digestFileName(digest))) {
    const tmpName = `.tmp-${digest}-${process.pid}-${Date.now()}.partial`;
    writeTempArtifact(dir, tmpName, bytes, digest, artifactBytesDigest);
  }
  return readArtifactBytes(dir, digest, bytes.byteLength);
}

export function putNamedDigestBytes(
  dir: TrustedArtifactDir,
  digest: string,
  bytes: Uint8Array,
  contentDigest: (b: Uint8Array) => string,
): StoredArtifactBytes {
  revalidateDir(dir);
  assertDigestName(digest);
  if (bytes.byteLength > MAX_BYTES_PER_ARTIFACT) {
    harnessFailure(`artifact exceeds ${MAX_BYTES_PER_ARTIFACT} bytes`);
  }
  if (contentDigest(bytes) !== digest) {
    harnessFailure("named artifact content digest mismatch before write", "artifact_mismatch");
  }

  try {
    return readArtifactBytes(dir, digest, { expectedByteCount: bytes.byteLength, contentDigest });
  } catch (err) {
    if (!isMissingArtifactError(err)) throw err;
  }

  if (!artifactTargetAlreadyPublished(dir, digestFileName(digest))) {
    const tmpName = `.tmp-${digest}-${process.pid}-${Date.now()}.partial`;
    writeTempArtifact(dir, tmpName, bytes, digest, contentDigest);
  }
  return readArtifactBytes(dir, digest, { expectedByteCount: bytes.byteLength, contentDigest });
}

export function deleteArtifactBytes(dir: TrustedArtifactDir, digest: string): void {
  revalidateDir(dir);
  assertDigestName(digest);
  const name = digestFileName(digest);
  try {
    unlinkAtDir(dir, name);
  } catch (err) {
    if (isRawMissingError(err)) return;
    if (err instanceof ArtifactFsError) throw err;
    harnessFailure(`artifact delete failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function artifactExists(dir: TrustedArtifactDir, digest: string): boolean {
  revalidateDir(dir);
  assertDigestName(digest);
  try {
    const fd = openAtDir(dir, digestFileName(digest), openFlags(O_RDONLY, true));
    try {
      const stats = fstatSync(fd);
      assertRegularFileStats(stats, "artifact exists");
      return true;
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    if (isMissingArtifactError(err)) return false;
    if (err instanceof ArtifactFsError) throw err;
    harnessFailure(`artifact exists check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
