/**
 * CODEX_HOME-keyed transition state and coordinator transaction ownership.
 *
 * The original JSON read/compare/replace was called a CAS while native and
 * history writers held different locks. It was not one: an old Worker could
 * replace N+1 with stale N. This module owns the SQLite row, the conditional
 * UPDATE, and the opaque one-shot capability backed by an already-open
 * `BEGIN IMMEDIATE` transaction.
 *
 * Design record: devlog/_fin/260804_codex_write_substrate/005_contract.md §1.
 */
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { Database } from "bun:sqlite";

import type {
  BeginCodexTransition,
  CodexCoordinatorTransaction,
  CodexCoordinatorTransactionController,
  CodexHistoryState,
  CodexTransitionState,
  CodexTransitionVersion,
  CommitExpectation,
  ReadCodexTransitionState,
  TransitionStateRead,
  TransitionStateUpdate,
  UpdateCodexHistoryTransition,
} from "./convergence-types";
import { resolveCodexHomeDir } from "./home";
import { readIntegrationRecord } from "./integration-record";
import { classifyNativeRoutedResidue } from "./native-residue";
import {
  CodexUserIdentityRefusal,
  resolveCodexCoordinatorDatabasePath,
  resolveEffectiveUserIdentity,
  samePathIdentity,
} from "./user-identity";

export const CODEX_COORDINATOR_SCHEMA_VERSION = 1;
const DURABLE_HISTORY_STATUSES = new Set(["adoption-pending", "converged", "pending", "running", "blocked", "unknown"]);
const DURABLE_HISTORY_REASONS = new Set([
  "db-busy",
  "permission",
  "unreadable",
  "schema",
  "timeout",
  "shutdown-cancelled",
  "worker-died",
  "overtaken",
  "record-write-failed",
]);

const CREATE_TRANSITION_TABLE = `
  CREATE TABLE IF NOT EXISTS codex_transition_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    native_generation INTEGER NOT NULL CHECK (native_generation >= 0),
    current_tx_id TEXT,
    history_status TEXT NOT NULL,
    history_reason TEXT,
    history_attempts INTEGER NOT NULL CHECK (history_attempts >= 0),
    history_next_retry_at TEXT,
    history_tx_id TEXT,
    history_direction TEXT CHECK (history_direction IN ('apply', 'remove')),
    history_authority_snapshot_id TEXT,
    history_pending_rows INTEGER,
    history_backup_entries INTEGER,
    updated_at TEXT NOT NULL,
    CHECK (history_status IN ('adoption-pending', 'converged', 'pending', 'running', 'blocked', 'unknown')),
    CHECK (history_reason IS NULL OR history_reason IN
      ('db-busy', 'permission', 'unreadable', 'schema', 'timeout',
       'shutdown-cancelled', 'worker-died', 'overtaken', 'record-write-failed')),
    CHECK (history_pending_rows IS NULL OR history_pending_rows >= 0),
    CHECK (history_backup_entries IS NULL OR history_backup_entries >= 0),
    CHECK ((native_generation = 0 AND current_tx_id IS NULL)
        OR (native_generation > 0 AND length(trim(current_tx_id)) > 0)),
    CHECK ((native_generation = 0
            AND history_status = 'unknown'
            AND history_tx_id IS NULL
            AND history_direction IS NULL
            AND history_authority_snapshot_id IS NULL)
        OR (native_generation = 0
            AND history_status = 'adoption-pending'
            AND length(trim(history_tx_id)) > 0
            AND history_direction IS NOT NULL
            AND length(trim(history_authority_snapshot_id)) > 0)
        OR (native_generation > 0
            AND history_tx_id = current_tx_id
            AND history_direction IS NOT NULL
            AND length(trim(history_authority_snapshot_id)) > 0)),
    CHECK (native_generation > 0 OR history_status = 'adoption-pending' OR
      (history_status = 'unknown'
       AND history_reason IS NULL
       AND history_attempts = 0
       AND history_next_retry_at IS NULL
       AND history_pending_rows IS NULL
       AND history_backup_entries IS NULL))
  )`;

const INITIALIZE_TRANSITION_ROW = `
  INSERT OR IGNORE INTO codex_transition_state (
    singleton, native_generation, current_tx_id,
    history_status, history_reason, history_attempts,
    history_next_retry_at, history_tx_id, history_direction,
    history_authority_snapshot_id, history_pending_rows,
    history_backup_entries, updated_at
  ) VALUES (1, 0, NULL, 'unknown', NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, ?)`;

const INITIALIZE_ADOPTION_ROW = `
  INSERT INTO codex_transition_state (
    singleton, native_generation, current_tx_id,
    history_status, history_reason, history_attempts,
    history_next_retry_at, history_tx_id, history_direction,
    history_authority_snapshot_id, history_pending_rows,
    history_backup_entries, updated_at
  ) VALUES (1, 0, NULL, 'adoption-pending', NULL, 0, NULL, ?, ?, ?, NULL, NULL, ?)`;

const SELECT_TRANSITION_ROW = `
  SELECT native_generation, current_tx_id,
         history_status, history_reason, history_attempts,
         history_next_retry_at, history_tx_id, history_direction,
         history_authority_snapshot_id, history_pending_rows,
         history_backup_entries
    FROM codex_transition_state
   WHERE singleton = 1`;

const BEGIN_TRANSITION = `
  UPDATE codex_transition_state
     SET native_generation = ?, current_tx_id = ?,
         history_status = 'pending', history_reason = NULL,
         history_attempts = 0, history_next_retry_at = ?, history_tx_id = ?,
         history_direction = ?, history_authority_snapshot_id = ?,
         history_pending_rows = NULL, history_backup_entries = NULL,
         updated_at = ?
   WHERE singleton = 1
     AND native_generation = ?
     AND current_tx_id IS ?`;

const UPDATE_HISTORY = `
  UPDATE codex_transition_state
     SET history_status = ?, history_reason = ?, history_attempts = ?,
         history_next_retry_at = ?, history_tx_id = ?,
         history_pending_rows = ?, history_backup_entries = ?, updated_at = ?
   WHERE singleton = 1
     AND native_generation = ?
     AND current_tx_id IS ?
     AND history_tx_id IS ?
     AND (native_generation = 0 OR history_direction IS NOT NULL)`;

interface TransitionRow {
  native_generation: unknown;
  current_tx_id: unknown;
  history_status: unknown;
  history_reason: unknown;
  history_attempts: unknown;
  history_next_retry_at: unknown;
  history_tx_id: unknown;
  history_direction: unknown;
  history_authority_snapshot_id: unknown;
  history_pending_rows: unknown;
  history_backup_entries: unknown;
}

const codexCoordinatorTransactionBrand: unique symbol = Symbol("CodexCoordinatorTransaction");

interface BrandedCodexCoordinatorTransaction extends CodexCoordinatorTransaction {
  readonly [codexCoordinatorTransactionBrand]: true;
}

export class CodexCoordinatorTransactionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexCoordinatorTransactionError";
  }
}

class CodexCoordinatorLegacyAmbiguousError extends CodexCoordinatorTransactionError {
  constructor(message: string) {
    super(message);
    this.name = "CodexCoordinatorLegacyAmbiguousError";
  }
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
}

function isBusy(error: unknown): boolean {
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || /database (?:is|table is) locked/i.test(message);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function nullableCount(value: unknown): value is number | null {
  return value === null || isNonNegativeInteger(value);
}

function rowToState(row: TransitionRow | null): CodexTransitionState {
  if (!row) throw new CodexCoordinatorTransactionError("The coordinator transition row is missing.");
  if (!isNonNegativeInteger(row.native_generation)
    || !nullableString(row.current_tx_id)
    || typeof row.history_status !== "string"
    || !DURABLE_HISTORY_STATUSES.has(row.history_status)
    || !nullableString(row.history_reason)
    || (row.history_reason !== null && !DURABLE_HISTORY_REASONS.has(row.history_reason))
    || !isNonNegativeInteger(row.history_attempts)
    || !nullableString(row.history_next_retry_at)
    || !nullableString(row.history_tx_id)
    || !nullableString(row.history_direction)
    || !nullableString(row.history_authority_snapshot_id)
    || !nullableCount(row.history_pending_rows)
    || !nullableCount(row.history_backup_entries)) {
    throw new CodexCoordinatorTransactionError("The coordinator transition row is malformed.");
  }

  const generation = row.native_generation;
  if (generation === 0) {
    const ordinaryInitial = row.history_status === "unknown"
      && row.history_tx_id === null
      && row.history_direction === null
      && row.history_authority_snapshot_id === null;
    const adoptionInitial = row.history_status === "adoption-pending"
      && Boolean(row.history_tx_id?.trim())
      && (row.history_direction === "apply" || row.history_direction === "remove")
      && Boolean(row.history_authority_snapshot_id?.trim());
    if (row.current_tx_id !== null || (!ordinaryInitial && !adoptionInitial)) {
      throw new CodexCoordinatorTransactionError("The initial coordinator row contains transition metadata.");
    }
  } else if (!row.current_tx_id?.trim()
    || row.history_tx_id !== row.current_tx_id
    || (row.history_direction !== "apply" && row.history_direction !== "remove")
    || !row.history_authority_snapshot_id?.trim()) {
    throw new CodexCoordinatorTransactionError("The positive coordinator row lacks its complete history schedule.");
  }

  const history: CodexHistoryState = {
    status: row.history_status as Exclude<CodexHistoryState["status"], "not-evaluated">,
    attempts: row.history_attempts,
    nextRetryAt: row.history_next_retry_at,
    txId: row.history_tx_id,
    pendingRows: row.history_pending_rows,
    backupEntries: row.history_backup_entries,
    ...(row.history_reason === null ? {} : { reason: row.history_reason as NonNullable<CodexHistoryState["reason"]> }),
  };
  return {
    nativeGeneration: generation,
    currentTxId: row.current_tx_id,
    history,
    historySchedule: generation === 0 && row.history_status !== "adoption-pending" ? null : {
      direction: row.history_direction as "apply" | "remove",
      authoritySnapshotId: row.history_authority_snapshot_id as string,
    },
  };
}

export type CodexCoordinatorAdoptionCheckpoint = "temp-created" | "temp-committed" | "published";

export interface CodexCoordinatorAdoptionOptions {
  readonly direction: "apply" | "remove";
  readonly onCheckpoint?: (checkpoint: CodexCoordinatorAdoptionCheckpoint) => void;
}

function fsyncFile(path: string): void {
  // Writable fd on purpose. Windows FlushFileBuffers needs GENERIC_WRITE;
  // openSync(path, "r") is GENERIC_READ only and fails with EPERM (measured on
  // Windows 11 25H2 / bun 1.3.14). prompt-journal.ts uses the same "r+" open.
  const fd = openSync(path, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function fsyncDir(path: string): void {
  // POSIX directory fsync is O_RDONLY. O_RDWR ("r+") is EISDIR.
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function publishAdoptionDatabase(
  finalDatabasePath: string,
  options: CodexCoordinatorAdoptionOptions,
): void {
  const parent = dirname(finalDatabasePath);
  const tempPath = join(parent, `.${basename(finalDatabasePath)}.adopt-${process.pid}-${randomUUID()}.tmp`);
  let tempPresent = false;
  try {
    const fd = openSync(tempPath, "wx", 0o600);
    closeSync(fd);
    tempPresent = true;
    options.onCheckpoint?.("temp-created");

    const temp = new Database(tempPath, { readwrite: true, create: false });
    try {
      temp.exec("PRAGMA journal_mode = DELETE; BEGIN IMMEDIATE");
      temp.exec(CREATE_TRANSITION_TABLE);
      temp.query(INITIALIZE_ADOPTION_ROW).run(
        randomUUID(),
        options.direction,
        randomUUID(),
        new Date().toISOString(),
      );
      temp.exec(`PRAGMA user_version = ${CODEX_COORDINATOR_SCHEMA_VERSION}; COMMIT`);
      readCodexCoordinatorState(temp);
    } catch (error) {
      try { temp.exec("ROLLBACK"); } catch { /* commit may already have completed */ }
      throw error;
    } finally {
      temp.close();
    }
    fsyncFile(tempPath);
    options.onCheckpoint?.("temp-committed");

    linkSync(tempPath, finalDatabasePath);
    options.onCheckpoint?.("published");
    if (process.platform !== "win32") fsyncDir(parent);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  } finally {
    if (tempPresent) {
      try { unlinkSync(tempPath); } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    }
  }
}

export function readCodexCoordinatorState(database: Database): CodexTransitionState {
  const row = database.query<TransitionRow, []>(SELECT_TRANSITION_ROW).get();
  return rowToState(row);
}

function validateHistoryWrite(expected: CodexTransitionVersion, history: CodexHistoryState): void {
  if (history.status === "not-evaluated" || !DURABLE_HISTORY_STATUSES.has(history.status)) {
    throw new CodexCoordinatorTransactionError("Ephemeral history state cannot be persisted.");
  }
  if (!isNonNegativeInteger(history.attempts)
    || !nullableCount(history.pendingRows)
    || !nullableCount(history.backupEntries)
    || (history.reason !== undefined && !DURABLE_HISTORY_REASONS.has(history.reason))) {
    throw new CodexCoordinatorTransactionError("The history update is malformed.");
  }
  if (history.txId !== expected.currentTxId) {
    throw new CodexCoordinatorTransactionError("The history update does not belong to the expected transition.");
  }
}

/**
 * The missing-row incident proved that absence is not authority: installing
 * `{0,null}` over a legacy JSON pair or routed native bytes loses the only
 * evidence that an interrupted transition still needs salvage.
 */
function assertInitialStateCanBeCreated(): void {
  const integration = readIntegrationRecord();
  if (integration.kind === "invalid") {
    throw new CodexCoordinatorLegacyAmbiguousError(
      "A missing coordinator row cannot be initialized over legacy or invalid Codex integration state.",
    );
  }
  if (classifyNativeRoutedResidue().kind !== "clean") {
    throw new CodexCoordinatorLegacyAmbiguousError(
      "A missing coordinator row cannot be initialized while native Codex routing residue exists.",
    );
  }
}

function initialize(database: Database, databaseWasAbsent: boolean): void {
  const version = database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
  if (version !== 0 && version !== CODEX_COORDINATOR_SCHEMA_VERSION) {
    throw new CodexCoordinatorTransactionError("The coordinator database schema version is unsupported.");
  }
  if (!databaseWasAbsent && version === 0) {
    throw new CodexCoordinatorLegacyAmbiguousError(
      "An existing unversioned coordinator database cannot be adopted automatically.",
    );
  }
  database.exec(CREATE_TRANSITION_TABLE);
  const existing = database.query<TransitionRow, []>(SELECT_TRANSITION_ROW).get();
  if (!existing && !databaseWasAbsent) {
    throw new CodexCoordinatorLegacyAmbiguousError(
      "The existing coordinator database has no authoritative transition row.",
    );
  }
  if (!existing) {
    assertInitialStateCanBeCreated();
    database.query(INITIALIZE_TRANSITION_ROW).run(new Date().toISOString());
  }
  if (version === 0) database.exec(`PRAGMA user_version = ${CODEX_COORDINATOR_SCHEMA_VERSION}`);
  readCodexCoordinatorState(database);
}

function createCapability(
  database: Database,
  onResult: (result: TransitionStateUpdate) => void,
): BrandedCodexCoordinatorTransaction {
  let consumed = false;
  return {
    [codexCoordinatorTransactionBrand]: true,
    beginTransition(expected, next) {
      if (consumed) {
        throw new CodexCoordinatorTransactionError("The coordinator capability has already been consumed.");
      }
      consumed = true;
      if (!isNonNegativeInteger(expected.nativeGeneration)
        || (expected.currentTxId !== null && !expected.currentTxId.trim())
        || !next.txId.trim()
        || (next.direction !== "apply" && next.direction !== "remove")
        || !next.authoritySnapshotId.trim()) {
        throw new CodexCoordinatorTransactionError("The transition update is malformed.");
      }

      const result = database.query(BEGIN_TRANSITION).run(
        expected.nativeGeneration + 1,
        next.txId,
        next.nextRetryAt,
        next.txId,
        next.direction,
        next.authoritySnapshotId,
        new Date().toISOString(),
        expected.nativeGeneration,
        expected.currentTxId,
      );
      const state = readCodexCoordinatorState(database);
      const update: TransitionStateUpdate = result.changes === 1
        ? { kind: "updated", state }
        : { kind: "conflict", current: state };
      onResult(update);
      return update;
    },
  };
}

export function openCodexCoordinatorTransaction(
  finalDatabasePath: string,
  adoption?: CodexCoordinatorAdoptionOptions,
): CodexCoordinatorTransactionController {
  let database: Database | undefined;
  let transactionOpen = false;
  let closed = false;
  let lastResult: TransitionStateUpdate | undefined;
  let initialIdentity: string | undefined;
  let databaseWasAbsent = false;
  let databaseWasEmpty = false;

  try {
    try {
      const before = lstatSync(finalDatabasePath);
      if (before.isSymbolicLink() || !before.isFile()) {
        throw new CodexUserIdentityRefusal("The coordinator database path is not a real file.");
      }
      // sqlite3_open_v2(..., SQLITE_OPEN_CREATE) makes the pathname visible
      // before the first schema write. A racing process can therefore observe a
      // real but zero-byte file that carries no coordinator authority yet. Treat
      // that exact state like ENOENT; any non-empty unversioned database remains
      // legacy-ambiguous below.
      databaseWasEmpty = before.size === 0;
      if (process.platform !== "win32") {
        const uid = process.getuid?.();
        // Ownership is decided here; MODE is not.
        //
        // Two processes reaching first use together both observe ENOENT, and the
        // loser can lstat the winner's file in the window between its creation
        // and its chmod. Refusing on mode here read as a permission problem when
        // it was a schedule — a real 1-in-12 flake on a 16-core box. Our own file
        // is ours to narrow, so the mode decision moves below the open, where it
        // can tighten once and then judge the settled state. A file owned by
        // somebody else is still refused immediately: that is not a race, and no
        // amount of waiting makes it ours.
        if (uid === undefined || before.uid !== uid) {
          throw new CodexUserIdentityRefusal(
            "The coordinator database has unsafe ownership or permissions.",
          );
        }
      }
    } catch (cause) {
      if (errorCode(cause) !== "ENOENT") throw cause;
      databaseWasAbsent = true;
    }
    if (databaseWasAbsent && adoption) {
      publishAdoptionDatabase(finalDatabasePath, adoption);
      databaseWasAbsent = false;
    }
    database = new Database(finalDatabasePath, { create: true });
    if (databaseWasAbsent) {
      try { chmodSync(finalDatabasePath, 0o600); } catch { /* Windows applies ACLs in WP11. */ }
    }
    // Re-check ownership and mode AFTER the open, not only before it.
    //
    // Two processes reaching first use together both see ENOENT, and the loser
    // opens the winner's file in the window before the winner's chmod lands. Its
    // pre-open check had already passed (the file did not exist), so without this
    // the loser refused with `unsafe-path` — a real flake, reproduced 1-in-12 on
    // a 16-core box, that read as a permission problem when it was a schedule.
    //
    // Narrowing our own descriptor's mode is safe and idempotent; a file that is
    // still wrong afterwards is genuinely wrong, not merely early.
    if (process.platform !== "win32") {
      const uid = process.getuid?.();
      let current = lstatSync(finalDatabasePath);
      if ((current.mode & 0o777) !== 0o600) {
        try { chmodSync(finalDatabasePath, 0o600); } catch { /* refused below */ }
        current = lstatSync(finalDatabasePath);
      }
      if (uid === undefined || current.uid !== uid || (current.mode & 0o777) !== 0o600) {
        throw new CodexUserIdentityRefusal(
          "The coordinator database has unsafe ownership or permissions.",
        );
      }
    }
    const opened = lstatSync(finalDatabasePath);
    if (opened.isSymbolicLink() || !opened.isFile()) {
      throw new CodexUserIdentityRefusal("The coordinator database path changed during open.");
    }
    initialIdentity = `${opened.dev}:${opened.ino}`;
    database.exec("PRAGMA busy_timeout = 0; PRAGMA locking_mode = NORMAL; BEGIN IMMEDIATE");
    transactionOpen = true;
    initialize(database, databaseWasAbsent || databaseWasEmpty);
  } catch (cause) {
    if (transactionOpen) {
      try { database?.exec("ROLLBACK"); } catch { /* close releases the transaction */ }
    }
    try { database?.close(); } catch { /* acquisition already failed */ }
    throw cause;
  }

  const db = database;
  const requireOpen = (): void => {
    if (closed || !transactionOpen) throw new CodexCoordinatorTransactionError("The coordinator transaction is closed.");
  };
  const assertStablePath = (): void => {
    requireOpen();
    const entry = lstatSync(finalDatabasePath);
    if (entry.isSymbolicLink() || !entry.isFile()
      || `${entry.dev}:${entry.ino}` !== initialIdentity
      || !samePathIdentity(realpathSync.native(finalDatabasePath), finalDatabasePath)) {
      throw new CodexUserIdentityRefusal("The coordinator database path was substituted.");
    }
  };

  const capability = createCapability(db, result => { lastResult = result; });
  return {
    capability,
    expectation() {
      requireOpen();
      const state = readCodexCoordinatorState(db);
      return {
        nativeBefore: state.nativeGeneration,
        nativeAfter: state.nativeGeneration + 1,
        txId: randomUUID(),
      };
    },
    version() {
      requireOpen();
      const state = readCodexCoordinatorState(db);
      return { nativeGeneration: state.nativeGeneration, currentTxId: state.currentTxId };
    },
    assertPublished(expectation) {
      requireOpen();
      if (lastResult?.kind !== "updated") {
        throw new CodexCoordinatorTransactionError("The coordinator transition was not published.");
      }
      const state = readCodexCoordinatorState(db);
      if (state.nativeGeneration !== expectation.nativeAfter || state.currentTxId !== expectation.txId) {
        throw new CodexCoordinatorTransactionError("The coordinator published a different transition.");
      }
    },
    assertStablePath,
    commit() {
      requireOpen();
      assertStablePath();
      db.exec("COMMIT");
      transactionOpen = false;
    },
    rollback() {
      if (!closed && transactionOpen) {
        try { db.exec("ROLLBACK"); } finally { transactionOpen = false; }
      }
    },
    close() {
      if (closed) return;
      if (transactionOpen) {
        try { db.exec("ROLLBACK"); } catch { /* close still releases the lock */ }
        transactionOpen = false;
      }
      db.close();
      closed = true;
    },
  };
}

function currentCoordinatorDatabasePath(): string {
  const canonicalCodexHome = realpathSync.native(resolveCodexHomeDir());
  return resolveCodexCoordinatorDatabasePath(resolveEffectiveUserIdentity(), canonicalCodexHome);
}

function mapUnavailable(
  error: unknown,
): Extract<TransitionStateRead, { kind: "unavailable" }> {
  if (error instanceof CodexUserIdentityRefusal) return { kind: "unavailable", reason: "unsafe-path" };
  return { kind: "unavailable", reason: isBusy(error) ? "busy" : "database" };
}

function mapReadError(error: unknown): TransitionStateRead {
  if (error instanceof CodexCoordinatorLegacyAmbiguousError) {
    return { kind: "legacy-ambiguous", message: error.message };
  }
  return mapUnavailable(error);
}

export const readCodexTransitionState: ReadCodexTransitionState = () => {
  let transaction: CodexCoordinatorTransactionController | undefined;
  try {
    transaction = openCodexCoordinatorTransaction(currentCoordinatorDatabasePath());
    // Initialization and validation happen while N is held. Commit that setup
    // before reopening read-only; the controller never leaks its Database.
    transaction.commit();
    transaction.close();
    transaction = undefined;
    return readCommittedState();
  } catch (error) {
    transaction?.rollback();
    return mapReadError(error);
  } finally {
    transaction?.close();
  }
};

function readCommittedState(): TransitionStateRead {
  const path = currentCoordinatorDatabasePath();
  let database: Database | undefined;
  try {
    database = new Database(path, { readonly: true });
    database.exec("PRAGMA busy_timeout = 0");
    return { kind: "ready", state: readCodexCoordinatorState(database) };
  } catch (error) {
    return mapUnavailable(error);
  } finally {
    try { database?.close(); } catch { /* read already completed */ }
  }
}

export const beginCodexTransition: BeginCodexTransition = (expected, next) => {
  let transaction: CodexCoordinatorTransactionController | undefined;
  try {
    transaction = openCodexCoordinatorTransaction(currentCoordinatorDatabasePath());
    const result = transaction.capability.beginTransition(expected, next);
    transaction.commit();
    return result;
  } catch (error) {
    transaction?.rollback();
    const unavailable = mapUnavailable(error);
    return { kind: "unavailable", reason: unavailable.reason };
  } finally {
    transaction?.close();
  }
};

export const updateCodexHistoryTransition: UpdateCodexHistoryTransition = (expected, history) => {
  let database: Database | undefined;
  let transactionOpen = false;
  try {
    validateHistoryWrite(expected, history);
    // `{ create: false }` ALONE is SQLITE_MISUSE on Bun 1.3.14: the flags must
    // name a read mode. Without `readwrite` every history update failed before
    // reaching its conditional UPDATE and returned `unavailable/database`, so no
    // terminal history state could ever be recorded — and the four tests here
    // still passed, because none of them called this function.
    database = new Database(currentCoordinatorDatabasePath(), { readwrite: true, create: false });
    database.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    transactionOpen = true;
    const current = readCodexCoordinatorState(database);
    if (current.nativeGeneration > 0 && current.historySchedule === null) {
      throw new CodexCoordinatorTransactionError("A positive transition cannot lose its direction.");
    }
    const result = database.query(UPDATE_HISTORY).run(
      history.status,
      history.reason ?? null,
      history.attempts,
      history.nextRetryAt,
      history.txId,
      history.pendingRows,
      history.backupEntries,
      new Date().toISOString(),
      expected.nativeGeneration,
      expected.currentTxId,
      expected.currentTxId,
    );
    const state = readCodexCoordinatorState(database);
    database.exec("COMMIT");
    transactionOpen = false;
    return result.changes === 1
      ? { kind: "updated", state }
      : { kind: "conflict", current: state };
  } catch (error) {
    if (transactionOpen) {
      try { database?.exec("ROLLBACK"); } catch { /* close releases N */ }
    }
    const unavailable = mapUnavailable(error);
    return { kind: "unavailable", reason: unavailable.reason };
  } finally {
    try { database?.close(); } catch { /* operation already completed */ }
  }
};
