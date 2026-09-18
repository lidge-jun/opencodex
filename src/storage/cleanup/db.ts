import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { CleanupErrorCode } from "./types";

const STATE_DB_FILE = /^state_(\d+)\.sqlite$/;

const LOGS_DB_FILE = /^logs_(\d+)\.sqlite$/;

const GOALS_DB_FILE = /^goals_(\d+)\.sqlite$/;

const MEMORIES_DB_FILE = /^memories_(\d+)\.sqlite$/;

/** Chunk size for `IN (...)` binds; spawn-edge checks bind each id twice. */
export const SQLITE_ID_CHUNK = 200;

export function chunkIds(ids: string[], chunkSize: number): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += chunkSize) chunks.push(ids.slice(i, i + chunkSize));
  return chunks;
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

export interface RuntimeDbPaths {
  state: string | null;
  logs: string | null;
  goals: string | null;
  memories: string | null;
}

export function discoverRuntimeDbPaths(codexHome: string): RuntimeDbPaths {
  return {
    state: newestVersionedDb(codexHome, STATE_DB_FILE),
    logs: newestVersionedDb(codexHome, LOGS_DB_FILE),
    goals: newestVersionedDb(codexHome, GOALS_DB_FILE),
    memories: newestVersionedDb(codexHome, MEMORIES_DB_FILE),
  };
}

export function openDbWritable(dbPath: string, busyTimeoutMs = 100): Database {
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

export function mapDbError(error: unknown): CleanupErrorCode {
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

export function tableExists(db: Database, name: string): boolean {
  const row = db.query<{ name: string }, [string]>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
  ).get(name);
  return Boolean(row);
}

export function columnExists(db: Database, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false;
  // `table` is only ever a hardcoded identifier already verified via sqlite_master.
  const rows = db.query<{ name: string }, []>(
    `PRAGMA table_info("${table.replaceAll('"', '""')}")`,
  ).all();
  return rows.some(r => r.name === column);
}

export interface ReconcileErr {
  ok: false;
  error: CleanupErrorCode;
  /** True when satellite rows were mutated and could not all be restored. */
  satelliteRestoreFailed?: boolean;
}

export type SqlRow = Record<string, string | number | bigint | null | Uint8Array>;

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function selectRows(db: Database, sql: string, params: Array<string | number>): SqlRow[] {
  return db.query<SqlRow, Array<string | number>>(sql).all(...params) as SqlRow[];
}

export function tableColumnNames(db: Database, table: string): Set<string> {
  if (!tableExists(db, table)) return new Set();
  const rows = db.query<{ name: string }, []>(
    `PRAGMA table_info("${table.replaceAll('"', '""')}")`,
  ).all();
  return new Set(rows.map(r => r.name));
}

/** Insert rows with ON CONFLICT DO NOTHING; returns only rows that were newly inserted. */
export function insertRowsConflictIgnore(db: Database, table: string, rows: SqlRow[]): SqlRow[] {
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

export function updateRowFromSnapshot(
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

export function sqlRowEqual(a: SqlRow, b: SqlRow): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (normalizeSqlValue(a[key]) !== normalizeSqlValue(b[key])) return false;
  }
  return true;
}

export function withWritableDb(
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

export function isSqlRowArray(value: unknown): value is SqlRow[] {
  return Array.isArray(value) && value.every(row => row && typeof row === "object" && !Array.isArray(row));
}
