import { unlinkSync } from "node:fs";
import { getConfigDir } from "../../config";
import { closeRequestHistoryIndex } from "./indexer";
import { historyIndexPath } from "./schema";

const DELETE_RETRY_DELAYS_MS = [25, 50] as const;

/** Return true only for Windows-style transient sharing violations worth retrying briefly. */
function isTransientDeleteError(error: unknown): boolean {
  if (process.platform !== "win32") return false;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EBUSY" || code === "EPERM" || code === "EACCES";
}

/** Remove one derived-index file, treating absence as success and retrying short Windows holds. */
function unlinkDerivedFile(path: string): boolean {
  for (let attempt = 0; ; attempt += 1) {
    try {
      unlinkSync(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return true;
      if (!isTransientDeleteError(error) || attempt >= DELETE_RETRY_DELAYS_MS.length) return false;
      Bun.sleepSync(DELETE_RETRY_DELAYS_MS[attempt]!);
    }
  }
}

/**
 * Close and best-effort delete the disposable request-history projection and WAL sidecars.
 *
 * Retention replaces the canonical `usage.jsonl` with a new filesystem identity. The indexer
 * would detect that identity change on its next query and rebuild automatically, but deleting
 * the old projection here reclaims its disk immediately even when no later history query occurs.
 * Failure is non-fatal: the next index open still validates source identity and recreates it.
 *
 * Sidecars are removed before the main database. If either sidecar remains locked, leave the
 * main file in place too; the indexer can later discard the complete stale set rather than
 * opening a fresh main database beside an old same-name WAL/SHM file.
 *
 * `configDir` is injectable so isolated retention tests never touch the process' real config home.
 */
export function discardRequestHistoryProjection(configDir = getConfigDir()): boolean {
  closeRequestHistoryIndex();
  const path = historyIndexPath(configDir);
  if (!unlinkDerivedFile(`${path}-wal`)) return false;
  if (!unlinkDerivedFile(`${path}-shm`)) return false;
  return unlinkDerivedFile(path);
}
