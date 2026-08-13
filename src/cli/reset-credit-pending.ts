import { createHash, randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { Database } from "bun:sqlite";
import { prepareConfigMutationDatabasePathForWrite } from "../config";
import { initializeConfigGeneration } from "../codex/generation";
import { isCodexResetCreditOperationId } from "../codex/reset-credit-recovery";
import { isCodexResetCreditConsentAccountId } from "../lib/codex-reset-credit-consent-contract";

const TABLE_NAME = "reset_credit_cli_pending";
const MAX_PENDING_OPERATIONS = 128;
const ACCOUNT_KEY_PATTERN = /^[0-9a-f]{64}$/;
const CREATE_TABLE = `CREATE TABLE main.reset_credit_cli_pending (
    account_key TEXT PRIMARY KEY
      CHECK (length(account_key) = 64 AND account_key NOT GLOB '*[^0-9a-f]*'),
    operation_id TEXT NOT NULL UNIQUE
  ) STRICT, WITHOUT ROWID`;
const EXPECTED_SCHEMA_SQL = CREATE_TABLE.replace("main.", "");
export const RESET_CREDIT_PENDING_SCHEMA_SQL_FOR_TESTS = EXPECTED_SCHEMA_SQL;

type PendingRow = {
  account_key: unknown;
  operation_id: unknown;
};

type SchemaRow = {
  type: unknown;
  name: unknown;
  tbl_name: unknown;
  sql: unknown;
};

function accountKey(accountId: string): string {
  if (!isCodexResetCreditConsentAccountId(accountId)) {
    throw new TypeError("Invalid reset-credit account id");
  }
  return createHash("sha256").update(accountId).digest("hex");
}

function assertCanonicalTable(database: Database): void {
  const rows = database.query<SchemaRow, [string]>(`
    SELECT type, name, tbl_name, sql
      FROM main.sqlite_schema
     WHERE name = ? COLLATE NOCASE
     ORDER BY type, name
     LIMIT 4
  `).all(TABLE_NAME);
  if (rows.length === 0) {
    database.exec(CREATE_TABLE);
  } else if (
    rows.length !== 1
    || rows[0]?.type !== "table"
    || rows[0]?.name !== TABLE_NAME
    || rows[0]?.tbl_name !== TABLE_NAME
    || rows[0]?.sql !== EXPECTED_SCHEMA_SQL
  ) {
    throw new Error("Reset-credit retry state schema is invalid");
  }

  const tableRows = database.query<{
    schema: unknown;
    name: unknown;
    type: unknown;
    ncol: unknown;
    wr: unknown;
    strict: unknown;
  }, []>("PRAGMA main.table_list").all().filter(row => row.name === TABLE_NAME);
  if (
    tableRows.length !== 1
    || tableRows[0]?.schema !== "main"
    || tableRows[0]?.type !== "table"
    || tableRows[0]?.ncol !== 2
    || tableRows[0]?.wr !== 1
    || tableRows[0]?.strict !== 1
  ) {
    throw new Error("Reset-credit retry state table is invalid");
  }

  const trigger = database.query<{ name: unknown }, [string]>(`
    SELECT name FROM main.sqlite_schema
     WHERE type = 'trigger' AND tbl_name = ? COLLATE NOCASE
     LIMIT 1
  `).get(TABLE_NAME);
  const tempTrigger = database.query<{ name: unknown }, [string]>(`
    SELECT name FROM temp.sqlite_schema
     WHERE type = 'trigger' AND tbl_name = ? COLLATE NOCASE
     LIMIT 1
  `).get(TABLE_NAME);
  if (trigger || tempTrigger) {
    throw new Error("Reset-credit retry state triggers are forbidden");
  }
}

function readAllPending(database: Database): ReadonlyMap<string, string> {
  const rows = database.query<PendingRow, []>(`
    SELECT account_key, operation_id
      FROM main.reset_credit_cli_pending
     ORDER BY account_key
     LIMIT ${MAX_PENDING_OPERATIONS + 1}
  `).all();
  if (rows.length > MAX_PENDING_OPERATIONS) {
    throw new Error("Reset-credit retry state capacity is exhausted");
  }
  const pending = new Map<string, string>();
  const operationIds = new Set<string>();
  for (const row of rows) {
    if (
      typeof row.account_key !== "string"
      || !ACCOUNT_KEY_PATTERN.test(row.account_key)
      || typeof row.operation_id !== "string"
      || !isCodexResetCreditOperationId(row.operation_id)
      || pending.has(row.account_key)
      || operationIds.has(row.operation_id)
    ) {
      throw new Error("Reset-credit retry state is invalid");
    }
    pending.set(row.account_key, row.operation_id);
    operationIds.add(row.operation_id);
  }
  return pending;
}

function isThenable(value: unknown): boolean {
  return ((typeof value === "object" && value !== null) || typeof value === "function")
    && typeof (value as { then?: unknown }).then === "function";
}

type Synchronous<T> = T extends PromiseLike<unknown> ? never : T;

/**
 * Commit pending intent changes with SQLite FULL synchronous durability. Keeping
 * this state in the shared config-mutation database avoids the Windows rename
 * window where a directory entry can disappear after a power loss.
 */
function withPendingDatabase<T>(operation: (database: Database) => Synchronous<T>): T {
  const path = prepareConfigMutationDatabasePathForWrite();
  let database: Database | undefined;
  let transactionOpen = false;
  try {
    database = new Database(path, { create: true });
    try { chmodSync(path, 0o600); } catch { /* platform may ignore chmod */ }
    database.exec(
      "PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 0; PRAGMA synchronous = FULL; BEGIN IMMEDIATE",
    );
    transactionOpen = true;
    initializeConfigGeneration(database);
    assertCanonicalTable(database);
    const value = operation(database);
    if (isThenable(value) || !database.inTransaction) {
      throw new Error("Reset-credit retry state work escaped its synchronous transaction");
    }
    database.exec("COMMIT");
    transactionOpen = false;
    return value;
  } catch (error) {
    if (transactionOpen) {
      try { database?.exec("ROLLBACK"); } catch { /* close still releases the lock */ }
      transactionOpen = false;
    }
    throw error;
  } finally {
    try { database?.close(); } catch { /* operation already completed */ }
  }
}

export function reservePendingResetCreditOperation(accountId: string): string {
  const key = accountKey(accountId);
  return withPendingDatabase(database => {
    const pending = readAllPending(database);
    const existing = pending.get(key);
    if (existing) return existing;
    if (pending.size >= MAX_PENDING_OPERATIONS) {
      throw new Error("Reset-credit retry state capacity is exhausted");
    }
    const operationId = randomUUID();
    database.query(`
      INSERT INTO main.reset_credit_cli_pending (account_key, operation_id)
      VALUES (?, ?)
    `).run(key, operationId);
    const persisted = database.query<PendingRow, [string]>(`
      SELECT account_key, operation_id
        FROM main.reset_credit_cli_pending
       WHERE account_key = ?
       LIMIT 2
    `).all(key);
    if (
      persisted.length !== 1
      || persisted[0]?.account_key !== key
      || persisted[0]?.operation_id !== operationId
    ) {
      throw new Error("Reset-credit retry state could not be verified");
    }
    return operationId;
  });
}

export function clearPendingResetCreditOperation(accountId: string, operationId: string): boolean {
  const key = accountKey(accountId);
  return withPendingDatabase(database => {
    const pending = readAllPending(database);
    if (pending.get(key) !== operationId) return false;
    const result = database.query(`
      DELETE FROM main.reset_credit_cli_pending
       WHERE account_key = ? AND operation_id = ?
    `).run(key, operationId);
    if (result.changes !== 1) {
      throw new Error("Reset-credit retry state could not be cleared");
    }
    const persisted = database.query<{ count: unknown }, [string]>(`
      SELECT count(*) AS count
        FROM main.reset_credit_cli_pending
       WHERE account_key = ?
    `).get(key);
    if (persisted?.count !== 0) {
      throw new Error("Reset-credit retry state clear could not be verified");
    }
    return true;
  });
}
