import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, join } from "node:path";

export type PrivateFileCommitFault = "before_publish" | "parent_directory_sync" | null;
let privateFileCommitFaultForTests: PrivateFileCommitFault = null;
let privateFileCleanupSyncFaultForTests = false;
const PRIVATE_STAGE_RE = /^\..+\.(\d+)\.[0-9a-f-]{36}\.tmp$/;
export const PRIVATE_FILE_STAGE_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface PrivateFilePublishOptions {
  /** Validate or harden the empty stage before caller-controlled bytes are written. */
  prepareStage?: (stagePath: string) => void;
}

function cleanup(path: string): void {
  try { unlinkSync(path); } catch { /* absent/already removed */ }
}

function pidDefinitelyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function staleTempPrefix(finalPath: string): string {
  return `.${basename(finalPath)}.`;
}

function fsyncParentBestEffort(path: string): void {
  if (process.platform === "win32") return;
  let fd: number | null = null;
  try {
    fd = openSync(dirname(path), fsConstants.O_RDONLY);
    fsyncSync(fd);
  } catch {
    // Cleanup durability is best-effort after unlink. Publication and crash-witness
    // retirement use the strict path below and never swallow POSIX failures.
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function fsyncParentStrict(path: string): void {
  if (process.platform === "win32") return;
  let fd: number | null = null;
  try {
    fd = openSync(dirname(path), fsConstants.O_RDONLY);
    fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    const wrapped = new Error(`private-file parent directory sync failed (${code})`);
    (wrapped as Error & { cause?: unknown }).cause = error;
    throw wrapped;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function fsyncParentForPublication(path: string): void {
  // Node does not provide a portable directory-fsync contract on Windows. The
  // exclusive hard-link publication remains atomic there, while POSIX requires
  // the parent directory sync before publication is reported as durable.
  if (process.platform === "win32") return;
  if (privateFileCommitFaultForTests === "parent_directory_sync") {
    throw new Error("synthetic private-file parent directory sync failure");
  }
  fsyncParentStrict(path);
}

export function isPrivateFileStageName(name: string): boolean {
  return PRIVATE_STAGE_RE.test(name);
}

function isPrivateRegularStage(stats: Stats): boolean {
  return stats.isFile() && !stats.isSymbolicLink();
}

function shouldReclaimPrivateFileStage(dir: string, name: string, nowMs: number): boolean {
  const match = PRIVATE_STAGE_RE.exec(name);
  if (!match) return false;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;

  let stats: Stats;
  try {
    stats = lstatSync(join(dir, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!isPrivateRegularStage(stats)) return false;

  const expired = nowMs - stats.mtimeMs > PRIVATE_FILE_STAGE_RETENTION_MS;
  const dead = pid !== process.pid && pidDefinitelyDead(pid);
  return expired || dead;
}

/** Reclaim private-file stages whose writer is dead or whose crash witness is past the retention window. */
export function cleanupStalePrivateFileStagesInDir(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const nowMs = Date.now();
  const reclaimable = names.filter((name) => shouldReclaimPrivateFileStage(dir, name, nowMs));
  if (reclaimable.length === 0) return;

  // A stale stage can be the hard-link witness for a final name that was linked
  // before a crash or directory-sync failure. Make that final directory entry
  // durable before removing any such witness.
  if (process.platform !== "win32" && privateFileCleanupSyncFaultForTests) {
    throw new Error("synthetic private-file cleanup parent directory sync failure");
  }
  fsyncParentStrict(join(dir, "."));

  let changed = false;
  for (const name of reclaimable) {
    try {
      unlinkSync(join(dir, name));
      changed = true;
    } catch {
      // Another cleanup or writer may have removed it after enumeration.
    }
  }
  if (changed) fsyncParentBestEffort(join(dir, "."));
}

/** Reclaim staging links from dead writers or expired crash witnesses. */
export function cleanupStalePrivateFileStages(finalPath: string): void {
  cleanupStalePrivateFileStagesInDir(dirname(finalPath));
}

/** Remove only stage links that already reference the durable final inode. */
function cleanupPublishedPrivateFileStages(finalPath: string): void {
  let finalStats;
  try {
    finalStats = lstatSync(finalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!finalStats.isFile() || finalStats.isSymbolicLink()) return;

  const dir = dirname(finalPath);
  const prefix = staleTempPrefix(finalPath);
  let changed = false;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(prefix) || !PRIVATE_STAGE_RE.test(name)) continue;
    const stagePath = join(dir, name);
    try {
      const stageStats = lstatSync(stagePath);
      if (!stageStats.isFile() || stageStats.isSymbolicLink()) continue;
      if (stageStats.dev !== finalStats.dev || stageStats.ino !== finalStats.ino) continue;
      unlinkSync(stagePath);
      changed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (changed) fsyncParentBestEffort(finalPath);
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const count = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (count <= 0) throw new Error("private file write made no progress");
    offset += count;
  }
}

/**
 * Publish immutable mode-0600 bytes without ever exposing a partially-written final path.
 * The caller owns EEXIST comparison semantics because some objects are idempotent and
 * others are identity conflicts. Staging files are target-scoped and stale stages from
 * definitely-dead writers are reclaimed on the next read or publication attempt.
 */
export function publishPrivateFileExclusive(
  finalPath: string,
  bytes: Uint8Array,
  options: PrivateFilePublishOptions = {},
): { created: boolean } {
  cleanupStalePrivateFileStages(finalPath);
  const tempPath = join(
    dirname(finalPath),
    `${staleTempPrefix(finalPath)}${process.pid}.${randomUUID()}.tmp`,
  );
  let fd: number | null = null;
  let preservePublishedStage = false;
  try {
    fd = openSync(tempPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    // Secret callers can harden the empty stage before any sensitive bytes exist.
    // A failure here can therefore leave at most an empty cleanup witness.
    options.prepareStage?.(tempPath);
    writeAll(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;

    if (privateFileCommitFaultForTests === "before_publish") {
      throw new Error("synthetic private-file commit failure before publish");
    }

    try {
      linkSync(tempPath, finalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        // A prior publication may have linked the final entry but failed while
        // syncing the parent directory. Re-sync before reporting idempotent success,
        // then remove only stages that are hard links to that durable final inode.
        fsyncParentForPublication(finalPath);
        cleanupPublishedPrivateFileStages(finalPath);
        return { created: false };
      }
      throw error;
    }
    try {
      fsyncParentForPublication(finalPath);
    } catch (error) {
      // The final name exists, but POSIX durability was not established. Keep this
      // exact hard-link stage so a retry can re-sync and then identify it by inode.
      preservePublishedStage = true;
      throw error;
    }
    return { created: true };
  } finally {
    if (fd !== null) closeSync(fd);
    if (!preservePublishedStage) {
      cleanup(tempPath);
      fsyncParentBestEffort(finalPath);
    }
  }
}

/** Test-only fault seam at the atomic publication point. Import this module directly in tests. */
export function setPrivateFileCommitFaultForTests(fault: PrivateFileCommitFault): void {
  privateFileCommitFaultForTests = fault;
}

/** Test-only fault seam for strict stale-stage cleanup durability. */
export function setPrivateFileCleanupSyncFaultForTests(enabled: boolean): void {
  privateFileCleanupSyncFaultForTests = enabled;
}
