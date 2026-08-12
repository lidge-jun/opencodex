import { createHash, randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { Database } from "bun:sqlite";
import { prepareConfigMutationDatabasePathForWrite } from "../config";
import { initializeConfigGeneration } from "./generation";
import {
  compareCodexResetCreditRecoveryGenerationOrder,
  isCodexResetCreditOperationId,
  type CodexResetCreditConsumeCode,
  type CodexResetCreditRecoveryGeneration,
  type CodexReservedOperationId,
} from "./reset-credit-recovery";
import { isValidCodexAccountId } from "./account-id";

export const MAX_RESET_CREDIT_OPERATION_ACCOUNTS = 128;
const ACCOUNT_KEY_PATTERN = /^[0-9a-f]{64}$/;
const TERMINAL_STATE_BY_CODE: Readonly<Record<
  CodexResetCreditConsumeCode,
  "confirmed" | "stopped"
>> = Object.freeze({
  reset: "confirmed",
  already_redeemed: "confirmed",
  nothing_to_reset: "stopped",
  no_credit: "stopped",
});
const STATES: ReadonlySet<string> = new Set(["pending", "ambiguous", "confirmed", "stopped"]);

type ResetCreditOperationState = "pending" | "ambiguous" | "confirmed" | "stopped";

type ResetCreditOperationRecord = Readonly<{
  accountKey: string;
  credentialGeneration: number;
  exhaustionGeneration: number;
  operationId: string;
  state: ResetCreditOperationState;
  code?: CodexResetCreditConsumeCode;
  createdAt: number;
  updatedAt: number;
}>;

type ResetCreditOperationRow = {
  account_key: unknown;
  credential_generation: unknown;
  exhaustion_generation: unknown;
  operation_id: unknown;
  state: unknown;
  code: unknown;
  created_at: unknown;
  updated_at: unknown;
};

export type OpenResetCreditOperationResult =
  | Readonly<{ kind: "execute"; operationId: CodexReservedOperationId; resumed: boolean }>
  | Readonly<{ kind: "terminal"; operationId: CodexReservedOperationId; code: CodexResetCreditConsumeCode }>
  | Readonly<{ kind: "stale-generation" | "unresolved-prior-generation" | "capacity" | "unavailable" }>;

export type UpdateResetCreditOperationResult =
  | Readonly<{ kind: "updated" }>
  | Readonly<{ kind: "mismatch" | "unavailable" }>;

const TABLE_NAME = "reset_credit_operations";
const CREATE_TABLE = `CREATE TABLE main.reset_credit_operations (
    account_key TEXT PRIMARY KEY,
    credential_generation INTEGER NOT NULL CHECK (credential_generation >= 0),
    exhaustion_generation INTEGER NOT NULL CHECK (exhaustion_generation >= 0),
    operation_id TEXT NOT NULL,
    state TEXT NOT NULL,
    code TEXT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
  ) STRICT, WITHOUT ROWID`;
const EXPECTED_SCHEMA_SQL = CREATE_TABLE.replace("main.", "");
export const RESET_CREDIT_OPERATION_SCHEMA_SQL_FOR_TESTS = EXPECTED_SCHEMA_SQL;
const SELECT_ALL = `
  SELECT account_key, credential_generation, exhaustion_generation, operation_id,
         state, code, created_at, updated_at
    FROM main.reset_credit_operations
   ORDER BY account_key
   LIMIT ${MAX_RESET_CREDIT_OPERATION_ACCOUNTS + 1}`;
const SELECT_BY_KEY = `
  SELECT account_key, credential_generation, exhaustion_generation, operation_id,
         state, code, created_at, updated_at
    FROM main.reset_credit_operations
   WHERE account_key = ?
   LIMIT 2`;
const INSERT_RECORD = `
  INSERT INTO main.reset_credit_operations (
    account_key, credential_generation, exhaustion_generation, operation_id,
    state, code, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
const REPLACE_RECORD = `
  UPDATE main.reset_credit_operations
     SET credential_generation = ?, exhaustion_generation = ?, operation_id = ?,
         state = ?, code = ?, created_at = ?, updated_at = ?
   WHERE account_key = ?`;
const UPDATE_RECORD = `
  UPDATE main.reset_credit_operations
     SET state = ?, code = ?, updated_at = ?
   WHERE account_key = ? AND credential_generation = ?
     AND exhaustion_generation = ? AND operation_id = ?`;

type SchemaObjectRow = {
  type: unknown;
  name: unknown;
  tbl_name: unknown;
  sql: unknown;
};

type TableListRow = {
  schema: unknown;
  name: unknown;
  type: unknown;
  ncol: unknown;
  wr: unknown;
  strict: unknown;
};

type TableColumnRow = {
  cid: unknown;
  name: unknown;
  type: unknown;
  notnull: unknown;
  dflt_value: unknown;
  pk: unknown;
  hidden: unknown;
};

const EXPECTED_COLUMNS = Object.freeze([
  Object.freeze({ name: "account_key", type: "TEXT", notnull: 1, pk: 1 }),
  Object.freeze({ name: "credential_generation", type: "INTEGER", notnull: 1, pk: 0 }),
  Object.freeze({ name: "exhaustion_generation", type: "INTEGER", notnull: 1, pk: 0 }),
  Object.freeze({ name: "operation_id", type: "TEXT", notnull: 1, pk: 0 }),
  Object.freeze({ name: "state", type: "TEXT", notnull: 1, pk: 0 }),
  Object.freeze({ name: "code", type: "TEXT", notnull: 0, pk: 0 }),
  Object.freeze({ name: "created_at", type: "INTEGER", notnull: 1, pk: 0 }),
  Object.freeze({ name: "updated_at", type: "INTEGER", notnull: 1, pk: 0 }),
]);

function accountKey(accountId: string): string {
  return createHash("sha256").update(`codex-reset-credit-operation\0${accountId}`).digest("hex");
}

function isGenerationNumber(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validateGeneration(generation: CodexResetCreditRecoveryGeneration): void {
  if (!isValidCodexAccountId(generation.accountId)
    || !isGenerationNumber(generation.credentialGeneration)
    || !isGenerationNumber(generation.exhaustionGeneration)) {
    throw new TypeError("invalid reset-credit recovery generation");
  }
}

function parseRecord(row: ResetCreditOperationRow | null): ResetCreditOperationRecord | undefined {
  if (!row) return undefined;
  const state = row.state;
  const code = row.code;
  if (typeof row.account_key !== "string" || !ACCOUNT_KEY_PATTERN.test(row.account_key)
    || !isGenerationNumber(row.credential_generation)
    || !isGenerationNumber(row.exhaustion_generation)
    || !isCodexResetCreditOperationId(row.operation_id)
    || typeof state !== "string" || !STATES.has(state)
    || !isGenerationNumber(row.created_at)
    || !isGenerationNumber(row.updated_at)
    || row.updated_at < row.created_at) {
    return undefined;
  }
  const terminal = state === "confirmed" || state === "stopped";
  const terminalState = typeof code === "string"
    && Object.prototype.hasOwnProperty.call(TERMINAL_STATE_BY_CODE, code)
    ? TERMINAL_STATE_BY_CODE[code as CodexResetCreditConsumeCode]
    : undefined;
  if (terminal !== (terminalState !== undefined)) return undefined;
  if (terminal && state !== terminalState) return undefined;
  return Object.freeze({
    accountKey: row.account_key,
    credentialGeneration: row.credential_generation,
    exhaustionGeneration: row.exhaustion_generation,
    operationId: row.operation_id,
    state: state as ResetCreditOperationState,
    ...(terminal ? { code: code as CodexResetCreditConsumeCode } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function assertCanonicalTable(database: Database): void {
  const schemaRows = database.query<SchemaObjectRow, [string, string]>(`
    SELECT type, name, tbl_name, sql
      FROM main.sqlite_schema
     WHERE name = ? COLLATE NOCASE OR tbl_name = ? COLLATE NOCASE
     ORDER BY type, name
     LIMIT 4
  `).all(TABLE_NAME, TABLE_NAME);
  if (schemaRows.length === 0) {
    database.exec(CREATE_TABLE);
  } else if (schemaRows.length !== 1
    || schemaRows[0]?.type !== "table"
    || schemaRows[0]?.name !== TABLE_NAME
    || schemaRows[0]?.tbl_name !== TABLE_NAME
    || schemaRows[0]?.sql !== EXPECTED_SCHEMA_SQL) {
    throw new Error("invalid reset-credit operation ledger schema");
  }

  const tableRows = database.query<TableListRow, []>("PRAGMA main.table_list").all()
    .filter(row => row.name === TABLE_NAME);
  if (tableRows.length !== 1) throw new Error("invalid reset-credit operation ledger table");
  const table = tableRows[0]!;
  if (table.schema !== "main" || table.type !== "table" || table.ncol !== EXPECTED_COLUMNS.length
    || table.wr !== 1 || table.strict !== 1) {
    throw new Error("invalid reset-credit operation ledger table");
  }

  const columns = database.query<TableColumnRow, []>(
    `PRAGMA main.table_xinfo(${TABLE_NAME})`,
  ).all();
  if (columns.length !== EXPECTED_COLUMNS.length) {
    throw new Error("invalid reset-credit operation ledger columns");
  }
  for (let index = 0; index < EXPECTED_COLUMNS.length; index += 1) {
    const actual = columns[index]!;
    const expected = EXPECTED_COLUMNS[index]!;
    if (actual.cid !== index || actual.name !== expected.name || actual.type !== expected.type
      || actual.notnull !== expected.notnull || actual.dflt_value !== null
      || actual.pk !== expected.pk || actual.hidden !== 0) {
      throw new Error("invalid reset-credit operation ledger columns");
    }
  }

  const mainTrigger = database.query<{ name: unknown }, [string]>(`
    SELECT name FROM main.sqlite_schema
     WHERE type = 'trigger' AND tbl_name = ? COLLATE NOCASE LIMIT 1
  `).get(TABLE_NAME);
  const tempTrigger = database.query<{ name: unknown }, [string]>(`
    SELECT name FROM temp.sqlite_schema
     WHERE type = 'trigger' AND tbl_name = ? COLLATE NOCASE LIMIT 1
  `).get(TABLE_NAME);
  if (mainTrigger || tempTrigger) throw new Error("reset-credit operation ledger triggers are forbidden");
}

function initializeTable(database: Database): number {
  assertCanonicalTable(database);
  const rows = database.query<ResetCreditOperationRow, []>(SELECT_ALL).all();
  if (rows.length > MAX_RESET_CREDIT_OPERATION_ACCOUNTS) {
    throw new Error("invalid reset-credit operation ledger capacity");
  }
  const accountKeys = new Set<string>();
  const operationIds = new Set<string>();
  for (const row of rows) {
    const record = parseRecord(row);
    if (!record || accountKeys.has(record.accountKey) || operationIds.has(record.operationId)) {
      throw new Error("invalid reset-credit operation ledger state");
    }
    accountKeys.add(record.accountKey);
    operationIds.add(record.operationId);
  }
  return rows.length;
}

function readRecord(database: Database, key: string): ResetCreditOperationRecord | undefined {
  const rows = database.query<ResetCreditOperationRow, [string]>(SELECT_BY_KEY).all(key);
  if (rows.length > 1) throw new Error("duplicate reset-credit operation records");
  const row = rows[0];
  const record = parseRecord(row ?? null);
  if (row && !record) throw new Error("invalid reset-credit operation record");
  return record;
}

function sameRecord(left: ResetCreditOperationRecord, right: ResetCreditOperationRecord): boolean {
  return left.accountKey === right.accountKey
    && left.credentialGeneration === right.credentialGeneration
    && left.exhaustionGeneration === right.exhaustionGeneration
    && left.operationId === right.operationId
    && left.state === right.state
    && left.code === right.code
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt;
}

function assertStoredRecord(
  database: Database,
  expected: ResetCreditOperationRecord,
): void {
  const stored = readRecord(database, expected.accountKey);
  if (!stored || !sameRecord(stored, expected)) {
    throw new Error("reset-credit operation write did not persist the expected record");
  }
}

function compareGeneration(
  record: ResetCreditOperationRecord,
  generation: CodexResetCreditRecoveryGeneration,
): -1 | 0 | 1 {
  return compareCodexResetCreditRecoveryGenerationOrder({
    accountId: generation.accountId,
    credentialGeneration: record.credentialGeneration,
    exhaustionGeneration: record.exhaustionGeneration,
  }, generation);
}

function isTerminal(record: ResetCreditOperationRecord): boolean {
  return record.state === "confirmed" || record.state === "stopped";
}

function isThenable(value: unknown): boolean {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? typeof (value as { then?: unknown }).then === "function"
    : false;
}

type Synchronous<T> = T extends PromiseLike<unknown> ? never : T;

function withLedger<T>(operation: (database: Database, recordCount: number) => Synchronous<T>): T {
  const path = prepareConfigMutationDatabasePathForWrite();
  let database: Database | undefined;
  let transactionOpen = false;
  try {
    database = new Database(path, { create: true });
    try { chmodSync(path, 0o600); } catch { /* platform may ignore chmod */ }
    database.exec("PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 0; PRAGMA synchronous = FULL; BEGIN IMMEDIATE");
    transactionOpen = true;
    initializeConfigGeneration(database);
    const recordCount = initializeTable(database);
    const value = operation(database, recordCount);
    if (isThenable(value) || !database.inTransaction) {
      throw new Error("reset-credit operation ledger work escaped its synchronous transaction");
    }
    database.exec("COMMIT");
    transactionOpen = false;
    return value;
  } catch (error) {
    if (transactionOpen) {
      try { database?.exec("ROLLBACK"); } catch { /* close still releases the write lock */ }
      transactionOpen = false;
    }
    throw error;
  } finally {
    try { database?.close(); } catch { /* operation already completed */ }
  }
}

function isLedgerBusyError(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  const message = error instanceof Error ? error.message : "";
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED"
    || /database (?:is|table is) locked/i.test(message);
}

function warnLedgerUnavailable(error: unknown): void {
  if (isLedgerBusyError(error)) return;
  const nested = error instanceof Error
    && error.message === "prepareConfigMutationDatabasePathForWrite must not run inside withConfigMutationLockSync";
  console.warn(nested
    ? "[opencodex] Reset-credit operation ledger refused a nested config mutation."
    : "[opencodex] Reset-credit operation ledger is unavailable.");
}

/**
 * Throws `TypeError` for a malformed generation or timestamp. Runtime storage
 * and contention failures are represented by a result kind.
 */
export function openResetCreditOperation(
  generation: CodexResetCreditRecoveryGeneration,
  now = Date.now(),
): OpenResetCreditOperationResult {
  validateGeneration(generation);
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("invalid reset-credit operation timestamp");
  try {
    return withLedger((database, recordCount) => {
      const key = accountKey(generation.accountId);
      const current = readRecord(database, key);
      if (current) {
        const comparison = compareGeneration(current, generation);
        if (comparison > 0) return Object.freeze({ kind: "stale-generation" as const });
        if (comparison === 0) {
          if (isTerminal(current)) {
            return Object.freeze({
              kind: "terminal" as const,
              operationId: current.operationId as CodexReservedOperationId,
              code: current.code!,
            });
          }
          return Object.freeze({
            kind: "execute" as const,
            operationId: current.operationId as CodexReservedOperationId,
            resumed: true,
          });
        }
        if (!isTerminal(current)) return Object.freeze({ kind: "unresolved-prior-generation" as const });
      } else if (recordCount >= MAX_RESET_CREDIT_OPERATION_ACCOUNTS) {
        return Object.freeze({ kind: "capacity" as const });
      }

      const operationId = randomUUID();
      if (!isCodexResetCreditOperationId(operationId)) throw new Error("runtime generated invalid UUID");
      const values = [
        generation.credentialGeneration,
        generation.exhaustionGeneration,
        operationId,
        "pending",
        null,
        now,
        now,
        key,
      ] as const;
      const result = current
        ? database.query(REPLACE_RECORD).run(...values)
        : database.query(INSERT_RECORD).run(key, ...values.slice(0, 7));
      if (result.changes !== 1) throw new Error("reset-credit operation reservation lost ownership");
      assertStoredRecord(database, Object.freeze({
        accountKey: key,
        credentialGeneration: generation.credentialGeneration,
        exhaustionGeneration: generation.exhaustionGeneration,
        operationId,
        state: "pending",
        createdAt: now,
        updatedAt: now,
      }));
      return Object.freeze({
        kind: "execute" as const,
        operationId: operationId as CodexReservedOperationId,
        resumed: false,
      });
    });
  } catch (error) {
    warnLedgerUnavailable(error);
    return Object.freeze({ kind: "unavailable" });
  }
}

function updateOperation(
  generation: CodexResetCreditRecoveryGeneration,
  operationId: string,
  update: (record: ResetCreditOperationRecord) => ResetCreditOperationRecord | undefined,
): UpdateResetCreditOperationResult {
  validateGeneration(generation);
  if (!isCodexResetCreditOperationId(operationId)) return Object.freeze({ kind: "mismatch" });
  try {
    return withLedger(database => {
      const key = accountKey(generation.accountId);
      const current = readRecord(database, key);
      if (!current
        || compareGeneration(current, generation) !== 0
        || current.operationId !== operationId) {
        return Object.freeze({ kind: "mismatch" as const });
      }
      const updated = update(current);
      if (!updated) return Object.freeze({ kind: "mismatch" as const });
      const result = database.query(UPDATE_RECORD).run(
        updated.state,
        updated.code ?? null,
        updated.updatedAt,
        key,
        generation.credentialGeneration,
        generation.exhaustionGeneration,
        operationId,
      );
      if (result.changes !== 1) throw new Error("reset-credit operation update lost ownership");
      assertStoredRecord(database, updated);
      return Object.freeze({ kind: "updated" as const });
    });
  } catch (error) {
    warnLedgerUnavailable(error);
    return Object.freeze({ kind: "unavailable" });
  }
}

/**
 * Throws `TypeError` for a malformed generation or timestamp. An invalid
 * operation id returns `mismatch`; runtime storage failures return `unavailable`.
 */
export function markResetCreditOperationAmbiguous(
  generation: CodexResetCreditRecoveryGeneration,
  operationId: string,
  now = Date.now(),
): UpdateResetCreditOperationResult {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("invalid reset-credit operation timestamp");
  return updateOperation(generation, operationId, record => {
    if (isTerminal(record)) return undefined;
    return Object.freeze({
      ...record,
      state: "ambiguous",
      code: undefined,
      updatedAt: Math.max(record.updatedAt, now),
    });
  });
}

/**
 * Throws `TypeError` for a malformed generation or timestamp. An invalid
 * operation id or non-terminal code returns `mismatch`; runtime storage
 * failures return `unavailable`.
 */
export function settleResetCreditOperation(
  generation: CodexResetCreditRecoveryGeneration,
  operationId: string,
  code: CodexResetCreditConsumeCode,
  now = Date.now(),
): UpdateResetCreditOperationResult {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("invalid reset-credit operation timestamp");
  if (!Object.prototype.hasOwnProperty.call(TERMINAL_STATE_BY_CODE, code)) {
    return Object.freeze({ kind: "mismatch" });
  }
  return updateOperation(generation, operationId, record => {
    if (isTerminal(record)) return record.code === code ? record : undefined;
    return Object.freeze({
      ...record,
      state: TERMINAL_STATE_BY_CODE[code],
      code,
      updatedAt: Math.max(record.updatedAt, now),
    });
  });
}
