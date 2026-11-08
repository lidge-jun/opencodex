/**
 * Derived candidate index for filtered usage queries (#7846).
 *
 * `usage.jsonl` stays the only authority. This module maintains a rebuildable SQLite
 * projection that records, per complete ledger row, its byte offset and the few fields a
 * filtered `GET /api/usage` selects on: timestamp, API-key id, client/surface/admission
 * labels, and one row per provider/model attribution the row can match. A filtered query
 * asks the index which rows qualify, then re-reads and normalizes only those rows.
 *
 * The alternative was a per-filter full scan: 143k rows cost roughly 25 seconds each time a
 * new provider/model/key/window combination is requested, and the work was repeated for
 * every distinct filter. Here the expensive pass happens once -- the initial build, and
 * again only when the ledger is replaced -- and every later query, including a brand-new
 * filter, reads a bounded candidate set.
 *
 * Bounds and identity:
 * - Ingest reuses `scanUsageLedgerCooperatively`, so the 1 MiB row ceiling, the 1 MiB
 *   chunk, the cooperative yield, the opened-EOF snapshot boundary, and the
 *   path/dev/inode/birthtime identity with its 64 KiB boundary digest all stay owned by the
 *   ledger scanner rather than being re-implemented here.
 * - A replaced, truncated, or same-size rewritten ledger rebuilds the projection. Rows are
 *   only ever appended to the projection; the ledger is never truncated or rewritten.
 * - An index that disagrees with the ledger (a recorded offset no longer frames a complete
 *   row) is discarded and rebuilt rather than served partially.
 *
 * Rebuild cost: the initial build normalizes every row once. It is cooperative, so the
 * event loop yields between chunks, and it is persisted, so a restart does not repeat it.
 * The projection stores offsets and keys, not row bodies, which keeps it far smaller than
 * the ledger it indexes.
 */
import { Database } from "bun:sqlite";
import { getConfigDir } from "../config";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { baseProviderLabel } from "../providers/label";
import {
  currentUsageLogRevision,
  usageLogIdentityKey,
  usageLogRevisionKey,
  type PersistedUsageEntry,
  type UsageLogRevision,
} from "./log";
import {
  scanUsageLedgerCooperatively,
  UsageLedgerRebuildRequiredError,
  type UsageLedgerScanResult,
} from "./ledger-scanner";
import type { UsageSourceFilter } from "./source-filter";
import { usageAttributions } from "./summary";
import type { UsageTimeWindow } from "./time-range";

export const USAGE_FILTER_INDEX_SCHEMA_VERSION = 1;
export const USAGE_FILTER_INDEX_DB_FILENAME = "usage-filter-index.sqlite";
/** Rows per SQLite transaction during ingest; also the peak pending-row allocation. */
export const USAGE_FILTER_INDEX_INSERT_BATCH = 500;
const MAX_REFRESH_ATTEMPTS = 2;

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_rows (
  byte_offset    INTEGER PRIMARY KEY,
  timestamp      INTEGER NOT NULL,
  api_key_id     TEXT,
  client         TEXT,
  surface        TEXT,
  admission_kind TEXT
);

CREATE INDEX IF NOT EXISTS idx_usage_rows_timestamp ON usage_rows(timestamp);
CREATE INDEX IF NOT EXISTS idx_usage_rows_api_key ON usage_rows(api_key_id, timestamp);

CREATE TABLE IF NOT EXISTS usage_attributions (
  byte_offset INTEGER NOT NULL,
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL,
  PRIMARY KEY (byte_offset, provider, model)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_usage_attr_provider ON usage_attributions(provider, model, byte_offset);
CREATE INDEX IF NOT EXISTS idx_usage_attr_model ON usage_attributions(model, provider, byte_offset);
`;

const META_KEYS = {
  schemaVersion: "schema_version",
  generation: "generation",
  sourcePath: "source_path",
  sourceDev: "source_dev",
  sourceIno: "source_ino",
  sourceBirthtimeMs: "source_birthtime_ms",
  sourceSize: "source_size",
  sourceMtimeMs: "source_mtime_ms",
  sourceCtimeMs: "source_ctime_ms",
  indexedOffset: "indexed_offset",
  boundaryDigest: "boundary_digest",
  indexedRows: "indexed_rows",
  invalidRows: "invalid_rows",
  oversizedRows: "oversized_rows",
  minTimestamp: "min_timestamp",
  maxTimestamp: "max_timestamp",
} as const;

/**
 * A retained filtered projection read this generation. A full rebuild replaces every
 * offset, so a projection from an older generation must be discarded even when the file
 * identity and size are unchanged.
 */
export interface UsageFilterIndexSnapshot {
  revision: UsageLogRevision | null;
  identityKey: string;
  generation: number;
  indexedOffset: number;
  processedThroughDigest: string;
  indexedRows: number;
  /** Whole-ledger diagnostics, monotonic across appends and reset by a rebuild. */
  invalidRows: number;
  oversizedRows: number;
  minTimestamp: number | null;
  maxTimestamp: number | null;
  /** Full-file ingest passes this process has run; the initial build counts as one. */
  ingestPasses: number;
  /** Rows this call ingested; a rebuild reports every row. */
  ingestedRows: number;
}

export interface UsageFilterIndexQuery {
  provider: string | null;
  model: string | null;
  apiKeyId: string | null;
  sourceFilter?: UsageSourceFilter;
  configuredApiKeyIds?: readonly string[];
  window?: UsageTimeWindow;
  /** Exclusive lower bound: rows already folded into a retained projection. */
  afterOffset?: number;
}

export interface UsageFilterCandidateRead {
  snapshot: UsageFilterIndexSnapshot;
  /** Ascending row-start offsets selected by the index. */
  offsets: number[];
}

/** Counts a caller can assert on: how much of the ledger a filtered query actually read. */
export interface UsageFilterQueryStats {
  totalRows: number;
  candidateRows: number;
  ingestedRows: number;
  ingestPasses: number;
}

interface IndexMeta {
  schemaVersion: number;
  generation: number;
  revision: UsageLogRevision | null;
  indexedOffset: number;
  digest: string;
  indexedRows: number;
  invalidRows: number;
  oversizedRows: number;
  minTimestamp: number | null;
  maxTimestamp: number | null;
}

let ingestFlight: Promise<UsageFilterIndexSnapshot> | null = null;
let ingestPasses = 0;
let rebuildRequested = false;

export function usageFilterIndexPath(configDir: string): string {
  return `${configDir.replace(/[\\/]+$/, "")}/${USAGE_FILTER_INDEX_DB_FILENAME}`;
}

function metaText(db: Database, key: string): string {
  const row = db.query("SELECT value FROM schema_meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? "";
}

function metaNumber(db: Database, key: string): number {
  const value = metaText(db, key);
  if (value === "") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function setMeta(db: Database, key: string, value: string | number): void {
  db.query(
    "INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, String(value));
}

function readMeta(db: Database): IndexMeta {
  const path = metaText(db, META_KEYS.sourcePath);
  const revision: UsageLogRevision | null = path
    ? {
      path,
      dev: metaText(db, META_KEYS.sourceDev),
      ino: metaText(db, META_KEYS.sourceIno),
      birthtimeMs: metaNumber(db, META_KEYS.sourceBirthtimeMs),
      size: metaNumber(db, META_KEYS.sourceSize),
      mtimeMs: metaNumber(db, META_KEYS.sourceMtimeMs),
      ctimeMs: metaNumber(db, META_KEYS.sourceCtimeMs),
    }
    : null;
  const minTimestamp = metaText(db, META_KEYS.minTimestamp);
  const maxTimestamp = metaText(db, META_KEYS.maxTimestamp);
  return {
    schemaVersion: metaNumber(db, META_KEYS.schemaVersion),
    generation: metaNumber(db, META_KEYS.generation),
    revision,
    indexedOffset: metaNumber(db, META_KEYS.indexedOffset),
    digest: metaText(db, META_KEYS.boundaryDigest),
    indexedRows: metaNumber(db, META_KEYS.indexedRows),
    invalidRows: metaNumber(db, META_KEYS.invalidRows),
    oversizedRows: metaNumber(db, META_KEYS.oversizedRows),
    minTimestamp: minTimestamp === "" ? null : Number(minTimestamp),
    maxTimestamp: maxTimestamp === "" ? null : Number(maxTimestamp),
  };
}

function writeMeta(db: Database, meta: IndexMeta): void {
  setMeta(db, META_KEYS.schemaVersion, meta.schemaVersion);
  setMeta(db, META_KEYS.generation, meta.generation);
  setMeta(db, META_KEYS.sourcePath, meta.revision?.path ?? "");
  setMeta(db, META_KEYS.sourceDev, meta.revision?.dev ?? "");
  setMeta(db, META_KEYS.sourceIno, meta.revision?.ino ?? "");
  setMeta(db, META_KEYS.sourceBirthtimeMs, meta.revision?.birthtimeMs ?? 0);
  setMeta(db, META_KEYS.sourceSize, meta.revision?.size ?? 0);
  setMeta(db, META_KEYS.sourceMtimeMs, meta.revision?.mtimeMs ?? 0);
  setMeta(db, META_KEYS.sourceCtimeMs, meta.revision?.ctimeMs ?? 0);
  setMeta(db, META_KEYS.indexedOffset, meta.indexedOffset);
  setMeta(db, META_KEYS.boundaryDigest, meta.digest);
  setMeta(db, META_KEYS.indexedRows, meta.indexedRows);
  setMeta(db, META_KEYS.invalidRows, meta.invalidRows);
  setMeta(db, META_KEYS.oversizedRows, meta.oversizedRows);
  setMeta(db, META_KEYS.minTimestamp, meta.minTimestamp === null ? "" : meta.minTimestamp);
  setMeta(db, META_KEYS.maxTimestamp, meta.maxTimestamp === null ? "" : meta.maxTimestamp);
}

function emptyMeta(generation: number): IndexMeta {
  return {
    schemaVersion: USAGE_FILTER_INDEX_SCHEMA_VERSION,
    generation,
    revision: null,
    indexedOffset: 0,
    digest: "",
    indexedRows: 0,
    invalidRows: 0,
    oversizedRows: 0,
    minTimestamp: null,
    maxTimestamp: null,
  };
}

function ensureSchema(db: Database): void {
  db.exec(SCHEMA_DDL);
  if (metaNumber(db, META_KEYS.schemaVersion) === USAGE_FILTER_INDEX_SCHEMA_VERSION) return;
  // A schema change invalidates every recorded offset, so drop the projection and rebuild
  // it from the ledger rather than migrating derived rows.
  db.exec("DELETE FROM usage_rows");
  db.exec("DELETE FROM usage_attributions");
  writeMeta(db, emptyMeta(0));
}

/**
 * Open the projection read-write.
 *
 * A read-only handle cannot recover a WAL that has no `-shm` beside it (a crash, or another
 * process that has since exited), so recovery uses the same handle the writer would.
 */
function openIndexDatabase(): Database {
  const dir = getConfigDir();
  const path = usageFilterIndexPath(dir);
  recordOwnedConfigPath(dir, path);
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

interface IngestResult {
  scan: UsageLedgerScanResult;
  rows: number;
  minTimestamp: number | null;
  maxTimestamp: number | null;
}

async function ingest(
  db: Database,
  startAtBytes: number,
  expected: { identityKey: string; digest: string } | null,
): Promise<IngestResult> {
  const insertRow = db.prepare(
    "INSERT OR REPLACE INTO usage_rows (byte_offset, timestamp, api_key_id, client, surface, admission_kind) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertAttribution = db.prepare(
    "INSERT OR REPLACE INTO usage_attributions (byte_offset, provider, model) VALUES (?, ?, ?)",
  );
  const commit = db.transaction((batch: Array<{ offset: number; entry: PersistedUsageEntry }>) => {
    for (const { offset, entry } of batch) {
      insertRow.run(
        offset,
        entry.timestamp,
        entry.apiKeyId ?? null,
        entry.client ?? null,
        entry.surface ?? null,
        entry.admissionKind ?? null,
      );
      // Keys are derived from the same attribution helper the accumulator filters with, so
      // the index can over-select but never reject a row the exact filter would keep.
      for (const attribution of usageAttributions(entry)) {
        insertAttribution.run(
          offset,
          baseProviderLabel(attribution.provider).toLowerCase(),
          attribution.model.toLowerCase(),
        );
      }
    }
  });
  let pending: Array<{ offset: number; entry: PersistedUsageEntry }> = [];
  let rows = 0;
  let minTimestamp: number | null = null;
  let maxTimestamp: number | null = null;
  try {
    const scan = await scanUsageLedgerCooperatively({
      startAtBytes,
      ...(expected
        ? { expectedIdentityKey: expected.identityKey, expectedProcessedThroughDigest: expected.digest }
        : {}),
      onEntry(entry, offset) {
        pending.push({ offset, entry });
        rows += 1;
        if (minTimestamp === null || entry.timestamp < minTimestamp) minTimestamp = entry.timestamp;
        if (maxTimestamp === null || entry.timestamp > maxTimestamp) maxTimestamp = entry.timestamp;
        if (pending.length >= USAGE_FILTER_INDEX_INSERT_BATCH) {
          commit(pending);
          pending = [];
        }
      },
    });
    if (pending.length > 0) commit(pending);
    return { scan, rows, minTimestamp, maxTimestamp };
  } finally {
    insertRow.finalize();
    insertAttribution.finalize();
  }
}

function snapshotFrom(meta: IndexMeta, ingestedRows: number): UsageFilterIndexSnapshot {
  return {
    revision: meta.revision,
    identityKey: usageLogIdentityKey(meta.revision),
    generation: meta.generation,
    indexedOffset: meta.indexedOffset,
    processedThroughDigest: meta.digest,
    indexedRows: meta.indexedRows,
    invalidRows: meta.invalidRows,
    oversizedRows: meta.oversizedRows,
    minTimestamp: meta.minTimestamp,
    maxTimestamp: meta.maxTimestamp,
    ingestPasses,
    ingestedRows,
  };
}

function earlier(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.min(left, right);
}

function later(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

async function rebuild(db: Database, prior: IndexMeta): Promise<UsageFilterIndexSnapshot> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_REFRESH_ATTEMPTS; attempt += 1) {
    db.exec("DELETE FROM usage_rows");
    db.exec("DELETE FROM usage_attributions");
    const reset = emptyMeta(prior.generation + 1);
    writeMeta(db, reset);
    try {
      const result = await ingest(db, 0, null);
      const next: IndexMeta = {
        ...reset,
        revision: result.scan.revision,
        indexedOffset: result.scan.processedThroughBytes,
        digest: result.scan.processedThroughDigest,
        indexedRows: result.rows,
        invalidRows: result.scan.invalidRows,
        oversizedRows: result.scan.oversizedRows,
        minTimestamp: result.minTimestamp,
        maxTimestamp: result.maxTimestamp,
      };
      writeMeta(db, next);
      ingestPasses += 1;
      return snapshotFrom(next, result.rows);
    } catch (error) {
      lastError = error;
      if (!(error instanceof UsageLedgerRebuildRequiredError) || attempt + 1 >= MAX_REFRESH_ATTEMPTS) {
        throw error;
      }
    }
  }
  throw lastError ?? new Error("usage filter index rebuild did not settle");
}

/**
 * Bring the projection up to the ledger's current EOF, appending only new complete rows.
 *
 * A same-size file whose revision metadata moved is a rewrite or replacement, not an append,
 * so it rebuilds. An append is verified by the scanner's boundary digest before any of its
 * rows are retained.
 */
async function refresh(db: Database): Promise<UsageFilterIndexSnapshot> {
  ensureSchema(db);
  const meta = readMeta(db);
  const revision = currentUsageLogRevision();
  if (meta.schemaVersion !== USAGE_FILTER_INDEX_SCHEMA_VERSION
    || usageLogIdentityKey(meta.revision) !== usageLogIdentityKey(revision)) {
    return rebuild(db, meta);
  }
  if (revision === null) return snapshotFrom(meta, 0);
  if (revision.size < meta.indexedOffset) return rebuild(db, meta);
  if (revision.size === meta.indexedOffset) {
    if (meta.revision && usageLogRevisionKey(meta.revision) === usageLogRevisionKey(revision)) {
      return snapshotFrom(meta, 0);
    }
    return rebuild(db, meta);
  }
  try {
    const result = await ingest(db, meta.indexedOffset, {
      identityKey: usageLogIdentityKey(meta.revision),
      digest: meta.digest,
    });
    const next: IndexMeta = {
      ...meta,
      revision: result.scan.revision,
      indexedOffset: result.scan.processedThroughBytes,
      digest: result.scan.processedThroughDigest,
      indexedRows: meta.indexedRows + result.rows,
      invalidRows: meta.invalidRows + result.scan.invalidRows,
      oversizedRows: meta.oversizedRows + result.scan.oversizedRows,
      minTimestamp: earlier(meta.minTimestamp, result.minTimestamp),
      maxTimestamp: later(meta.maxTimestamp, result.maxTimestamp),
    };
    writeMeta(db, next);
    return snapshotFrom(next, result.rows);
  } catch (error) {
    if (!(error instanceof UsageLedgerRebuildRequiredError)) throw error;
    return rebuild(db, meta);
  }
}

async function refreshUsageFilterIndex(): Promise<UsageFilterIndexSnapshot> {
  if (ingestFlight) return ingestFlight;
  const flight = (async () => {
    const db = openIndexDatabase();
    try {
      if (rebuildRequested) {
        rebuildRequested = false;
        return await rebuild(db, readMeta(db));
      }
      return await refresh(db);
    } finally {
      db.close();
    }
  })();
  ingestFlight = flight;
  try {
    return await flight;
  } finally {
    if (ingestFlight === flight) ingestFlight = null;
  }
}

function selectCandidates(
  db: Database,
  snapshot: UsageFilterIndexSnapshot,
  query: UsageFilterIndexQuery,
): number[] {
  const where: string[] = [];
  const values: Array<string | number> = [];
  const add = (clause: string, ...params: Array<string | number>) => {
    where.push(clause);
    values.push(...params);
  };
  const usesAttributions = query.provider !== null || query.model !== null;
  if (query.provider !== null) add("a.provider = ?", query.provider);
  if (query.model !== null) add("a.model = ?", query.model);
  if (query.apiKeyId !== null) add("r.api_key_id = ?", query.apiKeyId);
  const device = query.sourceFilter?.device;
  if (device?.kind === "no-key") add("r.api_key_id IS NULL");
  else if (device?.kind === "key") add("r.api_key_id = ?", device.id);
  else if (device?.kind === "unconfigured") {
    add("r.admission_kind = 'configured' AND r.api_key_id IS NOT NULL AND r.api_key_id <> ''");
    const ids = query.configuredApiKeyIds ?? [];
    if (ids.length > 0) add(`r.api_key_id NOT IN (${ids.map(() => "?").join(", ")})`, ...ids);
  }
  const client = query.sourceFilter?.client;
  if (client === "codex") {
    add("((r.client IS NULL AND r.surface IS NULL) OR r.client IN ('codex_cli', 'codex_desktop', 'codex_ide'))");
  } else if (client === "unknown") {
    add("(r.client = 'unknown' OR (r.client IS NULL AND r.surface IS NOT NULL))");
  } else if (client !== undefined && client !== "all") {
    add("r.client = ?", client);
  }
  if (query.window) add("r.timestamp >= ? AND r.timestamp <= ?", query.window.since, query.window.until);
  // `afterOffset` is the byte after the last folded row, which is exactly where the next
  // row starts, so the bound is inclusive.
  if (query.afterOffset !== undefined) add("r.byte_offset >= ?", query.afterOffset);
  add("r.byte_offset <= ?", snapshot.indexedOffset);
  const whereSql = ` WHERE ${where.join(" AND ")}`;
  const sql = usesAttributions
    ? `SELECT DISTINCT r.byte_offset AS byteOffset FROM usage_attributions a JOIN usage_rows r ON r.byte_offset = a.byte_offset${whereSql} ORDER BY r.byte_offset`
    : `SELECT r.byte_offset AS byteOffset FROM usage_rows r${whereSql} ORDER BY r.byte_offset`;
  const rows = db.query(sql).all(...values) as Array<{ byteOffset: number }>;
  return rows.map(row => row.byteOffset);
}

/**
 * Refresh the projection, then select the candidate offsets for one filter.
 *
 * The returned snapshot is the boundary the offsets belong to. A concurrent rebuild by another
 * process between the refresh and the select would renumber every offset, so the select
 * re-checks the generation and reports a rebuild-required error instead of mixing them.
 */
export async function readUsageFilterCandidates(
  query: UsageFilterIndexQuery,
): Promise<UsageFilterCandidateRead> {
  const snapshot = await refreshUsageFilterIndex();
  const db = openIndexDatabase();
  try {
    if (readMeta(db).generation !== snapshot.generation) {
      throw new UsageLedgerRebuildRequiredError("content_changed");
    }
    return { snapshot, offsets: selectCandidates(db, snapshot, query) };
  } finally {
    db.close();
  }
}

/** Discard the projection on the next refresh; used when an offset no longer frames a row. */
export function requestUsageFilterIndexRebuild(): void {
  rebuildRequested = true;
}

/** Test-only process-state reset for isolated harnesses. */
export function resetUsageFilterIndexForTests(): void {
  ingestFlight = null;
  ingestPasses = 0;
  rebuildRequested = false;
}
