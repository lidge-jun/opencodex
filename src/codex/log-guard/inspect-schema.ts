import type { Database } from "bun:sqlite";

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


export interface ColumnRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}
interface SchemaObjectRow { name: string; type: string; sql: string | null }

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

export function hasCurrentLogsTable(db: Database, columns: ColumnRow[]): boolean {
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
