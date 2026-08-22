import { lstatSync, realpathSync, statSync } from "node:fs";
import { Database, constants as sqliteConstants } from "bun:sqlite";

import { getCodexHome, resolveCodexLogsDbPath } from "../paths";
import { samePathIdentity } from "../user-identity";
import { hasCurrentLogsSchema, inspectCodexLogs } from "./inspect";
import { withCodexLogGuardLock, type CodexLogGuardLockOutcome } from "./lock";
import { sameLogGuardPathIdentity } from "./path-safety";
import { isSqliteBusy } from "./sqlite-errors";
import { listRunningCodexProcesses, type CodexWriterProcessCheck } from "./processes";

const CURRENT_LOG_COLUMNS = [
  "id",
  "ts",
  "ts_nanos",
  "level",
  "target",
  "feedback_log_body",
  "module_path",
  "file",
  "line",
  "thread_id",
  "process_uuid",
  "estimated_bytes",
] as const;

/**
 * Budgets are expressed in BYTES and converted with the database's real page
 * size, because that is what the guide promises: ~8 MiB per batch and ~256 MiB
 * per run. Fixed page counts silently meant something different on every page
 * size — at the 4 KiB pages the fixtures use, 512/8192 pages is 2 MiB/32 MiB,
 * a quarter of the documented budget.
 */
const DEFAULT_BATCH_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_BYTES_PER_RUN = 256 * 1024 * 1024;
const MAX_ITERATIONS = 64;

/** Convert a byte budget to whole pages, never returning zero pages. */
function pagesForBytes(bytes: number, pageSize: number): number {
  if (!Number.isFinite(pageSize) || pageSize <= 0) return 1;
  return Math.max(1, Math.floor(bytes / pageSize));
}

type CompactStopReason = "complete" | "page_budget" | "no_progress" | "busy";

export interface CodexLogGuardCompactionMeasure {
  databaseBytes: number;
  /** On-disk WAL sidecar size at measurement time; FULL checkpoint does not imply shrinkage. */
  walBytes: number;
  pageCount: number;
  freelistPages: number;
  reclaimableBytes: number;
}

export interface CodexLogGuardCompactionReport {
  pageSize: number;
  before: CodexLogGuardCompactionMeasure;
  after: CodexLogGuardCompactionMeasure;
  pagesReclaimed: number;
  /**
   * Logical space returned to the free list, in bytes (`pagesReclaimed * pageSize`).
   * Distinct from `physicalDatabaseBytesReclaimed`: an incremental vacuum can
   * reclaim pages without the file shrinking, so a run that reports logical
   * progress and zero physical shrinkage is normal rather than a failure. The
   * guide documented this field before it existed.
   */
  logicalBytesReclaimed: number;
  physicalDatabaseBytesReclaimed: number;
  iterations: number;
  complete: boolean;
  stopReason: CompactStopReason;
  integrity: { before: "ok"; after: "ok" };
}

export type CodexLogGuardCompactionError =
  | "unsupported_schema"
  | "codex_running"
  | "process_enumeration_failed"
  | "unsafe_path"
  | "busy"
  | "database_error"
  | "auto_vacuum_not_incremental"
  | "integrity_check_failed";

export type CodexLogGuardCompactionResult =
  | { ok: true; report: CodexLogGuardCompactionReport }
  | {
    ok: false;
    error: Exclude<CodexLogGuardCompactionError, "integrity_check_failed">;
  }
  | { ok: false; error: "integrity_check_failed"; phase: "before" | "after" };

export interface CodexLogGuardMaintenanceDeps {
  codexHome?: string;
  processCheck?: () => CodexWriterProcessCheck;
  withLock?: <T>(
    canonicalCodexHome: string,
    canonicalLogsDbPath: string,
    work: () => T,
  ) => CodexLogGuardLockOutcome<T>;
  quickCheck?: (db: Database) => string[];
  openDatabase?: (databasePath: string, flags: number) => Database;
  batchPages?: number;
  maxPagesPerRun?: number;
}

interface ColumnRow { name: string }
interface CheckpointRow {
  busy?: number;
  log?: number;
  checkpointed?: number;
}

interface DatabaseFileIdentity {
  dev: number;
  ino: number;
  realPath: string;
}

function databasePathIdentity(databasePath: string): DatabaseFileIdentity | null {
  try {
    const stat = lstatSync(databasePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const realPath = realpathSync.native(databasePath);
    if (!sameLogGuardPathIdentity(realPath, databasePath)) return null;
    return { dev: stat.dev, ino: stat.ino, realPath };
  } catch {
    return null;
  }
}

function databasePathIsSafe(databasePath: string): boolean {
  return databasePathIdentity(databasePath) !== null;
}

function databasePathStillMatches(
  databasePath: string,
  before: DatabaseFileIdentity,
): boolean {
  const after = databasePathIdentity(databasePath);
  return after !== null
    && after.dev === before.dev
    && after.ino === before.ino
    && samePathIdentity(after.realPath, before.realPath);
}

function exactCurrentSchema(db: Database): boolean {
  // Same reasoning as protection.ts: the pre-mutation recheck must match the
  // inspector's compatibility contract exactly, or Reclaim can vacuum a
  // database the inspector classifies as monitor-only.
  return hasCurrentLogsSchema(db);
}

function pragmaNumber(db: Database, sql: string): number {
  const row = db.query<Record<string, unknown>, []>(sql).get();
  if (!row) throw new Error(`missing pragma result for ${sql}`);
  const value = Number(Object.values(row)[0]);
  if (!Number.isFinite(value)) throw new Error(`invalid pragma result for ${sql}`);
  return value;
}

function defaultQuickCheck(db: Database): string[] {
  return db.query<Record<string, unknown>, []>("PRAGMA quick_check").all().map(row => {
    const value = Object.values(row)[0];
    return value === undefined ? "" : String(value);
  });
}

function quickCheckIsOk(rows: string[]): boolean {
  return rows.length === 1 && rows[0]?.trim().toLowerCase() === "ok";
}

function processRefusal(
  check: CodexWriterProcessCheck,
): "process_enumeration_failed" | "codex_running" | null {
  if (check.state === "unknown") return "process_enumeration_failed";
  if (check.processes.length > 0) return "codex_running";
  return null;
}

function checkpointFull(db: Database): "ok" | "busy" {
  const row = db.query<CheckpointRow, []>("PRAGMA wal_checkpoint(FULL)").get();
  if (!row) throw new Error("missing wal_checkpoint result");
  const values = Object.values(row).map(Number);
  const busy = Number(row.busy ?? values[0] ?? 0);
  const log = Number(row.log ?? values[1] ?? -1);
  const checkpointed = Number(row.checkpointed ?? values[2] ?? -1);
  if (busy !== 0) return "busy";
  // SQLite returns -1/-1 when the database is not in WAL mode or there are no
  // WAL frames to report. Otherwise FULL must have copied every frame.
  if (log >= 0 && checkpointed >= 0 && checkpointed < log) return "busy";
  return "ok";
}

function measure(databasePath: string, db: Database, pageSize: number): CodexLogGuardCompactionMeasure {
  const databaseBytes = (() => {
    try {
      const stat = statSync(databasePath);
      return stat.isFile() ? stat.size : 0;
    } catch {
      return 0;
    }
  })();
  const walBytes = (() => {
    try {
      const stat = statSync(`${databasePath}-wal`);
      return stat.isFile() ? stat.size : 0;
    } catch {
      return 0;
    }
  })();
  const pageCount = pragmaNumber(db, "PRAGMA page_count");
  const freelistPages = pragmaNumber(db, "PRAGMA freelist_count");
  return {
    databaseBytes,
    walBytes,
    pageCount,
    freelistPages,
    reclaimableBytes: pageSize * freelistPages,
  };
}

function runCompaction(
  databasePath: string,
  deps: CodexLogGuardMaintenanceDeps,
): CodexLogGuardCompactionResult {
  let db: Database | undefined;
  let probeOpen = false;
  let reportBusyPartial: (() => CodexLogGuardCompactionResult) | undefined;
  try {
    const beforeOpenIdentity = databasePathIdentity(databasePath);
    if (!beforeOpenIdentity) return { ok: false, error: "unsafe_path" };
    const openDatabase = deps.openDatabase
      ?? ((path: string, flags: number) => new Database(path, flags));
    db = openDatabase(databasePath, sqliteConstants.SQLITE_OPEN_READWRITE);
    // The path is user-writable foreign state. Re-check its regular-file,
    // canonical-path and st_dev/st_ino identity immediately after SQLite opens
    // it, before issuing any pragma or write-capable statement.
    if (!databasePathStillMatches(databasePath, beforeOpenIdentity)) {
      return { ok: false, error: "unsafe_path" };
    }
    db.exec("PRAGMA busy_timeout = 0");

    if (!exactCurrentSchema(db)) return { ok: false, error: "unsupported_schema" };
    if (pragmaNumber(db, "PRAGMA auto_vacuum") !== 2) {
      return { ok: false, error: "auto_vacuum_not_incremental" };
    }

    const quickCheck = deps.quickCheck ?? defaultQuickCheck;
    if (!quickCheckIsOk(quickCheck(db))) {
      return { ok: false, error: "integrity_check_failed", phase: "before" };
    }

    // Confirm no SQLite writer can acquire the file before the first checkpoint.
    // BEGIN IMMEDIATE is intentionally released before PRAGMA wal_checkpoint,
    // which cannot run while this same connection holds a write transaction.
    db.exec("BEGIN IMMEDIATE");
    probeOpen = true;
    db.exec("ROLLBACK");
    probeOpen = false;

    if (checkpointFull(db) === "busy") return { ok: false, error: "busy" };

    const pageSize = pragmaNumber(db, "PRAGMA page_size");
    const before = measure(databasePath, db, pageSize);
    // Derived from the byte budgets AFTER reading the real page size, so the
    // documented ~8 MiB batch / ~256 MiB run hold at any page size. Explicit
    // page-count overrides still win, which is what the tests use.
    const batchPages = Math.max(1, Math.floor(deps.batchPages ?? pagesForBytes(DEFAULT_BATCH_BYTES, pageSize)));
    const maxPages = Math.max(batchPages, Math.floor(deps.maxPagesPerRun ?? pagesForBytes(DEFAULT_MAX_BYTES_PER_RUN, pageSize)));
    let previousFreelist = before.freelistPages;
    let pagesReclaimed = 0;
    let iterations = 0;
    let stopReason: CompactStopReason = previousFreelist === 0 ? "complete" : "page_budget";

    const finish = (reason: CompactStopReason): CodexLogGuardCompactionResult => {
      const after = measure(databasePath, db!, pageSize);
      if (!quickCheckIsOk(quickCheck(db!))) {
        return { ok: false, error: "integrity_check_failed", phase: "after" };
      }
      const complete = after.freelistPages === 0;
      // If SQLITE_BUSY is thrown after an incremental_vacuum commit but before the
      // loop can sample freelist_count, the before/after measurements still capture
      // that committed logical reclamation. Never under-report already-landed work.
      const observedPagesReclaimed = Math.max(
        pagesReclaimed,
        Math.max(0, before.freelistPages - after.freelistPages),
      );
      return {
        ok: true,
        report: {
          pageSize,
          before,
          after,
          pagesReclaimed: observedPagesReclaimed,
          logicalBytesReclaimed: observedPagesReclaimed * pageSize,
          physicalDatabaseBytesReclaimed: Math.max(0, before.databaseBytes - after.databaseBytes),
          iterations,
          complete,
          stopReason: reason === "busy" ? "busy" : complete ? "complete" : reason,
          integrity: { before: "ok", after: "ok" },
        },
      };
    };
    reportBusyPartial = () => iterations > 0 ? finish("busy") : { ok: false, error: "busy" };

    while (previousFreelist > 0 && pagesReclaimed < maxPages && iterations < MAX_ITERATIONS) {
      const pageBudget = Math.min(batchPages, maxPages - pagesReclaimed, previousFreelist);
      if (pageBudget <= 0) {
        stopReason = "page_budget";
        break;
      }
      const priorFreelist = previousFreelist;
      db.exec(`PRAGMA incremental_vacuum(${pageBudget})`);
      iterations += 1;
      const checkpoint = checkpointFull(db);
      const currentFreelist = pragmaNumber(db, "PRAGMA freelist_count");
      const reclaimed = Math.max(0, priorFreelist - currentFreelist);
      pagesReclaimed += reclaimed;
      previousFreelist = currentFreelist;

      // incremental_vacuum has already committed by this point. A busy FULL
      // checkpoint is therefore a partial-success stop, not an atomic refusal.
      if (checkpoint === "busy") return finish("busy");
      if (currentFreelist === 0) {
        stopReason = "complete";
        break;
      }
      if (currentFreelist >= priorFreelist) {
        stopReason = "no_progress";
        break;
      }
      stopReason = "page_budget";
    }

    if (previousFreelist > 0 && iterations >= MAX_ITERATIONS && stopReason !== "no_progress") {
      // MAX_ITERATIONS is a bounded-work limit, not evidence that vacuum stalled.
      stopReason = "page_budget";
    }

    // The preceding incremental-vacuum iterations checkpoint after every batch.
    // One final FULL checkpoint backfills any remaining WAL frames before the
    // final main-database measurement. FULL does not reset or shrink the WAL
    // sidecar, so `after.walBytes` is an observational size, not reclaimed WAL.
    if (checkpointFull(db) === "busy") {
      return iterations > 0 ? finish("busy") : { ok: false, error: "busy" };
    }
    return finish(stopReason);
  } catch (error) {
    if (probeOpen) {
      try { db?.exec("ROLLBACK"); } catch { /* close releases it */ }
    }
    if (isSqliteBusy(error)) {
      // Mirror the explicit busy exits. Once at least one vacuum batch completed,
      // a later thrown busy is a partial-success stop rather than a pure refusal.
      if (reportBusyPartial) {
        try { return reportBusyPartial(); } catch { /* fall through to refusal */ }
      }
      return { ok: false, error: "busy" };
    }
    return { ok: false, error: "database_error" };
  } finally {
    try { db?.close(); } catch { /* maintenance already settled */ }
  }
}

export function compactCodexLogs(
  deps: CodexLogGuardMaintenanceDeps = {},
): CodexLogGuardCompactionResult {
  const codexHome = deps.codexHome ?? getCodexHome();
  const inspection = inspectCodexLogs({ codexHome });
  const databasePath = resolveCodexLogsDbPath({ codexHome });
  if (inspection.capabilities.reclaim.state !== "supported") {
    return { ok: false, error: "unsupported_schema" };
  }
  if (!databasePathIsSafe(databasePath)) return { ok: false, error: "unsafe_path" };

  const checkProcesses = deps.processCheck ?? listRunningCodexProcesses;
  const firstRefusal = processRefusal(checkProcesses());
  if (firstRefusal) return { ok: false, error: firstRefusal };

  const withLock = deps.withLock ?? withCodexLogGuardLock;
  let locked: CodexLogGuardLockOutcome<CodexLogGuardCompactionResult>;
  try {
    locked = withLock(codexHome, databasePath, () => {
      const secondRefusal = processRefusal(checkProcesses());
      if (secondRefusal) return { ok: false as const, error: secondRefusal };
      return runCompaction(databasePath, deps);
    });
  } catch {
    return { ok: false, error: "database_error" };
  }

  if (locked.kind === "unavailable") {
    return {
      ok: false,
      error: locked.reason === "busy"
        ? "busy"
        : locked.reason === "unsafe-path" ? "unsafe_path" : "database_error",
    };
  }
  return locked.value;
}
