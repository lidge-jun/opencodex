import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { LAB_PROJECTION_SPEC_VERSION } from "../constants";
import { labSqlitePath } from "../paths";
import { LAB_SQLITE_SCHEMA_VERSION } from "../projection/schema";
import { LabProjectionIncompatibleError, LabProjectionUnavailableError } from "./errors";

export interface LabReadConnection {
  db: Database;
  sqlitePath: string;
  schemaVersion: number;
  projectionSpecVersion: string;
  builtAtMs: number;
}

const COUNTABLE_TABLES = [
  "events",
  "subjects",
  "observations",
  "claims",
  "verdicts",
  "artifacts",
  "corruption",
] as const;

export type CountableTable = (typeof COUNTABLE_TABLES)[number];

const COUNT_TABLE_SQL: Record<CountableTable, string> = {
  events: "SELECT COUNT(*) AS c FROM events",
  subjects: "SELECT COUNT(*) AS c FROM subjects",
  observations: "SELECT COUNT(*) AS c FROM observations",
  claims: "SELECT COUNT(*) AS c FROM claims",
  verdicts: "SELECT COUNT(*) AS c FROM verdicts",
  artifacts: "SELECT COUNT(*) AS c FROM artifacts",
  corruption: "SELECT COUNT(*) AS c FROM corruption",
};

export function resolveLabSqlitePath(configDir?: string): string {
  return labSqlitePath(configDir);
}

export function openLabReadConnection(configDir?: string): LabReadConnection {
  const sqlitePath = resolveLabSqlitePath(configDir);
  if (!existsSync(sqlitePath)) {
    throw new LabProjectionUnavailableError();
  }
  let db: Database;
  try {
    db = new Database(sqlitePath, { readonly: true });
  } catch {
    throw new LabProjectionUnavailableError();
  }
  try {
    const metaRows = db
      .query("SELECT key, value FROM schema_meta")
      .all() as Array<{ key: string; value: string }>;
    const meta = new Map(metaRows.map((r) => [r.key, r.value]));
    const schemaRaw = meta.get("schema_version");
    const specRaw = meta.get("projection_spec_version");
    const builtRaw = meta.get("built_at_ms");
    if (!schemaRaw || !specRaw || !builtRaw) {
      db.close();
      throw new LabProjectionUnavailableError();
    }
    const schemaVersion = Number(schemaRaw);
    const projectionSpecVersion = specRaw;
    const builtAtMs = Number(builtRaw);
    if (
      !Number.isInteger(schemaVersion) ||
      schemaVersion !== LAB_SQLITE_SCHEMA_VERSION ||
      projectionSpecVersion !== LAB_PROJECTION_SPEC_VERSION ||
      !Number.isFinite(builtAtMs)
    ) {
      db.close();
      throw new LabProjectionIncompatibleError();
    }
    return {
      db,
      sqlitePath,
      schemaVersion,
      projectionSpecVersion,
      builtAtMs,
    };
  } catch (err) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    if (err instanceof LabProjectionUnavailableError || err instanceof LabProjectionIncompatibleError) {
      throw err;
    }
    throw new LabProjectionUnavailableError();
  }
}

export function closeLabReadConnection(conn: LabReadConnection): void {
  conn.db.close();
}

export function countTable(conn: LabReadConnection, table: CountableTable): number {
  if (!(COUNTABLE_TABLES as readonly string[]).includes(table)) {
    throw new LabProjectionUnavailableError();
  }
  const row = conn.db.query(COUNT_TABLE_SQL[table]).get() as { c: number };
  return Number(row.c);
}
