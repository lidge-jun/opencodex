import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SQLITE_ID_CHUNK, chunkIds, columnExists, insertRowsConflictIgnore, openDbWritable, selectRows, sqlRowEqual, tableExists, updateRowFromSnapshot, withWritableDb } from "./db";
import type { RuntimeDbPaths, SqlRow } from "./db";
import { writePrivateFile } from "./paths";

const JOB_KIND_MEMORY_STAGE1 = "memory_stage1";

const JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL = "memory_consolidate_global";

const MEMORY_CONSOLIDATION_JOB_KEY = "global";

const DEFAULT_RETRY_REMAINING = 3;

export interface SatelliteBackup {
  threadIds: string[];
  /** Full `threads` row images (SELECT *) captured under the state write lock. */
  threads?: SqlRow[];
  dynamicTools?: SqlRow[];
  spawnEdges?: SqlRow[];
  logs?: { path: string; rows: SqlRow[] };
  memories?: {
    path: string;
    stage1: SqlRow[];
    stage1Jobs: SqlRow[];
    consolidateJob: SqlRow | null;
    consolidateTouched: boolean;
    /** Row image after deleteMemoriesInTx; set before memories commit (in-memory only). */
    consolidatePostImage?: SqlRow | null;
  };
  goals?: {
    path: string;
    goals: SqlRow[];
    deferrals: SqlRow[];
  };
}

type SatelliteBackupRead =
  | { status: "missing" }
  | { status: "ok"; backup: SatelliteBackup }
  | { status: "invalid" };

export const SATELLITE_BACKUP_FILE = "satellite-backup.json";

/** Snapshot state-DB dependents that cleanup deletes with the thread rows. */
export function snapshotStateDependents(
  db: Database,
  threadIds: string[],
): Pick<SatelliteBackup, "threads" | "dynamicTools" | "spawnEdges"> {
  const out: Pick<SatelliteBackup, "threads" | "dynamicTools" | "spawnEdges"> = {};
  if (threadIds.length === 0 || !tableExists(db, "threads")) return out;

  const threads: SqlRow[] = [];
  for (const chunk of chunkIds(threadIds, SQLITE_ID_CHUNK * 2)) {
    const placeholders = chunk.map(() => "?").join(",");
    threads.push(...selectRows(db, `SELECT * FROM threads WHERE id IN (${placeholders})`, chunk));
  }
  out.threads = threads;

  if (tableExists(db, "thread_dynamic_tools")) {
    const dynamicTools: SqlRow[] = [];
    for (const chunk of chunkIds(threadIds, SQLITE_ID_CHUNK * 2)) {
      const placeholders = chunk.map(() => "?").join(",");
      dynamicTools.push(...selectRows(
        db,
        `SELECT * FROM thread_dynamic_tools WHERE thread_id IN (${placeholders})`,
        chunk,
      ));
    }
    out.dynamicTools = dynamicTools;
  }

  if (tableExists(db, "thread_spawn_edges")) {
    const spawnEdges: SqlRow[] = [];
    for (const chunk of chunkIds(threadIds, SQLITE_ID_CHUNK)) {
      const placeholders = chunk.map(() => "?").join(",");
      spawnEdges.push(...selectRows(
        db,
        `SELECT * FROM thread_spawn_edges
         WHERE parent_thread_id IN (${placeholders}) OR child_thread_id IN (${placeholders})`,
        [...chunk, ...chunk],
      ));
    }
    out.spawnEdges = spawnEdges;
  }

  return out;
}

/** Remap serialized absolute DB paths onto the newest DBs under the current Codex home. */
export function remapSatelliteBackupPaths(
  backup: SatelliteBackup,
  paths: RuntimeDbPaths,
): { ok: true; backup: SatelliteBackup } | { ok: false } {
  const next: SatelliteBackup = {
    threadIds: backup.threadIds,
    ...(backup.threads ? { threads: backup.threads } : {}),
    ...(backup.dynamicTools ? { dynamicTools: backup.dynamicTools } : {}),
    ...(backup.spawnEdges ? { spawnEdges: backup.spawnEdges } : {}),
  };
  if (backup.logs) {
    if (!paths.logs) return { ok: false };
    next.logs = { ...backup.logs, path: paths.logs };
  }
  if (backup.memories) {
    if (!paths.memories) return { ok: false };
    next.memories = { ...backup.memories, path: paths.memories };
  }
  if (backup.goals) {
    if (!paths.goals) return { ok: false };
    next.goals = { ...backup.goals, path: paths.goals };
  }
  return { ok: true, backup: next };
}

export function readConsolidateGlobalJob(db: Database): SqlRow | null {
  if (!tableExists(db, "jobs")) return null;
  return db.query<SqlRow, [string, string]>(
    "SELECT * FROM jobs WHERE kind = ? AND job_key = ?",
  ).get(JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL, MEMORY_CONSOLIDATION_JOB_KEY) as SqlRow | null;
}

/** Revert delete-time enqueue only when the row still matches cleanup's post-delete image. */
export function restoreConsolidateGlobalJob(
  db: Database,
  snapshot: SqlRow | null,
  postImage: SqlRow | null | undefined,
): void {
  if (!postImage) return;
  const current = readConsolidateGlobalJob(db);
  if (!current) {
    if (snapshot) insertRowsConflictIgnore(db, "jobs", [snapshot]);
    return;
  }
  if (!sqlRowEqual(current, postImage)) return;
  if (snapshot) {
    updateRowFromSnapshot(db, "jobs", snapshot, ["kind", "job_key"]);
  } else {
    db.run(
      "DELETE FROM jobs WHERE kind = ? AND job_key = ?",
      [JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL, MEMORY_CONSOLIDATION_JOB_KEY],
    );
  }
}

/**
 * Atomically replace satellite-backup.json: private temp in the stage, full write + fsync,
 * rename (with Windows sharing-violation retries), then best-effort directory fsync.
 * An interrupted update never truncates the last valid backup that was written before a
 * satellite DB commit.
 */
export function writeSatelliteBackup(
  stageDir: string,
  backup: SatelliteBackup,
  options?: { failWrite?: boolean; failReplaceBeforeRename?: boolean },
): void {
  if (options?.failWrite) throw new Error("test_fail_satellite_backup_write");
  const dest = join(stageDir, SATELLITE_BACKUP_FILE);
  const replacing = existsSync(dest);
  writePrivateFile(dest, JSON.stringify(backup), () => {
    if (options?.failReplaceBeforeRename && replacing) {
      throw new Error("test_fail_satellite_backup_replace");
    }
  });
}

export function clearSatelliteBackup(stageDir: string): void {
  try { unlinkSync(join(stageDir, SATELLITE_BACKUP_FILE)); } catch { /* */ }
}

interface SatelliteWriteLock {
  path: string;
  db: Database;
}

export interface SatelliteWriteLocks {
  logs?: SatelliteWriteLock;
  memories?: SatelliteWriteLock;
  goals?: SatelliteWriteLock;
}

/** Deterministic order: logs → memories → goals. Each present DB gets BEGIN IMMEDIATE. */
export function beginSatelliteWriteLocks(
  paths: RuntimeDbPaths,
  busyTimeoutMs: number,
  only?: Partial<Record<"logs" | "memories" | "goals", boolean>>,
): SatelliteWriteLocks {
  const locks: SatelliteWriteLocks = {};
  const order: Array<{ key: "logs" | "memories" | "goals"; path: string | null }> = [
    { key: "logs", path: paths.logs },
    { key: "memories", path: paths.memories },
    { key: "goals", path: paths.goals },
  ];
  try {
    for (const { key, path } of order) {
      if (only && !only[key]) continue;
      if (!path || !existsSync(path)) continue;
      const db = openDbWritable(path, busyTimeoutMs);
      try {
        db.exec("BEGIN IMMEDIATE");
        locks[key] = { path, db };
      } catch (error) {
        try { db.close(); } catch { /* */ }
        throw error;
      }
    }
    return locks;
  } catch (error) {
    rollbackAllSatelliteLocks(locks);
    throw error;
  }
}

function rollbackSatelliteLock(lock: SatelliteWriteLock | undefined): void {
  if (!lock) return;
  try { lock.db.exec("ROLLBACK"); } catch { /* */ }
  try { lock.db.close(); } catch { /* */ }
}

export function rollbackAllSatelliteLocks(locks: SatelliteWriteLocks): void {
  rollbackSatelliteLock(locks.logs);
  rollbackSatelliteLock(locks.memories);
  rollbackSatelliteLock(locks.goals);
  locks.logs = undefined;
  locks.memories = undefined;
  locks.goals = undefined;
}

export function commitSatelliteLock(lock: SatelliteWriteLock | undefined): void {
  if (!lock) return;
  lock.db.exec("COMMIT");
  lock.db.close();
}

function snapshotLogsInTx(
  db: Database,
  path: string,
  threadIds: string[],
): SatelliteBackup["logs"] {
  if (threadIds.length === 0) return undefined;
  if (!tableExists(db, "logs")) throw new Error("missing_logs_table");
  const rows: SqlRow[] = [];
  for (const chunk of chunkIds(threadIds, SQLITE_ID_CHUNK * 2)) {
    const placeholders = chunk.map(() => "?").join(",");
    rows.push(...selectRows(db, `SELECT * FROM logs WHERE thread_id IN (${placeholders})`, chunk));
  }
  return { path, rows };
}

function snapshotMemoriesInTx(
  db: Database,
  path: string,
  threadIds: string[],
): SatelliteBackup["memories"] {
  if (threadIds.length === 0) return undefined;
  if (!tableExists(db, "stage1_outputs")) throw new Error("missing_stage1_outputs_table");
  const stage1: SqlRow[] = [];
  let stage1Jobs: SqlRow[] = [];
  for (const chunk of chunkIds(threadIds, SQLITE_ID_CHUNK * 2)) {
    const placeholders = chunk.map(() => "?").join(",");
    stage1.push(...selectRows(
      db,
      `SELECT * FROM stage1_outputs WHERE thread_id IN (${placeholders})`,
      chunk,
    ));
    if (tableExists(db, "jobs")) {
      stage1Jobs.push(...selectRows(
        db,
        `SELECT * FROM jobs WHERE kind = ? AND job_key IN (${placeholders})`,
        [JOB_KIND_MEMORY_STAGE1, ...chunk],
      ));
    }
  }
  let consolidateJob: SqlRow | null = null;
  let selectedForPhase2 = 0;
  if (columnExists(db, "stage1_outputs", "selected_for_phase2")) {
    selectedForPhase2 = stage1.filter(r => Number(r.selected_for_phase2 ?? 0) !== 0).length;
  }
  if (tableExists(db, "jobs")) {
    consolidateJob = readConsolidateGlobalJob(db);
  }
  return {
    path,
    stage1,
    stage1Jobs,
    consolidateJob,
    consolidateTouched: selectedForPhase2 > 0,
  };
}

function snapshotGoalsInTx(
  db: Database,
  path: string,
  threadIds: string[],
): SatelliteBackup["goals"] {
  if (threadIds.length === 0) return undefined;
  if (!tableExists(db, "thread_goals")) throw new Error("missing_thread_goals_table");
  const goals: SqlRow[] = [];
  let deferrals: SqlRow[] = [];
  for (const chunk of chunkIds(threadIds, SQLITE_ID_CHUNK * 2)) {
    const placeholders = chunk.map(() => "?").join(",");
    goals.push(...selectRows(
      db,
      `SELECT * FROM thread_goals WHERE thread_id IN (${placeholders})`,
      chunk,
    ));
    if (tableExists(db, "thread_goal_continuation_deferrals")) {
      deferrals.push(...selectRows(
        db,
        `SELECT * FROM thread_goal_continuation_deferrals WHERE thread_id IN (${placeholders})`,
        chunk,
      ));
    }
  }
  return { path, goals, deferrals };
}

/** Snapshot every present satellite under its write lock (rows stable until commit). */
export function snapshotSatelliteBackupInLocks(
  locks: SatelliteWriteLocks,
  threadIds: string[],
): SatelliteBackup {
  const backup: SatelliteBackup = { threadIds };
  if (locks.logs) {
    backup.logs = snapshotLogsInTx(locks.logs.db, locks.logs.path, threadIds);
  }
  if (locks.memories) {
    backup.memories = snapshotMemoriesInTx(locks.memories.db, locks.memories.path, threadIds);
  }
  if (locks.goals) {
    backup.goals = snapshotGoalsInTx(locks.goals.db, locks.goals.path, threadIds);
  }
  return backup;
}

export function deleteLogsInTx(db: Database, rows: SqlRow[]): void {
  if (rows.length === 0) return;
  if (!tableExists(db, "logs")) throw new Error("missing_logs_table");
  const ids = rows.map(r => r.id).filter(id => id !== null && id !== undefined);
  if (ids.length === 0) return;
  for (const chunk of chunkIds(ids as string[], SQLITE_ID_CHUNK * 2)) {
    const placeholders = chunk.map(() => "?").join(",");
    db.run(`DELETE FROM logs WHERE id IN (${placeholders})`, chunk as Array<string | number>);
  }
}

export function deleteMemoriesInTx(
  db: Database,
  section: NonNullable<SatelliteBackup["memories"]>,
): void {
  if (!tableExists(db, "stage1_outputs")) throw new Error("missing_stage1_outputs_table");
  const stage1Ids = section.stage1.map(r => String(r.thread_id));
  for (const chunk of chunkIds(stage1Ids, SQLITE_ID_CHUNK * 2)) {
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    db.run(`DELETE FROM stage1_outputs WHERE thread_id IN (${placeholders})`, chunk);
  }
  if (tableExists(db, "jobs")) {
    const jobKeys = section.stage1Jobs.map(r => String(r.job_key));
    for (const chunk of chunkIds(jobKeys, SQLITE_ID_CHUNK * 2)) {
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(",");
      db.run(
        `DELETE FROM jobs WHERE kind = ? AND job_key IN (${placeholders})`,
        [JOB_KIND_MEMORY_STAGE1, ...chunk],
      );
    }
    if (section.consolidateTouched) {
      const now = Math.floor(Date.now() / 1000);
      db.run(
        `INSERT INTO jobs (
           kind, job_key, status, worker_id, ownership_token, started_at, finished_at,
           lease_until, retry_at, retry_remaining, last_error, input_watermark, last_success_watermark
         ) VALUES (?, ?, 'pending', NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL, ?, 0)
         ON CONFLICT(kind, job_key) DO UPDATE SET
           status = CASE WHEN jobs.status = 'running' THEN 'running' ELSE 'pending' END,
           retry_at = CASE WHEN jobs.status = 'running' THEN jobs.retry_at ELSE NULL END,
           retry_remaining = max(jobs.retry_remaining, excluded.retry_remaining),
           input_watermark = CASE
             WHEN excluded.input_watermark > COALESCE(jobs.input_watermark, 0)
             THEN excluded.input_watermark
             ELSE COALESCE(jobs.input_watermark, 0) + 1
           END`,
        [JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL, MEMORY_CONSOLIDATION_JOB_KEY, DEFAULT_RETRY_REMAINING, now],
      );
    }
  }
}

export function deleteGoalsInTx(
  db: Database,
  section: NonNullable<SatelliteBackup["goals"]>,
): void {
  if (!tableExists(db, "thread_goals")) throw new Error("missing_thread_goals_table");
  const deferralIds = section.deferrals.map(r => String(r.thread_id));
  if (tableExists(db, "thread_goal_continuation_deferrals")) {
    for (const chunk of chunkIds(deferralIds, SQLITE_ID_CHUNK * 2)) {
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(",");
      db.run(
        `DELETE FROM thread_goal_continuation_deferrals WHERE thread_id IN (${placeholders})`,
        chunk,
      );
    }
  }
  const goalIds = section.goals.map(r => String(r.thread_id));
  for (const chunk of chunkIds(goalIds, SQLITE_ID_CHUNK * 2)) {
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    db.run(`DELETE FROM thread_goals WHERE thread_id IN (${placeholders})`, chunk);
  }
}

/** Restore only snapshotted rows; concurrent inserts/updates after commit stay intact. */
export function restoreSatelliteBackup(
  backup: SatelliteBackup,
  busyTimeoutMs: number,
  failRestore = false,
): boolean {
  if (failRestore) return false;
  try {
    if (backup.logs) {
      const restored = withWritableDb(backup.logs.path, busyTimeoutMs, db => {
        if (!tableExists(db, "logs")) throw new Error("missing_logs_table");
        insertRowsConflictIgnore(db, "logs", backup.logs!.rows);
      });
      if (!restored.ok) return false;
    }
    if (backup.memories) {
      const mem = backup.memories;
      const restored = withWritableDb(mem.path, busyTimeoutMs, db => {
        if (!tableExists(db, "stage1_outputs")) throw new Error("missing_stage1_outputs_table");
        insertRowsConflictIgnore(db, "stage1_outputs", mem.stage1);
        if (tableExists(db, "jobs")) {
          insertRowsConflictIgnore(db, "jobs", mem.stage1Jobs);
          if (mem.consolidateTouched) {
            restoreConsolidateGlobalJob(db, mem.consolidateJob, mem.consolidatePostImage);
          }
        }
      });
      if (!restored.ok) return false;
    }
    if (backup.goals) {
      const g = backup.goals;
      const restored = withWritableDb(g.path, busyTimeoutMs, db => {
        if (!tableExists(db, "thread_goals")) throw new Error("missing_thread_goals_table");
        insertRowsConflictIgnore(db, "thread_goals", g.goals);
        if (tableExists(db, "thread_goal_continuation_deferrals")) {
          insertRowsConflictIgnore(db, "thread_goal_continuation_deferrals", g.deferrals);
        }
      });
      if (!restored.ok) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function readSatelliteBackupFile(stageDir: string): SatelliteBackupRead {
  const path = join(stageDir, SATELLITE_BACKUP_FILE);
  if (!existsSync(path)) return { status: "missing" };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return { status: "invalid" };
    const o = raw as SatelliteBackup;
    if (!Array.isArray(o.threadIds)) return { status: "invalid" };
    return { status: "ok", backup: o };
  } catch {
    // File exists but is truncated / malformed — distinct from a missing backup.
    return { status: "invalid" };
  }
}
