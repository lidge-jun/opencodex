import type { AstraEffortStoreMeasurement } from "../usage/astra-effort-cache";
import { Database } from "bun:sqlite";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config/paths";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { hardenSecretDir, hardenSecretPath } from "../lib/windows-secret-acl";

const MAX_DATABASE_BYTES = 32 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_CONVERSATIONS = 128;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function withAstraEffortState<T>(
  directory: string,
  scope: string,
  work: (state: string | undefined) => { value: T; state?: string | null },
  measurement?: AstraEffortStoreMeasurement,
): T {
  const started = performance.now();
  let db: Database | undefined;
  if (measurement) measurement.outcome = "error";
  try {
    assertNotRealHomeUnderTest(getConfigDir());
    assertNotRealHomeUnderTest(directory);
    if (!recordOwnedConfigPath(getConfigDir(), directory)) throw new Error("Unowned effort state directory");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error("Invalid effort state directory");
    if (process.platform !== "win32") chmodSync(directory, 0o700);
    hardenSecretDir(directory, { required: true });
    const path = join(directory, "state.sqlite");
    try { closeSync(openSync(path, "wx", 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const file = lstatSync(path);
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.size > MAX_DATABASE_BYTES) throw new Error("Invalid effort state file");
    if (process.platform !== "win32") chmodSync(path, 0o600);
    hardenSecretPath(path, { required: true });
    db = new Database(path, { readwrite: true });
    const database = db;
    db.exec("PRAGMA busy_timeout = 0; PRAGMA journal_mode = DELETE; PRAGMA page_size = 4096; PRAGMA max_page_count = 8192");
    const pageSize = (database.query("PRAGMA page_size").get() as { page_size: number }).page_size;
    db.exec(`PRAGMA max_page_count = ${Math.floor(MAX_DATABASE_BYTES / pageSize)}`);
    db.exec("CREATE TABLE IF NOT EXISTS sessions (scope TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(length(CAST(state AS BLOB)) <= 2097152), touched INTEGER NOT NULL)");
    if (measurement) measurement.setupMs = performance.now() - started;
    const transactionStarted = performance.now();
    let result: T;
    try {
      result = database.transaction(() => {
        const now = Date.now();
        database.query("DELETE FROM sessions WHERE touched < ?").run(now - RETENTION_MS);
        const row = database.query("SELECT state FROM sessions WHERE scope = ?").get(scope) as { state: string } | null;
        const result = work(row?.state);
        if (result.state === null) database.query("DELETE FROM sessions WHERE scope = ?").run(scope);
        else if (result.state !== undefined) {
          database.query("INSERT INTO sessions VALUES (?, ?, ?) ON CONFLICT(scope) DO UPDATE SET state = excluded.state, touched = excluded.touched")
            .run(scope, result.state, now);
          for (;;) {
            const totals = database.query("SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(state AS BLOB))), 0) AS bytes FROM sessions").get() as { count: number; bytes: number };
            if (totals.count <= MAX_CONVERSATIONS && totals.bytes <= MAX_PAYLOAD_BYTES) break;
            database.query("DELETE FROM sessions WHERE scope = (SELECT scope FROM sessions WHERE scope != ? ORDER BY touched, scope LIMIT 1)").run(scope);
          }
        }
        return result.value;
      }).immediate();
    } finally {
      if (measurement) measurement.transactionMs = performance.now() - transactionStarted;
    }
    if (measurement) measurement.outcome = "committed";
    return result;
  } catch (error) {
    if (measurement) {
      measurement.setupMs ??= performance.now() - started;
      const code = (error as { code?: unknown } | null)?.code;
      measurement.outcome = code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" ? "busy" : "error";
    }
    throw error;
  } finally {
    if (db) {
      const closeStarted = performance.now();
      try { db.close(); }
      catch (error) { if (measurement) measurement.outcome = "error"; throw error; }
      finally { if (measurement) measurement.closeMs = performance.now() - closeStarted; }
    }
  }
}
