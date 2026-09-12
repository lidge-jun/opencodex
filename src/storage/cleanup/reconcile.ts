import { existsSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SQLITE_ID_CHUNK, chunkIds, columnExists, mapDbError, openDbWritable, tableExists } from "./db";
import type { ReconcileErr, RuntimeDbPaths } from "./db";
import { normalizeArchivedRolloutPath } from "./paths";
import { beginSatelliteWriteLocks, clearSatelliteBackup, commitSatelliteLock, deleteGoalsInTx, deleteLogsInTx, deleteMemoriesInTx, readConsolidateGlobalJob, restoreSatelliteBackup, rollbackAllSatelliteLocks, snapshotSatelliteBackupInLocks, snapshotStateDependents, writeSatelliteBackup } from "./satellite";
import type { SatelliteBackup, SatelliteWriteLocks } from "./satellite";
import type { ArchivedCandidate, CleanupErrorCode } from "./types";

export interface ThreadSnapshot {
  id: string;
  rollout_path: string;
  archived: number | null;
  history_mode?: string | null;
  is_pinned?: number | null;
}

/**
 * Load archived threads matching the candidate set.
 * Optional columns are detected via PRAGMA; missing `threads` / query failures throw
 * so callers map to `db_reconcile_failed` / `codex_busy` instead of treating them as empty.
 */
function loadMatchingThreads(db: Database, candidates: ArchivedCandidate[], codexHome: string): ThreadSnapshot[] {
  if (!tableExists(db, "threads")) {
    throw new Error("missing_threads_table");
  }
  const logicalSet = new Set(candidates.map(c => c.relPath));
  const hasArchived = columnExists(db, "threads", "archived");
  const hasHistoryMode = columnExists(db, "threads", "history_mode");
  const hasIsPinned = columnExists(db, "threads", "is_pinned");
  const selectCols = ["id", "rollout_path"];
  if (hasArchived) selectCols.push("archived");
  if (hasHistoryMode) selectCols.push("history_mode");
  if (hasIsPinned) selectCols.push("is_pinned");
  const rows = db.query<
    { id: string; rollout_path: string; archived?: number | null; history_mode?: string | null; is_pinned?: number | null },
    []
  >(`SELECT ${selectCols.join(", ")} FROM threads`).all();

  return rows
    .filter(row => {
      // When the archived column is present, only archived=1 rows may be deleted.
      if (hasArchived && Number(row.archived ?? 0) !== 1) {
        return false;
      }
      const normalized = normalizeArchivedRolloutPath(row.rollout_path, codexHome);
      return normalized !== null && logicalSet.has(normalized);
    })
    .map(row => ({
      id: row.id,
      rollout_path: row.rollout_path,
      archived: hasArchived ? (row.archived ?? null) : null,
      history_mode: hasHistoryMode ? (row.history_mode ?? null) : null,
      is_pinned: hasIsPinned ? (row.is_pinned ?? null) : null,
    }));
}

/**
 * Partition matched threads into deletable and referenced snapshots. Linked spawn/fork
 * history and paginated histories stay in the skipped set. Throws real DB errors.
 */
function filterReferencedHistory(
  db: Database,
  threads: ThreadSnapshot[],
): { safe: ThreadSnapshot[]; skipped: ThreadSnapshot[] } {
  let safe = threads.filter(t => (t.history_mode ?? "").toLowerCase() !== "paginated");
  const skipped = new Map(threads
    .filter(t => (t.history_mode ?? "").toLowerCase() === "paginated")
    .map(t => [t.id, t]));

  while (safe.length > 0) {
    const idSet = new Set(safe.map(t => t.id));
    const unsafeIds = new Set<string>();

    // Spawn edges that cross the delete boundary keep history reachable.
    if (tableExists(db, "thread_spawn_edges")) {
      for (const chunk of chunkIds([...idSet], SQLITE_ID_CHUNK)) {
      const placeholders = chunk.map(() => "?").join(",");
      const edges = db.query<{ parent_thread_id: string; child_thread_id: string }, string[]>(
        `SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges
         WHERE parent_thread_id IN (${placeholders}) OR child_thread_id IN (${placeholders})`,
      ).all(...chunk, ...chunk);
      for (const edge of edges) {
        if (!idSet.has(edge.parent_thread_id)) unsafeIds.add(edge.child_thread_id);
        if (!idSet.has(edge.child_thread_id)) unsafeIds.add(edge.parent_thread_id);
      }
    }
    }

    // Other threads that list one of ours as forked_from / parent (when columns exist).
    for (const column of ["forked_from_id", "parent_thread_id", "source_thread_id"] as const) {
      if (!columnExists(db, "threads", column)) continue;
      for (const chunk of chunkIds([...idSet], SQLITE_ID_CHUNK * 2)) {
        const placeholders = chunk.map(() => "?").join(",");
        const rows = db.query<{ id: string; ref: string }, string[]>(
          `SELECT id, ${column} AS ref FROM threads WHERE ${column} IN (${placeholders})`,
        ).all(...chunk);
        for (const row of rows) {
          if (!idSet.has(row.id)) unsafeIds.add(row.ref);
        }
      }
    }

    if (unsafeIds.size === 0) break;
    for (const thread of safe) {
      if (unsafeIds.has(thread.id)) skipped.set(thread.id, thread);
    }
    safe = safe.filter(thread => !unsafeIds.has(thread.id));
  }

  return { safe, skipped: [...skipped.values()] };
}

function deleteThreadsAndDependents(db: Database, threadIds: string[]): void {
  if (threadIds.length === 0) return;

  // Upstream deletes dynamic tools before spawn edges before threads.
  if (tableExists(db, "thread_dynamic_tools")) {
    for (const chunk of chunkIds(threadIds, SQLITE_ID_CHUNK * 2)) {
      const placeholders = chunk.map(() => "?").join(",");
      db.run(`DELETE FROM thread_dynamic_tools WHERE thread_id IN (${placeholders})`, chunk);
    }
  }

  if (tableExists(db, "thread_spawn_edges")) {
    for (const chunk of chunkIds(threadIds, SQLITE_ID_CHUNK)) {
      const placeholders = chunk.map(() => "?").join(",");
      db.run(
        `DELETE FROM thread_spawn_edges WHERE parent_thread_id IN (${placeholders}) OR child_thread_id IN (${placeholders})`,
        [...chunk, ...chunk],
      );
    }
  }

  for (const chunk of chunkIds(threadIds, SQLITE_ID_CHUNK * 2)) {
    const placeholders = chunk.map(() => "?").join(",");
    db.run(`DELETE FROM threads WHERE id IN (${placeholders})`, chunk);
  }
}

interface ReconcileOk {
  ok: true;
  threads: ThreadSnapshot[];
  skipped: ThreadSnapshot[];
}

interface ReconcileTestHooks {
  /** Runs at the top of reconcileDeletedThreads, before the write lock is taken. */
  beforeReconcileLock?: () => void;
  failAfterLogsMutation?: boolean;
  failAfterMemoriesMutation?: boolean;
  failAfterGoalsMutation?: boolean;
  failBeforeStateCommit?: boolean;
  failSatelliteRestore?: boolean;
  failSatelliteBackupWrite?: boolean;
  /**
   * Fail a satellite-backup.json *replacement* after the temp is durable but before
   * rename — exercises crash-safety of the post-memories rewrite without truncating
   * the last valid backup.
   */
  failSatelliteBackupReplace?: boolean;
  /** Runs after satellite deletes are committed, before state thread deletion. */
  afterSatelliteMutations?: () => void;
}

/** Delete snapshotted primary-key rows and commit each satellite write transaction. */
function deleteAndCommitSatellites(
  locks: SatelliteWriteLocks,
  backup: SatelliteBackup,
  stageDir: string,
  hooks?: ReconcileTestHooks,
): void {
  try {
    if (locks.logs && backup.logs) {
      deleteLogsInTx(locks.logs.db, backup.logs.rows);
      commitSatelliteLock(locks.logs);
      locks.logs = undefined;
      if (hooks?.failAfterLogsMutation) throw new Error("test_fail_after_logs");
    }
    if (locks.memories && backup.memories) {
      deleteMemoriesInTx(locks.memories.db, backup.memories);
      if (backup.memories.consolidateTouched) {
        // Capture under the write lock, but persist only after COMMIT+close.
        // Holding BEGIN IMMEDIATE across a durable backup rewrite lets Windows CI
        // disk/AV latency stall the lock long enough for concurrent reopen hooks
        // (and bun's default 5s test timeout) to hang — see PR #558 windows-latest.
        backup.memories.consolidatePostImage = readConsolidateGlobalJob(locks.memories.db);
      }
      commitSatelliteLock(locks.memories);
      locks.memories = undefined;
      if (backup.memories.consolidateTouched) {
        writeSatelliteBackup(stageDir, backup, {
          failReplaceBeforeRename: hooks?.failSatelliteBackupReplace,
        });
      }
      if (hooks?.failAfterMemoriesMutation) throw new Error("test_fail_after_memories");
    }
    if (locks.goals && backup.goals) {
      deleteGoalsInTx(locks.goals.db, backup.goals);
      commitSatelliteLock(locks.goals);
      locks.goals = undefined;
      if (hooks?.failAfterGoalsMutation) throw new Error("test_fail_after_goals");
    }
  } catch (error) {
    rollbackAllSatelliteLocks(locks);
    throw error;
  }
}

/** Load matching archived threads and retain referenced history — no deletes yet. */
export function loadThreadsForCleanup(
  stateDbPath: string,
  candidates: ArchivedCandidate[],
  codexHome: string,
  busyTimeoutMs: number,
): ReconcileOk | ReconcileErr {
  if (!stateDbPath || !existsSync(stateDbPath)) return { ok: true, threads: [], skipped: [] };
  let db: Database | undefined;
  try {
    db = openDbWritable(stateDbPath, busyTimeoutMs);
    const threads = loadMatchingThreads(db, candidates, codexHome);
    if (threads.some(t => Number(t.is_pinned ?? 0) === 1)) {
      return { ok: false, error: "pinned_thread" };
    }
    const filtered = filterReferencedHistory(db, threads);
    return { ok: true, threads: filtered.safe, skipped: filtered.skipped };
  } catch (error) {
    return { ok: false, error: mapDbError(error) };
  } finally {
    try { db?.close(); } catch { /* */ }
  }
}

/**
 * Reconcile all Codex per-thread stores for the matched archived candidates.
 *
 * Freezes the thread-ID set under the state write lock, persists a complete
 * satellite backup, then mutates satellites (logs → memories → goals). Any later
 * failure restores satellite rows before the caller restores staged files.
 */
export function reconcileDeletedThreads(
  paths: RuntimeDbPaths,
  candidates: ArchivedCandidate[],
  codexHome: string,
  busyTimeoutMs: number,
  stageDir: string,
  hooks?: ReconcileTestHooks,
): ReconcileOk | ReconcileErr {
  if (!paths.state || !existsSync(paths.state)) return { ok: true, threads: [], skipped: [] };

  if (hooks?.beforeReconcileLock) hooks.beforeReconcileLock();

  let stateDb: Database | undefined;
  let backup: SatelliteBackup | undefined;
  let satellitesMutated = false;
  let satelliteLocks: SatelliteWriteLocks | undefined;

  const failWithRestore = (error: CleanupErrorCode, mapped?: CleanupErrorCode): ReconcileErr => {
    const code = mapped ?? error;
    let satelliteRestoreFailed = false;
    if (satellitesMutated && backup) {
      satelliteRestoreFailed = !restoreSatelliteBackup(
        backup,
        busyTimeoutMs,
        Boolean(hooks?.failSatelliteRestore),
      );
      // Keep on-disk backup + manifest when restore cannot complete.
      if (!satelliteRestoreFailed) clearSatelliteBackup(stageDir);
    } else {
      clearSatelliteBackup(stageDir);
    }
    return {
      ok: false,
      error: code,
      ...(satelliteRestoreFailed ? { satelliteRestoreFailed: true } : {}),
    };
  };

  try {
    stateDb = openDbWritable(paths.state, busyTimeoutMs);
    stateDb.exec("BEGIN IMMEDIATE");

    // Freeze the exact delete set under the write lock before any satellite mutation.
    const threads = loadMatchingThreads(stateDb, candidates, codexHome);
    // A pin applied after selection must stop the delete, even though the
    // staged files are already in trash staging — the caller restores them.
    if (threads.some(t => Number(t.is_pinned ?? 0) === 1)) {
      stateDb.exec("ROLLBACK");
      return { ok: false, error: "pinned_thread" };
    }
    if (filterReferencedHistory(stateDb, threads).safe.length !== threads.length) {
      stateDb.exec("ROLLBACK");
      return { ok: false, error: "referenced_history" };
    }
    const threadIds = threads.map(t => t.id);

    satelliteLocks = beginSatelliteWriteLocks(paths, busyTimeoutMs);
    try {
      backup = snapshotSatelliteBackupInLocks(satelliteLocks, threadIds);
      const stateDeps = snapshotStateDependents(stateDb, threadIds);
      backup.threads = stateDeps.threads;
      backup.dynamicTools = stateDeps.dynamicTools;
      backup.spawnEdges = stateDeps.spawnEdges;
      try {
        writeSatelliteBackup(stageDir, backup, {
          failWrite: hooks?.failSatelliteBackupWrite,
        });
      } catch {
        rollbackAllSatelliteLocks(satelliteLocks);
        stateDb.exec("ROLLBACK");
        clearSatelliteBackup(stageDir);
        return { ok: false, error: "fs_failed" };
      }

      const hasSatelliteWork = Boolean(backup.logs || backup.memories || backup.goals);
      if (hasSatelliteWork) {
        satellitesMutated = true;
        deleteAndCommitSatellites(satelliteLocks, backup, stageDir, hooks);
      } else {
        rollbackAllSatelliteLocks(satelliteLocks);
      }
      satelliteLocks = undefined;

      if (hooks?.afterSatelliteMutations) hooks.afterSatelliteMutations();

      // Re-check under the same lock before committing state deletes.
      if (filterReferencedHistory(stateDb, threads).safe.length !== threads.length) {
        stateDb.exec("ROLLBACK");
        return failWithRestore("referenced_history");
      }
      deleteThreadsAndDependents(stateDb, threadIds);
      if (hooks?.failBeforeStateCommit) throw new Error("test_fail_before_state_commit");
      stateDb.exec("COMMIT");
      // Keep satellite-backup.json for quarantine restore; permanent purge removes the stage.
      return { ok: true, threads, skipped: [] };
    } catch (error) {
      if (satelliteLocks) rollbackAllSatelliteLocks(satelliteLocks);
      throw error;
    }
  } catch (error) {
    try { stateDb?.exec("ROLLBACK"); } catch { /* */ }
    return failWithRestore("db_reconcile_failed", mapDbError(error));
  } finally {
    try { stateDb?.close(); } catch { /* */ }
  }
}
