import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Database, constants } from "bun:sqlite";

import {
  getCodexHome,
  resolveCodexSqliteHome,
  type CodexSqliteHomeDeps,
} from "../paths";

const IMMUTABLE_READONLY_FLAGS = constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI;
const KNOWN_LOG_LEVELS = new Set(["TRACE", "DEBUG", "INFO", "WARN", "ERROR"]);
// The issue reporter measured a ~1 GB database taking 17.3s for GROUP BY level
// alone; skipping all row aggregates above 64 MiB reduced /api/storage to 628ms.
const MAX_SYNCHRONOUS_METRICS_DATABASE_BYTES = 64 * 1024 * 1024;

interface CurrentLogColumn {
  name: string;
  type: string;
  notnull: number;
  defaultValue: string | null;
  pk: number;
}

// Pinned to Codex logs migration 0002. Keep this schema private: inspection reports
// compatibility, not column names, so sensitive payload-bearing fields never leak through
// the management API. Any additive/rebuilt future schema is monitor-only until reviewed.
const CURRENT_LOG_SCHEMA: readonly CurrentLogColumn[] = [
  { name: "id", type: "INTEGER", notnull: 0, defaultValue: null, pk: 1 },
  { name: "ts", type: "INTEGER", notnull: 1, defaultValue: null, pk: 0 },
  { name: "ts_nanos", type: "INTEGER", notnull: 1, defaultValue: null, pk: 0 },
  { name: "level", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
  { name: "target", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
  { name: "feedback_log_body", type: "TEXT", notnull: 0, defaultValue: null, pk: 0 },
  { name: "module_path", type: "TEXT", notnull: 0, defaultValue: null, pk: 0 },
  { name: "file", type: "TEXT", notnull: 0, defaultValue: null, pk: 0 },
  { name: "line", type: "INTEGER", notnull: 0, defaultValue: null, pk: 0 },
  { name: "thread_id", type: "TEXT", notnull: 0, defaultValue: null, pk: 0 },
  { name: "process_uuid", type: "TEXT", notnull: 0, defaultValue: null, pk: 0 },
  { name: "estimated_bytes", type: "INTEGER", notnull: 1, defaultValue: "0", pk: 0 },
] as const;

const CURRENT_LOG_TABLE_SQL = `CREATE TABLE logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  ts_nanos INTEGER NOT NULL,
  level TEXT NOT NULL,
  target TEXT NOT NULL,
  feedback_log_body TEXT,
  module_path TEXT,
  file TEXT,
  line INTEGER,
  thread_id TEXT,
  process_uuid TEXT,
  estimated_bytes INTEGER NOT NULL DEFAULT 0
)`;

const CURRENT_LOG_INDEX_SQL = {
  idx_logs_ts: "CREATE INDEX idx_logs_ts ON logs(ts DESC, ts_nanos DESC, id DESC)",
  idx_logs_thread_id: "CREATE INDEX idx_logs_thread_id ON logs(thread_id)",
  idx_logs_thread_id_ts: "CREATE INDEX idx_logs_thread_id_ts ON logs(thread_id, ts DESC, ts_nanos DESC, id DESC)",
  idx_logs_process_uuid_threadless_ts: `CREATE INDEX idx_logs_process_uuid_threadless_ts
    ON logs(process_uuid, ts DESC, ts_nanos DESC, id DESC)
    WHERE thread_id IS NULL`,
} as const;

export type CodexLogGuardCapabilityReason =
  | "database_missing"
  | "database_unreadable"
  | "unknown_schema"
  | "inspect_failed";

export type CodexLogGuardSchemaState =
  | { state: "compatible" }
  | { state: "missing"; reason: "database_missing" }
  | { state: "unreadable"; reason: "database_unreadable" }
  | { state: "unsupported"; reason: "unknown_schema" }
  | { state: "unavailable"; reason: "inspect_failed" };

export type CodexLogGuardCapability =
  | { state: "supported" }
  | { state: "unsupported"; reason: CodexLogGuardCapabilityReason };

export interface CodexLogGuardMetrics {
  totalRows: number;
  rowsByLevel: Record<string, number>;
  traceRows: number;
  traceShare: number;
  topTargets: Array<{ target: string; rows: number }>;
  pageSize: number;
  pageCount: number;
  freelistPages: number;
  reclaimableBytes: number;
  estimatedLogBytes: number | null;
}

/**
 * Serializable, privacy-safe Log Guard inspection result.
 *
 * Canonical filesystem paths are deliberately kept local to the inspector. Consumers get
 * only the coarse location relation (`externalSqliteHome`) and aggregate file/SQLite data.
 * `externalSqliteHome` is null only when config resolution itself is unavailable.
 */
export interface CodexLogGuardInspection {
  generatedAt: number;
  externalSqliteHome: boolean | null;
  snapshot: "checkpointed";
  files: {
    databaseBytes: number;
    walBytes: number;
    shmBytes: number;
  };
  schema: CodexLogGuardSchemaState;
  capabilities: {
    inspection: CodexLogGuardCapability;
    protection: CodexLogGuardCapability;
    reclaim: CodexLogGuardCapability;
  };
  metrics: CodexLogGuardMetrics | null;
  metricsSkipped: null | {
    reason: "database_too_large";
    thresholdBytes: number;
  };
}

interface ColumnRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}
interface SchemaObjectRow { name: string; type: string; sql: string | null }
interface CountRow { n: number }
interface LevelRow { level: string; rows: number }
interface TargetCountRow { rows: number }
interface EstimatedBytesRow { bytes: number | null }

type CanonicalTargetState = "missing" | "file" | "unusable";

function canonicalTargetState(path: string): CanonicalTargetState {
  try {
    return statSync(path).isFile() ? "file" : "unusable";
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" ? "missing" : "unusable";
  }
}

function fileSize(path: string): number {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

/**
 * Memoized inspection, keyed by the database and WAL identity.
 *
 * `readMetrics` runs four unbounded aggregates (`count(*)`, two `GROUP BY`s and
 * a `sum`) over the whole `logs` table. `bun:sqlite` is synchronous, so that
 * work occupies the proxy thread for its full duration — measured at ~49s on a
 * 15.6 GB / 302k-row database, exactly the large fragmented case this feature
 * exists to diagnose. Both `/api/storage` and `/api/storage/codex-logs` call it
 * inline, so merely opening or refreshing the Storage page could stall routing
 * and health responses.
 *
 * A dashboard refresh, a page that renders both panels, and a poll loop all
 * repeat an identical scan. Keying on size+mtime of the database and WAL means a
 * repeat inspection is free until Codex actually writes, which removes the
 * repeated stalls without ever serving stale numbers: any write changes the WAL
 * and invalidates the entry.
 *
 * Memoization bounds repeat cost. The database-size gate below separately bounds
 * cold request-thread work by omitting these aggregates for large databases.
 */
type InspectionCacheEntry = {
  key: string;
  value: CodexLogGuardInspection;
};

let inspectionCache: InspectionCacheEntry | null = null;

function inspectionCacheKey(databasePath: string): string {
  const stamp = (path: string): string => {
    try {
      // `size:mtimeMs` alone is not an identity. An atomic replace (write a new
      // file, rename over the old one) can preserve both, and the cache then
      // served the previous schema/capability verdict indefinitely — trading a
      // repeated-scan cost for a persistent wrong answer. Include the inode and
      // device so a replaced file is a different key even at identical size and
      // mtime, plus nanosecond ctime/mtime so an in-place rewrite inside one
      // millisecond still invalidates.
      const stat = statSync(path, { bigint: true });
      return [
        stat.dev,
        stat.ino,
        stat.size,
        stat.mtimeNs,
        stat.ctimeNs,
      ].join(":");
    } catch {
      return "-";
    }
  };
  return [
    databasePath,
    stamp(databasePath),
    stamp(`${databasePath}-wal`),
    stamp(`${databasePath}-shm`),
  ].join("|");
}

/** Drop the memoized inspection. Exported for tests and for post-mutation refresh. */
export function resetCodexLogGuardInspectionCache(): void {
  inspectionCache = null;
}

function capabilityFor(schema: CodexLogGuardSchemaState): CodexLogGuardCapability {
  if (schema.state === "compatible") return { state: "supported" };
  return { state: "unsupported", reason: schema.reason };
}

function unavailableInspection(): CodexLogGuardInspection {
  const schema: CodexLogGuardSchemaState = { state: "unavailable", reason: "inspect_failed" };
  const unavailable: CodexLogGuardCapability = { state: "unsupported", reason: "inspect_failed" };
  return {
    generatedAt: Date.now(),
    externalSqliteHome: null,
    snapshot: "checkpointed",
    files: { databaseBytes: 0, walBytes: 0, shmBytes: 0 },
    schema,
    capabilities: {
      inspection: unavailable,
      protection: unavailable,
      reclaim: unavailable,
    },
    metrics: null,
    metricsSkipped: null,
  };
}

function normalizeDeclaredType(type: string): string {
  return String(type ?? "").trim().toUpperCase();
}

function normalizeDefault(value: string | null): string | null {
  return value === null ? null : String(value).trim();
}

function normalizeSchemaSql(sql: string | null | undefined): string {
  return (sql ?? "").trim().replace(/;\s*$/, "").replace(/\s+/g, " ");
}

function sameColumns(columns: ColumnRow[]): boolean {
  if (columns.length !== CURRENT_LOG_SCHEMA.length) return false;
  return columns.every((column, index) => {
    const expected = CURRENT_LOG_SCHEMA[index];
    return column.cid === index
      && column.name === expected.name
      && normalizeDeclaredType(column.type) === expected.type
      && Number(column.notnull) === expected.notnull
      && normalizeDefault(column.dflt_value) === expected.defaultValue
      && Number(column.pk) === expected.pk;
  });
}

/**
 * The authoritative compatibility predicate: exact table SQL, exact column
 * metadata, and every canonical index.
 *
 * Exported because the mutation paths must apply the SAME test inside their
 * write transaction. They used to check column NAMES only, which is strictly
 * weaker than what the inspector reports, so a schema change landing between
 * the outer inspection and the locked write let Protect install a row-dropping
 * trigger and let Reclaim vacuum pages on a database the inspector classifies
 * as monitor-only. The lock serializes OpenCodex against itself; it does not
 * stop Codex or another SQLite writer, so that TOCTOU window is real.
 */
export function hasCurrentLogsSchema(db: Database): boolean {
  const columns = db.query<ColumnRow, []>("PRAGMA table_info(logs)").all();
  return hasCurrentLogsTable(db, columns);
}

function hasCurrentLogsTable(db: Database, columns: ColumnRow[]): boolean {
  const table = db.query<SchemaObjectRow, []>(
    "SELECT name, type, sql FROM sqlite_schema WHERE name = 'logs' LIMIT 1",
  ).get();
  if (table?.type !== "table"
    || !sameColumns(columns)
    || normalizeSchemaSql(table.sql) !== normalizeSchemaSql(CURRENT_LOG_TABLE_SQL)) {
    return false;
  }

  const indexes = db.query<SchemaObjectRow, []>(`
    SELECT name, type, sql FROM sqlite_schema
    WHERE name IN (
      'idx_logs_ts',
      'idx_logs_thread_id',
      'idx_logs_thread_id_ts',
      'idx_logs_process_uuid_threadless_ts'
    )
  `).all();
  const byName = new Map(indexes.map(row => [row.name, row]));
  for (const [name, expectedSql] of Object.entries(CURRENT_LOG_INDEX_SQL)) {
    const row = byName.get(name);
    if (row?.type !== "index" || normalizeSchemaSql(row.sql) !== normalizeSchemaSql(expectedSql)) {
      return false;
    }
  }

  // Extra indexes and triggers do not redefine the table contract. In particular,
  // Protect intentionally installs OpenCodex-owned triggers and unrelated user triggers
  // are supported, so compatibility is based on the canonical table plus required indexes.
  return true;
}

function pragmaNumber(db: Database, pragma: "page_size" | "page_count" | "freelist_count"): number {
  const row = db.query<Record<string, number>, []>(`PRAGMA ${pragma}`).get();
  return Number(row?.[pragma] ?? 0);
}

function readMetrics(db: Database, columns: string[]): CodexLogGuardMetrics | null {
  if (!columns.includes("level") || !columns.includes("target")) return null;

  try {
    const totalRows = Number(db.query<CountRow, []>("SELECT count(*) AS n FROM logs").get()?.n ?? 0);
    const rowsByLevel: Record<string, number> = {};
    for (const row of db.query<LevelRow, []>(
      "SELECT level, count(*) AS rows FROM logs GROUP BY level ORDER BY level",
    ).all()) {
      const rawLevel = String(row.level ?? "").toUpperCase();
      const level = KNOWN_LOG_LEVELS.has(rawLevel) ? rawLevel : "OTHER";
      rowsByLevel[level] = (rowsByLevel[level] ?? 0) + Number(row.rows ?? 0);
    }

    // Preserve the useful top-target distribution without serializing target names from
    // the foreign database. Rank labels are fixed output values and cannot carry local
    // paths, credentials, or other injected diagnostic content.
    const topTargets = db.query<TargetCountRow, []>(
      "SELECT count(*) AS rows FROM logs GROUP BY target ORDER BY rows DESC, target ASC LIMIT 10",
    ).all().map((row, index) => ({ target: `TARGET_${index + 1}`, rows: Number(row.rows ?? 0) }));

    const pageSize = pragmaNumber(db, "page_size");
    const pageCount = pragmaNumber(db, "page_count");
    const freelistPages = pragmaNumber(db, "freelist_count");
    const traceRows = rowsByLevel.TRACE ?? 0;
    const estimatedLogBytes = columns.includes("estimated_bytes")
      ? Number(db.query<EstimatedBytesRow, []>(
        "SELECT COALESCE(sum(estimated_bytes), 0) AS bytes FROM logs",
      ).get()?.bytes ?? 0)
      : null;

    return {
      totalRows,
      rowsByLevel,
      traceRows,
      traceShare: totalRows > 0 ? traceRows / totalRows : 0,
      topTargets,
      pageSize,
      pageCount,
      freelistPages,
      reclaimableBytes: pageSize * freelistPages,
      estimatedLogBytes,
    };
  } catch {
    // A future schema may still have a `logs` table but change aggregate-compatible
    // columns or virtual-table behaviour. Metadata inspection remains valid; metrics do
    // not become a reason to throw or to open a writable connection.
    return null;
  }
}

/**
 * Inspect the canonical Codex diagnostic log database without participating in SQLite's
 * write/locking protocol. `immutable=1` intentionally observes the last checkpointed
 * snapshot: file sizes include live sidecars, while SQL aggregates may lag a live WAL.
 * This is a zero-write health view, not an SSD/NAND write-rate measurement.
 */
export function inspectCodexLogs(deps: CodexSqliteHomeDeps = {}): CodexLogGuardInspection {
  let cacheKey: string | null = null;
  try {
    const home = deps.codexHome ?? getCodexHome();
    cacheKey = inspectionCacheKey(join(resolveCodexSqliteHome({ ...deps, codexHome: home }), "logs_2.sqlite"));
    if (inspectionCache?.key === cacheKey) return inspectionCache.value;
  } catch {
    cacheKey = null;
  }
  const value = inspectCodexLogsUncached(deps);
  // `generatedAt` is part of the memoized value, so a cached response reports the
  // time the numbers were actually measured rather than the time they were served.
  if (cacheKey !== null) inspectionCache = { key: cacheKey, value };
  return value;
}

function inspectCodexLogsUncached(deps: CodexSqliteHomeDeps = {}): CodexLogGuardInspection {
  let codexHome: string;
  let sqliteHome: string;
  try {
    codexHome = deps.codexHome ?? getCodexHome();
    sqliteHome = resolveCodexSqliteHome({ ...deps, codexHome });
  } catch {
    // Resolution errors can include config paths. Convert them to a fixed, non-fatal
    // inspection state before they cross any diagnostic/API boundary.
    return unavailableInspection();
  }

  // Resolve sqlite_home exactly once so the location flag and inspected file cannot refer
  // to different roots if config changes during one inspection.
  const databasePath = join(sqliteHome, "logs_2.sqlite");
  const targetState = canonicalTargetState(databasePath);
  const files = {
    databaseBytes: fileSize(databasePath),
    walBytes: fileSize(`${databasePath}-wal`),
    shmBytes: fileSize(`${databasePath}-shm`),
  };

  const common = {
    generatedAt: Date.now(),
    externalSqliteHome: resolve(sqliteHome) !== resolve(codexHome),
    snapshot: "checkpointed" as const,
    files,
  };

  if (targetState === "missing") {
    const schema: CodexLogGuardSchemaState = { state: "missing", reason: "database_missing" };
    const mutation = capabilityFor(schema);
    return {
      ...common,
      schema,
      metrics: null,
      metricsSkipped: null,
      capabilities: {
        inspection: { state: "supported" },
        protection: mutation,
        reclaim: mutation,
      },
    };
  }

  if (targetState === "unusable") {
    const schema: CodexLogGuardSchemaState = { state: "unreadable", reason: "database_unreadable" };
    const mutation = capabilityFor(schema);
    return {
      ...common,
      schema,
      metrics: null,
      metricsSkipped: null,
      capabilities: {
        inspection: { state: "supported" },
        protection: mutation,
        reclaim: mutation,
      },
    };
  }

  // SQLite accepts a zero-byte file as an empty database. For Log Guard this is not a
  // compatible future schema: Codex's canonical logs database must already contain its
  // migrated `logs` table before any future mutation capability can be considered safe.
  if (files.databaseBytes === 0) {
    const schema: CodexLogGuardSchemaState = { state: "unreadable", reason: "database_unreadable" };
    const mutation = capabilityFor(schema);
    return {
      ...common,
      schema,
      metrics: null,
      metricsSkipped: null,
      capabilities: {
        inspection: { state: "supported" },
        protection: mutation,
        reclaim: mutation,
      },
    };
  }

  try {
    const uri = `${pathToFileURL(databasePath).href}?immutable=1`;
    const db = new Database(uri, IMMUTABLE_READONLY_FLAGS);
    try {
      const columnRows = db.query<ColumnRow, []>("PRAGMA table_info(logs)").all();
      const columns = columnRows.map(row => row.name);
      const schema: CodexLogGuardSchemaState = hasCurrentLogsTable(db, columnRows)
        ? { state: "compatible" }
        : { state: "unsupported", reason: "unknown_schema" };
      const mutation = capabilityFor(schema);
      const metricsSkipped = files.databaseBytes > MAX_SYNCHRONOUS_METRICS_DATABASE_BYTES
        ? {
            reason: "database_too_large" as const,
            thresholdBytes: MAX_SYNCHRONOUS_METRICS_DATABASE_BYTES,
          }
        : null;
      return {
        ...common,
        schema,
        metrics: metricsSkipped === null ? readMetrics(db, columns) : null,
        metricsSkipped,
        capabilities: {
          inspection: { state: "supported" },
          protection: mutation,
          reclaim: mutation,
        },
      };
    } finally {
      db.close();
    }
  } catch {
    const schema: CodexLogGuardSchemaState = { state: "unreadable", reason: "database_unreadable" };
    const mutation = capabilityFor(schema);
    return {
      ...common,
      schema,
      metrics: null,
      metricsSkipped: null,
      capabilities: {
        inspection: { state: "supported" },
        protection: mutation,
        reclaim: mutation,
      },
    };
  }
}
