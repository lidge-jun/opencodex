/**
 * Phase 2 archived-session cleanup (issue #42 Option A).
 *
 * Preview + execute for files under `archived_sessions/` only. Active `sessions/`
 * are never touched. Default mode quarantines into `CODEX_HOME/.trash/<epoch>/`;
 * permanent delete is opt-in.
 *
 * Execution is bound to a preview digest. All candidates are staged first; any FS
 * Freezes the thread-ID set under the state write lock, persists a complete
 * satellite-backup.json before any satellite delete commit, then mutates
 * `logs_*` → `memories_*` → `goals_*` → `state_*`. Later failures restore
 * satellite rows before staged files. Success never carries soft `dbWarning` /
 * `failedPaths`.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  chmodSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Database } from "bun:sqlite";
import { resolveCodexHomeDir } from "../codex/home";
import { readThreadFieldsFromRollout } from "../codex/history-provider";
import { renameAtomicFile } from "../config";

export const ARCHIVED_SESSIONS_DIR = "archived_sessions";
export const TRASH_DIR = ".trash";

export type CleanupMode = "quarantine" | "permanent";

/** Mapped failure codes only — never embed absolute host paths. */
export type CleanupErrorCode =
  | "invalid_mode"
  | "invalid_digest"
  | "stale_preview"
  | "codex_busy"
  | "storage_mutation_busy"
  | "fs_failed"
  | "db_reconcile_failed"
  | "referenced_history"
  | "pinned_thread"
  | "restore_pending_overlap"
  | "cleanup_failed";

export interface ArchivedCandidate {
  /** Path relative to CODEX_HOME, forward-slash separated (logical `.jsonl` path). */
  relPath: string;
  absPath: string;
  bytes: number;
  mtimeMs: number;
  /** All physical files for this logical rollout (`.jsonl` and/or `.jsonl.zst`). */
  physicalRelPaths: string[];
  /** Per-physical-file metadata bound into the preview digest. */
  physicalFiles: Array<{ relPath: string; bytes: number; mtimeMs: number }>;
}

export interface CleanupPreview {
  codexHome: string;
  percent: number;
  count: number;
  bytes: number;
  /** HMAC-free content digest binding execute to this exact candidate set. */
  digest: string;
  candidates: ArchivedCandidate[];
}

export interface CleanupManifestEntry {
  relPath: string;
  bytes: number;
  mtimeMs: number;
  physicalRelPaths: string[];
  threadId?: string;
  rolloutPath?: string;
  archived?: number | null;
}

export interface CleanupResult {
  ok: boolean;
  mode: CleanupMode;
  percent: number;
  count: number;
  bytes: number;
  trashDir?: string;
  error?: CleanupErrorCode;
  removedPaths: string[];
}

const STATE_DB_FILE = /^state_(\d+)\.sqlite$/;
const LOGS_DB_FILE = /^logs_(\d+)\.sqlite$/;
const GOALS_DB_FILE = /^goals_(\d+)\.sqlite$/;
const MEMORIES_DB_FILE = /^memories_(\d+)\.sqlite$/;
const JSONL_SUFFIX = ".jsonl";
const ZST_SUFFIX = ".jsonl.zst";
const JOB_KIND_MEMORY_STAGE1 = "memory_stage1";
const JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL = "memory_consolidate_global";
const MEMORY_CONSOLIDATION_JOB_KEY = "global";
const DEFAULT_RETRY_REMAINING = 3;
/** Chunk size for `IN (...)` binds; spawn-edge checks bind each id twice. */
const SQLITE_ID_CHUNK = 200;

function chmodPrivatePath(path: string, mode: number): void {
  try { chmodSync(path, mode); } catch { /* best-effort (e.g. Windows ACLs) */ }
}

function writePrivateFile(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
  chmodPrivatePath(path, 0o600);
}

function chunkIds(ids: string[], chunkSize: number): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += chunkSize) chunks.push(ids.slice(i, i + chunkSize));
  return chunks;
}

/** Create `.trash/<epoch>` exclusively; suffix on collision. */
function createExclusiveStageDir(codexHome: string, epoch: number): string {
  const trashRoot = join(codexHome, TRASH_DIR);
  mkdirSync(trashRoot, { recursive: true });
  chmodPrivatePath(trashRoot, 0o700);
  for (let attempt = 0; attempt < 100; attempt++) {
    const name = attempt === 0 ? String(epoch) : `${epoch}-${attempt}`;
    const stageDir = join(trashRoot, name);
    try {
      mkdirSync(stageDir);
      chmodPrivatePath(stageDir, 0o700);
      return stageDir;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error("stage_dir_collision");
}

function isSafeArchiveFileName(name: string): boolean {
  if (name.includes("/") || name.includes("\\") || name.includes("..")) return false;
  return isRolloutFileName(name);
}

function clampPercent(percent: unknown): number {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, Math.floor(percent)));
}

function toForwardSlash(p: string): string {
  return p.split(sep).join("/");
}

/** Strip trailing `.zst` so plain + compressed share one logical rollout id. */
export function logicalRolloutRelPath(relPath: string): string {
  const normalized = toForwardSlash(relPath);
  return normalized.endsWith(ZST_SUFFIX)
    ? normalized.slice(0, -".zst".length)
    : normalized;
}

function isRolloutFileName(name: string): boolean {
  return name.endsWith(ZST_SUFFIX) || name.endsWith(JSONL_SUFFIX);
}

/** Newest `prefix_N.sqlite` under CODEX_HOME, or null when absent. */
function newestVersionedDb(codexHome: string, pattern: RegExp): string | null {
  let best: string | null = null;
  let bestVersion = -1;
  let names: string[] = [];
  try {
    names = readdirSync(codexHome);
  } catch {
    return null;
  }
  for (const name of names) {
    const match = name.match(pattern);
    if (!match) continue;
    const version = Number(match[1]);
    if (version > bestVersion) {
      bestVersion = version;
      best = name;
    }
  }
  return best ? join(codexHome, best) : null;
}

function newestStateDb(codexHome: string): string | null {
  return newestVersionedDb(codexHome, STATE_DB_FILE);
}

interface RuntimeDbPaths {
  state: string | null;
  logs: string | null;
  goals: string | null;
  memories: string | null;
}

function discoverRuntimeDbPaths(codexHome: string): RuntimeDbPaths {
  return {
    state: newestVersionedDb(codexHome, STATE_DB_FILE),
    logs: newestVersionedDb(codexHome, LOGS_DB_FILE),
    goals: newestVersionedDb(codexHome, GOALS_DB_FILE),
    memories: newestVersionedDb(codexHome, MEMORIES_DB_FILE),
  };
}

/**
 * Normalize a DB `rollout_path` to a CODEX_HOME-relative forward-slash path, then
 * to the logical `.jsonl` form. Returns null when the path is not under
 * `archived_sessions/` (rejects active `sessions/` and foreign paths).
 */
export function normalizeArchivedRolloutPath(rolloutPath: string, codexHome: string): string | null {
  const raw = toForwardSlash(rolloutPath.trim());
  if (!raw) return null;
  let relativePath = raw;
  try {
    // Prefer Node's absolute-path detection. Do not treat a colon anywhere in the
    // filename (Codex ISO timestamps) as an absolute Windows path.
    const looksAbsolute = isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw);
    const abs = looksAbsolute ? resolve(raw) : resolve(codexHome, raw);
    const homeAbs = resolve(codexHome);
    const rel = toForwardSlash(relative(homeAbs, abs));
    if (rel.startsWith("..") || rel === "") return null;
    relativePath = rel;
  } catch {
    return null;
  }
  const logical = logicalRolloutRelPath(relativePath);
  if (!logical.startsWith(`${ARCHIVED_SESSIONS_DIR}/`)) return null;
  if (!logical.endsWith(JSONL_SUFFIX)) return null;
  // Reject path tricks: only a single file under archived_sessions/
  const rest = logical.slice(ARCHIVED_SESSIONS_DIR.length + 1);
  if (!rest || rest.includes("/") || rest.includes("..")) return null;
  return logical;
}

function candidateDigestLines(candidates: ArchivedCandidate[]): string[] {
  return candidates
    .map(c => {
      const physical = [...c.physicalFiles]
        .sort((a, b) => a.relPath.localeCompare(b.relPath))
        .map(f => `${f.relPath}|${f.bytes}|${Math.trunc(f.mtimeMs)}`)
        .join(",");
      return `${c.relPath}|${c.bytes}|${Math.trunc(c.mtimeMs)}|${physical}`;
    })
    .sort();
}

/** Content digest of the exact previewed candidate set (paths + size + mtime). */
export function computePreviewDigest(candidates: ArchivedCandidate[], percent: number): string {
  return createHash("sha256")
    .update(`${clampPercent(percent)}\n${candidateDigestLines(candidates).join("\n")}`)
    .digest("hex");
}

/**
 * Digest bound to an explicit candidate list (not a percent selection).
 * Used when reduceToBytes needs an exact count that percent rounding cannot represent.
 */
export function computeExactPreviewDigest(candidates: ArchivedCandidate[]): string {
  return createHash("sha256")
    .update(`exact\n${candidateDigestLines(candidates).join("\n")}`)
    .digest("hex");
}

/** List archived rollout groups oldest-first. Never walks `sessions/`. */
export function listArchivedCandidates(codexHome: string): ArchivedCandidate[] {
  const dir = join(codexHome, ARCHIVED_SESSIONS_DIR);
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  type Acc = {
    logicalRel: string;
    files: Array<{ name: string; absPath: string; relPath: string; bytes: number; mtimeMs: number }>;
  };
  const groups = new Map<string, Acc>();

  for (const name of names) {
    if (!isSafeArchiveFileName(name)) continue;
    const absPath = join(dir, name);
    try {
      const st = statSync(absPath);
      if (!st.isFile()) continue;
      const relPath = `${ARCHIVED_SESSIONS_DIR}/${name}`;
      const logicalRel = logicalRolloutRelPath(relPath);
      let acc = groups.get(logicalRel);
      if (!acc) {
        acc = { logicalRel, files: [] };
        groups.set(logicalRel, acc);
      }
      acc.files.push({
        name,
        absPath,
        relPath,
        bytes: st.size,
        mtimeMs: st.mtimeMs,
      });
    } catch {
      /* vanished mid-scan */
    }
  }

  const out: ArchivedCandidate[] = [];
  for (const acc of groups.values()) {
    // Prefer the plain `.jsonl` path as the public/logical identity when both exist.
    acc.files.sort((a, b) => a.relPath.localeCompare(b.relPath));
    const primary =
      acc.files.find(f => f.relPath === acc.logicalRel) ??
      acc.files[0]!;
    out.push({
      relPath: acc.logicalRel,
      absPath: primary.absPath,
      bytes: acc.files.reduce((sum, f) => sum + f.bytes, 0),
      mtimeMs: Math.min(...acc.files.map(f => f.mtimeMs)),
      physicalRelPaths: acc.files.map(f => f.relPath),
      physicalFiles: acc.files.map(f => ({ relPath: f.relPath, bytes: f.bytes, mtimeMs: f.mtimeMs })),
    });
  }
  out.sort((a, b) => a.mtimeMs - b.mtimeMs || a.relPath.localeCompare(b.relPath));
  return out;
}

export function selectOldestPercent(candidates: ArchivedCandidate[], percent: number): ArchivedCandidate[] {
  const pct = clampPercent(percent);
  if (pct <= 0 || candidates.length === 0) return [];
  if (pct >= 100) return [...candidates];
  const n = percentSelectionTargetCount(candidates.length, pct);
  return candidates.slice(0, n);
}

/** Count implied by percent selection over the full candidate list. */
export function percentSelectionTargetCount(totalCount: number, percent: number): number {
  const pct = clampPercent(percent);
  if (pct <= 0 || totalCount === 0) return 0;
  if (pct >= 100) return totalCount;
  return Math.max(1, Math.floor((totalCount * pct) / 100));
}

function candidateOverlapsPendingRestore(
  candidate: ArchivedCandidate,
  pendingDestRels: ReadonlySet<string>,
): boolean {
  if (pendingDestRels.size === 0) return false;
  for (const rel of candidate.physicalRelPaths) {
    if (pendingDestRels.has(rel)) return true;
  }
  return pendingDestRels.has(candidate.relPath);
}

/** Drop cleanup candidates whose physical paths overlap an in-progress restore. */
export function filterCandidatesExcludingPendingRestore(
  candidates: ArchivedCandidate[],
  codexHome: string = resolveCodexHomeDir(),
): ArchivedCandidate[] {
  const pendingDestRels = collectRestorePendingAcceptedDestRels(codexHome);
  if (pendingDestRels.size === 0) return candidates;
  return candidates.filter(c => !candidateOverlapsPendingRestore(c, pendingDestRels));
}

/**
 * Oldest-first percent selection that skips pending-restore destinations without
 * consuming the percent budget, backfilling with the next oldest safe candidates.
 */
export function selectOldestPercentSkippingPendingRestore(
  candidates: ArchivedCandidate[],
  percent: number,
  codexHome: string = resolveCodexHomeDir(),
): ArchivedCandidate[] {
  const target = percentSelectionTargetCount(candidates.length, percent);
  if (target === 0) return [];
  const pendingDestRels = collectRestorePendingAcceptedDestRels(codexHome);
  const out: ArchivedCandidate[] = [];
  for (const c of candidates) {
    if (candidateOverlapsPendingRestore(c, pendingDestRels)) continue;
    out.push(c);
    if (out.length >= target) break;
  }
  return out;
}

/**
 * Reduce archived total toward `reduceToBytes` using oldest safe candidates only.
 * Pending-restore destinations are skipped and do not count toward bytes freed.
 */
export function selectReduceToBytesSkippingPendingRestore(
  candidates: ArchivedCandidate[],
  reduceToBytes: number,
  codexHome: string = resolveCodexHomeDir(),
): ArchivedCandidate[] {
  if (!Number.isFinite(reduceToBytes) || reduceToBytes < 0) return [];
  const total = candidates.reduce((sum, c) => sum + c.bytes, 0);
  if (total <= reduceToBytes) return [];
  const need = total - reduceToBytes;
  const pendingDestRels = collectRestorePendingAcceptedDestRels(codexHome);
  const out: ArchivedCandidate[] = [];
  let freed = 0;
  for (const c of candidates) {
    if (candidateOverlapsPendingRestore(c, pendingDestRels)) continue;
    out.push(c);
    freed += c.bytes;
    if (freed >= need) break;
  }
  return out;
}

/** Accepted destination paths from every valid in-progress restore marker under `.trash`. */
export function collectRestorePendingAcceptedDestRels(codexHome: string): Set<string> {
  const out = new Set<string>();
  const trashRoot = join(codexHome, TRASH_DIR);
  if (!existsSync(trashRoot)) return out;
  for (const name of readdirSync(trashRoot)) {
    if (!TRASH_EPOCH_DIR.test(name)) continue;
    const read = readRestorePending(join(trashRoot, name));
    if (read.status !== "valid") continue;
    for (const rel of read.state.acceptedDestRels) out.add(rel);
  }
  return out;
}

/**
 * Normalized rollout paths of pinned threads. Pinned threads are never
 * cleanup candidates: a pin is the user's explicit "keep this" signal and
 * deleting its rollout would be permanent task-data loss (#858).
 *
 * Selection-time use is advisory: on any DB problem this returns an empty
 * set, and the write-locked re-check inside reconcileDeletedThreads stays
 * the fail-closed gate. Older schemas without `is_pinned` keep prior
 * behavior.
 */
function collectPinnedArchivedRolloutPaths(codexHome: string): Set<string> {
  const statePath = discoverRuntimeDbPaths(codexHome).state;
  if (!statePath || !existsSync(statePath)) return new Set();
  let db: Database | undefined;
  try {
    db = new Database(statePath, { readonly: true });
    if (!tableExists(db, "threads") || !columnExists(db, "threads", "is_pinned")) {
      return new Set();
    }
    const rows = db.query<{ rollout_path: string }, []>(
      `SELECT rollout_path FROM threads WHERE is_pinned = 1`,
    ).all();
    const out = new Set<string>();
    for (const row of rows) {
      const normalized = normalizeArchivedRolloutPath(row.rollout_path, codexHome);
      if (normalized) out.add(normalized);
    }
    return out;
  } catch {
    return new Set();
  } finally {
    try { db?.close(); } catch { /* */ }
  }
}

/** Drop candidates whose rollout belongs to a pinned thread (#858). */
export function filterCandidatesExcludingPinned(
  candidates: ArchivedCandidate[],
  codexHome: string,
): ArchivedCandidate[] {
  const pinned = collectPinnedArchivedRolloutPaths(codexHome);
  if (pinned.size === 0) return candidates;
  return candidates.filter(c => !pinned.has(c.relPath));
}

export function previewArchivedCleanup(
  percent: number,
  codexHome: string = resolveCodexHomeDir(),
): CleanupPreview {
  const all = listArchivedCandidates(codexHome);
  const safe = selectOldestPercentSkippingPendingRestore(
    filterCandidatesExcludingPinned(all, codexHome),
    percent,
    codexHome,
  );
  const pct = clampPercent(percent);
  return {
    codexHome,
    percent: pct,
    count: safe.length,
    bytes: safe.reduce((sum, c) => sum + c.bytes, 0),
    digest: computePreviewDigest(safe, pct),
    candidates: safe,
  };
}

/** Preview bound to an explicit candidate set (exact digest, percent left at 0). */
export function previewExactArchivedCleanup(
  candidates: ArchivedCandidate[],
  codexHome: string = resolveCodexHomeDir(),
): CleanupPreview {
  const safe = filterCandidatesExcludingPinned(
    filterCandidatesExcludingPendingRestore(candidates, codexHome),
    codexHome,
  );
  return {
    codexHome,
    percent: 0,
    count: safe.length,
    bytes: safe.reduce((sum, c) => sum + c.bytes, 0),
    digest: computeExactPreviewDigest(safe),
    candidates: safe,
  };
}

/**
 * Resolve an exact candidate list from current archive state.
 * Returns null when any requested path is missing or drifted (caller maps to stale_preview).
 */
export function resolveExactArchivedCandidates(
  candidateRelPaths: string[],
  codexHome: string = resolveCodexHomeDir(),
): ArchivedCandidate[] | null {
  if (!Array.isArray(candidateRelPaths) || candidateRelPaths.length === 0) return [];
  const all = listArchivedCandidates(codexHome);
  const byRel = new Map(all.map(c => [c.relPath, c]));
  const selected: ArchivedCandidate[] = [];
  for (const rel of candidateRelPaths) {
    const hit = byRel.get(rel);
    if (!hit) return null;
    selected.push(hit);
  }
  return selected;
}

function openDbWritable(dbPath: string, busyTimeoutMs = 100): Database {
  const db = new Database(dbPath);
  try {
    // bun:sqlite exposes a binding-level timeout; set both so Windows lock waits
    // honor the caller's budget (pragma alone has been flaky under CI contention).
    (db as Database & { timeout?: number }).timeout = busyTimeoutMs;
  } catch {
    /* older bindings */
  }
  try {
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  } catch {
    /* older sqlite */
  }
  try {
    db.exec("PRAGMA foreign_keys = ON");
  } catch {
    /* ignore */
  }
  return db;
}

function isBusyError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string })?.code ?? "";
  return (
    code === "SQLITE_BUSY" ||
    code === "SQLITE_LOCKED" ||
    /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(msg)
  );
}

function mapDbError(error: unknown): CleanupErrorCode {
  if (isBusyError(error)) return "codex_busy";
  return "db_reconcile_failed";
}

/** Probe a single DB with BEGIN IMMEDIATE; missing path is a no-op success. */
function probeDbWritable(
  path: string | null,
  busyTimeoutMs: number,
): { ok: true } | { ok: false; error: CleanupErrorCode } {
  if (!path || !existsSync(path)) return { ok: true };
  let db: Database | undefined;
  try {
    db = openDbWritable(path, busyTimeoutMs);
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
    return { ok: true };
  } catch (error) {
    if (isBusyError(error)) return { ok: false, error: "codex_busy" };
    return { ok: false, error: "db_reconcile_failed" };
  } finally {
    try { db?.close(); } catch { /* */ }
  }
}

/**
 * True when every present Codex runtime DB can be written (BEGIN IMMEDIATE).
 * Busy / corrupt stores abort cleanup before any filesystem mutation.
 */
export function probeStateDbWritable(
  codexHome: string,
  busyTimeoutMs = 100,
): { ok: true; path: string } | { ok: false; error: CleanupErrorCode } {
  const paths = discoverRuntimeDbPaths(codexHome);
  for (const path of [paths.state, paths.logs, paths.goals, paths.memories]) {
    const probed = probeDbWritable(path, busyTimeoutMs);
    if (!probed.ok) return probed;
  }
  return { ok: true, path: paths.state ?? "" };
}

interface ThreadSnapshot {
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
 * True when any matched thread is still linked to a thread outside the delete set
 * (spawn edges) or uses paginated history that other live threads may depend on via fork.
 * Throws real DB errors (busy/corruption) so callers can refuse cleanup.
 */
function findReferencedHistory(
  db: Database,
  threads: ThreadSnapshot[],
): boolean {
  if (threads.length === 0) return false;
  const ids = threads.map(t => t.id);
  const idSet = new Set(ids);

  // Paginated history keeps durable projections tied to the rollout — refuse cleanup.
  if (threads.some(t => (t.history_mode ?? "").toLowerCase() === "paginated")) {
    return true;
  }

  // Spawn edges that cross the delete boundary keep history reachable.
  if (tableExists(db, "thread_spawn_edges")) {
    for (const chunk of chunkIds(ids, SQLITE_ID_CHUNK)) {
      const placeholders = chunk.map(() => "?").join(",");
      const edges = db.query<{ parent_thread_id: string; child_thread_id: string }, string[]>(
        `SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges
         WHERE parent_thread_id IN (${placeholders}) OR child_thread_id IN (${placeholders})`,
      ).all(...chunk, ...chunk);
      for (const edge of edges) {
        if (!idSet.has(edge.parent_thread_id) || !idSet.has(edge.child_thread_id)) {
          return true;
        }
      }
    }
  }

  // Other threads that list one of ours as forked_from / parent (when columns exist).
  for (const column of ["forked_from_id", "parent_thread_id", "source_thread_id"] as const) {
    if (!columnExists(db, "threads", column)) continue;
    for (const chunk of chunkIds(ids, SQLITE_ID_CHUNK * 2)) {
      const placeholders = chunk.map(() => "?").join(",");
      const rows = db.query<{ id: string }, string[]>(
        `SELECT id FROM threads WHERE ${column} IN (${placeholders})`,
      ).all(...chunk);
      if (rows.some(r => !idSet.has(r.id))) return true;
    }
  }

  return false;
}

function tableExists(db: Database, name: string): boolean {
  const row = db.query<{ name: string }, [string]>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
  ).get(name);
  return Boolean(row);
}

function columnExists(db: Database, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false;
  // `table` is only ever a hardcoded identifier already verified via sqlite_master.
  const rows = db.query<{ name: string }, []>(
    `PRAGMA table_info("${table.replaceAll('"', '""')}")`,
  ).all();
  return rows.some(r => r.name === column);
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
}
interface ReconcileErr {
  ok: false;
  error: CleanupErrorCode;
  /** True when satellite rows were mutated and could not all be restored. */
  satelliteRestoreFailed?: boolean;
}

type SqlRow = Record<string, string | number | bigint | null | Uint8Array>;

interface SatelliteBackup {
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

const SATELLITE_BACKUP_FILE = "satellite-backup.json";
/** Marks an incomplete restore so retries can accept dest files and resume metadata. */
const RESTORE_PENDING_FILE = "restore-pending.json";
let _satelliteBackupSeq = 0;

type StagedFile = { from: string; to: string; relPath: string };

interface RestorePendingSections {
  state: boolean;
  logs: boolean;
  memories: boolean;
  goals: boolean;
}

interface RestorePendingState {
  version: 1;
  filesRestored: true;
  /**
   * Planned CODEX_HOME-relative destinations for this restore attempt.
   * Written before moves so a mid-loop failure can still accept placed dests
   * on resume while finishing files that remain staged.
   */
  acceptedDestRels: string[];
  /** Sections that still need reconciliation on retry. */
  pending: RestorePendingSections;
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function selectRows(db: Database, sql: string, params: Array<string | number>): SqlRow[] {
  return db.query<SqlRow, Array<string | number>>(sql).all(...params) as SqlRow[];
}

function tableColumnNames(db: Database, table: string): Set<string> {
  if (!tableExists(db, table)) return new Set();
  const rows = db.query<{ name: string }, []>(
    `PRAGMA table_info("${table.replaceAll('"', '""')}")`,
  ).all();
  return new Set(rows.map(r => r.name));
}

/** Insert rows with ON CONFLICT DO NOTHING; returns only rows that were newly inserted. */
function insertRowsConflictIgnore(db: Database, table: string, rows: SqlRow[]): SqlRow[] {
  const inserted: SqlRow[] = [];
  if (rows.length === 0) return inserted;
  const allowed = tableColumnNames(db, table);
  for (const row of rows) {
    const cols = Object.keys(row).filter(c => allowed.has(c));
    if (cols.length === 0) continue;
    const result = db.run(
      `INSERT INTO ${quoteIdent(table)} (${cols.map(quoteIdent).join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) ON CONFLICT DO NOTHING`,
      cols.map(c => row[c] as string | number | bigint | null | Uint8Array),
    );
    if (result.changes > 0) inserted.push(row);
  }
  return inserted;
}

/** Snapshot state-DB dependents that cleanup deletes with the thread rows. */
function snapshotStateDependents(
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
function remapSatelliteBackupPaths(
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

/**
 * Same-volume move that never replaces an existing destination.
 *
 * `existsSync` + `renameSync` is TOCTOU: a live file created between the check
 * and rename can be overwritten (Windows rename replaces files). Hard-link then
 * unlink fails with EEXIST if `to` appears, which is what trash → archived_sessions
 * restore needs. Callers under the same `CODEX_HOME` volume should not hit EXDEV.
 */
function renameNoReplace(from: string, to: string): void {
  try {
    linkSync(from, to);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    // Hard links unavailable (rare FS) — refuse rather than clobber via rename.
    if (code === "EXDEV" || code === "EPERM" || code === "ENOTSUP" || code === "EINVAL") {
      throw Object.assign(new Error("rename_no_replace_unsupported"), { code, cause: error });
    }
    throw error;
  }
  try {
    unlinkSync(from);
  } catch (error) {
    // Roll back the hard link so we do not leave the file at both paths.
    try { unlinkSync(to); } catch { /* best-effort */ }
    throw error;
  }
}

function isExistError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

function updateRowFromSnapshot(
  db: Database,
  table: string,
  row: SqlRow,
  pkCols: string[],
): void {
  const cols = Object.keys(row).filter(c => !pkCols.includes(c));
  if (cols.length === 0) return;
  const sets = cols.map(c => `${quoteIdent(c)} = ?`).join(", ");
  const where = pkCols.map(c => `${quoteIdent(c)} = ?`).join(" AND ");
  db.run(
    `UPDATE ${quoteIdent(table)} SET ${sets} WHERE ${where}`,
  [
    ...cols.map(c => row[c] as string | number | bigint | null | Uint8Array),
    ...pkCols.map(c => row[c] as string | number | bigint | null | Uint8Array),
  ],
  );
}

function normalizeSqlValue(
  v: string | number | bigint | null | Uint8Array | undefined,
): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Uint8Array) return Buffer.from(v).toString("base64");
  return String(v);
}

function sqlRowEqual(a: SqlRow, b: SqlRow): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (normalizeSqlValue(a[key]) !== normalizeSqlValue(b[key])) return false;
  }
  return true;
}

function readConsolidateGlobalJob(db: Database): SqlRow | null {
  if (!tableExists(db, "jobs")) return null;
  return db.query<SqlRow, [string, string]>(
    "SELECT * FROM jobs WHERE kind = ? AND job_key = ?",
  ).get(JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL, MEMORY_CONSOLIDATION_JOB_KEY) as SqlRow | null;
}

/** Revert delete-time enqueue only when the row still matches cleanup's post-delete image. */
function restoreConsolidateGlobalJob(
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
 * Best-effort directory fsync so a preceding rename is durable on crash.
 * Unsupported on some Windows setups — never treat failure as fatal.
 */
function fsyncDirectoryBestEffort(dirPath: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dirPath, "r");
    fsyncSync(fd);
  } catch {
    /* best-effort */
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* */ }
    }
  }
}

/**
 * Atomically replace satellite-backup.json: private temp in the stage, full write + fsync,
 * rename (with Windows sharing-violation retries), then best-effort directory fsync.
 * An interrupted update never truncates the last valid backup that was written before a
 * satellite DB commit.
 */
function writeSatelliteBackup(
  stageDir: string,
  backup: SatelliteBackup,
  options?: { failWrite?: boolean; failReplaceBeforeRename?: boolean },
): void {
  if (options?.failWrite) throw new Error("test_fail_satellite_backup_write");
  const dest = join(stageDir, SATELLITE_BACKUP_FILE);
  const replacing = existsSync(dest);
  const tmp = join(stageDir, `${SATELLITE_BACKUP_FILE}.${process.pid}.${++_satelliteBackupSeq}.tmp`);
  const payload = Buffer.from(JSON.stringify(backup), "utf8");
  const fd = openSync(tmp, "w", 0o600);
  try {
    let offset = 0;
    while (offset < payload.length) {
      offset += writeSync(fd, payload, offset, payload.length - offset, null);
    }
    fsyncSync(fd);
  } catch (error) {
    try { closeSync(fd); } catch { /* */ }
    try { unlinkSync(tmp); } catch { /* */ }
    throw error;
  }
  closeSync(fd);
  chmodPrivatePath(tmp, 0o600);
  if (options?.failReplaceBeforeRename && replacing) {
    try { unlinkSync(tmp); } catch { /* */ }
    throw new Error("test_fail_satellite_backup_replace");
  }
  try {
    renameAtomicFile(tmp, dest, undefined, "storage-cleanup");
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* */ }
    throw error;
  }
  chmodPrivatePath(dest, 0o600);
  fsyncDirectoryBestEffort(stageDir);
}

function clearSatelliteBackup(stageDir: string): void {
  try { unlinkSync(join(stageDir, SATELLITE_BACKUP_FILE)); } catch { /* */ }
}

interface SatelliteWriteLock {
  path: string;
  db: Database;
}

interface SatelliteWriteLocks {
  logs?: SatelliteWriteLock;
  memories?: SatelliteWriteLock;
  goals?: SatelliteWriteLock;
}

/** Deterministic order: logs → memories → goals. Each present DB gets BEGIN IMMEDIATE. */
function beginSatelliteWriteLocks(
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

function rollbackAllSatelliteLocks(locks: SatelliteWriteLocks): void {
  rollbackSatelliteLock(locks.logs);
  rollbackSatelliteLock(locks.memories);
  rollbackSatelliteLock(locks.goals);
  locks.logs = undefined;
  locks.memories = undefined;
  locks.goals = undefined;
}

function commitSatelliteLock(lock: SatelliteWriteLock | undefined): void {
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
function snapshotSatelliteBackupInLocks(
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

function deleteLogsInTx(db: Database, rows: SqlRow[]): void {
  if (rows.length === 0) return;
  if (!tableExists(db, "logs")) throw new Error("missing_logs_table");
  const ids = rows.map(r => r.id).filter(id => id !== null && id !== undefined);
  if (ids.length === 0) return;
  for (const chunk of chunkIds(ids as string[], SQLITE_ID_CHUNK * 2)) {
    const placeholders = chunk.map(() => "?").join(",");
    db.run(`DELETE FROM logs WHERE id IN (${placeholders})`, chunk as Array<string | number>);
  }
}

function deleteMemoriesInTx(
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

function deleteGoalsInTx(
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

/** Restore only snapshotted rows; concurrent inserts/updates after commit stay intact. */
function restoreSatelliteBackup(
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

function withWritableDb(
  path: string,
  busyTimeoutMs: number,
  body: (db: Database) => void,
): { ok: true } | ReconcileErr {
  let db: Database | undefined;
  try {
    db = openDbWritable(path, busyTimeoutMs);
    db.exec("BEGIN IMMEDIATE");
    try {
      body(db);
      db.exec("COMMIT");
      return { ok: true };
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* */ }
      throw error;
    }
  } catch (error) {
    return { ok: false, error: mapDbError(error) };
  } finally {
    try { db?.close(); } catch { /* */ }
  }
}

/** Load matching archived threads and refuse referenced history — no deletes yet. */
function loadThreadsForCleanup(
  stateDbPath: string,
  candidates: ArchivedCandidate[],
  codexHome: string,
  busyTimeoutMs: number,
): ReconcileOk | ReconcileErr {
  if (!stateDbPath || !existsSync(stateDbPath)) return { ok: true, threads: [] };
  let db: Database | undefined;
  try {
    db = openDbWritable(stateDbPath, busyTimeoutMs);
    const threads = loadMatchingThreads(db, candidates, codexHome);
    if (threads.some(t => Number(t.is_pinned ?? 0) === 1)) {
      return { ok: false, error: "pinned_thread" };
    }
    if (findReferencedHistory(db, threads)) {
      return { ok: false, error: "referenced_history" };
    }
    return { ok: true, threads };
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
function reconcileDeletedThreads(
  paths: RuntimeDbPaths,
  candidates: ArchivedCandidate[],
  codexHome: string,
  busyTimeoutMs: number,
  stageDir: string,
  hooks?: ReconcileTestHooks,
): ReconcileOk | ReconcileErr {
  if (!paths.state || !existsSync(paths.state)) return { ok: true, threads: [] };

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
    if (findReferencedHistory(stateDb, threads)) {
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
      if (findReferencedHistory(stateDb, threads)) {
        stateDb.exec("ROLLBACK");
        return failWithRestore("referenced_history");
      }
      deleteThreadsAndDependents(stateDb, threadIds);
      if (hooks?.failBeforeStateCommit) throw new Error("test_fail_before_state_commit");
      stateDb.exec("COMMIT");
      // Keep satellite-backup.json for quarantine restore; permanent purge removes the stage.
      return { ok: true, threads };
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

function absFromRel(codexHome: string, relPath: string): string {
  if (relPath.includes("..") || isAbsolute(relPath) || /^[A-Za-z]:[\\/]/.test(relPath)) {
    throw new Error("invalid_rel_path");
  }
  const abs = resolve(codexHome, ...relPath.split("/"));
  const homeAbs = resolve(codexHome);
  const rel = toForwardSlash(relative(homeAbs, abs));
  if (!rel || rel.startsWith("..")) throw new Error("path_escape");
  return abs;
}

function stageCandidates(
  codexHome: string,
  candidates: ArchivedCandidate[],
  stageDir: string,
  opts?: { blockDestBasenames?: Set<string> },
): { ok: true; staged: StagedFile[] } | { ok: false; staged: StagedFile[] } {
  const staged: StagedFile[] = [];
  const usedBasenames = new Set<string>();
  try {
    mkdirSync(stageDir, { recursive: true });
    for (const candidate of candidates) {
      for (const rel of candidate.physicalRelPaths) {
        const from = absFromRel(codexHome, rel);
        const base = basename(rel);
        // archived_sessions/ is flat today; refuse collisions so a future nested walk
        // cannot silently overwrite another staged file.
        if (usedBasenames.has(base)) {
          throw new Error("stage_basename_collision");
        }
        usedBasenames.add(base);
        const to = join(stageDir, base);
        if (opts?.blockDestBasenames?.has(base)) {
          mkdirSync(to, { recursive: true });
        }
        renameSync(from, to);
        staged.push({ from, to, relPath: rel });
      }
    }
    return { ok: true, staged };
  } catch {
    return { ok: false, staged };
  }
}

/**
 * Rename staged files back to their originals.
 * Returns whether every staged file was restored. Unrestored entries stay in `remaining`.
 */
function rollbackStaged(
  staged: StagedFile[],
  opts?: { failBasenames?: Set<string> },
): { restored: boolean; remaining: StagedFile[] } {
  const remaining: StagedFile[] = [];
  for (let i = staged.length - 1; i >= 0; i--) {
    const item = staged[i]!;
    const base = basename(item.to);
    if (opts?.failBasenames?.has(base)) {
      remaining.push(item);
      continue;
    }
    try {
      if (existsSync(item.to) && !existsSync(item.from)) {
        renameSync(item.to, item.from);
      } else if (existsSync(item.to)) {
        // Destination occupied — cannot restore without clobbering.
        remaining.push(item);
      }
    } catch {
      remaining.push(item);
    }
  }
  return { restored: remaining.length === 0, remaining };
}

function purgeStaged(
  staged: StagedFile[],
  opts?: { failBasenames?: Set<string> },
): { purged: StagedFile[]; remaining: StagedFile[] } {
  const purged: StagedFile[] = [];
  const remaining: StagedFile[] = [];
  for (const item of staged) {
    const base = basename(item.to);
    if (opts?.failBasenames?.has(base)) {
      remaining.push(item);
      continue;
    }
    try {
      unlinkSync(item.to);
      purged.push(item);
    } catch {
      remaining.push(item);
    }
  }
  return { purged, remaining };
}

/** Remove stageDir only when it contains no unrestored staged files. */
function removeStageIfEmpty(stageDir: string, remaining: StagedFile[]): void {
  if (remaining.length > 0) return;
  try { rmSync(stageDir, { recursive: true, force: true }); } catch { /* */ }
}

function removeEmptyTrashRoot(codexHome: string): void {
  try {
    const trashRoot = join(codexHome, TRASH_DIR);
    if (existsSync(trashRoot) && readdirSync(trashRoot).length === 0) {
      rmSync(trashRoot, { recursive: true, force: true });
    }
  } catch { /* */ }
}

function trashRelPath(codexHome: string, stageDir: string): string {
  return toForwardSlash(relative(codexHome, stageDir) || stageDir);
}

export interface ExecuteCleanupOptions {
  percent: number;
  mode: CleanupMode;
  /** Required digest from preview; rejects when the candidate set drifted. */
  digest: string;
  /**
   * Optional exact candidate set (logical relPaths). When set, selection bypasses
   * percent rounding and the digest must match `computeExactPreviewDigest`.
   */
  candidateRelPaths?: string[];
  codexHome?: string;
  /** Test-only: shrink busy_timeout so lock tests fail fast. */
  busyTimeoutMs?: number;
  now?: number;
  /** Test-only failure injection for atomicity regressions. */
  _test?: {
    failManifestWrite?: boolean;
    failPurgeBasenames?: string[];
    failRollbackBasenames?: string[];
    blockStageDestBasenames?: string[];
    failAfterLogsMutation?: boolean;
    failAfterMemoriesMutation?: boolean;
    failAfterGoalsMutation?: boolean;
    failBeforeStateCommit?: boolean;
    failSatelliteRestore?: boolean;
    failSatelliteBackupWrite?: boolean;
    failSatelliteBackupReplace?: boolean;
    afterSatelliteMutations?: () => void;
    beforeReconcileLock?: () => void;
  };
}

/** Serializable cleanup test hooks allowed on the management API wire. */
export type CleanupWireTestHooks = Omit<
  NonNullable<ExecuteCleanupOptions["_test"]>,
  "afterSatelliteMutations" | "beforeReconcileLock"
>;

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(e => typeof e === "string");
}

/** Pick only allowlisted serializable hooks; drops function hooks (afterSatelliteMutations, beforeReconcileLock) and unknown keys. */
export function pickWireCleanupTestHooks(raw: unknown): CleanupWireTestHooks | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const out: CleanupWireTestHooks = {};
  if (typeof o.failManifestWrite === "boolean") out.failManifestWrite = o.failManifestWrite;
  if (isStringArray(o.failPurgeBasenames)) out.failPurgeBasenames = o.failPurgeBasenames;
  if (isStringArray(o.failRollbackBasenames)) out.failRollbackBasenames = o.failRollbackBasenames;
  if (isStringArray(o.blockStageDestBasenames)) out.blockStageDestBasenames = o.blockStageDestBasenames;
  if (typeof o.failAfterLogsMutation === "boolean") out.failAfterLogsMutation = o.failAfterLogsMutation;
  if (typeof o.failAfterMemoriesMutation === "boolean") out.failAfterMemoriesMutation = o.failAfterMemoriesMutation;
  if (typeof o.failAfterGoalsMutation === "boolean") out.failAfterGoalsMutation = o.failAfterGoalsMutation;
  if (typeof o.failBeforeStateCommit === "boolean") out.failBeforeStateCommit = o.failBeforeStateCommit;
  if (typeof o.failSatelliteRestore === "boolean") out.failSatelliteRestore = o.failSatelliteRestore;
  if (typeof o.failSatelliteBackupWrite === "boolean") out.failSatelliteBackupWrite = o.failSatelliteBackupWrite;
  if (typeof o.failSatelliteBackupReplace === "boolean") out.failSatelliteBackupReplace = o.failSatelliteBackupReplace;
  return Object.keys(out).length > 0 ? out : undefined;
}

function fail(
  mode: CleanupMode,
  percent: number,
  error: CleanupErrorCode,
  extra?: { trashDir?: string },
): CleanupResult {
  return {
    ok: false,
    mode,
    percent,
    count: 0,
    bytes: 0,
    removedPaths: [],
    error,
    ...(extra?.trashDir ? { trashDir: extra.trashDir } : {}),
  };
}

/**
 * Execute archived cleanup bound to a preview digest.
 * Stages every physical file, writes the recovery manifest, then commits DB deletes.
 * Rollback never deletes a stage directory that still holds unrestored files.
 */
export function executeArchivedCleanup(options: ExecuteCleanupOptions): CleanupResult {
  const codexHome = options.codexHome ?? resolveCodexHomeDir();
  const mode = options.mode;
  const percent = clampPercent(options.percent);
  const busyTimeoutMs = options.busyTimeoutMs ?? 100;
  const failRollback = new Set(options._test?.failRollbackBasenames ?? []);
  const failPurge = new Set(options._test?.failPurgeBasenames ?? []);
  const blockStageDest = new Set(options._test?.blockStageDestBasenames ?? []);

  if (mode !== "quarantine" && mode !== "permanent") {
    return fail(mode, percent, "invalid_mode");
  }
  if (typeof options.digest !== "string" || !/^[a-f0-9]{64}$/i.test(options.digest)) {
    return fail(mode, percent, "invalid_digest");
  }

  let preview: CleanupPreview;
  let unfilteredSelected: ArchivedCandidate[];
  if (options.candidateRelPaths !== undefined) {
    const selected = resolveExactArchivedCandidates(options.candidateRelPaths, codexHome);
    if (selected === null) {
      return fail(mode, percent, "stale_preview");
    }
    unfilteredSelected = selected;
    preview = previewExactArchivedCleanup(selected, codexHome);
  } else {
    const all = listArchivedCandidates(codexHome);
    unfilteredSelected = selectOldestPercent(all, percent);
    preview = previewArchivedCleanup(percent, codexHome);
  }
  if (preview.digest.toLowerCase() !== options.digest.toLowerCase()) {
    const pendingDestRels = collectRestorePendingAcceptedDestRels(codexHome);
    const blocked = unfilteredSelected.filter(c => candidateOverlapsPendingRestore(c, pendingDestRels));
    const unfilteredDigest = options.candidateRelPaths !== undefined
      ? computeExactPreviewDigest(unfilteredSelected)
      : computePreviewDigest(unfilteredSelected, percent);
    if (
      unfilteredDigest.toLowerCase() === options.digest.toLowerCase()
      && blocked.length > 0
    ) {
      return fail(mode, percent, "restore_pending_overlap");
    }
    return fail(mode, percent, "stale_preview");
  }
  const pendingDestRels = collectRestorePendingAcceptedDestRels(codexHome);
  if (preview.candidates.some(c => candidateOverlapsPendingRestore(c, pendingDestRels))) {
    return fail(mode, percent, "restore_pending_overlap");
  }

  if (preview.candidates.length === 0) {
    return {
      ok: true,
      mode,
      percent,
      count: 0,
      bytes: 0,
      removedPaths: [],
    };
  }

  const paths = discoverRuntimeDbPaths(codexHome);
  const probe = probeStateDbWritable(codexHome, busyTimeoutMs);
  if (!probe.ok) {
    return fail(mode, percent, probe.error);
  }

  // Preflight referenced-history / matching while DB is free, before any rename.
  const loaded = loadThreadsForCleanup(paths.state ?? "", preview.candidates, codexHome, busyTimeoutMs);
  if (!loaded.ok) {
    return fail(mode, percent, loaded.error);
  }

  const epoch = options.now ?? Date.now();
  let stageDir: string;
  try {
    stageDir = createExclusiveStageDir(codexHome, epoch);
  } catch {
    return fail(mode, percent, "fs_failed");
  }
  const trashDir = trashRelPath(codexHome, stageDir);

  const threadByRelPath = new Map<string, ThreadSnapshot>();
  for (const thread of loaded.threads) {
    const normalized = normalizeArchivedRolloutPath(thread.rollout_path, codexHome);
    if (normalized) threadByRelPath.set(normalized, thread);
  }
  const manifestEntries: CleanupManifestEntry[] = preview.candidates.map(candidate => {
    const thread = threadByRelPath.get(candidate.relPath);
    return {
      relPath: candidate.relPath,
      bytes: candidate.bytes,
      mtimeMs: candidate.mtimeMs,
      physicalRelPaths: candidate.physicalRelPaths,
      ...(thread
        ? { threadId: thread.id, rolloutPath: thread.rollout_path, archived: thread.archived }
        : {}),
    };
  });

  const writeManifest = (extra: Record<string, unknown> = {}) => {
    writePrivateFile(
      join(stageDir, "manifest.json"),
      JSON.stringify({
        quarantinedAt: epoch,
        mode,
        percent,
        digest: preview.digest,
        entries: manifestEntries,
        ...extra,
      }, null, 2),
    );
  };

  // Journal staged paths before the first rename so a crash mid-stage is recoverable.
  try {
    if (options._test?.failManifestWrite) {
      throw new Error("test_fail_manifest_write");
    }
    writeManifest({ staging: true });
  } catch {
    removeStageIfEmpty(stageDir, []);
    return fail(mode, percent, "fs_failed");
  }

  const stageResult = stageCandidates(codexHome, preview.candidates, stageDir, {
    blockDestBasenames: blockStageDest.size > 0 ? blockStageDest : undefined,
  });
  if (!stageResult.ok) {
    const rolled = rollbackStaged(stageResult.staged, { failBasenames: failRollback });
    removeStageIfEmpty(stageDir, rolled.remaining);
    return fail(mode, percent, "fs_failed", rolled.restored ? undefined : { trashDir });
  }

  // Final manifest before DB deletion so a mid-flight crash still has recovery metadata.
  try {
    writeManifest();
  } catch {
    const rolled = rollbackStaged(stageResult.staged, { failBasenames: failRollback });
    removeStageIfEmpty(stageDir, rolled.remaining);
    return fail(mode, percent, "fs_failed", rolled.restored ? undefined : { trashDir });
  }

  const deleted = reconcileDeletedThreads(
    paths,
    preview.candidates,
    codexHome,
    busyTimeoutMs,
    stageDir,
    options._test,
  );
  if (!deleted.ok) {
    const rolled = rollbackStaged(stageResult.staged, { failBasenames: failRollback });
    // Keep the stage (and recovery manifest) when files or satellite DB rows remain unrestored.
    const keepTrash = Boolean(deleted.satelliteRestoreFailed) || !rolled.restored;
    if (!keepTrash) {
      removeStageIfEmpty(stageDir, rolled.remaining);
      removeEmptyTrashRoot(codexHome);
    }
    return fail(mode, percent, deleted.error, keepTrash ? { trashDir } : undefined);
  }

  const removedPaths = preview.candidates.map(c => c.relPath);
  const bytes = preview.candidates.reduce((sum, c) => sum + c.bytes, 0);

  if (mode === "quarantine") {
    return {
      ok: true,
      mode,
      percent,
      count: removedPaths.length,
      bytes,
      trashDir,
      removedPaths,
    };
  }

  // Permanent: purge staged files only after a successful DB commit.
  const purge = purgeStaged(stageResult.staged, { failBasenames: failPurge });
  if (purge.remaining.length > 0) {
    // Overwrite the pre-commit manifest so recovery reflects what actually survived.
    const survivingRelPaths = new Set(purge.remaining.map(item => item.relPath));
    try {
      writePrivateFile(
        join(stageDir, "manifest.json"),
        JSON.stringify({
          quarantinedAt: epoch,
          mode: "permanent",
          percent,
          digest: preview.digest,
          purgeIncomplete: true,
          purgedRelPaths: purge.purged.map(item => item.relPath),
          entries: manifestEntries
            .map(entry => ({
              ...entry,
              physicalRelPaths: entry.physicalRelPaths.filter(rel => survivingRelPaths.has(rel)),
            }))
            .filter(entry => entry.physicalRelPaths.length > 0),
        }, null, 2),
      );
    } catch { /* best-effort: the pre-commit manifest is still on disk */ }
    return {
      ok: false,
      mode,
      percent,
      count: 0,
      bytes: 0,
      trashDir,
      removedPaths: [],
      error: "fs_failed",
    };
  }

  try { rmSync(stageDir, { recursive: true, force: true }); } catch { /* empty dir */ }
  // Drop an empty `.trash` root so permanent cleanup leaves no quarantine tree behind.
  removeEmptyTrashRoot(codexHome);

  return {
    ok: true,
    mode,
    percent,
    count: removedPaths.length,
    bytes,
    removedPaths,
  };
}

// ---------------------------------------------------------------------------
// Phase 2.1 — quarantine list + restore
// ---------------------------------------------------------------------------

export type RestoreErrorCode =
  | "invalid_trash"
  | "missing_trash"
  | "codex_busy"
  | "storage_mutation_busy"
  | "fs_failed"
  | "db_reconcile_failed"
  | "dest_exists"
  | "restore_failed"
  | "restore_worker_timeout"
  | "restore_worker_aborted"
  | "restore_worker_failed";

export interface TrashEntrySummary {
  /** CODEX_HOME-relative path, e.g. `.trash/1700000000000`. */
  id: string;
  /** Epoch directory name (may include collision suffix, e.g. `1700-1`). */
  epoch: string;
  fileCount: number;
  bytes: number;
  quarantinedAt?: number;
  mode?: CleanupMode;
}

export interface RestoreResult {
  ok: boolean;
  trashDir?: string;
  count: number;
  bytes: number;
  restoredPaths: string[];
  error?: RestoreErrorCode;
  /** Optional operator-facing detail when the error code alone is insufficient. */
  message?: string;
}

interface TrashManifest {
  quarantinedAt?: number;
  mode?: CleanupMode;
  entries?: CleanupManifestEntry[];
}

/** Epoch dir names: digits, optionally `-N` from createExclusiveStageDir collision. */
const TRASH_EPOCH_DIR = /^(\d+)(-\d+)?$/;

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

function readSatelliteBackupFile(stageDir: string): SatelliteBackupRead {
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

function isSqlRowArray(value: unknown): value is SqlRow[] {
  return Array.isArray(value) && value.every(row => row && typeof row === "object" && !Array.isArray(row));
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

type RestorePendingRead =
  | { status: "missing" }
  | { status: "valid"; state: RestorePendingState }
  | { status: "invalid" };

let _restorePendingSeq = 0;

function parseRestorePendingState(raw: unknown): RestorePendingState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.version !== 1 || o.filesRestored !== true) return null;
  if (!Array.isArray(o.acceptedDestRels)) return null;
  const acceptedDestRels = o.acceptedDestRels.filter((r): r is string => typeof r === "string");
  if (acceptedDestRels.length !== o.acceptedDestRels.length) return null;
  const pendingRaw = o.pending;
  if (!pendingRaw || typeof pendingRaw !== "object" || Array.isArray(pendingRaw)) return null;
  const p = pendingRaw as Record<string, unknown>;
  if (
    typeof p.state !== "boolean"
    || typeof p.logs !== "boolean"
    || typeof p.memories !== "boolean"
    || typeof p.goals !== "boolean"
  ) {
    return null;
  }
  return {
    version: 1,
    filesRestored: true,
    acceptedDestRels,
    pending: {
      state: p.state,
      logs: p.logs,
      memories: p.memories,
      goals: p.goals,
    },
  };
}

/**
 * Distinguish a missing marker from a present-but-malformed one. An invalid marker
 * must never be treated as a fresh restore (that would ignore already-moved files).
 */
function readRestorePending(stageDir: string): RestorePendingRead {
  const path = join(stageDir, RESTORE_PENDING_FILE);
  if (!existsSync(path)) return { status: "missing" };
  try {
    const state = parseRestorePendingState(JSON.parse(readFileSync(path, "utf8")) as unknown);
    if (!state) return { status: "invalid" };
    return { status: "valid", state };
  } catch {
    return { status: "invalid" };
  }
}

/**
 * Atomically replace restore-pending.json: private temp in the stage, fsync, then rename.
 * An interrupted update leaves the previous valid marker intact.
 */
function writeRestorePending(
  stageDir: string,
  state: RestorePendingState,
  options?: { failBeforeRename?: boolean; failWrite?: boolean },
): void {
  if (options?.failWrite) throw new Error("test_fail_pending_write");
  const dest = join(stageDir, RESTORE_PENDING_FILE);
  const tmp = join(stageDir, `${RESTORE_PENDING_FILE}.${process.pid}.${++_restorePendingSeq}.tmp`);
  const payload = JSON.stringify(state);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, payload, null, "utf8");
    fsyncSync(fd);
  } catch (error) {
    try { closeSync(fd); } catch { /* */ }
    try { unlinkSync(tmp); } catch { /* */ }
    throw error;
  }
  closeSync(fd);
  chmodPrivatePath(tmp, 0o600);
  if (options?.failBeforeRename) {
    try { unlinkSync(tmp); } catch { /* */ }
    throw new Error("test_fail_pending_rename");
  }
  try {
    renameAtomicFile(tmp, dest, undefined, "storage-cleanup");
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* */ }
    throw error;
  }
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

function isSafeArchivedPhysicalRel(rel: string): boolean {
  const normalized = toForwardSlash(rel);
  if (!normalized.startsWith(`${ARCHIVED_SESSIONS_DIR}/`)) return false;
  if (normalized.includes("..")) return false;
  const rest = normalized.slice(ARCHIVED_SESSIONS_DIR.length + 1);
  if (!rest || rest.includes("/")) return false;
  return isRolloutFileName(rest);
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
