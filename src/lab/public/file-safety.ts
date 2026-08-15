import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { isPrivateFileStageName } from "./private-file";
import { PublicEvidenceValidationError } from "./validate";

const O_NOFOLLOW = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

export interface PrivateRegularFileReadOptions {
  maxBytes: number;
  errorCode: string;
  errorMessage: string;
  sizeErrorCode?: string;
  sizeErrorMessage?: string;
  requireMode600?: boolean;
}

function sizeError(options: PrivateRegularFileReadOptions): PublicEvidenceValidationError {
  return new PublicEvidenceValidationError(
    options.sizeErrorCode ?? options.errorCode,
    options.sizeErrorMessage ?? options.errorMessage,
  );
}

/**
 * Heal only the publication-specific hard link left behind when the final name was linked
 * but the parent-directory durability check failed. The stage must be target-scoped and
 * inode-identical to the final file; unrelated hard links remain and are rejected below.
 */
function recoverPublishedPrivateFileStage(path: string): void {
  if (process.platform === "win32") return;
  const finalStats = lstatSync(path);
  if (finalStats.isSymbolicLink() || !finalStats.isFile() || finalStats.nlink <= 1) return;

  const dir = dirname(path);
  const prefix = `.${basename(path)}.`;
  const candidates: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(prefix) || !isPrivateFileStageName(name)) continue;
    const stagePath = join(dir, name);
    try {
      const stageStats = lstatSync(stagePath);
      if (
        stageStats.isFile()
        && !stageStats.isSymbolicLink()
        && stageStats.dev === finalStats.dev
        && stageStats.ino === finalStats.ino
      ) {
        candidates.push(stagePath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (candidates.length === 0) return;

  // The final directory entry already exists. Make that entry durable before deleting
  // the recovery witness. A real fsync failure propagates and the strict read stays closed.
  let dirFd: number | null = null;
  try {
    dirFd = openSync(dir, fsConstants.O_RDONLY);
    fsyncSync(dirFd);
  } finally {
    if (dirFd !== null) closeSync(dirFd);
  }

  for (const stagePath of candidates) {
    try {
      const stageStats = lstatSync(stagePath);
      if (
        stageStats.isFile()
        && !stageStats.isSymbolicLink()
        && stageStats.dev === finalStats.dev
        && stageStats.ino === finalStats.ino
      ) {
        unlinkSync(stagePath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function withPrivateRegularFile<T>(
  path: string,
  options: PrivateRegularFileReadOptions,
  consume: (fd: number, size: number) => T,
): T {
  let pathStats = lstatSync(path);
  if (!pathStats.isSymbolicLink() && pathStats.isFile() && pathStats.nlink > 1) {
    recoverPublishedPrivateFileStage(path);
    pathStats = lstatSync(path);
  }
  if (pathStats.isSymbolicLink() || !pathStats.isFile() || pathStats.nlink !== 1) {
    throw new PublicEvidenceValidationError(options.errorCode, options.errorMessage);
  }
  if (pathStats.size > options.maxBytes) throw sizeError(options);

  const fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW);
  try {
    const stats = fstatSync(fd);
    if (
      !stats.isFile()
      || stats.nlink !== 1
      || stats.dev !== pathStats.dev
      || stats.ino !== pathStats.ino
    ) {
      throw new PublicEvidenceValidationError(options.errorCode, options.errorMessage);
    }
    if (stats.size > options.maxBytes) throw sizeError(options);
    if (options.requireMode600 && process.platform !== "win32" && (stats.mode & 0o777) !== 0o600) {
      throw new PublicEvidenceValidationError(options.errorCode, options.errorMessage);
    }
    return consume(fd, stats.size);
  } finally {
    closeSync(fd);
  }
}

/**
 * Inspect a file only after proving that the pathname and checked descriptor refer to
 * the same private regular file. This keeps quota scans descriptor-bound without
 * reading every cached object into memory.
 */
export function privateRegularFileSize(
  path: string,
  options: PrivateRegularFileReadOptions,
): number {
  return withPrivateRegularFile(path, options, (_fd, size) => size);
}

/**
 * Read bytes only after proving that the pathname and the consumed descriptor refer to
 * the same private regular file. The lstat/dev+ino comparison keeps the protection on
 * platforms where O_NOFOLLOW is unavailable instead of silently following a symlink.
 */
export function readPrivateRegularFile(
  path: string,
  options: PrivateRegularFileReadOptions,
): Buffer {
  return withPrivateRegularFile(path, options, (fd) => {
    const bytes = readFileSync(fd);
    if (bytes.byteLength > options.maxBytes) throw sizeError(options);
    return bytes;
  });
}
