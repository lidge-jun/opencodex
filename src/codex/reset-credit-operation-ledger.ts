import { createHash, randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { Database } from "bun:sqlite";
import { NestedConfigMutationError, prepareConfigMutationDatabasePathForWrite } from "../config";
import { initializeConfigGeneration } from "./generation";
import {
  compareCodexResetCreditRecoveryGenerationOrder,
  isCodexResetCreditOperationId,
  snapshotCodexResetCreditRecoveryGeneration,
  type CodexResetCreditConsumeCode,
  type CodexResetCreditRecoveryGeneration,
  type CodexReservedOperationId,
} from "./reset-credit-recovery";
import { isValidCodexAccountId, MAIN_CODEX_ACCOUNT_ID } from "./account-id";

export const MAX_RESET_CREDIT_OPERATION_ACCOUNTS = 128;
export const MAX_MANUAL_RESET_CREDIT_OPERATION_IDS = 4_096;
const MANUAL_RESET_CREDIT_HISTORY_HIGH_WATER_MARK = Math.ceil(
  MAX_MANUAL_RESET_CREDIT_OPERATION_IDS * 0.9,
);
let reportedManualHistoryLevel = 0;
type ResetCreditOperationMigrationFaultForTests = "after_first_write" | null;
let migrationFaultForTests: ResetCreditOperationMigrationFaultForTests = null;
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
type ResetCreditOperationKind = "recovery" | "manual";

type ResetCreditOperationRecord = Readonly<{
  accountKey: string;
  operationKind: ResetCreditOperationKind;
  credentialGeneration?: number;
  exhaustionGeneration?: number;
  operationId: string;
  joinedOperationId?: string;
  state: ResetCreditOperationState;
  code?: CodexResetCreditConsumeCode;
  createdAt: number;
  updatedAt: number;
}>;

type ResetCreditOperationRow = {
  account_key: unknown;
  operation_kind: unknown;
  credential_generation: unknown;
  exhaustion_generation: unknown;
  operation_id: unknown;
  joined_operation_id: unknown;
  state: unknown;
  code: unknown;
  created_at: unknown;
  updated_at: unknown;
};

type ManualResetCreditOperationIdRecord = Readonly<{
  operationId: string;
  accountKey: string;
  canonicalOperationId: string;
  terminalCode?: CodexResetCreditConsumeCode;
  createdAt: number;
  updatedAt: number;
}>;

type ManualResetCreditOperationIdRow = {
  operation_id: unknown;
  account_key: unknown;
  canonical_operation_id: unknown;
  terminal_code: unknown;
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

export type ManualResetCreditOperationIdentity = Readonly<{
  accountId: string;
  chatgptAccountId: string;
  operationId: string;
}>;

export type OpenManualResetCreditOperationResult =
  | Readonly<{ kind: "execute"; operationId: CodexReservedOperationId; resumed: boolean }>
  | Readonly<{ kind: "terminal"; operationId: CodexReservedOperationId; code: CodexResetCreditConsumeCode }>
  | Readonly<{ kind: "capacity" | "identity-mismatch" | "unavailable" }>;

const TABLE_NAME = "reset_credit_operations";
const CREATE_TABLE = `CREATE TABLE main.reset_credit_operations (
    account_key TEXT PRIMARY KEY,
    operation_kind TEXT NOT NULL CHECK (operation_kind IN ('recovery', 'manual')),
    credential_generation INTEGER,
    exhaustion_generation INTEGER,
    operation_id TEXT NOT NULL,
    joined_operation_id TEXT,
    state TEXT NOT NULL,
    code TEXT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    CHECK (
      (operation_kind = 'recovery'
        AND credential_generation IS NOT NULL AND credential_generation >= 0
        AND exhaustion_generation IS NOT NULL AND exhaustion_generation >= 0
        AND joined_operation_id IS NULL)
      OR
      (operation_kind = 'manual'
        AND credential_generation IS NULL AND exhaustion_generation IS NULL)
    ),
    CHECK (joined_operation_id IS NULL OR joined_operation_id <> operation_id)
  ) STRICT, WITHOUT ROWID`;
const EXPECTED_SCHEMA_SQL = CREATE_TABLE.replace("main.", "");
const MANUAL_ID_TABLE_NAME = "reset_credit_manual_operation_ids";
const CREATE_MANUAL_ID_TABLE = `CREATE TABLE main.reset_credit_manual_operation_ids (
    operation_id TEXT PRIMARY KEY,
    account_key TEXT NOT NULL,
    canonical_operation_id TEXT NOT NULL,
    terminal_code TEXT CHECK (
      terminal_code IS NULL OR terminal_code IN (
        'reset', 'already_redeemed', 'nothing_to_reset', 'no_credit'
      )
    ),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
  ) STRICT, WITHOUT ROWID`;
const EXPECTED_MANUAL_ID_SCHEMA_SQL = CREATE_MANUAL_ID_TABLE.replace("main.", "");
const PRIOR_TABLE_NAME = "reset_credit_operations_legacy_v2";
const PRIOR_CREATE_TABLE = `CREATE TABLE reset_credit_operations (
    account_key TEXT PRIMARY KEY,
    operation_kind TEXT NOT NULL CHECK (operation_kind IN ('recovery', 'manual')),
    credential_generation INTEGER,
    exhaustion_generation INTEGER,
    operation_id TEXT NOT NULL,
    state TEXT NOT NULL,
    code TEXT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    CHECK (
      (operation_kind = 'recovery'
        AND credential_generation IS NOT NULL AND credential_generation >= 0
        AND exhaustion_generation IS NOT NULL AND exhaustion_generation >= 0)
      OR
      (operation_kind = 'manual'
        AND credential_generation IS NULL AND exhaustion_generation IS NULL)
    )
  ) STRICT, WITHOUT ROWID`;
const LEGACY_TABLE_NAME = "reset_credit_operations_legacy_v1";
const LEGACY_CREATE_TABLE = `CREATE TABLE reset_credit_operations (
    account_key TEXT PRIMARY KEY,
    credential_generation INTEGER NOT NULL CHECK (credential_generation >= 0),
    exhaustion_generation INTEGER NOT NULL CHECK (exhaustion_generation >= 0),
    operation_id TEXT NOT NULL,
    state TEXT NOT NULL,
    code TEXT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
  ) STRICT, WITHOUT ROWID`;
const SELECT_ALL = `
  SELECT account_key, operation_kind, credential_generation,
         exhaustion_generation, operation_id, joined_operation_id,
         state, code, created_at, updated_at
    FROM main.reset_credit_operations
   ORDER BY account_key
   LIMIT ${MAX_RESET_CREDIT_OPERATION_ACCOUNTS + 1}`;
const SELECT_BY_KEY = `
  SELECT account_key, operation_kind, credential_generation,
         exhaustion_generation, operation_id, joined_operation_id,
         state, code, created_at, updated_at
    FROM main.reset_credit_operations
   WHERE account_key = ?
   LIMIT 2`;
const SELECT_KEY_BY_OPERATION_ID = `
  SELECT account_key FROM (
    SELECT account_key
      FROM main.reset_credit_operations
     WHERE operation_id = ? OR joined_operation_id = ?
    UNION
    SELECT account_key
      FROM main.reset_credit_manual_operation_ids
     WHERE operation_id = ?
  )
   LIMIT 2`;
const SELECT_ALL_MANUAL_IDS = `
  SELECT operation_id, account_key, canonical_operation_id,
         terminal_code, created_at, updated_at
    FROM main.reset_credit_manual_operation_ids
   ORDER BY operation_id
   LIMIT ${MAX_MANUAL_RESET_CREDIT_OPERATION_IDS + 1}`;
const SELECT_BOUNDED_MANUAL_ID_COUNT = `
  SELECT COUNT(*) AS count
    FROM (
      SELECT 1
        FROM main.reset_credit_manual_operation_ids
       LIMIT ${MAX_MANUAL_RESET_CREDIT_OPERATION_IDS + 1}
    )`;
const SELECT_DUPLICATE_RECOVERY_MANUAL_ID = `
  SELECT operations.operation_id
    FROM main.reset_credit_operations AS operations
    JOIN main.reset_credit_manual_operation_ids AS manual_ids
      ON manual_ids.operation_id = operations.operation_id
   WHERE operations.operation_kind = 'recovery'
   LIMIT 1`;
const SELECT_MANUAL_ID = `
  SELECT operation_id, account_key, canonical_operation_id,
         terminal_code, created_at, updated_at
    FROM main.reset_credit_manual_operation_ids
   WHERE operation_id = ?
   LIMIT 2`;
const SELECT_MANUAL_IDS_BY_CANONICAL = `
  SELECT operation_id, account_key, canonical_operation_id,
         terminal_code, created_at, updated_at
    FROM main.reset_credit_manual_operation_ids
   WHERE account_key = ? AND canonical_operation_id = ?
   ORDER BY operation_id
   LIMIT ${MAX_MANUAL_RESET_CREDIT_OPERATION_IDS + 1}`;
const INSERT_MANUAL_ID = `
  INSERT INTO main.reset_credit_manual_operation_ids (
    operation_id, account_key, canonical_operation_id,
    terminal_code, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?)`;
const SETTLE_MANUAL_IDS = `
  UPDATE main.reset_credit_manual_operation_ids
     SET terminal_code = ?, updated_at = ?
   WHERE account_key = ? AND canonical_operation_id = ?
     AND (terminal_code IS NULL OR terminal_code = ?)`;
const INSERT_RECORD = `
  INSERT INTO main.reset_credit_operations (
    account_key, operation_kind, credential_generation, exhaustion_generation,
    operation_id, joined_operation_id, state, code, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const REPLACE_RECORD = `
  UPDATE main.reset_credit_operations
     SET operation_kind = ?, credential_generation = ?, exhaustion_generation = ?,
         operation_id = ?, joined_operation_id = ?, state = ?, code = ?,
         created_at = ?, updated_at = ?
   WHERE account_key = ?`;
const UPDATE_RECORD = `
  UPDATE main.reset_credit_operations
     SET state = ?, code = ?, updated_at = ?
   WHERE account_key = ? AND operation_kind = ? AND operation_id = ?
     AND credential_generation IS ? AND exhaustion_generation IS ?`;
const JOIN_MANUAL_OPERATION = `
  UPDATE main.reset_credit_operations
     SET joined_operation_id = ?, updated_at = ?
   WHERE account_key = ? AND operation_kind = 'manual' AND operation_id = ?
     AND joined_operation_id IS NULL AND state IN ('pending', 'ambiguous')`;
const TOUCH_MANUAL_OPERATION = `
  UPDATE main.reset_credit_operations
     SET updated_at = ?
   WHERE account_key = ? AND operation_kind = 'manual' AND operation_id = ?
     AND joined_operation_id IS NOT NULL AND state IN ('pending', 'ambiguous')`;

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
  Object.freeze({ name: "operation_kind", type: "TEXT", notnull: 1, pk: 0 }),
  Object.freeze({ name: "credential_generation", type: "INTEGER", notnull: 0, pk: 0 }),
  Object.freeze({ name: "exhaustion_generation", type: "INTEGER", notnull: 0, pk: 0 }),
  Object.freeze({ name: "operation_id", type: "TEXT", notnull: 1, pk: 0 }),
  Object.freeze({ name: "joined_operation_id", type: "TEXT", notnull: 0, pk: 0 }),
  Object.freeze({ name: "state", type: "TEXT", notnull: 1, pk: 0 }),
  Object.freeze({ name: "code", type: "TEXT", notnull: 0, pk: 0 }),
  Object.freeze({ name: "created_at", type: "INTEGER", notnull: 1, pk: 0 }),
  Object.freeze({ name: "updated_at", type: "INTEGER", notnull: 1, pk: 0 }),
]);

const MANUAL_ID_COLUMNS = Object.freeze([
  Object.freeze({ name: "operation_id", type: "TEXT", notnull: 1, pk: 1 }),
  Object.freeze({ name: "account_key", type: "TEXT", notnull: 1, pk: 0 }),
  Object.freeze({ name: "canonical_operation_id", type: "TEXT", notnull: 1, pk: 0 }),
  Object.freeze({ name: "terminal_code", type: "TEXT", notnull: 0, pk: 0 }),
  Object.freeze({ name: "created_at", type: "INTEGER", notnull: 1, pk: 0 }),
  Object.freeze({ name: "updated_at", type: "INTEGER", notnull: 1, pk: 0 }),
]);

const LEGACY_COLUMNS = Object.freeze([
  Object.freeze({ name: "account_key", type: "TEXT", notnull: 1, pk: 1 }),
  Object.freeze({ name: "credential_generation", type: "INTEGER", notnull: 1, pk: 0 }),
  Object.freeze({ name: "exhaustion_generation", type: "INTEGER", notnull: 1, pk: 0 }),
  Object.freeze({ name: "operation_id", type: "TEXT", notnull: 1, pk: 0 }),
  Object.freeze({ name: "state", type: "TEXT", notnull: 1, pk: 0 }),
  Object.freeze({ name: "code", type: "TEXT", notnull: 0, pk: 0 }),
  Object.freeze({ name: "created_at", type: "INTEGER", notnull: 1, pk: 0 }),
  Object.freeze({ name: "updated_at", type: "INTEGER", notnull: 1, pk: 0 }),
]);
const PRIOR_COLUMNS = Object.freeze([
  Object.freeze({ name: "account_key", type: "TEXT", notnull: 1, pk: 1 }),
  Object.freeze({ name: "operation_kind", type: "TEXT", notnull: 1, pk: 0 }),
  Object.freeze({ name: "credential_generation", type: "INTEGER", notnull: 0, pk: 0 }),
  Object.freeze({ name: "exhaustion_generation", type: "INTEGER", notnull: 0, pk: 0 }),
  Object.freeze({ name: "operation_id", type: "TEXT", notnull: 1, pk: 0 }),
  Object.freeze({ name: "state", type: "TEXT", notnull: 1, pk: 0 }),
  Object.freeze({ name: "code", type: "TEXT", notnull: 0, pk: 0 }),
  Object.freeze({ name: "created_at", type: "INTEGER", notnull: 1, pk: 0 }),
  Object.freeze({ name: "updated_at", type: "INTEGER", notnull: 1, pk: 0 }),
]);

function accountKey(accountId: string): string {
  return createHash("sha256").update(`codex-reset-credit-operation\0${accountId}`).digest("hex");
}

function validateManualAccountId(accountId: string): void {
  if (accountId !== MAIN_CODEX_ACCOUNT_ID && !isValidCodexAccountId(accountId)) {
    throw new TypeError("invalid manual reset-credit account");
  }
}

function manualPhysicalAccountKey(chatgptAccountId: string): string {
  const normalized = chatgptAccountId.trim();
  if (!normalized) throw new TypeError("invalid manual reset-credit credential identity");
  return createHash("sha256")
    .update(`codex-reset-credit-manual-physical\0${normalized}`)
    .digest("hex");
}

function isGenerationNumber(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function parseRecord(row: ResetCreditOperationRow | null): ResetCreditOperationRecord | undefined {
  if (!row) return undefined;
  const state = row.state;
  const code = row.code;
  const joinedOperationId = row.joined_operation_id;
  if (typeof row.account_key !== "string" || !ACCOUNT_KEY_PATTERN.test(row.account_key)
    || (row.operation_kind !== "recovery" && row.operation_kind !== "manual")
    || !isCodexResetCreditOperationId(row.operation_id)
    || (joinedOperationId !== null
      && (!isCodexResetCreditOperationId(joinedOperationId) || joinedOperationId === row.operation_id))
    || typeof state !== "string" || !STATES.has(state)
    || !isGenerationNumber(row.created_at)
    || !isGenerationNumber(row.updated_at)
    || row.updated_at < row.created_at) {
    return undefined;
  }
  const recovery = row.operation_kind === "recovery";
  const manual = row.operation_kind === "manual";
  if (recovery !== (isGenerationNumber(row.credential_generation)
      && isGenerationNumber(row.exhaustion_generation))
    || manual !== (row.credential_generation === null
      && row.exhaustion_generation === null)
    || (recovery && joinedOperationId !== null)) {
    return undefined;
  }
  const terminal = state === "confirmed" || state === "stopped";
  if (!terminal && code !== null) return undefined;
  const terminalState = typeof code === "string"
    && Object.prototype.hasOwnProperty.call(TERMINAL_STATE_BY_CODE, code)
    ? TERMINAL_STATE_BY_CODE[code as CodexResetCreditConsumeCode]
    : undefined;
  if (terminal !== (terminalState !== undefined)) return undefined;
  if (terminal && state !== terminalState) return undefined;
  return Object.freeze({
    accountKey: row.account_key,
    operationKind: row.operation_kind,
    ...(recovery
      ? {
          credentialGeneration: row.credential_generation as number,
          exhaustionGeneration: row.exhaustion_generation as number,
        }
      : {}),
    operationId: row.operation_id,
    ...(joinedOperationId === null ? {} : { joinedOperationId }),
    state: state as ResetCreditOperationState,
    ...(terminal ? { code: code as CodexResetCreditConsumeCode } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function parseManualIdRecord(
  row: ManualResetCreditOperationIdRow | null,
): ManualResetCreditOperationIdRecord | undefined {
  if (!row) return undefined;
  const terminalCode = row.terminal_code;
  if (!isCodexResetCreditOperationId(row.operation_id)
    || typeof row.account_key !== "string" || !ACCOUNT_KEY_PATTERN.test(row.account_key)
    || !isCodexResetCreditOperationId(row.canonical_operation_id)
    || (terminalCode !== null
      && (typeof terminalCode !== "string"
        || !Object.prototype.hasOwnProperty.call(TERMINAL_STATE_BY_CODE, terminalCode)))
    || !isGenerationNumber(row.created_at)
    || !isGenerationNumber(row.updated_at)
    || row.updated_at < row.created_at) {
    return undefined;
  }
  return Object.freeze({
    operationId: row.operation_id,
    accountKey: row.account_key,
    canonicalOperationId: row.canonical_operation_id,
    ...(terminalCode === null ? {} : { terminalCode: terminalCode as CodexResetCreditConsumeCode }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function assertColumnLayout(
  database: Database,
  tableName: string,
  expectedColumns: readonly Readonly<{ name: string; type: string; notnull: number; pk: number }>[],
): void {
  const tableRows = database.query<TableListRow, []>("PRAGMA main.table_list").all()
    .filter(row => row.name === tableName);
  if (tableRows.length !== 1) throw new Error("invalid reset-credit operation ledger table");
  const table = tableRows[0]!;
  if (table.schema !== "main" || table.type !== "table" || table.ncol !== expectedColumns.length
    || table.wr !== 1 || table.strict !== 1) {
    throw new Error("invalid reset-credit operation ledger table");
  }
  const columns = database.query<TableColumnRow, []>(
    `PRAGMA main.table_xinfo(${tableName})`,
  ).all();
  if (columns.length !== expectedColumns.length) {
    throw new Error("invalid reset-credit operation ledger columns");
  }
  for (let index = 0; index < expectedColumns.length; index += 1) {
    const actual = columns[index]!;
    const expected = expectedColumns[index]!;
    if (actual.cid !== index || actual.name !== expected.name || actual.type !== expected.type
      || actual.notnull !== expected.notnull || actual.dflt_value !== null
      || actual.pk !== expected.pk || actual.hidden !== 0) {
      throw new Error("invalid reset-credit operation ledger columns");
    }
  }
}

function assertNoLedgerTriggers(database: Database, tableName: string): void {
  const mainTrigger = database.query<{ name: unknown }, [string]>(`
    SELECT name FROM main.sqlite_schema
     WHERE type = 'trigger' AND tbl_name = ? COLLATE NOCASE LIMIT 1
  `).get(tableName);
  const tempTrigger = database.query<{ name: unknown }, [string]>(`
    SELECT name FROM temp.sqlite_schema
     WHERE type = 'trigger' AND tbl_name = ? COLLATE NOCASE LIMIT 1
  `).get(tableName);
  if (mainTrigger || tempTrigger) throw new Error("reset-credit operation ledger triggers are forbidden");
}

function failMigrationAfterFirstWriteForTests(): void {
  if (migrationFaultForTests === "after_first_write") {
    throw new Error("synthetic reset-credit operation migration failure");
  }
}

/** @internal Test-only fault injection after the first transactional migration write. */
export function setResetCreditOperationMigrationFaultForTests(
  fault: ResetCreditOperationMigrationFaultForTests,
): void {
  if (process.env.OCX_TEST_HOME_GUARD !== "1") {
    throw new Error("reset-credit operation migration faults require the repository test preload");
  }
  migrationFaultForTests = fault;
}

function migrateLegacyTable(database: Database): void {
  assertColumnLayout(database, TABLE_NAME, LEGACY_COLUMNS);
  assertNoLedgerTriggers(database, TABLE_NAME);
  const legacyRows = database.query<{
    account_key: unknown;
    credential_generation: unknown;
    exhaustion_generation: unknown;
    operation_id: unknown;
    state: unknown;
    code: unknown;
    created_at: unknown;
    updated_at: unknown;
  }, []>(`
    SELECT account_key, credential_generation, exhaustion_generation, operation_id,
           state, code, created_at, updated_at
      FROM main.reset_credit_operations
     ORDER BY account_key
     LIMIT ${MAX_RESET_CREDIT_OPERATION_ACCOUNTS + 1}
  `).all();
  if (legacyRows.length > MAX_RESET_CREDIT_OPERATION_ACCOUNTS) {
    throw new Error("invalid reset-credit operation ledger capacity");
  }
  const keys = new Set<string>();
  const operations = new Set<string>();
  for (const row of legacyRows) {
    const record = parseRecord({
      ...row,
      operation_kind: "recovery",
      joined_operation_id: null,
    });
    if (!record || keys.has(record.accountKey) || operations.has(record.operationId)) {
      throw new Error("invalid reset-credit operation ledger state");
    }
    keys.add(record.accountKey);
    operations.add(record.operationId);
  }
  database.exec(`ALTER TABLE main.${TABLE_NAME} RENAME TO ${LEGACY_TABLE_NAME}`);
  failMigrationAfterFirstWriteForTests();
  database.exec(CREATE_TABLE);
  database.exec(`
    INSERT INTO main.${TABLE_NAME} (
      account_key, operation_kind, credential_generation, exhaustion_generation,
      operation_id, joined_operation_id, state, code, created_at, updated_at
    )
    SELECT account_key, 'recovery', credential_generation, exhaustion_generation,
           operation_id, NULL, state, code, created_at, updated_at
      FROM main.${LEGACY_TABLE_NAME}
  `);
  database.exec(`DROP TABLE main.${LEGACY_TABLE_NAME}`);
}

function migratePriorTable(database: Database): void {
  assertColumnLayout(database, TABLE_NAME, PRIOR_COLUMNS);
  assertNoLedgerTriggers(database, TABLE_NAME);
  const priorRows = database.query<Omit<ResetCreditOperationRow, "joined_operation_id">, []>(`
    SELECT account_key, operation_kind, credential_generation, exhaustion_generation,
           operation_id, state, code, created_at, updated_at
      FROM main.reset_credit_operations
     ORDER BY account_key
     LIMIT ${MAX_RESET_CREDIT_OPERATION_ACCOUNTS + 1}
  `).all();
  if (priorRows.length > MAX_RESET_CREDIT_OPERATION_ACCOUNTS) {
    throw new Error("invalid reset-credit operation ledger capacity");
  }
  const keys = new Set<string>();
  const operations = new Set<string>();
  for (const row of priorRows) {
    const record = parseRecord({ ...row, joined_operation_id: null });
    if (!record || keys.has(record.accountKey) || operations.has(record.operationId)) {
      throw new Error("invalid reset-credit operation ledger state");
    }
    keys.add(record.accountKey);
    operations.add(record.operationId);
  }
  database.exec(`ALTER TABLE main.${TABLE_NAME} RENAME TO ${PRIOR_TABLE_NAME}`);
  failMigrationAfterFirstWriteForTests();
  database.exec(CREATE_TABLE);
  database.exec(`
    INSERT INTO main.${TABLE_NAME} (
      account_key, operation_kind, credential_generation, exhaustion_generation,
      operation_id, joined_operation_id, state, code, created_at, updated_at
    )
    SELECT account_key, operation_kind, credential_generation, exhaustion_generation,
           operation_id, NULL, state, code, created_at, updated_at
      FROM main.${PRIOR_TABLE_NAME}
  `);
  database.exec(`DROP TABLE main.${PRIOR_TABLE_NAME}`);
}

function isExactLegacySchema(database: Database, schema: SchemaObjectRow): boolean {
  if (schema.type !== "table" || schema.name !== TABLE_NAME || schema.tbl_name !== TABLE_NAME
    || schema.sql !== LEGACY_CREATE_TABLE) return false;
  try {
    assertColumnLayout(database, TABLE_NAME, LEGACY_COLUMNS);
    assertNoLedgerTriggers(database, TABLE_NAME);
    return true;
  } catch {
    return false;
  }
}

function isExactPriorSchema(database: Database, schema: SchemaObjectRow): boolean {
  if (schema.type !== "table" || schema.name !== TABLE_NAME || schema.tbl_name !== TABLE_NAME
    || schema.sql !== PRIOR_CREATE_TABLE) return false;
  try {
    assertColumnLayout(database, TABLE_NAME, PRIOR_COLUMNS);
    assertNoLedgerTriggers(database, TABLE_NAME);
    return true;
  } catch {
    return false;
  }
}

type PrimaryTableInitialization = "created" | "migrated" | "existing";

function assertCanonicalTable(database: Database): PrimaryTableInitialization {
  const schemaRows = database.query<SchemaObjectRow, [string, string]>(`
    SELECT type, name, tbl_name, sql
      FROM main.sqlite_schema
     WHERE name = ? COLLATE NOCASE OR tbl_name = ? COLLATE NOCASE
     ORDER BY type, name
     LIMIT 4
  `).all(TABLE_NAME, TABLE_NAME);
  let initialization: PrimaryTableInitialization;
  if (schemaRows.length === 0) {
    database.exec(CREATE_TABLE);
    initialization = "created";
  } else if (schemaRows.length === 1 && isExactLegacySchema(database, schemaRows[0]!)) {
    migrateLegacyTable(database);
    initialization = "migrated";
  } else if (schemaRows.length === 1 && isExactPriorSchema(database, schemaRows[0]!)) {
    migratePriorTable(database);
    initialization = "migrated";
  } else if (schemaRows.length !== 1
    || schemaRows[0]?.type !== "table"
    || schemaRows[0]?.name !== TABLE_NAME
    || schemaRows[0]?.tbl_name !== TABLE_NAME
    || schemaRows[0]?.sql !== EXPECTED_SCHEMA_SQL) {
    throw new Error("invalid reset-credit operation ledger schema");
  } else {
    initialization = "existing";
  }
  assertColumnLayout(database, TABLE_NAME, EXPECTED_COLUMNS);
  assertNoLedgerTriggers(database, TABLE_NAME);
  return initialization;
}

function ensureManualIdTable(database: Database, allowCreate: boolean): boolean {
  const schemaRows = database.query<SchemaObjectRow, [string, string]>(`
    SELECT type, name, tbl_name, sql
      FROM main.sqlite_schema
     WHERE name = ? COLLATE NOCASE OR tbl_name = ? COLLATE NOCASE
     ORDER BY type, name
     LIMIT 4
  `).all(MANUAL_ID_TABLE_NAME, MANUAL_ID_TABLE_NAME);
  let created = false;
  if (schemaRows.length === 0) {
    if (!allowCreate) {
      throw new Error("missing manual reset-credit operation identity schema");
    }
    database.exec(CREATE_MANUAL_ID_TABLE);
    created = true;
  } else if (schemaRows.length !== 1
    || schemaRows[0]?.type !== "table"
    || schemaRows[0]?.name !== MANUAL_ID_TABLE_NAME
    || schemaRows[0]?.tbl_name !== MANUAL_ID_TABLE_NAME
    || schemaRows[0]?.sql !== EXPECTED_MANUAL_ID_SCHEMA_SQL) {
    throw new Error("invalid manual reset-credit operation identity schema");
  }
  assertColumnLayout(database, MANUAL_ID_TABLE_NAME, MANUAL_ID_COLUMNS);
  assertNoLedgerTriggers(database, MANUAL_ID_TABLE_NAME);
  return created;
}

function initializeTable(
  database: Database,
  validationScope: ResetCreditOperationKind,
): Readonly<{
  recordCount: number;
  manualIdCount: number;
}> {
  const manualSchemaPresentBefore = database.query<{ present: number }, [string, string]>(`
    SELECT 1 AS present
      FROM main.sqlite_schema
     WHERE name = ? COLLATE NOCASE OR tbl_name = ? COLLATE NOCASE
     LIMIT 1
  `).get(MANUAL_ID_TABLE_NAME, MANUAL_ID_TABLE_NAME) !== null;
  const primaryInitialization = assertCanonicalTable(database);
  if (primaryInitialization !== "existing" && manualSchemaPresentBefore) {
    throw new Error("invalid partial reset-credit operation ledger schema");
  }
  const rows = database.query<ResetCreditOperationRow, []>(SELECT_ALL).all();
  if (rows.length > MAX_RESET_CREDIT_OPERATION_ACCOUNTS) {
    throw new Error("invalid reset-credit operation ledger capacity");
  }
  const accountKeys = new Set<string>();
  const operationIds = new Set<string>();
  const records = new Map<string, ResetCreditOperationRecord>();
  for (const row of rows) {
    const record = parseRecord(row);
    const ids = record ? [record.operationId, ...(record.joinedOperationId ? [record.joinedOperationId] : [])] : [];
    if (!record || accountKeys.has(record.accountKey) || ids.some(id => operationIds.has(id))) {
      throw new Error("invalid reset-credit operation ledger state");
    }
    accountKeys.add(record.accountKey);
    records.set(record.accountKey, record);
    for (const id of ids) operationIds.add(id);
  }

  const manualTableCreated = ensureManualIdTable(database, primaryInitialization !== "existing");
  if (manualTableCreated) {
    for (const record of records.values()) {
      if (record.operationKind !== "manual") continue;
      const ids = [record.operationId, ...(record.joinedOperationId ? [record.joinedOperationId] : [])];
      for (const operationId of ids) {
        insertManualIdRecord(database, Object.freeze({
          operationId,
          accountKey: record.accountKey,
          canonicalOperationId: record.operationId,
          ...(record.code === undefined ? {} : { terminalCode: record.code }),
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        }));
      }
    }
  }

  const manualIdCount = database.query<{ count: unknown }, []>(SELECT_BOUNDED_MANUAL_ID_COUNT)
    .get()?.count;
  if (typeof manualIdCount !== "number" || !Number.isSafeInteger(manualIdCount) || manualIdCount < 0
    || manualIdCount > MAX_MANUAL_RESET_CREDIT_OPERATION_IDS) {
    throw new Error("invalid manual reset-credit operation identity capacity");
  }
  if (validationScope === "recovery") {
    if (database.query<{ operation_id: unknown }, []>(SELECT_DUPLICATE_RECOVERY_MANUAL_ID).get()) {
      throw new Error("duplicate reset-credit operation ids");
    }
    return Object.freeze({ recordCount: rows.length, manualIdCount });
  }

  const manualRows = database.query<ManualResetCreditOperationIdRow, []>(SELECT_ALL_MANUAL_IDS).all();
  if (manualRows.length !== manualIdCount) throw new Error("invalid manual reset-credit operation identity state");
  const manualIds = new Map<string, ManualResetCreditOperationIdRecord>();
  for (const row of manualRows) {
    const record = parseManualIdRecord(row);
    if (!record || manualIds.has(record.operationId)) {
      throw new Error("invalid manual reset-credit operation identity state");
    }
    manualIds.set(record.operationId, record);
  }
  for (const record of manualIds.values()) {
    const canonical = manualIds.get(record.canonicalOperationId);
    if (!canonical || canonical.operationId !== canonical.canonicalOperationId
      || canonical.accountKey !== record.accountKey
      || canonical.terminalCode !== record.terminalCode) {
      throw new Error("invalid manual reset-credit operation identity state");
    }
    if (record.terminalCode === undefined) {
      const current = records.get(record.accountKey);
      if (!current || current.operationKind !== "manual" || isTerminal(current)
        || current.operationId !== record.canonicalOperationId) {
        throw new Error("invalid manual reset-credit operation identity state");
      }
    }
  }
  for (const record of records.values()) {
    if (record.operationKind === "recovery") {
      if (manualIds.has(record.operationId)) {
        throw new Error("duplicate reset-credit operation ids");
      }
      continue;
    }
    const expectedIds = [record.operationId, ...(record.joinedOperationId ? [record.joinedOperationId] : [])];
    for (const operationId of expectedIds) {
      const identity = manualIds.get(operationId);
      if (!identity || identity.accountKey !== record.accountKey
        || identity.canonicalOperationId !== record.operationId
        || identity.terminalCode !== record.code) {
        throw new Error("invalid manual reset-credit operation identity state");
      }
    }
  }
  return Object.freeze({ recordCount: rows.length, manualIdCount });
}

function readRecord(database: Database, key: string): ResetCreditOperationRecord | undefined {
  const rows = database.query<ResetCreditOperationRow, [string]>(SELECT_BY_KEY).all(key);
  if (rows.length > 1) throw new Error("duplicate reset-credit operation records");
  const row = rows[0];
  const record = parseRecord(row ?? null);
  if (row && !record) throw new Error("invalid reset-credit operation record");
  return record;
}

function readManualIdRecord(
  database: Database,
  operationId: string,
): ManualResetCreditOperationIdRecord | undefined {
  const rows = database.query<ManualResetCreditOperationIdRow, [string]>(SELECT_MANUAL_ID)
    .all(operationId);
  if (rows.length > 1) throw new Error("duplicate manual reset-credit operation ids");
  const row = rows[0];
  const record = parseManualIdRecord(row ?? null);
  if (row && !record) throw new Error("invalid manual reset-credit operation identity");
  return record;
}

function sameManualIdRecord(
  left: ManualResetCreditOperationIdRecord,
  right: ManualResetCreditOperationIdRecord,
): boolean {
  return left.operationId === right.operationId
    && left.accountKey === right.accountKey
    && left.canonicalOperationId === right.canonicalOperationId
    && left.terminalCode === right.terminalCode
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt;
}

function assertStoredManualIdRecord(
  database: Database,
  expected: ManualResetCreditOperationIdRecord,
): void {
  const stored = readManualIdRecord(database, expected.operationId);
  if (!stored || !sameManualIdRecord(stored, expected)) {
    throw new Error("manual reset-credit operation identity write did not persist");
  }
}

function insertManualIdRecord(
  database: Database,
  record: ManualResetCreditOperationIdRecord,
): void {
  const result = database.query(INSERT_MANUAL_ID).run(
    record.operationId,
    record.accountKey,
    record.canonicalOperationId,
    record.terminalCode ?? null,
    record.createdAt,
    record.updatedAt,
  );
  if (result.changes !== 1) throw new Error("manual reset-credit operation identity insert failed");
  assertStoredManualIdRecord(database, record);
}

function operationOwner(database: Database, operationId: string): string | undefined {
  const rows = database.query<{ account_key: unknown }, [string, string, string]>(SELECT_KEY_BY_OPERATION_ID)
    .all(operationId, operationId, operationId);
  if (rows.length > 1) throw new Error("duplicate reset-credit operation ids");
  const owner = rows[0]?.account_key;
  if (owner !== undefined && (typeof owner !== "string" || !ACCOUNT_KEY_PATTERN.test(owner))) {
    throw new Error("invalid reset-credit operation owner");
  }
  return owner;
}

function sameRecord(left: ResetCreditOperationRecord, right: ResetCreditOperationRecord): boolean {
  return left.accountKey === right.accountKey
    && left.operationKind === right.operationKind
    && left.credentialGeneration === right.credentialGeneration
    && left.exhaustionGeneration === right.exhaustionGeneration
    && left.operationId === right.operationId
    && left.joinedOperationId === right.joinedOperationId
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
    credentialGeneration: record.credentialGeneration!,
    exhaustionGeneration: record.exhaustionGeneration!,
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

function withLedger<T>(validationScope: ResetCreditOperationKind, operation: (
  database: Database,
  recordCount: number,
  manualIdCount: number,
) => Synchronous<T>): T {
  const path = prepareConfigMutationDatabasePathForWrite();
  let database: Database | undefined;
  let transactionOpen = false;
  try {
    database = new Database(path, { create: true });
    try { chmodSync(path, 0o600); } catch { /* platform may ignore chmod */ }
    database.exec("PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 0; PRAGMA synchronous = FULL; BEGIN IMMEDIATE");
    transactionOpen = true;
    initializeConfigGeneration(database);
    const counts = initializeTable(database, validationScope);
    const value = operation(database, counts.recordCount, counts.manualIdCount);
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
  const nested = error instanceof NestedConfigMutationError;
  // Native SQLite and filesystem errors may contain absolute, account-bearing
  // paths. Keep this warning categorical rather than forwarding error.message.
  console.warn(nested
    ? "[opencodex] Reset-credit operation ledger refused a nested config mutation."
    : "[opencodex] Reset-credit operation ledger is unavailable.");
}

function reportManualHistoryCapacity(count: number): void {
  const level = count >= MAX_MANUAL_RESET_CREDIT_OPERATION_IDS
    ? MAX_MANUAL_RESET_CREDIT_OPERATION_IDS
    : count >= MANUAL_RESET_CREDIT_HISTORY_HIGH_WATER_MARK
      ? MANUAL_RESET_CREDIT_HISTORY_HIGH_WATER_MARK
      : 0;
  if (level === 0 || level <= reportedManualHistoryLevel) return;
  reportedManualHistoryLevel = level;
  try {
    console.warn(
      `[opencodex] Reset-credit manual operation history is at ${count}/${MAX_MANUAL_RESET_CREDIT_OPERATION_IDS} entries${
        level === MAX_MANUAL_RESET_CREDIT_OPERATION_IDS
          ? "; new manual operation IDs, including aliases, are disabled until a maintainer expands capacity or applies an approved retirement policy."
          : "."
      }`,
    );
  } catch {
    // Count-only operational reporting must never weaken the fail-closed result.
  }
}

/**
 * Throws `TypeError` for a malformed generation or timestamp. Runtime storage
 * and contention failures are represented by a result kind.
 */
export function openResetCreditOperation(
  generation: CodexResetCreditRecoveryGeneration,
  now = Date.now(),
): OpenResetCreditOperationResult {
  const generationSnapshot = snapshotCodexResetCreditRecoveryGeneration(generation);
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("invalid reset-credit operation timestamp");
  try {
    return withLedger("recovery", (database, recordCount) => {
      const key = accountKey(generationSnapshot.accountId);
      const current = readRecord(database, key);
      if (current) {
        if (current.operationKind !== "recovery") {
          return Object.freeze({ kind: "unresolved-prior-generation" as const });
        }
        const comparison = compareGeneration(current, generationSnapshot);
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
      if (operationOwner(database, operationId) !== undefined) {
        throw new Error("duplicate reset-credit operation ids");
      }
      const values = [
        "recovery",
        generationSnapshot.credentialGeneration,
        generationSnapshot.exhaustionGeneration,
        operationId,
        null,
        "pending",
        null,
        now,
        now,
      ] as const;
      const result = current
        ? database.query(REPLACE_RECORD).run(...values, key)
        : database.query(INSERT_RECORD).run(key, ...values);
      if (result.changes !== 1) throw new Error("reset-credit operation reservation lost ownership");
      assertStoredRecord(database, Object.freeze({
        accountKey: key,
        operationKind: "recovery",
        credentialGeneration: generationSnapshot.credentialGeneration,
        exhaustionGeneration: generationSnapshot.exhaustionGeneration,
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
  owner: Readonly<{
    accountKey: string;
    operationKind: ResetCreditOperationKind;
    credentialGeneration?: number;
    exhaustionGeneration?: number;
  }>,
  operationId: string,
  update: (record: ResetCreditOperationRecord) => ResetCreditOperationRecord | undefined,
  afterWrite?: (database: Database, updated: ResetCreditOperationRecord) => void,
): UpdateResetCreditOperationResult {
  if (!isCodexResetCreditOperationId(operationId)) return Object.freeze({ kind: "mismatch" });
  try {
    return withLedger(owner.operationKind, database => {
      const current = readRecord(database, owner.accountKey);
      if (!current
        || current.operationKind !== owner.operationKind
        || current.credentialGeneration !== owner.credentialGeneration
        || current.exhaustionGeneration !== owner.exhaustionGeneration
        || current.operationId !== operationId) {
        return Object.freeze({ kind: "mismatch" as const });
      }
      const updated = update(current);
      if (!updated) return Object.freeze({ kind: "mismatch" as const });
      const result = database.query(UPDATE_RECORD).run(
        updated.state,
        updated.code ?? null,
        updated.updatedAt,
        owner.accountKey,
        owner.operationKind,
        operationId,
        owner.credentialGeneration ?? null,
        owner.exhaustionGeneration ?? null,
      );
      if (result.changes !== 1) throw new Error("reset-credit operation update lost ownership");
      assertStoredRecord(database, updated);
      afterWrite?.(database, updated);
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
  const generationSnapshot = snapshotCodexResetCreditRecoveryGeneration(generation);
  return updateOperation({
    accountKey: accountKey(generationSnapshot.accountId),
    operationKind: "recovery",
    credentialGeneration: generationSnapshot.credentialGeneration,
    exhaustionGeneration: generationSnapshot.exhaustionGeneration,
  }, operationId, record => {
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
  const generationSnapshot = snapshotCodexResetCreditRecoveryGeneration(generation);
  return updateOperation({
    accountKey: accountKey(generationSnapshot.accountId),
    operationKind: "recovery",
    credentialGeneration: generationSnapshot.credentialGeneration,
    exhaustionGeneration: generationSnapshot.exhaustionGeneration,
  }, operationId, record => {
    if (isTerminal(record)) return record.code === code ? record : undefined;
    return Object.freeze({
      ...record,
      state: TERMINAL_STATE_BY_CODE[code],
      code,
      updatedAt: Math.max(record.updatedAt, now),
    });
  });
}

function snapshotManualIdentity(identity: ManualResetCreditOperationIdentity): {
  accountKey: string;
  operationId: string;
} {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    throw new TypeError("manual reset-credit identity must be an object");
  }
  const value = identity as unknown as Record<string, unknown>;
  const hasOwn = Object.prototype.hasOwnProperty;
  if (!hasOwn.call(value, "accountId")
    || !hasOwn.call(value, "chatgptAccountId")
    || !hasOwn.call(value, "operationId")) {
    throw new TypeError("manual reset-credit identity fields must be own properties");
  }
  const accountId = value.accountId;
  const chatgptAccountId = value.chatgptAccountId;
  const operationId = value.operationId;
  if (!isCodexResetCreditOperationId(operationId)) {
    throw new TypeError("invalid manual reset-credit operation id");
  }
  if (typeof accountId !== "string") throw new TypeError("invalid manual reset-credit account");
  validateManualAccountId(accountId);
  if (typeof chatgptAccountId !== "string") {
    throw new TypeError("invalid manual reset-credit credential identity");
  }
  return Object.freeze({
    accountKey: manualPhysicalAccountKey(chatgptAccountId),
    operationId,
  });
}

/**
 * Reserve or restore one explicit manual redemption intent.
 *
 * Throws `TypeError` for malformed identity fields or `now`; these are caller
 * contract violations. Durable-state and runtime failures return a result kind.
 */
export function openManualResetCreditOperation(
  identity: ManualResetCreditOperationIdentity,
  now = Date.now(),
): OpenManualResetCreditOperationResult {
  const owner = snapshotManualIdentity(identity);
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("invalid reset-credit operation timestamp");
  try {
    return withLedger("manual", (database, recordCount, manualIdCount) => {
      reportManualHistoryCapacity(manualIdCount);
      const admitNewCallerId = () => {
        if (manualIdCount >= MAX_MANUAL_RESET_CREDIT_OPERATION_IDS) {
          return Object.freeze({ kind: "capacity" as const });
        }
        const existingOwner = operationOwner(database, owner.operationId);
        if (existingOwner !== undefined) {
          return Object.freeze({
            kind: existingOwner === owner.accountKey ? "unavailable" as const : "identity-mismatch" as const,
          });
        }
        return undefined;
      };

      const reserve = (replaceCurrent: boolean): OpenManualResetCreditOperationResult => {
        const rejected = admitNewCallerId();
        if (rejected) return rejected;

        const record: ResetCreditOperationRecord = Object.freeze({
          accountKey: owner.accountKey,
          operationKind: "manual",
          operationId: owner.operationId,
          state: "pending",
          createdAt: now,
          updatedAt: now,
        });
        const values = [
          "manual",
          null,
          null,
          owner.operationId,
          null,
          "pending",
          null,
          now,
          now,
        ] as const;
        const result = replaceCurrent
          ? database.query(REPLACE_RECORD).run(...values, owner.accountKey)
          : database.query(INSERT_RECORD).run(owner.accountKey, ...values);
        if (result.changes !== 1) throw new Error("manual reset-credit reservation lost ownership");
        assertStoredRecord(database, record);
        insertManualIdRecord(database, Object.freeze({
          operationId: owner.operationId,
          accountKey: owner.accountKey,
          canonicalOperationId: owner.operationId,
          createdAt: now,
          updatedAt: now,
        }));
        return Object.freeze({
          kind: "execute" as const,
          operationId: owner.operationId as CodexReservedOperationId,
          resumed: false,
        });
      };

      const knownIdentity = readManualIdRecord(database, owner.operationId);
      if (knownIdentity) {
        if (knownIdentity.accountKey !== owner.accountKey) {
          return Object.freeze({ kind: "identity-mismatch" as const });
        }
        if (knownIdentity.terminalCode !== undefined) {
          return Object.freeze({
            kind: "terminal" as const,
            operationId: knownIdentity.canonicalOperationId as CodexReservedOperationId,
            code: knownIdentity.terminalCode,
          });
        }
        const current = readRecord(database, owner.accountKey);
        if (!current || current.operationKind !== "manual" || isTerminal(current)
          || current.operationId !== knownIdentity.canonicalOperationId) {
          throw new Error("manual reset-credit operation identity lost its active owner");
        }
        return Object.freeze({
          kind: "execute" as const,
          operationId: current.operationId as CodexReservedOperationId,
          resumed: true,
        });
      }

      const current = readRecord(database, owner.accountKey);
      if (current) {
        if (current.operationKind !== "manual") {
          return Object.freeze({ kind: "unavailable" as const });
        }
        if (!isTerminal(current)) {
          const rejected = admitNewCallerId();
          if (rejected) return rejected;
          insertManualIdRecord(database, Object.freeze({
            operationId: owner.operationId,
            accountKey: owner.accountKey,
            canonicalOperationId: current.operationId,
            createdAt: now,
            updatedAt: now,
          }));
          const joined: ResetCreditOperationRecord = Object.freeze({
            ...current,
            ...(current.joinedOperationId === undefined
              ? { joinedOperationId: owner.operationId }
              : {}),
            updatedAt: Math.max(current.updatedAt, now),
          });
          const result = current.joinedOperationId === undefined
            ? database.query(JOIN_MANUAL_OPERATION).run(
                owner.operationId,
                joined.updatedAt,
                owner.accountKey,
                current.operationId,
              )
            : database.query(TOUCH_MANUAL_OPERATION).run(
                joined.updatedAt,
                owner.accountKey,
                current.operationId,
              );
          if (result.changes !== 1) {
            throw new Error("manual reset-credit join lost ownership");
          }
          assertStoredRecord(database, joined);
          // The upstream request keeps the original durable id. Every caller id
          // is retained in the identity history; the first alias is also kept on
          // the current row for compatibility with the previous schema.
          return Object.freeze({
            kind: "execute" as const,
            operationId: current.operationId as CodexReservedOperationId,
            resumed: true,
          });
        }
        // Deliberate: a distinct caller id after a settled intent represents a
        // new explicit redemption. Prior ids remain immutable in the history,
        // so a delayed retry can never be reclassified as this new intent.
        return reserve(true);
      }
      if (recordCount >= MAX_RESET_CREDIT_OPERATION_ACCOUNTS) {
        return Object.freeze({ kind: "capacity" as const });
      }
      return reserve(false);
    });
  } catch (error) {
    warnLedgerUnavailable(error);
    return Object.freeze({ kind: "unavailable" });
  }
}

/**
 * Mark a reserved manual redemption as ambiguous.
 *
 * Throws `TypeError` for malformed identity fields or `now`. A missing or
 * incompatible durable record returns the existing result kind.
 */
export function markManualResetCreditOperationAmbiguous(
  identity: ManualResetCreditOperationIdentity,
  now = Date.now(),
): UpdateResetCreditOperationResult {
  const owner = snapshotManualIdentity(identity);
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("invalid reset-credit operation timestamp");
  return updateOperation({ accountKey: owner.accountKey, operationKind: "manual" }, owner.operationId, record => {
    if (isTerminal(record)) return undefined;
    return Object.freeze({ ...record, state: "ambiguous", code: undefined, updatedAt: Math.max(record.updatedAt, now) });
  });
}

/**
 * Settle a reserved manual redemption with one terminal consume code.
 *
 * Throws `TypeError` for malformed identity fields or `now`; an unsupported
 * code or incompatible durable record returns `mismatch`.
 */
export function settleManualResetCreditOperation(
  identity: ManualResetCreditOperationIdentity,
  code: CodexResetCreditConsumeCode,
  now = Date.now(),
): UpdateResetCreditOperationResult {
  const owner = snapshotManualIdentity(identity);
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("invalid reset-credit operation timestamp");
  if (!Object.prototype.hasOwnProperty.call(TERMINAL_STATE_BY_CODE, code)) {
    return Object.freeze({ kind: "mismatch" });
  }
  return updateOperation({ accountKey: owner.accountKey, operationKind: "manual" }, owner.operationId, record => {
    if (isTerminal(record)) return record.code === code ? record : undefined;
    return Object.freeze({
      ...record,
      state: TERMINAL_STATE_BY_CODE[code],
      code,
      updatedAt: Math.max(record.updatedAt, now),
    });
  }, (database, updated) => {
    const result = database.query(SETTLE_MANUAL_IDS).run(
      code,
      updated.updatedAt,
      owner.accountKey,
      owner.operationId,
      code,
    );
    if (result.changes < 1) {
      throw new Error("manual reset-credit terminal identity update lost ownership");
    }
    const rows = database.query<ManualResetCreditOperationIdRow, [string, string]>(
      SELECT_MANUAL_IDS_BY_CANONICAL,
    ).all(owner.accountKey, owner.operationId);
    if (rows.length < 1 || rows.length > MAX_MANUAL_RESET_CREDIT_OPERATION_IDS) {
      throw new Error("invalid manual reset-credit terminal identity set");
    }
    for (const row of rows) {
      const stored = parseManualIdRecord(row);
      if (!stored || stored.accountKey !== owner.accountKey
        || stored.canonicalOperationId !== owner.operationId
        || stored.terminalCode !== code
        || stored.updatedAt !== updated.updatedAt) {
        throw new Error("manual reset-credit terminal identity write did not persist");
      }
    }
  });
}
