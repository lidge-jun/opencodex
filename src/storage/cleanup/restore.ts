import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { resolveCodexHomeDir } from "../../codex/home";
import { readThreadFieldsFromRollout } from "../../codex/history-provider";
import { discoverRuntimeDbPaths, insertRowsConflictIgnore, isSqlRowArray, mapDbError, probeStateDbWritable, tableColumnNames, tableExists, withWritableDb } from "./db";
import type { ReconcileErr, SqlRow } from "./db";
import { ARCHIVED_SESSIONS_DIR, TRASH_DIR, TRASH_EPOCH_DIR, ZST_SUFFIX, isExistError, isRolloutFileName, isSafeArchivedPhysicalRel, renameNoReplace, toForwardSlash } from "./paths";
import { RESTORE_PENDING_FILE, readRestorePending, writeRestorePending } from "./pending";
import type { RestorePendingSections, RestorePendingState } from "./pending";
import { SATELLITE_BACKUP_FILE, beginSatelliteWriteLocks, commitSatelliteLock, readSatelliteBackupFile, remapSatelliteBackupPaths, restoreConsolidateGlobalJob, rollbackAllSatelliteLocks } from "./satellite";
import type { SatelliteBackup, SatelliteWriteLocks } from "./satellite";
import { absFromRel, removeEmptyTrashRoot } from "./staging";
import type { StagedFile } from "./staging";
import type { CleanupManifestEntry, CleanupMode, RestoreErrorCode, RestoreResult, TrashEntrySummary } from "./types";

interface TrashManifest {
  quarantinedAt?: number;
  mode?: CleanupMode;
  entries?: CleanupManifestEntry[];
}

/**
 * Parse a trash `manifest.json` atomically.
 *
 * Any missing `entries` array, or any malformed entry / `physicalRelPaths` value /
 * required field, rejects the **entire** manifest (returns null). Individual bad
 * entries are never filtered out so a partial parse cannot silently drop evidence.
 */
function parseTrashManifest(raw: string): TrashManifest | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const o = parsed as Record<string, unknown>;
    if (!Array.isArray(o.entries)) return null;

    const entries: CleanupManifestEntry[] = [];
    for (const e of o.entries) {
      if (!e || typeof e !== "object" || Array.isArray(e)) return null;
      const entry = e as Record<string, unknown>;
      if (typeof entry.relPath !== "string" || entry.relPath.length === 0) return null;
      if (typeof entry.bytes !== "number" || !Number.isFinite(entry.bytes)) return null;
      if (typeof entry.mtimeMs !== "number" || !Number.isFinite(entry.mtimeMs)) return null;
      if (!Array.isArray(entry.physicalRelPaths) || entry.physicalRelPaths.length === 0) return null;
      const physical: string[] = [];
      for (const p of entry.physicalRelPaths) {
        // Do not strip bad elements — one malformed path invalidates the whole manifest.
        if (typeof p !== "string" || p.length === 0) return null;
        physical.push(p);
      }
      if ("threadId" in entry && typeof entry.threadId !== "string") return null;
      if ("rolloutPath" in entry && typeof entry.rolloutPath !== "string") return null;
      if (
        "archived" in entry
        && entry.archived !== null
        && typeof entry.archived !== "number"
      ) {
        return null;
      }
      entries.push({
        relPath: entry.relPath,
        bytes: entry.bytes,
        mtimeMs: entry.mtimeMs,
        physicalRelPaths: physical,
        ...(typeof entry.threadId === "string" ? { threadId: entry.threadId } : {}),
        ...(typeof entry.rolloutPath === "string" ? { rolloutPath: entry.rolloutPath } : {}),
        ...(entry.archived === null || typeof entry.archived === "number"
          ? { archived: entry.archived as number | null }
          : {}),
      });
    }

    const out: TrashManifest = { entries };
    if (typeof o.quarantinedAt === "number" && Number.isFinite(o.quarantinedAt)) {
      out.quarantinedAt = o.quarantinedAt;
    }
    if (o.mode === "quarantine" || o.mode === "permanent") out.mode = o.mode;
    return out;
  } catch {
    return null;
  }
}

/**
 * Validate a trash entry id as a single `.trash/<epoch>` segment under CODEX_HOME.
 * Returns the absolute stage directory, or null when the id is unsafe / missing.
 */
export function resolveTrashStageDir(
  trashId: string,
  codexHome: string,
): { ok: true; stageDir: string; id: string } | { ok: false; error: RestoreErrorCode } {
  const normalized = toForwardSlash(trashId.trim()).replace(/\/+$/, "");
  if (!normalized.startsWith(`${TRASH_DIR}/`)) return { ok: false, error: "invalid_trash" };
  const rest = normalized.slice(TRASH_DIR.length + 1);
  if (!rest || rest.includes("/") || rest.includes("\\") || rest.includes("..")) {
    return { ok: false, error: "invalid_trash" };
  }
  if (!TRASH_EPOCH_DIR.test(rest)) return { ok: false, error: "invalid_trash" };
  let stageDir: string;
  try {
    stageDir = absFromRel(codexHome, `${TRASH_DIR}/${rest}`);
  } catch {
    return { ok: false, error: "invalid_trash" };
  }
  if (!existsSync(stageDir)) return { ok: false, error: "missing_trash" };
  try {
    if (!statSync(stageDir).isDirectory()) return { ok: false, error: "invalid_trash" };
  } catch {
    return { ok: false, error: "missing_trash" };
  }
  return { ok: true, stageDir, id: `${TRASH_DIR}/${rest}` };
}

function sumTrashEntryBytes(stageDir: string, manifest: TrashManifest | null): {
  fileCount: number;
  bytes: number;
} {
  let fileCount = 0;
  let bytes = 0;
  let names: string[] = [];
  try {
    names = readdirSync(stageDir);
  } catch {
    return { fileCount: 0, bytes: 0 };
  }
  for (const name of names) {
    if (
      name === "manifest.json"
      || name === SATELLITE_BACKUP_FILE
      || name === RESTORE_PENDING_FILE
    ) {
      continue;
    }
    if (!isRolloutFileName(name)) continue;
    try {
      const st = statSync(join(stageDir, name));
      if (!st.isFile()) continue;
      fileCount += 1;
      bytes += st.size;
    } catch { /* */ }
  }
  // Prefer live FS counts; fall back to manifest totals when the stage is empty of rollouts.
  if (fileCount === 0 && manifest?.entries?.length) {
    fileCount = manifest.entries.reduce((n, e) => n + Math.max(1, e.physicalRelPaths.length), 0);
    bytes = manifest.entries.reduce((n, e) => n + (e.bytes || 0), 0);
  }
  return { fileCount, bytes };
}

/** List quarantine entries under `CODEX_HOME/.trash/` (relative ids only). */
export function listTrashEntries(
  codexHome: string = resolveCodexHomeDir(),
): TrashEntrySummary[] {
  const trashRoot = join(codexHome, TRASH_DIR);
  let names: string[] = [];
  try {
    names = readdirSync(trashRoot);
  } catch {
    return [];
  }
  const out: TrashEntrySummary[] = [];
  for (const name of names) {
    if (!TRASH_EPOCH_DIR.test(name)) continue;
    const stageDir = join(trashRoot, name);
    try {
      if (!statSync(stageDir).isDirectory()) continue;
    } catch {
      continue;
    }
    let manifest: TrashManifest | null = null;
    try {
      manifest = parseTrashManifest(readFileSync(join(stageDir, "manifest.json"), "utf8"));
    } catch {
      manifest = null;
    }
    const { fileCount, bytes } = sumTrashEntryBytes(stageDir, manifest);
    // Skip empty collision placeholders left behind without a manifest or rollouts.
    if (fileCount === 0 && !manifest?.entries?.length) {
      try {
        if (!existsSync(join(stageDir, "manifest.json"))) continue;
      } catch {
        continue;
      }
    }
    out.push({
      id: `${TRASH_DIR}/${name}`,
      epoch: name,
      fileCount,
      bytes,
      ...(manifest?.quarantinedAt !== undefined ? { quarantinedAt: manifest.quarantinedAt } : {}),
      ...(manifest?.mode ? { mode: manifest.mode } : {}),
    });
  }
  out.sort((a, b) => {
    const aq = a.quarantinedAt ?? (Number(a.epoch.split("-")[0]) || 0);
    const bq = b.quarantinedAt ?? (Number(b.epoch.split("-")[0]) || 0);
    return bq - aq || b.epoch.localeCompare(a.epoch);
  });
  return out;
}

/** True when a snapshotted thread row covers every NOT NULL column on the live schema. */
function threadSnapshotCoversRequiredColumns(row: SqlRow, requiredCols: string[]): boolean {
  for (const col of requiredCols) {
    if (!(col in row) || row[col] === undefined) return false;
  }
  return true;
}

function requiredThreadColumnNames(db: Database): string[] {
  if (!tableExists(db, "threads")) return [];
  const rows = db.query<{ name: string; notnull: number }, []>(
    `PRAGMA table_info("threads")`,
  ).all();
  return rows.filter(r => r.notnull === 1).map(r => r.name);
}

/**
 * Build a production-shaped thread row for schemas that predate full satellite snapshots.
 * Prefer `readThreadFieldsFromRollout` (canonical history/session_meta path); fall back to
 * the sparse manifest fields only when the live schema does not require model/source/message.
 */
function reconstructThreadRowFromRollout(
  entry: CleanupManifestEntry,
  rolloutAbsPath: string,
  allowedCols: Set<string>,
  requiredCols: string[],
): SqlRow | null {
  if (typeof entry.threadId !== "string" || typeof entry.rolloutPath !== "string") return null;

  const fields = readThreadFieldsFromRollout(rolloutAbsPath);
  const row: SqlRow = {
    id: entry.threadId,
    rollout_path: entry.rolloutPath,
  };

  if (fields) {
    // Prefer manifest thread id (binding) but keep rollout-derived listing fields.
    if (allowedCols.has("model_provider")) row.model_provider = fields.modelProvider;
    if (allowedCols.has("source")) row.source = fields.source;
    if (allowedCols.has("first_user_message")) row.first_user_message = fields.firstUserMessage;
    if (allowedCols.has("has_user_event")) row.has_user_event = fields.hasUserEvent;
    if (allowedCols.has("cwd") && fields.cwd !== undefined) row.cwd = fields.cwd;
    if (allowedCols.has("history_mode") && fields.historyMode !== undefined) {
      row.history_mode = fields.historyMode;
    }
    if (allowedCols.has("cli_version") && fields.cliVersion !== undefined) {
      row.cli_version = fields.cliVersion;
    }
  }

  if (allowedCols.has("archived")) {
    row.archived = entry.archived ?? 1;
  }
  if (allowedCols.has("archived_at")) {
    row.archived_at = null;
  }

  // Fill remaining NOT NULL columns with safe empties when the rollout lacked them
  // (e.g. fixture rollouts without a user turn still need first_user_message = '').
  for (const col of requiredCols) {
    if (row[col] !== undefined) continue;
    if (col === "id" || col === "rollout_path") continue;
    if (col === "model_provider") row[col] = "openai";
    else if (col === "source") row[col] = "cli";
    else if (col === "first_user_message") row[col] = "";
    else if (col === "has_user_event") row[col] = 0;
    else if (col === "archived") row[col] = entry.archived ?? 1;
    else return null; // unknown required column we cannot invent
  }

  // If the schema requires listing fields, refuse when the rollout was unreadable.
  const needsSessionMeta = requiredCols.some(
    c => c === "model_provider" || c === "source" || c === "first_user_message",
  );
  if (needsSessionMeta && !fields) return null;

  return row;
}

function restoreThreadsFromManifest(
  stateDbPath: string | null,
  entries: CleanupManifestEntry[],
  backup: SatelliteBackup | null,
  busyTimeoutMs: number,
  codexHome: string,
): { ok: true } | ReconcileErr {
  const manifestThreadIds = entries
    .map(e => e.threadId)
    .filter((id): id is string => typeof id === "string");
  const backupThreadIds = backup?.threadIds ?? [];
  const needsThreads = manifestThreadIds.length > 0
    || backupThreadIds.length > 0
    || Boolean(backup?.threads?.length);

  if (needsThreads && (!stateDbPath || !existsSync(stateDbPath))) {
    return { ok: false, error: "db_reconcile_failed" };
  }
  if (!stateDbPath || !existsSync(stateDbPath)) {
    return { ok: true };
  }

  const result = withWritableDb(stateDbPath, busyTimeoutMs, db => {
    if (!tableExists(db, "threads")) throw new Error("missing_threads_table");

    const requiredCols = requiredThreadColumnNames(db);
    const allowedCols = tableColumnNames(db, "threads");
    const snapshotThreads = backup?.threads && isSqlRowArray(backup.threads)
      ? backup.threads
      : [];
    const completeSnapshots = snapshotThreads.filter(row =>
      threadSnapshotCoversRequiredColumns(row, requiredCols),
    );
    const coveredIds = new Set(
      completeSnapshots
        .map(r => r.id)
        .filter((id): id is string => typeof id === "string"),
    );

    // Legacy Phase-2 quarantine (no / incomplete satellite thread snapshots): reconstruct
    // every required column from the restored rollout via the history-provider session path.
    const toReconstruct = entries.filter(
      e => typeof e.threadId === "string"
        && typeof e.rolloutPath === "string"
        && !coveredIds.has(e.threadId!),
    );
    const reconstructed: SqlRow[] = [];
    for (const entry of toReconstruct) {
      let abs: string | undefined;
      try {
        abs = absFromRel(codexHome, entry.rolloutPath!);
      } catch {
        abs = undefined;
      }
      // Legacy compressed-only quarantine: manifest rolloutPath is often the logical
      // `.jsonl` name while the only restored physical file is `.jsonl.zst`.
      if (!abs || !existsSync(abs)) {
        for (const rel of entry.physicalRelPaths) {
          try {
            const candidate = absFromRel(codexHome, rel);
            if (existsSync(candidate)) {
              abs = candidate;
              break;
            }
          } catch {
            /* try next physical path */
          }
        }
      }
      if (!abs) throw new Error("missing_rollout_for_thread");
      // Prefer a plain .jsonl sibling when present; otherwise readThreadFieldsFromRollout
      // decompresses a lone .jsonl.zst in memory (bounded) for legacy quarantine restores.
      if (abs.endsWith(ZST_SUFFIX)) {
        const plain = abs.slice(0, -".zst".length);
        if (existsSync(plain)) abs = plain;
      }
      const row = reconstructThreadRowFromRollout(entry, abs, allowedCols, requiredCols);
      if (!row) throw new Error("thread_reconstruct_failed");
      reconstructed.push(row);
    }

    if (completeSnapshots.length > 0) {
      insertRowsConflictIgnore(db, "threads", completeSnapshots);
    }
    if (reconstructed.length > 0) {
      insertRowsConflictIgnore(db, "threads", reconstructed);
    }

    if (backup?.dynamicTools && isSqlRowArray(backup.dynamicTools) && tableExists(db, "thread_dynamic_tools")) {
      insertRowsConflictIgnore(db, "thread_dynamic_tools", backup.dynamicTools);
    }
    if (backup?.spawnEdges && isSqlRowArray(backup.spawnEdges) && tableExists(db, "thread_spawn_edges")) {
      insertRowsConflictIgnore(db, "thread_spawn_edges", backup.spawnEdges);
    }
  });
  if (!result.ok) return result;
  return { ok: true };
}

/** Test-only failure injection for restore atomicity regressions. */
export interface RestoreTestHooks {
  /** After state threads/dependents commit, before satellite commits. */
  failAfterStateCommit?: boolean;
  /** After the first satellite DB commit (logs → memories → goals). */
  failAfterFirstSatelliteCommit?: boolean;
  /** When the leftover staged-rollout completeness gate runs. */
  failAtLeftoverStageGate?: boolean;
  /** Fail the initial restore-pending.json write (before any file moves). */
  failInitialPendingWrite?: boolean;
  /** Fail a later pending update after the temp is written but before rename. */
  failPendingWriteBeforeRename?: boolean;
  /** Crash immediately after file moves (marker already durable). */
  failAfterFileMoves?: boolean;
  /**
   * After this many successful rollout moves in the current attempt, throw.
   * Exercises mid-loop failure with some dests placed and others still staged.
   */
  failAfterMoveCount?: number;
  /** Fail renaming the completed stage to a non-listable tombstone dir. */
  failStageTombstoneRename?: boolean;
  /** After tombstone rename, skip best-effort tombstone delete (orphan is OK). */
  failTombstoneDelete?: boolean;
  /**
   * Test-only: spin-wait this many ms after rollout file moves, before DB
   * reconcile, so cleanup can race an in-flight restore.
   */
  holdAfterFileMovesMs?: number;
  /**
   * Test-only: publish a ready file after rollout moves, then wait until the
   * release file exists. This makes cross-thread race tests phase-driven.
   */
  pauseAfterFileMoves?: { readyPath: string; releasePath: string };
}

/**
 * Resume must not clear owed satellite work when the matching backup section is
 * absent — fail closed per section instead.
 */
function failClosedSatelliteResume(
  priorPending: RestorePendingState,
  satelliteBackup: SatelliteBackup | null,
): RestoreErrorCode | null {
  const owed = priorPending.pending;
  if (!owed.logs && !owed.memories && !owed.goals) return null;
  if (!satelliteBackup) return "db_reconcile_failed";
  if (owed.logs && !satelliteBackup.logs) return "db_reconcile_failed";
  if (owed.memories && !satelliteBackup.memories) return "db_reconcile_failed";
  if (owed.goals && !satelliteBackup.goals) return "db_reconcile_failed";
  return null;
}

/**
 * Successful restore finalization: rename the stage to a tombstone name that
 * `listTrashEntries` ignores, then delete the tombstone best-effort. A failed
 * rename leaves the original stage (and all evidence) intact for retry.
 */
function finalizeRestoredStage(
  stageDir: string,
  codexHome: string,
  hooks?: Pick<RestoreTestHooks, "failStageTombstoneRename" | "failTombstoneDelete">,
): boolean {
  const trashRoot = join(codexHome, TRASH_DIR);
  const epoch = basename(stageDir);
  const tombstoneName = `.tombstone-${epoch}-${randomUUID()}`;
  const tombstonePath = join(trashRoot, tombstoneName);
  try {
    if (hooks?.failStageTombstoneRename) throw new Error("test_fail_stage_tombstone_rename");
    renameSync(stageDir, tombstonePath);
  } catch {
    return false;
  }
  if (!hooks?.failTombstoneDelete) {
    try { rmSync(tombstonePath, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  return true;
}

/**
 * Restore one quarantine entry: move JSONL back, re-insert threads (+ satellites
 * when satellite-backup.json is present), then remove the trash directory.
 *
 * Late failures after files have moved never compensate metadata or restage.
 * Instead they persist `restore-pending.json` (accepted dest paths + which
 * state/logs/memories/goals sections still need work) atomically *before* any
 * rollout move, then update it after each section so a retry can accept existing
 * destinations and resume only missing metadata.
 */
export function restoreTrashEntry(
  trashId: string,
  options?: {
    codexHome?: string;
    busyTimeoutMs?: number;
    _test?: RestoreTestHooks;
  },
): RestoreResult {
  const codexHome = options?.codexHome ?? resolveCodexHomeDir();
  const busyTimeoutMs = options?.busyTimeoutMs ?? 100;
  const hooks = options?._test;

  const resolved = resolveTrashStageDir(trashId, codexHome);
  if (!resolved.ok) {
    return { ok: false, count: 0, bytes: 0, restoredPaths: [], error: resolved.error };
  }
  const { stageDir, id } = resolved;

  let manifestRaw: string;
  try {
    manifestRaw = readFileSync(join(stageDir, "manifest.json"), "utf8");
  } catch {
    return { ok: false, trashDir: id, count: 0, bytes: 0, restoredPaths: [], error: "invalid_trash" };
  }
  const manifest = parseTrashManifest(manifestRaw);
  if (!manifest?.entries?.length) {
    return { ok: false, trashDir: id, count: 0, bytes: 0, restoredPaths: [], error: "invalid_trash" };
  }

  const pendingRead = readRestorePending(stageDir);
  if (pendingRead.status === "invalid") {
    // Malformed marker means an incomplete restore may already have moved files;
    // never treat it as a fresh restore.
    return { ok: false, trashDir: id, count: 0, bytes: 0, restoredPaths: [], error: "fs_failed" };
  }
  const priorPending = pendingRead.status === "valid" ? pendingRead.state : null;
  const acceptedDest = new Set(priorPending?.acceptedDestRels ?? []);

  // Partial permanent purges may leave only a subset of physical files on disk —
  // trim to survivors rather than failing the whole entry for a purged twin.
  // Resume also treats already-restored accepted destinations as survivors.
  const entries: CleanupManifestEntry[] = [];
  for (const entry of manifest.entries) {
    if (!entry.physicalRelPaths.every(isSafeArchivedPhysicalRel)) {
      return { ok: false, trashDir: id, count: 0, bytes: 0, restoredPaths: [], error: "invalid_trash" };
    }
    const surviving = entry.physicalRelPaths.filter(rel => {
      if (existsSync(join(stageDir, basename(rel)))) return true;
      if (!acceptedDest.has(rel)) return false;
      try {
        return existsSync(absFromRel(codexHome, rel));
      } catch {
        return false;
      }
    });
    if (surviving.length === 0) {
      return { ok: false, trashDir: id, count: 0, bytes: 0, restoredPaths: [], error: "fs_failed" };
    }
    entries.push({ ...entry, physicalRelPaths: surviving });
  }

  const paths = discoverRuntimeDbPaths(codexHome);
  const backupRead = readSatelliteBackupFile(stageDir);
  if (backupRead.status === "invalid") {
    return {
      ok: false,
      trashDir: id,
      count: 0,
      bytes: 0,
      restoredPaths: [],
      error: "db_reconcile_failed",
    };
  }

  let satelliteBackup: SatelliteBackup | null = null;
  if (backupRead.status === "ok") {
    const remapped = remapSatelliteBackupPaths(backupRead.backup, paths);
    if (!remapped.ok) {
      return {
        ok: false,
        trashDir: id,
        count: 0,
        bytes: 0,
        restoredPaths: [],
        error: "db_reconcile_failed",
      };
    }
    satelliteBackup = remapped.backup;
  }

  if (priorPending) {
    const resumeErr = failClosedSatelliteResume(priorPending, satelliteBackup);
    if (resumeErr) {
      return {
        ok: false,
        trashDir: id,
        count: 0,
        bytes: 0,
        restoredPaths: [],
        error: resumeErr,
      };
    }
  }

  const pendingSections: RestorePendingSections = {
    state: priorPending ? priorPending.pending.state : true,
    logs: priorPending ? priorPending.pending.logs : Boolean(satelliteBackup?.logs),
    memories: priorPending ? priorPending.pending.memories : Boolean(satelliteBackup?.memories),
    goals: priorPending ? priorPending.pending.goals : Boolean(satelliteBackup?.goals),
  };

  const needAnySatellite = pendingSections.logs || pendingSections.memories || pendingSections.goals;
  if (pendingSections.state) {
    const needsThreads = entries.some(e => typeof e.threadId === "string")
      || Boolean(satelliteBackup?.threadIds?.length)
      || Boolean(satelliteBackup?.threads?.length);
    if (needsThreads && (!paths.state || !existsSync(paths.state))) {
      return {
        ok: false,
        trashDir: id,
        count: 0,
        bytes: 0,
        restoredPaths: [],
        error: "db_reconcile_failed",
      };
    }
    const probe = probeStateDbWritable(codexHome, busyTimeoutMs);
    if (!probe.ok) {
      return {
        ok: false,
        trashDir: id,
        count: 0,
        bytes: 0,
        restoredPaths: [],
        error: probe.error === "codex_busy" ? "codex_busy" : "db_reconcile_failed",
      };
    }
  }

  // Acquire only the satellite locks still needed so a busy DB for an already-
  // finished section cannot block resume. Locks happen before moves on a fresh
  // attempt so failure stays retryable (nothing has left the stage yet).
  let satelliteLocks: SatelliteWriteLocks | undefined;
  if (needAnySatellite) {
    try {
      satelliteLocks = beginSatelliteWriteLocks(paths, busyTimeoutMs, {
        logs: pendingSections.logs,
        memories: pendingSections.memories,
        goals: pendingSections.goals,
      });
    } catch (error) {
      return {
        ok: false,
        trashDir: id,
        count: 0,
        bytes: 0,
        restoredPaths: [],
        error: mapDbError(error) === "codex_busy" ? "codex_busy" : "db_reconcile_failed",
      };
    }
  }

  const failBeforeMoves = (error: RestoreErrorCode): RestoreResult => {
    if (satelliteLocks) rollbackAllSatelliteLocks(satelliteLocks);
    return { ok: false, trashDir: id, count: 0, bytes: 0, restoredPaths: [], error };
  };

  // Plan renames: staged basename → original archived_sessions path.
  // Resume accepts destinations already restored by this incomplete attempt.
  const alreadyMoved: StagedFile[] = [];
  const toMove: StagedFile[] = [];
  for (const entry of entries) {
    for (const rel of entry.physicalRelPaths) {
      const base = basename(rel);
      const from = join(stageDir, base);
      let to: string;
      try {
        to = absFromRel(codexHome, rel);
      } catch {
        return failBeforeMoves("invalid_trash");
      }
      const fromExists = existsSync(from);
      const toExists = existsSync(to);
      if (toExists && acceptedDest.has(rel) && !fromExists) {
        alreadyMoved.push({ from, to, relPath: rel });
        continue;
      }
      if (toExists) {
        return failBeforeMoves("dest_exists");
      }
      if (!fromExists) {
        return failBeforeMoves("fs_failed");
      }
      toMove.push({ from, to, relPath: rel });
    }
  }

  const planned = [...alreadyMoved, ...toMove];
  const restoredPaths = [...new Set(entries.map(e => e.relPath))];
  const bytes = entries.reduce((sum, e) => sum + (e.bytes || 0), 0);
  const partialCounts = { count: restoredPaths.length, bytes, restoredPaths };

  let pendingWriteCount = 0;
  const persistPending = (): void => {
    pendingWriteCount += 1;
    const isInitial = pendingWriteCount === 1;
    writeRestorePending(
      stageDir,
      {
        version: 1,
        filesRestored: true,
        acceptedDestRels: planned.map(m => m.relPath),
        pending: { ...pendingSections },
      },
      {
        failWrite: Boolean(isInitial && hooks?.failInitialPendingWrite),
        failBeforeRename: Boolean(!isInitial && hooks?.failPendingWriteBeforeRename),
      },
    );
  };

  // Durable resume marker before any rollout leaves the stage. Crash after a
  // later move can still accept destinations from this marker.
  try {
    persistPending();
  } catch {
    return failBeforeMoves("fs_failed");
  }

  const newlyMoved: StagedFile[] = [];
  try {
    mkdirSync(join(codexHome, ARCHIVED_SESSIONS_DIR), { recursive: true });
    for (const item of toMove) {
      // Atomic no-replace (.trash ↔ archived_sessions). Mid-loop failure keeps
      // already-placed dests and the durable planned acceptedDestRels marker.
      renameNoReplace(item.from, item.to);
      newlyMoved.push(item);
      if (
        hooks?.failAfterMoveCount !== undefined
        && newlyMoved.length >= hooks.failAfterMoveCount
      ) {
        throw new Error("test_fail_after_move_count");
      }
    }
  } catch (error) {
    // Marker was written before any move. Never reverse successful renames or
    // drop/narrow acceptedDestRels — resume must accept placed dests and finish
    // the remaining staged files.
    if (satelliteLocks) rollbackAllSatelliteLocks(satelliteLocks);
    const placed = [...alreadyMoved, ...newlyMoved];
    const placedPhysical = new Set(placed.map(m => m.relPath));
    const partialEntries = entries.filter(e =>
      e.physicalRelPaths.every(rel => placedPhysical.has(rel)),
    );
    const midMoveRestored = [...new Set(partialEntries.map(e => e.relPath))];
    return {
      ok: false,
      trashDir: id,
      count: midMoveRestored.length,
      bytes: partialEntries.reduce((sum, e) => sum + (e.bytes || 0), 0),
      restoredPaths: midMoveRestored,
      error: isExistError(error) ? "dest_exists" : "fs_failed",
    };
  }

  const moved = [...alreadyMoved, ...newlyMoved];

  /**
   * Never compensate DBs or restage files after moves. Keep restored files,
   * persist which sections remain, and return accurate partial counts.
   */
  const abortAfterMoves = (error: RestoreErrorCode): RestoreResult => {
    if (satelliteLocks) {
      rollbackAllSatelliteLocks(satelliteLocks);
      satelliteLocks = undefined;
    }
    try {
      persistPending();
    } catch {
      /* best-effort — files already restored; prior atomic marker remains */
    }
    return { ok: false, trashDir: id, ...partialCounts, error };
  };

  if (hooks?.pauseAfterFileMoves) {
    writeFileSync(hooks.pauseAfterFileMoves.readyPath, "ready\n");
    while (!existsSync(hooks.pauseAfterFileMoves.releasePath)) Bun.sleepSync(10);
  }

  if (hooks?.holdAfterFileMovesMs !== undefined) {
    const holdMs = Math.max(0, Math.floor(hooks.holdAfterFileMovesMs));
    if (holdMs > 0) {
      const deadline = Date.now() + holdMs;
      while (Date.now() < deadline) { /* test-only spin wait */ }
    }
  }

  if (hooks?.failAfterFileMoves) {
    return abortAfterMoves("fs_failed");
  }

  if (pendingSections.state) {
    const threadsRestored = restoreThreadsFromManifest(
      paths.state,
      entries,
      satelliteBackup,
      busyTimeoutMs,
      codexHome,
    );
    if (!threadsRestored.ok) {
      return abortAfterMoves(
        threadsRestored.error === "codex_busy" ? "codex_busy" : "db_reconcile_failed",
      );
    }
    pendingSections.state = false;
    try {
      persistPending();
    } catch {
      return abortAfterMoves("fs_failed");
    }
  }

  if (hooks?.failAfterStateCommit) {
    return abortAfterMoves("db_reconcile_failed");
  }

  if (satelliteLocks && satelliteBackup) {
    const locks = satelliteLocks;
    try {
      // Commit one satellite DB at a time; uncommitted txs roll back via
      // rollbackAllSatelliteLocks. Completed sections are cleared in pending.
      if (pendingSections.logs && satelliteBackup.logs) {
        if (!locks.logs) throw new Error("missing_logs_lock");
        if (!tableExists(locks.logs.db, "logs")) throw new Error("missing_logs_table");
        insertRowsConflictIgnore(locks.logs.db, "logs", satelliteBackup.logs.rows);
        commitSatelliteLock(locks.logs);
        locks.logs = undefined;
        pendingSections.logs = false;
        persistPending();
        if (hooks?.failAfterFirstSatelliteCommit) {
          throw new Error("test_fail_after_first_satellite");
        }
      }
      if (pendingSections.memories && satelliteBackup.memories) {
        if (!locks.memories) throw new Error("missing_memories_lock");
        const mem = satelliteBackup.memories;
        if (!tableExists(locks.memories.db, "stage1_outputs")) {
          throw new Error("missing_stage1_outputs_table");
        }
        insertRowsConflictIgnore(locks.memories.db, "stage1_outputs", mem.stage1);
        if (tableExists(locks.memories.db, "jobs")) {
          insertRowsConflictIgnore(locks.memories.db, "jobs", mem.stage1Jobs);
          if (mem.consolidateTouched) {
            restoreConsolidateGlobalJob(
              locks.memories.db,
              mem.consolidateJob,
              mem.consolidatePostImage,
            );
          }
        }
        commitSatelliteLock(locks.memories);
        locks.memories = undefined;
        pendingSections.memories = false;
        persistPending();
        if (hooks?.failAfterFirstSatelliteCommit && !satelliteBackup.logs) {
          throw new Error("test_fail_after_first_satellite");
        }
      }
      if (pendingSections.goals && satelliteBackup.goals) {
        if (!locks.goals) throw new Error("missing_goals_lock");
        const g = satelliteBackup.goals;
        if (!tableExists(locks.goals.db, "thread_goals")) {
          throw new Error("missing_thread_goals_table");
        }
        insertRowsConflictIgnore(locks.goals.db, "thread_goals", g.goals);
        if (tableExists(locks.goals.db, "thread_goal_continuation_deferrals")) {
          insertRowsConflictIgnore(
            locks.goals.db,
            "thread_goal_continuation_deferrals",
            g.deferrals,
          );
        }
        commitSatelliteLock(locks.goals);
        locks.goals = undefined;
        pendingSections.goals = false;
        persistPending();
        if (
          hooks?.failAfterFirstSatelliteCommit
          && !satelliteBackup.logs
          && !satelliteBackup.memories
        ) {
          throw new Error("test_fail_after_first_satellite");
        }
      }
      // Close any locks acquired for DBs that had no pending work / backup rows.
      rollbackAllSatelliteLocks(locks);
      satelliteLocks = undefined;
    } catch (error) {
      return abortAfterMoves(
        mapDbError(error) === "codex_busy" ? "codex_busy" : "db_reconcile_failed",
      );
    }
  }

  if (
    pendingSections.state
    || pendingSections.logs
    || pendingSections.memories
    || pendingSections.goals
  ) {
    return abortAfterMoves("db_reconcile_failed");
  }

  // Completeness gate: every planned file must sit at its restored path, and the stage
  // must hold no leftover rollout files, before we destroy the quarantine evidence.
  for (const item of moved) {
    if (!existsSync(item.to) || existsSync(item.from)) {
      return abortAfterMoves("fs_failed");
    }
  }
  try {
    if (hooks?.failAtLeftoverStageGate) {
      return abortAfterMoves("fs_failed");
    }
    for (const name of readdirSync(stageDir)) {
      if (
        name === "manifest.json"
        || name === SATELLITE_BACKUP_FILE
        || name === RESTORE_PENDING_FILE
      ) {
        continue;
      }
      if (!isRolloutFileName(name)) continue;
      return abortAfterMoves("fs_failed");
    }
  } catch {
    return abortAfterMoves("fs_failed");
  }

  if (!finalizeRestoredStage(stageDir, codexHome, hooks)) {
    return {
      ok: false,
      trashDir: id,
      ...partialCounts,
      error: "fs_failed",
    };
  }
  removeEmptyTrashRoot(codexHome);

  return {
    ok: true,
    trashDir: id,
    ...partialCounts,
  };
}
