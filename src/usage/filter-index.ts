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
 * Crash and multi-process contract:
 * - Rows belong to a generation. Meta names the one published generation; readers only ever
 *   select rows of that generation, bounded by the published byte offset.
 * - A rebuild stages a fresh generation and publishes it in one short transaction that
 *   re-checks the generation it started from. Nothing deletes another writer's staged rows
 *   while it is still ingesting; only a successful publish prunes other generations. An
 *   interrupted rebuild therefore leaves the previously published generation intact, so a
 *   crash can never turn a complete projection into a complete-looking zero.
 * - An append writes into the published generation and publishes its new offset, digest,
 *   counts and span in the same transaction. A crash mid-append leaves rows beyond the
 *   published offset, which readers ignore and the next append replays idempotently.
 * - Two writers that stage concurrently get distinct generations, so neither can mix the
 *   other's rows. The loser's publish is fenced out and it retries against the winner.
 * - Metadata is written by one transaction; there is no window where the cursor, digest,
 *   counts and span describe different scans.
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
 * - A file at the index path that is not this projection is never modified, and a passive
 *   management read never creates, writes or registers anything.
 *
 * Rebuild cost: the initial build normalizes every row once. It is cooperative, so the
 * event loop yields between chunks, and it is persisted, so a restart does not repeat it.
 * The projection stores offsets and keys, not row bodies, which keeps it far smaller than
 * the ledger it indexes. A nonselective filter (no provider/model/key, `client=all`,
 * `device=all`) still has to normalize every row in its window; the index makes the
 * selection exact, not sublinear.
 */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { getConfigDir } from "../config";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import {
  preparePrivateSqliteDatabase,
  SQLITE_SIDECAR_SUFFIXES,
  UnsafeSqlitePathError,
} from "../lib/private-sqlite-path";
import { hardenSecretPath } from "../lib/windows-secret-acl";
import { baseProviderLabel } from "../providers/label";
import {
  currentUsageLogRevision,
  usageLogIdentityKey,
  usageLogRevisionKey,
  type PersistedUsageEntry,
  type UsageLogRevision,
} from "./log";
import {
  readUsageLedgerRowsAtOffsets,
  scanUsageLedgerCooperatively,
  UsageLedgerRebuildRequiredError,
  type UsageLedgerScanResult,
} from "./ledger-scanner";
import { USAGE_CODEX_CLIENT_LABELS, type UsageSourceFilter } from "./source-filter";
import { usageAttributions } from "./summary";
import type { UsageTimeWindow } from "./time-range";

export const USAGE_FILTER_INDEX_SCHEMA_VERSION = 4;
export const USAGE_FILTER_INDEX_DB_FILENAME = "usage-filter-index.sqlite";
/** Rows per SQLite transaction during ingest; also the peak pending-row allocation. */
export const USAGE_FILTER_INDEX_INSERT_BATCH = 500;
const META_TABLE = "usage_filter_index_meta";
const MAX_REFRESH_ATTEMPTS = 3;
// SQLite's busy handler blocks the thread, so the wait stays short and contention is retried
// asynchronously instead of parking the event loop behind another writer. A single ingest batch
// or publish holds the write lock for a few milliseconds.
const SQLITE_BUSY_TIMEOUT_MS = 250;
const BATCH_BUSY_RETRIES = 3;
const BATCH_BUSY_RETRY_MS = 5;
const BUSY_RETRY_DELAYS_MS = [10, 25, 50] as const;

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS ${META_TABLE} (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_rows (
  generation     TEXT NOT NULL,
  byte_offset    INTEGER NOT NULL,
  timestamp      INTEGER,
  api_key_id     TEXT,
  client         TEXT,
  surface        TEXT,
  admission_kind TEXT,
  unattributable INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (generation, byte_offset)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_usage_rows_ts ON usage_rows(generation, timestamp, byte_offset);
CREATE INDEX IF NOT EXISTS idx_usage_rows_key ON usage_rows(generation, api_key_id, timestamp, byte_offset);
CREATE INDEX IF NOT EXISTS idx_usage_rows_client ON usage_rows(generation, client, timestamp, byte_offset);
CREATE INDEX IF NOT EXISTS idx_usage_rows_admission ON usage_rows(generation, admission_kind, api_key_id, byte_offset);
CREATE INDEX IF NOT EXISTS idx_usage_rows_unattributable ON usage_rows(generation, unattributable);

CREATE TABLE IF NOT EXISTS usage_attributions (
  generation  TEXT NOT NULL,
  byte_offset INTEGER NOT NULL,
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL,
  PRIMARY KEY (generation, byte_offset, provider, model)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_usage_attr_provider ON usage_attributions(generation, provider, model, byte_offset);
CREATE INDEX IF NOT EXISTS idx_usage_attr_model ON usage_attributions(generation, model, provider, byte_offset);

CREATE TABLE IF NOT EXISTS usage_filter_index_writers (
  generation   TEXT PRIMARY KEY,
  pid          INTEGER NOT NULL,
  started_at   INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_filter_index_generations (
  generation TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
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

/** The file at the index path is not this projection. It is left untouched. */
export class UsageFilterIndexForeignError extends Error {
  constructor() {
    super("usage filter index path holds a file this projection does not own");
    this.name = "UsageFilterIndexForeignError";
  }
}

/** Reading `usage.jsonl` itself failed; this is not an index problem and must not be hidden. */
export class UsageFilterIndexSourceError extends Error {
  constructor(readonly sourceError: unknown) {
    super("usage ledger could not be read for the filtered usage index");
    this.name = "UsageFilterIndexSourceError";
  }
}

/** The config directory changed while a refresh was running; the projection must not mix homes. */
export class UsageFilterIndexHomeChangedError extends Error {
  constructor() {
    super("usage filter index home changed during a refresh");
    this.name = "UsageFilterIndexHomeChangedError";
  }
}

/**
 * A retained filtered projection read this generation. A full rebuild replaces every offset,
 * so a projection from an older generation must be discarded even when the file identity and
 * size are unchanged.
 */
export interface UsageFilterIndexSnapshot {
  revision: UsageLogRevision | null;
  identityKey: string;
  generation: string;
  indexedOffset: number;
  processedThroughDigest: string;
  indexedRows: number;
  /** Whole-ledger diagnostics, monotonic across appends and reset by a rebuild. */
  invalidRows: number;
  oversizedRows: number;
  minTimestamp: number | null;
  maxTimestamp: number | null;
  /** Full-file ingest passes this process has run for this home; the initial build counts. */
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
  /** Inclusive lower bound: the byte after the last row already folded in. */
  afterOffset?: number;
}

export interface UsageFilterCandidateRead {
  snapshot: UsageFilterIndexSnapshot;
  /** Ascending row-start offsets selected by the index. */
  offsets: number[];
}

/**
 * Counts a caller can assert on.
 *
 * `candidateRows` is the number of ledger rows this query selected and normalized -- not the
 * number of SQL index entries SQLite examined. For a selective filter it is far below
 * `totalRows`; for a nonselective one it is every row in scope, which is inherent.
 */
export interface UsageFilterQueryStats {
  totalRows: number;
  /** Rows selected for this call; an append selects only the rows after its retained cursor. */
  candidateRows: number;
  /** Whether those rows are the whole candidate set or only the appended suffix. */
  scope: "rebuild" | "append" | "unchanged";
  ingestedRows: number;
  ingestPasses: number;
}

export interface UsageFilterIndexTestHooks {
  /**
   * Runs after a rebuild has staged its rows and before the publish transaction. Throwing
   * simulates a crash at that boundary; the hook also lets a test publish from a second
   * connection to exercise the generation fence.
   */
  beforePublish?: (info: {
    dbPath: string;
    stagedGeneration: string;
    publishedGeneration: string;
  }) => void | Promise<void>;
  /** Runs after a publish committed, before the caller reads the projection. */
  afterPublish?: (info: { dbPath: string; generation: string }) => void | Promise<void>;
  /** Runs after a staging generation registered its lease, before its first row. */
  afterStagingRegistered?: (info: { dbPath: string; generation: string }) => void | Promise<void>;
  /** Runs inside the staging transaction, between the registry and lease writes. */
  betweenStagingWrites?: (info: { dbPath: string; generation: string }) => void;
  /** Runs after a reclamation pre-check, before its write transaction takes the lock. */
  betweenReclaimCheckAndLock?: (info: { dbPath: string; candidates: string[] }) => void;
  /** Runs after a refresh, before the candidate select reads the projection. */
  afterRefresh?: (info: { dbPath: string }) => void;
}

interface IndexMeta {
  schemaVersion: number;
  generation: string;
  revision: UsageLogRevision | null;
  indexedOffset: number;
  digest: string;
  indexedRows: number;
  invalidRows: number;
  oversizedRows: number;
  minTimestamp: number | null;
  maxTimestamp: number | null;
}

let ingestFlight: { path: string; promise: Promise<UsageFilterIndexSnapshot> } | null = null;
const ingestPassesByPath = new Map<string, number>();
const rebuildRequestedPaths = new Set<string>();
let testHooks: UsageFilterIndexTestHooks | null = null;

export function usageFilterIndexPath(configDir: string): string {
  return `${configDir.replace(/[\\/]+$/, "")}/${USAGE_FILTER_INDEX_DB_FILENAME}`;
}

function indexPathForCurrentHome(): string {
  return usageFilterIndexPath(getConfigDir());
}

function errorCode(error: unknown): unknown {
  return error !== null && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}

function isBusyError(error: unknown): boolean {
  const code = errorCode(error);
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return true;
  const message = error instanceof Error ? error.message : "";
  return /database is locked|database table is locked/i.test(message);
}

function isCorruptError(error: unknown): boolean {
  const code = errorCode(error);
  return code === "SQLITE_CORRUPT" || code === "SQLITE_NOTADB";
}

function metaText(db: Database, key: string): string {
  const row = db.query(`SELECT value FROM ${META_TABLE} WHERE key = ?`).get(key) as
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
    `INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
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
    generation: metaText(db, META_KEYS.generation),
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

function writeMetaStatements(db: Database, meta: IndexMeta): void {
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

function emptyMeta(generation: string): IndexMeta {
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

function tableNames(db: Database): string[] {
  const rows = db.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  ).all() as Array<{ name: string }>;
  return rows.map(row => row.name);
}

/** `fresh` is an empty database, `ours` carries this projection's meta table, anything else is foreign. */
function classifyDatabase(db: Database): "fresh" | "ours" | "foreign" {
  let names: string[];
  try {
    names = tableNames(db);
  } catch {
    return "foreign";
  }
  if (names.length === 0) return "fresh";
  // Require a data table as well as the meta table: a foreign database that happens to use the
  // meta table's name is not this projection and must never have its tables dropped.
  const ours = names.includes(META_TABLE)
    && (names.includes("usage_rows") || names.includes("usage_attributions"));
  return ours ? "ours" : "foreign";
}

function createSchema(db: Database): void {
  db.exec(SCHEMA_DDL);
  const generation = randomUUID();
  writeMetaStatements(db, emptyMeta(generation));
  db.query("INSERT OR REPLACE INTO usage_filter_index_generations (generation, created_at) VALUES (?, ?)")
    .run(generation, Date.now());
}

/**
 * Recreate the projection's own tables. Only called for a database already classified as
 * ours, so a file this module did not create is never dropped.
 */
function recreateSchema(db: Database): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DROP TABLE IF EXISTS usage_rows");
    db.exec("DROP TABLE IF EXISTS usage_attributions");
    db.exec("DROP TABLE IF EXISTS usage_filter_index_writers");
    db.exec("DROP TABLE IF EXISTS usage_filter_index_generations");
    db.exec(`DROP TABLE IF EXISTS ${META_TABLE}`);
    db.exec(SCHEMA_DDL);
    const generation = randomUUID();
    writeMetaStatements(db, emptyMeta(generation));
    db.query("INSERT OR REPLACE INTO usage_filter_index_generations (generation, created_at) VALUES (?, ?)")
      .run(generation, Date.now());
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* the close below releases the lock */ }
    throw error;
  }
}

function ensureSchema(db: Database, classification: "fresh" | "ours"): void {
  if (classification === "fresh") {
    createSchema(db);
    return;
  }
  const tables = new Set(tableNames(db));
  const current = metaNumber(db, META_KEYS.schemaVersion) === USAGE_FILTER_INDEX_SCHEMA_VERSION
    && tables.has("usage_rows")
    && tables.has("usage_attributions")
    && tables.has("usage_filter_index_writers")
    && tables.has("usage_filter_index_generations");
  if (current) return;
  // A schema change can alter column shape, so the derived tables are recreated rather than
  // migrated. The ledger is untouched and the next refresh rebuilds from it.
  recreateSchema(db);
}

function openIndexForWrite(dir: string, path: string): Database {
  const existed = existsSync(path);
  preparePrivateSqliteDatabase(path);
  const db = new Database(path, { create: true });
  try {
    const classification = classifyDatabase(db);
    if (classification === "foreign") throw new UsageFilterIndexForeignError();
    if (!existed) {
      // Register only names this module is about to create; an existing sidecar may belong to
      // something else and is never adopted.
      recordOwnedConfigPath(dir, path);
      for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
        const sidecar = `${path}${suffix}`;
        if (!existsSync(sidecar)) recordOwnedConfigPath(dir, sidecar);
      }
      if (process.platform !== "win32") {
        try { chmodSync(path, 0o600); } catch { /* platform may ignore chmod */ }
      }
      hardenSecretPath(path, { required: false });
    }
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    ensureSchema(db, classification);
    return db;
  } catch (error) {
    try { db.close(); } catch { /* already closed */ }
    throw error;
  }
}

/** Sidecars inherit the database's mode on creation; re-assert it after the first write. */
function hardenSidecars(path: string): void {
  if (process.platform === "win32") return;
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    try { chmodSync(`${path}${suffix}`, 0o600); } catch { /* not created yet */ }
  }
}

function openIndexForRead(path: string): Database {
  try {
    return new Database(path, { readonly: true });
  } catch (error) {
    // A WAL left without its index (a crash, or a writer that exited abruptly) cannot be
    // opened read-only; the read-write handle recovers it on open. Never create a database
    // that vanished: a missing file means the projection is gone, not that it should be
    // recreated without the private-path and ownership checks.
    if (!existsSync(path)) throw error;
    const db = new Database(path, { create: false });
    try {
      if (classifyDatabase(db) !== "ours") throw new UsageFilterIndexForeignError();
      return db;
    } catch (inner) {
      try { db.close(); } catch { /* already closed */ }
      throw inner;
    }
  }
}

interface IngestResult {
  scan: UsageLedgerScanResult;
  rows: number;
  minTimestamp: number | null;
  maxTimestamp: number | null;
}

async function ingest(
  db: Database,
  generation: string,
  startAtBytes: number,
  expected: { identityKey: string; digest: string } | null,
  onBatch?: () => void,
): Promise<IngestResult> {
  const insertRow = db.prepare(
    "INSERT OR REPLACE INTO usage_rows (generation, byte_offset, timestamp, api_key_id, client, surface, admission_kind, unattributable) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertAttribution = db.prepare(
    "INSERT OR REPLACE INTO usage_attributions (generation, byte_offset, provider, model) VALUES (?, ?, ?, ?)",
  );
  const writeBatch = (batch: Array<{ offset: number; entry: PersistedUsageEntry }>): void => {
    for (const { offset, entry } of batch) {
      // Normalization preserves hand-edited rows with a missing or non-numeric timestamp and
      // a missing model. A null timestamp is selected without a window and excluded by one,
      // exactly as the accumulator treats it.
      const timestamp = Number.isFinite(entry.timestamp) ? entry.timestamp : null;
      let attributions: ReturnType<typeof usageAttributions> = [];
      try {
        attributions = usageAttributions(entry);
      } catch {
        attributions = [];
      }
      const attributable = attributions.filter(attribution =>
        typeof attribution.provider === "string" && typeof attribution.model === "string");
      insertRow.run(
        generation,
        offset,
        timestamp,
        entry.apiKeyId ?? null,
        entry.client ?? null,
        entry.surface ?? null,
        entry.admissionKind ?? null,
        attributable.length === 0 ? 1 : 0,
      );
      for (const attribution of attributable) {
        // Keys are derived from the same attribution helper the accumulator filters with, so
        // the index can over-select but never reject a row the exact filter would keep.
        insertAttribution.run(
          generation,
          offset,
          baseProviderLabel(attribution.provider).toLowerCase(),
          attribution.model.toLowerCase(),
        );
      }
    }
  };
  /**
   * Commit one batch under `BEGIN IMMEDIATE`.
   *
   * A deferred `BEGIN` that later upgrades can fail with SQLITE_BUSY without consulting the
   * busy handler, which is exactly the shape two concurrent rebuilds produce. Taking the write
   * lock up front makes the handler apply, and the short synchronous retry rides out a batch
   * another process is committing.
   */
  const commit = (batch: Array<{ offset: number; entry: PersistedUsageEntry }>): void => {
    for (let attempt = 0; ; attempt += 1) {
      db.exec("BEGIN IMMEDIATE");
      try {
        writeBatch(batch);
        db.exec("COMMIT");
        onBatch?.();
        return;
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* the transaction never started */ }
        if (!isBusyError(error) || attempt >= BATCH_BUSY_RETRIES) throw error;
        Bun.sleepSync(BATCH_BUSY_RETRY_MS);
      }
    }
  };
  let pending: Array<{ offset: number; entry: PersistedUsageEntry }> = [];
  let rows = 0;
  let minTimestamp: number | null = null;
  let maxTimestamp: number | null = null;
  let callbackError: unknown = null;
  try {
    let scan: UsageLedgerScanResult;
    try {
      scan = await scanUsageLedgerCooperatively({
        startAtBytes,
        ...(expected
          ? { expectedIdentityKey: expected.identityKey, expectedProcessedThroughDigest: expected.digest }
          : {}),
        onEntry(entry, offset) {
          try {
            pending.push({ offset, entry });
            rows += 1;
            if (Number.isFinite(entry.timestamp)) {
              if (minTimestamp === null || entry.timestamp < minTimestamp) minTimestamp = entry.timestamp;
              if (maxTimestamp === null || entry.timestamp > maxTimestamp) maxTimestamp = entry.timestamp;
            }
            if (pending.length >= USAGE_FILTER_INDEX_INSERT_BATCH) {
              commit(pending);
              pending = [];
            }
          } catch (error) {
            // An index write failure is not a ledger read failure; keep it classified as one.
            callbackError = error;
            throw error;
          }
        },
      });
    } catch (error) {
      if (error instanceof UsageLedgerRebuildRequiredError) throw error;
      if (callbackError !== null) throw callbackError;
      // A ledger read failure is the authoritative read failing, not the index: surface it.
      throw new UsageFilterIndexSourceError(error);
    }
    if (pending.length > 0) commit(pending);
    return { scan, rows, minTimestamp, maxTimestamp };
  } finally {
    insertRow.finalize();
    insertAttribution.finalize();
  }
}

function ingestPassesFor(path: string): number {
  return ingestPassesByPath.get(path) ?? 0;
}

function bumpIngestPasses(path: string): number {
  const next = ingestPassesFor(path) + 1;
  ingestPassesByPath.set(path, next);
  return next;
}

function snapshotFrom(meta: IndexMeta, ingestedRows: number, ingestPasses: number): UsageFilterIndexSnapshot {
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

function discardGeneration(db: Database, generation: string): void {
  db.query("DELETE FROM usage_rows WHERE generation = ?").run(generation);
  db.query("DELETE FROM usage_attributions WHERE generation = ?").run(generation);
  db.query("DELETE FROM usage_filter_index_writers WHERE generation = ?").run(generation);
  db.query("DELETE FROM usage_filter_index_generations WHERE generation = ?").run(generation);
}

/** Whether the process that staged a generation is still running. EPERM means it exists. */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

/**
 * Record the writer that owns a staging generation.
 *
 * The lease is written before the first staged row and removed with the rows, so a generation
 * with rows but no lease cannot belong to a live writer. Reclamation uses the recorded pid as
 * owner evidence; a timestamp alone never deletes a generation whose writer is alive.
 */
function beginStaging(db: Database, path: string, generation: string): void {
  // Registry and lease must become visible together: a reclaimer that saw the registry row
  // without the lease would treat a live writer's generation as abandoned.
  db.exec("BEGIN IMMEDIATE");
  try {
    const now = Date.now();
    db.query("INSERT OR REPLACE INTO usage_filter_index_generations (generation, created_at) VALUES (?, ?)")
      .run(generation, now);
    testHooks?.betweenStagingWrites?.({ dbPath: path, generation });
    db.query(
      "INSERT OR REPLACE INTO usage_filter_index_writers (generation, pid, started_at, heartbeat_at) VALUES (?, ?, ?, ?)",
    ).run(generation, process.pid, now, now);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* the close releases the lock */ }
    throw error;
  }
}

function heartbeatLease(db: Database, generation: string): void {
  db.query("UPDATE usage_filter_index_writers SET heartbeat_at = ? WHERE generation = ?")
    .run(Date.now(), generation);
}

function endLease(db: Database, generation: string): void {
  db.query("DELETE FROM usage_filter_index_writers WHERE generation = ?").run(generation);
}

/**
 * Remove staging generations left behind by writers that are gone.
 *
 * Every staging generation writes its lease before its first row and removes it with the rows,
 * so the lease table is the complete set of in-flight generations. A generation is reclaimed
 * only when it is not published and its recorded writer pid is dead; a live writer's staging is
 * never touched, which is what keeps this from repeating the multi-writer row loss it cleans up
 * after. The published generation never has a lease and is never a candidate.
 */
function reclaimAbandonedStaging(db: Database, path: string, published: string): void {
  // Cheap pre-check without the write lock: most refreshes have nothing to reclaim.
  const generations = db.query(
    "SELECT g.generation AS generation, w.pid AS pid FROM usage_filter_index_generations g LEFT JOIN usage_filter_index_writers w ON w.generation = g.generation",
  ).all() as Array<{ generation: string; pid: number | null }>;
  const maybe = new Set<string>();
  for (const entry of generations) {
    if (entry.generation === published) continue;
    // No lease means no live writer ever owned it; a dead pid means its writer is gone.
    if (entry.pid === null || !processAlive(entry.pid)) maybe.add(entry.generation);
  }
  // A lease whose generation is no longer registered cannot belong to a live writer, because
  // registration and the lease commit together.
  const orphanLease = db.query(
    "SELECT 1 AS present FROM usage_filter_index_writers WHERE generation NOT IN (SELECT generation FROM usage_filter_index_generations) LIMIT 1",
  ).get() !== null;
  if (maybe.size === 0 && !orphanLease) return;
  testHooks?.betweenReclaimCheckAndLock?.({ dbPath: path, candidates: [...maybe] });
  db.exec("BEGIN IMMEDIATE");
  try {
    // Re-read under the write lock: a writer may have registered its lease, or a publish may
    // have moved the watermark, since the pre-check. Eligibility is decided here, not outside.
    const currentPublished = metaText(db, META_KEYS.generation);
    for (const generation of maybe) {
      if (generation === currentPublished) continue;
      const lease = db.query("SELECT pid FROM usage_filter_index_writers WHERE generation = ?")
        .get(generation) as { pid: number } | null;
      if (lease && processAlive(lease.pid)) continue;
      db.query("DELETE FROM usage_rows WHERE generation = ?").run(generation);
      db.query("DELETE FROM usage_attributions WHERE generation = ?").run(generation);
      db.query("DELETE FROM usage_filter_index_writers WHERE generation = ?").run(generation);
      db.query("DELETE FROM usage_filter_index_generations WHERE generation = ?").run(generation);
    }
    // A lease whose generation is no longer registered cannot belong to a live writer:
    // registration is atomic, so this is a leftover record rather than an active one.
    db.query(
      "DELETE FROM usage_filter_index_writers WHERE generation NOT IN (SELECT generation FROM usage_filter_index_generations)",
    ).run();
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* the close releases the lock */ }
    throw error;
  }
}

/** The watermark a publish must still be standing on: the generation and its cursor. */
interface PublishFence {
  generation: string;
  indexedOffset: number;
}

/**
 * Publish one consistent meta snapshot, fenced on the watermark the writer started from.
 *
 * The fence covers the generation and its cursor: a stale append that started at an older offset
 * must not publish over a newer one, because that would regress the cursor and hide the rows in
 * between until the next read. Returns false when another writer moved the watermark first; the
 * caller then discards its staging set and retries. Pruning other generations happens here,
 * inside the fence, and never while they may still be the rows another writer is ingesting.
 */
function publish(
  db: Database,
  fence: PublishFence,
  next: IndexMeta,
): boolean {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (metaText(db, META_KEYS.generation) !== fence.generation
      || metaNumber(db, META_KEYS.indexedOffset) !== fence.indexedOffset) {
      db.exec("ROLLBACK");
      return false;
    }
    writeMetaStatements(db, next);
    // A published staging generation no longer needs its writer lease.
    endLease(db, next.generation);
    // Delete retired generations by equality. The registry is small and known, so this never
    // scans the row table under the write lock.
    const retired = db.query(
      "SELECT generation FROM usage_filter_index_generations WHERE generation <> ?",
    ).all(next.generation) as Array<{ generation: string }>;
    for (const { generation } of retired) {
      if (generation === "") continue;
      // A live writer still owns its staging generation. Its own publish will fail the fence
      // and retry, so leaving it here is what keeps its rows from being deleted mid-ingest.
      const liveLease = db.query("SELECT pid FROM usage_filter_index_writers WHERE generation = ?")
        .get(generation) as { pid: number } | null;
      if (liveLease && processAlive(liveLease.pid)) continue;
      db.query("DELETE FROM usage_rows WHERE generation = ?").run(generation);
      db.query("DELETE FROM usage_attributions WHERE generation = ?").run(generation);
      db.query("DELETE FROM usage_filter_index_generations WHERE generation = ?").run(generation);
      // Drop a dead writer's record with its generation; a live writer keeps its lease so the
      // fence can make it retry rather than look abandoned.
      db.query("DELETE FROM usage_filter_index_writers WHERE generation = ?").run(generation);
    }
    db.exec("COMMIT");
    return true;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* the close releases the lock */ }
    throw error;
  }
}

function assertHomeUnchanged(dir: string): void {
  if (getConfigDir() !== dir) throw new UsageFilterIndexHomeChangedError();
}

async function rebuild(
  db: Database,
  dir: string,
  path: string,
  prior: IndexMeta,
): Promise<UsageFilterIndexSnapshot | null> {
  const staging = randomUUID();
  beginStaging(db, path, staging);
  let published = false;
  try {
    await testHooks?.afterStagingRegistered?.({ dbPath: path, generation: staging });
    const result = await ingest(db, staging, 0, null, () => heartbeatLease(db, staging));
    const next: IndexMeta = {
      schemaVersion: USAGE_FILTER_INDEX_SCHEMA_VERSION,
      generation: staging,
      revision: result.scan.revision,
      indexedOffset: result.scan.processedThroughBytes,
      digest: result.scan.processedThroughDigest,
      indexedRows: result.rows,
      invalidRows: result.scan.invalidRows,
      oversizedRows: result.scan.oversizedRows,
      minTimestamp: result.minTimestamp,
      maxTimestamp: result.maxTimestamp,
    };
    await testHooks?.beforePublish?.({
      dbPath: path,
      stagedGeneration: staging,
      publishedGeneration: prior.generation,
    });
    // The ledger this ingest read is the live home's; publishing it under another home would
    // mix two installations.
    assertHomeUnchanged(dir);
    if (!publish(db, { generation: prior.generation, indexedOffset: prior.indexedOffset }, next)) {
      return null;
    }
    published = true;
    await testHooks?.afterPublish?.({ dbPath: path, generation: staging });
    hardenSidecars(path);
    return snapshotFrom(next, result.rows, bumpIngestPasses(path));
  } finally {
    if (!published) {
      // A failed or crashed attempt must not leave its staging behind.
      discardGeneration(db, staging);
      endLease(db, staging);
    }
  }
}

async function append(
  db: Database,
  dir: string,
  path: string,
  meta: IndexMeta,
): Promise<UsageFilterIndexSnapshot | null> {
  const result = await ingest(db, meta.generation, meta.indexedOffset, {
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
  await testHooks?.beforePublish?.({
    dbPath: path,
    stagedGeneration: meta.generation,
    publishedGeneration: meta.generation,
  });
  assertHomeUnchanged(dir);
  if (!publish(db, { generation: meta.generation, indexedOffset: meta.indexedOffset }, next)) {
    return null;
  }
  await testHooks?.afterPublish?.({ dbPath: path, generation: meta.generation });
  hardenSidecars(path);
  return snapshotFrom(next, result.rows, ingestPassesFor(path));
}

/**
 * Bring the projection up to the ledger's current EOF, appending only new complete rows.
 *
 * A same-size file whose revision metadata moved is a rewrite or replacement, not an append,
 * so it rebuilds. An append is verified by the scanner's boundary digest before any of its
 * rows are retained. Returns null when another writer won the publish race.
 */
async function refreshOnce(
  db: Database,
  dir: string,
  path: string,
): Promise<UsageFilterIndexSnapshot | null> {
  assertHomeUnchanged(dir);
  const meta = readMeta(db);
  reclaimAbandonedStaging(db, path, meta.generation);
  const revision = currentUsageLogRevision();
  if (meta.schemaVersion !== USAGE_FILTER_INDEX_SCHEMA_VERSION
    || !meta.generation
    || usageLogIdentityKey(meta.revision) !== usageLogIdentityKey(revision)) {
    return rebuildOrRetry(db, dir, path, meta);
  }
  if (revision === null) return snapshotFrom(meta, 0, ingestPassesFor(path));
  // Growth is measured against the physical size the snapshot recorded, not the processed
  // boundary: a torn suffix leaves the file larger than the boundary without being new content,
  // and treating that as growth would let a same-size rewrite masquerade as an append.
  const recordedSize = meta.revision?.size ?? 0;
  if (revision.size < recordedSize) return rebuildOrRetry(db, dir, path, meta);
  if (revision.size === recordedSize) {
    if (meta.revision && usageLogRevisionKey(meta.revision) === usageLogRevisionKey(revision)) {
      return snapshotFrom(meta, 0, ingestPassesFor(path));
    }
    return rebuildOrRetry(db, dir, path, meta);
  }
  try {
    return await append(db, dir, path, meta);
  } catch (error) {
    // The append suffix failed the boundary digest: the ledger was rewritten under the
    // projection, so the answer is a full rebuild, not another attempt at the same suffix.
    if (error instanceof UsageLedgerRebuildRequiredError) {
      return rebuildOrRetry(db, dir, path, meta);
    }
    throw error;
  }
}

async function rebuildOrRetry(
  db: Database,
  dir: string,
  path: string,
  meta: IndexMeta,
): Promise<UsageFilterIndexSnapshot | null> {
  try {
    return await rebuild(db, dir, path, meta);
  } catch (error) {
    if (error instanceof UsageLedgerRebuildRequiredError) return null;
    throw error;
  }
}

async function refreshWithRetry(
  db: Database,
  dir: string,
  path: string,
): Promise<UsageFilterIndexSnapshot> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_REFRESH_ATTEMPTS; attempt += 1) {
    try {
      const snapshot = await refreshOnce(db, dir, path);
      if (snapshot) return snapshot;
    } catch (error) {
      if (error instanceof UsageLedgerRebuildRequiredError) {
        lastError = error;
        continue;
      }
      // A corrupt file this module owns is derived data: recreate its own tables and retry.
      if (isCorruptError(error) && attempt === 0) {
        try {
          recreateSchema(db);
          continue;
        } catch {
          throw error;
        }
      }
      throw error;
    }
  }
  throw lastError ?? new Error("usage filter index refresh did not settle");
}

async function refreshUsageFilterIndex(
  dir: string,
  path: string,
): Promise<UsageFilterIndexSnapshot> {
  if (ingestFlight?.path === path) return ingestFlight.promise;
  const promise = (async () => {
    const db = openIndexForWrite(dir, path);
    try {
      if (rebuildRequestedPaths.delete(path)) {
        const rebuilt = await rebuild(db, dir, path, readMeta(db));
        return rebuilt ?? await refreshWithRetry(db, dir, path);
      }
      return await refreshWithRetry(db, dir, path);
    } finally {
      db.close();
    }
  })();
  ingestFlight = { path, promise };
  try {
    return await promise;
  } finally {
    if (ingestFlight?.promise === promise) ingestFlight = null;
  }
}

function buildCandidateSelect(
  query: UsageFilterIndexQuery,
  snapshot: UsageFilterIndexSnapshot,
): { sql: string; values: Array<string | number> } {
  const attrClauses: string[] = [];
  const attrValues: Array<string | number> = [];
  const rowClauses: string[] = [];
  const rowValues: Array<string | number> = [];
  const usesAttributions = query.provider !== null || query.model !== null;
  if (query.provider !== null) {
    attrClauses.push("a.provider = ?");
    attrValues.push(query.provider);
  }
  if (query.model !== null) {
    attrClauses.push("a.model = ?");
    attrValues.push(query.model);
  }
  if (query.apiKeyId !== null) {
    rowClauses.push("r.api_key_id = ?");
    rowValues.push(query.apiKeyId);
  }
  const device = query.sourceFilter?.device;
  if (device?.kind === "no-key") rowClauses.push("r.api_key_id IS NULL");
  else if (device?.kind === "key") {
    rowClauses.push("r.api_key_id = ?");
    rowValues.push(device.id);
  } else if (device?.kind === "unconfigured") {
    rowClauses.push("r.admission_kind = 'configured' AND r.api_key_id IS NOT NULL AND r.api_key_id <> ''");
    const ids = query.configuredApiKeyIds ?? [];
    if (ids.length > 0) {
      rowClauses.push(`r.api_key_id NOT IN (${ids.map(() => "?").join(", ")})`);
      rowValues.push(...ids);
    }
  }
  const client = query.sourceFilter?.client;
  // Each alternative is its own index-friendly predicate. Keeping the Codex and unknown
  // expansions as an OR inside one scan made SQLite walk the whole generation; as separate
  // branches each one searches the client index.
  const clientAlternatives: Array<{ clauses: string[]; values: Array<string | number> }> = [];
  if (client === "codex") {
    clientAlternatives.push({
      clauses: [`r.client IN (${USAGE_CODEX_CLIENT_LABELS.map(() => "?").join(", ")})`],
      values: [...USAGE_CODEX_CLIENT_LABELS],
    });
    // Mirrors matchesUsageSource: legacy Codex-surface rows are included too.
    clientAlternatives.push({ clauses: ["r.client IS NULL AND r.surface IS NULL"], values: [] });
  } else if (client === "unknown") {
    clientAlternatives.push({ clauses: ["r.client = ?"], values: ["unknown"] });
    // Mirrors matchesUsageSource: attributed-but-unclassified rows are unknown too.
    clientAlternatives.push({ clauses: ["r.client IS NULL AND r.surface IS NOT NULL"], values: [] });
  } else if (client !== undefined && client !== "all") {
    clientAlternatives.push({ clauses: ["r.client = ?"], values: [client] });
  } else {
    clientAlternatives.push({ clauses: [], values: [] });
  }
  if (query.window) {
    // A row without a usable timestamp is excluded, exactly as the accumulator skips it.
    rowClauses.push("r.timestamp >= ? AND r.timestamp <= ?");
    rowValues.push(query.window.since, query.window.until);
  }
  if (query.afterOffset !== undefined) {
    rowClauses.push("r.byte_offset >= ?");
    rowValues.push(query.afterOffset);
  }
  rowClauses.push("r.byte_offset <= ?");
  rowValues.push(snapshot.indexedOffset);
  const alternativeSql = clientAlternatives
    .map(alternative => alternative.clauses.length > 0 ? `(${alternative.clauses.join(" AND ")})` : "")
    .filter(clause => clause !== "")
    .join(" OR ");
  const rowSql = [rowClauses.join(" AND "), alternativeSql === "" ? "" : `(${alternativeSql})`]
    .filter(clause => clause !== "")
    .join(" AND ");
  if (!usesAttributions) {
    // Force the matching index for a selective row predicate. Without it SQLite's default
    // estimate prefers the row primary key, which examines every row in the ledger even when
    // one API key or client matches a handful.
    const baseIndex = rowAccessIndexWithoutClient(query);
    const branches = clientAlternatives.map(alternative => {
      const index = alternative.clauses.length > 0 ? "idx_usage_rows_client" : baseIndex;
      const clauses = [...rowClauses, ...alternative.clauses];
      return {
        sql: `SELECT r.byte_offset AS byteOffset FROM usage_rows r${index ? ` INDEXED BY ${index}` : ""} WHERE r.generation = ? AND ${clauses.join(" AND ")}`,
        values: [snapshot.generation, ...rowValues, ...alternative.values],
      };
    });
    return {
      sql: `${branches.map(branch => branch.sql).join(" UNION ")} ORDER BY byteOffset`,
      values: branches.flatMap(branch => branch.values),
    };
  }
  // Drive from the attribution index rather than scanning the row range: SQLite's default
  // estimate otherwise prefers the row primary key, which examines every row in the ledger.
  const attrIndex = query.provider === null ? "idx_usage_attr_model" : "idx_usage_attr_provider";
  // Rows with no usable attribution are selected too: the accumulator is what decides, and a
  // hand-edited row with a missing model must fail a provider/model filter exactly as the
  // streaming read does rather than disappear from the result.
  return {
    sql: `SELECT DISTINCT a.byte_offset AS byteOffset FROM usage_attributions a INDEXED BY ${attrIndex} WHERE a.generation = ? AND ${attrClauses.join(" AND ")} AND a.byte_offset <= ? AND EXISTS (SELECT 1 FROM usage_rows r WHERE r.generation = a.generation AND r.byte_offset = a.byte_offset AND ${rowSql}) UNION SELECT r.byte_offset AS byteOffset FROM usage_rows r INDEXED BY idx_usage_rows_unattributable WHERE r.generation = ? AND r.unattributable = 1 AND ${rowSql} ORDER BY byteOffset`,
    values: [
      snapshot.generation,
      ...attrValues,
      snapshot.indexedOffset,
      ...rowValues,
      ...clientAlternatives.flatMap(alternative => alternative.values),
      snapshot.generation,
      ...rowValues,
      ...clientAlternatives.flatMap(alternative => alternative.values),
    ],
  };
}

/** The index that answers the non-client part of a row-only filter. */
function rowAccessIndexWithoutClient(query: UsageFilterIndexQuery): string | null {
  if (query.apiKeyId !== null) return "idx_usage_rows_key";
  const device = query.sourceFilter?.device;
  if (device?.kind === "no-key" || device?.kind === "key") return "idx_usage_rows_key";
  if (device?.kind === "unconfigured") return "idx_usage_rows_admission";
  if (query.window) return "idx_usage_rows_ts";
  return null;
}

function selectCandidates(
  db: Database,
  snapshot: UsageFilterIndexSnapshot,
  query: UsageFilterIndexQuery,
): number[] {
  const { sql, values } = buildCandidateSelect(query, snapshot);
  const rows = db.query(sql).all(...values) as Array<{ byteOffset: number }>;
  return rows.map(row => row.byteOffset);
}

/** A published generation with a nonzero row count must actually hold rows. */
function hasPublishedRows(db: Database, generation: string): boolean {
  return db.query("SELECT 1 AS present FROM usage_rows WHERE generation = ? LIMIT 1")
    .get(generation) !== null;
}

async function readActive(
  dir: string,
  path: string,
  query: UsageFilterIndexQuery,
): Promise<UsageFilterCandidateRead> {
  const refreshed = await refreshUsageFilterIndex(dir, path);
  testHooks?.afterRefresh?.({ dbPath: path });
  const db = openIndexForRead(path);
  try {
    db.exec("BEGIN");
    try {
      const meta = readMeta(db);
      if (meta.schemaVersion !== USAGE_FILTER_INDEX_SCHEMA_VERSION
        || meta.generation !== refreshed.generation) {
        throw new UsageLedgerRebuildRequiredError("content_changed");
      }
      const snapshot: UsageFilterIndexSnapshot = {
        ...snapshotFrom(meta, 0, ingestPassesFor(path)),
        ingestedRows: refreshed.ingestedRows,
        ingestPasses: refreshed.ingestPasses,
      };
      const offsets = selectCandidates(db, snapshot, query);
      if (offsets.length === 0 && meta.indexedRows > 0 && !hasPublishedRows(db, meta.generation)) {
        // The published generation claims rows it no longer has. Never serve that as a
        // complete zero; drop the projection and rebuild. The refresh alone cannot see this
        // (the cursor and identity still match), so the rebuild must be requested explicitly.
        requestUsageFilterIndexRebuild();
        throw new UsageLedgerRebuildRequiredError("content_changed");
      }
      db.exec("COMMIT");
      return { snapshot, offsets };
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* nothing to roll back */ }
      throw error;
    }
  } finally {
    db.close();
  }
}

/**
 * Refresh the projection, then select the candidate offsets for one filter.
 *
 * Returns null when the projection cannot be used -- a foreign file at its path, an unsafe or
 * unwritable path, a full disk, or sustained write contention -- so the caller falls back to
 * the streaming read. A failure to read `usage.jsonl` itself is rethrown: that is the
 * authoritative source failing, not the acceleration.
 */
export async function readUsageFilterCandidates(
  query: UsageFilterIndexQuery,
): Promise<UsageFilterCandidateRead | null> {
  // Capture the home once: every open and ownership registration for this call must target the
  // directory the flight was keyed on, even if the environment changes mid-flight.
  const dir = getConfigDir();
  const path = usageFilterIndexPath(dir);
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await readActive(dir, path, query);
    } catch (error) {
      if (error instanceof UsageFilterIndexSourceError) throw error;
      if (error instanceof UsageFilterIndexForeignError
        || error instanceof UnsafeSqlitePathError
        || error instanceof UsageFilterIndexHomeChangedError) {
        return null;
      }
      if (error instanceof UsageLedgerRebuildRequiredError) {
        const delay = BUSY_RETRY_DELAYS_MS[attempt];
        if (delay === undefined) return null;
        await new Promise<void>(resolve => setTimeout(resolve, delay));
        continue;
      }
      if (isBusyError(error)) {
        const delay = BUSY_RETRY_DELAYS_MS[attempt];
        if (delay === undefined) return null;
        await new Promise<void>(resolve => setTimeout(resolve, delay));
        continue;
      }
      // Any other index-side failure (permissions, disk full, a corrupt file) degrades to the
      // streaming read rather than failing a request the authoritative scan can answer.
      return null;
    }
  }
}

/**
 * Read the projection without writing anything, for a passive management read.
 *
 * Returns null unless the projection is current for the exact ledger revision, in which case
 * the caller keeps its streaming read. No database, WAL or ownership write happens here.
 */
export async function readUsageFilterCandidatesPassive(
  query: UsageFilterIndexQuery,
): Promise<UsageFilterCandidateRead | null> {
  const path = indexPathForCurrentHome();
  if (!existsSync(path)) return null;
  let db: Database;
  try {
    db = new Database(path, { readonly: true });
  } catch {
    return null;
  }
  try {
    // A foreign SQLite file that happens to carry a meta table is not this projection.
    const tables = new Set(tableNames(db));
    if (!tables.has(META_TABLE)
      || !tables.has("usage_rows")
      || !tables.has("usage_attributions")
      || !tables.has("usage_filter_index_writers")) {
      return null;
    }
    db.exec("BEGIN");
    try {
      const meta = readMeta(db);
      const revision = currentUsageLogRevision();
      if (meta.schemaVersion !== USAGE_FILTER_INDEX_SCHEMA_VERSION || !meta.generation) return null;
      if (usageLogIdentityKey(meta.revision) !== usageLogIdentityKey(revision)) return null;
      if (!revision || meta.indexedOffset !== revision.size) return null;
      if (usageLogRevisionKey(meta.revision) !== usageLogRevisionKey(revision)) return null;
      const snapshot = snapshotFrom(meta, 0, 0);
      // The exact revision match above already proves the ledger is the one indexed; the
      // empty read keeps the passive path on the same validation as the active one.
      await readUsageLedgerRowsAtOffsets({
        offsets: [],
        expectedIdentityKey: snapshot.identityKey,
        expectedRevisionKey: usageLogRevisionKey(snapshot.revision),
        expectedProcessedThroughBytes: snapshot.indexedOffset,
        expectedProcessedThroughDigest: snapshot.processedThroughDigest,
        expectedFileSize: snapshot.revision?.size,
      });
      const offsets = selectCandidates(db, snapshot, query);
      if (offsets.length === 0 && meta.indexedRows > 0 && !hasPublishedRows(db, meta.generation)) {
        // Same guard as the active read: a published generation that lost its rows must not
        // be reported as a complete zero.
        return null;
      }
      return { snapshot, offsets };
    } finally {
      try { db.exec("COMMIT"); } catch { /* read-only transaction */ }
    }
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** Test seam: the SQLite plan for one filter's candidate select. */
export function usageFilterCandidatePlan(query: UsageFilterIndexQuery): string[] {
  const path = indexPathForCurrentHome();
  const db = new Database(path, { readonly: true });
  try {
    const meta = readMeta(db);
    const snapshot = snapshotFrom(meta, 0, 0);
    const { sql, values } = buildCandidateSelect(query, snapshot);
    const rows = db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...values) as Array<{ detail: string }>;
    return rows.map(row => row.detail);
  } finally {
    db.close();
  }
}

/** Test seam: simulate a crash or a competing writer at the publish boundary. */
export function setUsageFilterIndexTestHooksForTests(hooks: UsageFilterIndexTestHooks | null): void {
  testHooks = hooks;
}

/** Discard the projection on the next refresh; used when an offset no longer frames a row. */
export function requestUsageFilterIndexRebuild(): void {
  rebuildRequestedPaths.add(indexPathForCurrentHome());
}

/** Test-only process-state reset for isolated harnesses. */
export function resetUsageFilterIndexForTests(): void {
  ingestFlight = null;
  ingestPassesByPath.clear();
  rebuildRequestedPaths.clear();
  testHooks = null;
}
