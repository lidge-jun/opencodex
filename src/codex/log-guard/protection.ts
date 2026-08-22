import { lstatSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Database, constants as sqliteConstants } from "bun:sqlite";

import { getCodexHome, resolveCodexLogsDbPath } from "../paths";
import { hasCurrentLogsSchema, inspectCodexLogs, type CodexLogGuardInspection } from "./inspect";
import { withCodexLogGuardLock, type CodexLogGuardLockOutcome } from "./lock";
import { sameLogGuardPathIdentity } from "./path-safety";
import { isSqliteBusy } from "./sqlite-errors";
import {
  readCodexLogGuardMode,
  writeCodexLogGuardMode,
  type CodexLogGuardMode,
} from "./policy";
import {
  listRunningCodexProcesses,
  type CodexWriterProcessCheck,
} from "./processes";

export { type CodexLogGuardMode } from "./policy";

const IMMUTABLE_READONLY_FLAGS = sqliteConstants.SQLITE_OPEN_READONLY | sqliteConstants.SQLITE_OPEN_URI;
const COMPAT_TRIGGER = "opencodex_log_guard_compat_v1";
const QUIET_TRIGGER = "opencodex_log_guard_quiet_v1";
const OWNED_TRIGGER_NAMES = [COMPAT_TRIGGER, QUIET_TRIGGER] as const;

const CURRENT_LOG_COLUMNS = [
  "id",
  "ts",
  "ts_nanos",
  "level",
  "target",
  "feedback_log_body",
  "module_path",
  "file",
  "line",
  "thread_id",
  "process_uuid",
  "estimated_bytes",
] as const;

/**
 * Versioned compatibility policy pinned to the current upstream Codex persistent
 * log filters researched for Log Guard v1. It intentionally preserves unrelated
 * TRACE rows rather than assuming all TRACE diagnostics are disposable.
 */
/**
 * Upstream configures these filters with `Targets::with_target`, which matches a
 * target and every module path BENEATH it: `hyper_util` also covers
 * `hyper_util::client::legacy::pool`, and `codex_api::sse` also covers
 * `codex_api::sse::responses`. Exact equality reproduced only the parent, so the
 * high-volume child targets — the ones that actually fill the database — kept
 * writing while compat mode reported itself active.
 *
 * The comparison uses `substr`, not `LIKE`. SQLite's `LIKE` is ASCII
 * case-insensitive by default, so a `LIKE` form would also suppress
 * `HYPER_UTIL::child` — Rust target paths are case-sensitive, and silently
 * dropping a differently-cased target is a wrong answer, not a safe default.
 * `substr(NEW.target, 1, N) = 'X::'` is a plain case-sensitive comparison with
 * no wildcard metacharacters to escape, which also removes the `_`/`%` hazard
 * that `LIKE` would have required an ESCAPE clause to contain.
 *
 * The `'::'` boundary is deliberate and NARROWER than upstream's raw prefix
 * rule: `Targets::with_target("hyper_util")` would also match a sibling crate
 * named `hyper_utilities`. Suppressing an unrelated crate's logs is worse for
 * a guard that silently discards rows, so this matches the module-descendant
 * relation instead. The existing regression pins `hyper_utilities` as
 * preserved.
 *
 * `opentelemetry_sdk` stays exact because upstream registers it with exact
 * equality rather than a prefix filter.
 */
function targetOrDescendant(target: string): string {
  const prefix = `${target}::`;
  return `(NEW.target = '${target}' OR substr(NEW.target, 1, ${prefix.length}) = '${prefix}')`;
}

function anyTargetOrDescendant(targets: readonly string[]): string {
  return `(${targets.map(targetOrDescendant).join(" OR ")})`;
}

const COMPAT_TRIGGER_SQL = `CREATE TRIGGER ${COMPAT_TRIGGER}
BEFORE INSERT ON logs
WHEN
  NEW.target = 'log'
  OR NEW.target = 'codex_otel.log_only'
  OR NEW.target = 'codex_otel.trace_safe'
  OR NEW.target = 'codex_api::responses_websocket_timing'
  OR NEW.target = 'codex_core::post_sampling_token_estimate'
  OR (${targetOrDescendant("hyper_util")} AND upper(NEW.level) IN ('TRACE', 'DEBUG', 'INFO'))
  OR (${anyTargetOrDescendant(["codex_rmcp_client", "rmcp"])} AND upper(NEW.level) IN ('TRACE', 'DEBUG'))
  OR (${anyTargetOrDescendant([
    "codex_http_client::transport",
    "codex_api::sse",
    "codex_tui::streaming::controller",
    "codex_tui::streaming::table_holdback",
  ])} AND upper(NEW.level) = 'TRACE')
  OR (NEW.target = 'opentelemetry_sdk' AND upper(NEW.level) IN ('TRACE', 'DEBUG'))
BEGIN
  SELECT RAISE(IGNORE);
END`;

const QUIET_TRIGGER_SQL = `CREATE TRIGGER ${QUIET_TRIGGER}
BEFORE INSERT ON logs
WHEN upper(NEW.level) = 'TRACE'
BEGIN
  SELECT RAISE(IGNORE);
END`;

const SQL_BY_MODE: Record<Exclude<CodexLogGuardMode, "off">, string> = {
  compat: COMPAT_TRIGGER_SQL,
  quiet: QUIET_TRIGGER_SQL,
};

export type CodexLogGuardObservedMode = CodexLogGuardMode | "collision";
export type CodexLogGuardProtectionState = "off" | "active" | "drifted" | "unsupported" | "unknown";

export interface CodexLogGuardProtectionSummary {
  desiredMode: CodexLogGuardMode;
  observedMode: CodexLogGuardObservedMode;
  state: CodexLogGuardProtectionState;
}

export type CodexLogGuardStatus = CodexLogGuardInspection & {
  protection: CodexLogGuardProtectionSummary;
};

export type CodexLogGuardMutationError =
  | "unsupported_schema"
  | "codex_running"
  | "process_enumeration_failed"
  | "trigger_collision"
  | "unsafe_path"
  | "busy"
  | "database_error"
  | "config_write_failed";

export type CodexLogGuardMutationResult =
  | { ok: true; status: CodexLogGuardStatus }
  | { ok: false; error: CodexLogGuardMutationError };

export interface CodexLogGuardProtectionDeps {
  codexHome?: string;
  processCheck?: () => CodexWriterProcessCheck;
  readDesiredMode?: () => CodexLogGuardMode;
  writeDesiredMode?: (mode: CodexLogGuardMode) => void;
  withLock?: <T>(
    canonicalCodexHome: string,
    canonicalLogsDbPath: string,
    work: () => T,
  ) => CodexLogGuardLockOutcome<T>;
}

interface TriggerRow {
  name: string;
  sql: string | null;
}
interface ColumnRow { name: string }
interface OwnedTriggerSnapshot { name: string; sql: string }

type LockedMutationResult =
  | { ok: true }
  | { ok: false; error: CodexLogGuardMutationError };

function normalizeSql(sql: string | null | undefined): string {
  return (sql ?? "").trim().replace(/;\s*$/, "").replace(/\s+/g, " ");
}

function expectedSql(mode: Exclude<CodexLogGuardMode, "off">): string {
  return normalizeSql(SQL_BY_MODE[mode]);
}

function ownedModeForRow(row: TriggerRow): Exclude<CodexLogGuardMode, "off"> | null {
  if (row.name === COMPAT_TRIGGER && normalizeSql(row.sql) === expectedSql("compat")) return "compat";
  if (row.name === QUIET_TRIGGER && normalizeSql(row.sql) === expectedSql("quiet")) return "quiet";
  return null;
}

function queryReservedTriggers(db: Database): TriggerRow[] {
  const placeholders = OWNED_TRIGGER_NAMES.map(() => "?").join(", ");
  return db.query<TriggerRow, string[]>(
    `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (${placeholders}) ORDER BY name`,
  ).all(...OWNED_TRIGGER_NAMES);
}

function observeTriggers(db: Database): CodexLogGuardObservedMode {
  const rows = queryReservedTriggers(db);
  if (rows.length === 0) return "off";
  const modes = rows.map(ownedModeForRow);
  if (modes.some(mode => mode === null)) return "collision";
  const unique = new Set(modes);
  return unique.size === 1 && rows.length === 1 ? modes[0]! : "collision";
}

function exactCurrentSchema(db: Database): boolean {
  // Delegates to the inspector's predicate so the locked recheck is exactly as
  // strict as the compatibility report. Column names alone let a schema change
  // between inspection and the locked write slip a mutation onto a database the
  // inspector calls monitor-only.
  return hasCurrentLogsSchema(db);
}

/**
 * Read trigger metadata with the same immutable/checkpointed semantics as PR 1
 * diagnostics. A status GET must never participate in Codex's SQLite WAL/SHM
 * protocol or materialise sidecars merely to report protection state.
 */
function openReadOnly(databasePath: string): Database {
  const uri = `${pathToFileURL(databasePath).href}?immutable=1`;
  return new Database(uri, IMMUTABLE_READONLY_FLAGS);
}

function openReadWrite(databasePath: string): Database {
  // READWRITE without CREATE: a missing/moved canonical DB is a refusal, not a
  // reason for OpenCodex to materialise a new foreign database.
  return new Database(databasePath, sqliteConstants.SQLITE_OPEN_READWRITE);
}

function databasePathIsSafe(databasePath: string): boolean {
  try {
    const stat = lstatSync(databasePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    return sameLogGuardPathIdentity(realpathSync.native(databasePath), databasePath);
  } catch {
    return false;
  }
}

function protectionSummary(
  inspection: CodexLogGuardInspection,
  desiredMode: CodexLogGuardMode,
  observedMode: CodexLogGuardObservedMode,
): CodexLogGuardProtectionSummary {
  if (inspection.capabilities.protection.state !== "supported") {
    return { desiredMode, observedMode, state: "unsupported" };
  }
  if (observedMode === "collision") return { desiredMode, observedMode, state: "unknown" };
  if (desiredMode === "off" && observedMode === "off") {
    return { desiredMode, observedMode, state: "off" };
  }
  if (desiredMode !== "off" && desiredMode === observedMode) {
    return { desiredMode, observedMode, state: "active" };
  }
  return { desiredMode, observedMode, state: "drifted" };
}

function inspectionDeps(deps: CodexLogGuardProtectionDeps): { codexHome?: string } {
  return deps.codexHome ? { codexHome: deps.codexHome } : {};
}

export function getCodexLogGuardProtectionStatus(
  deps: CodexLogGuardProtectionDeps = {},
): CodexLogGuardStatus {
  const codexHome = deps.codexHome ?? getCodexHome();
  const inspection = inspectCodexLogs({ codexHome });
  const databasePath = resolveCodexLogsDbPath({ codexHome });
  const desiredMode = (deps.readDesiredMode ?? readCodexLogGuardMode)();
  let observedMode: CodexLogGuardObservedMode = inspection.schema.state === "compatible" ? "collision" : "off";

  if (inspection.schema.state === "compatible" && databasePathIsSafe(databasePath)) {
    try {
      const db = openReadOnly(databasePath);
      try { observedMode = observeTriggers(db); }
      finally { db.close(); }
    } catch {
      observedMode = "collision";
    }
  }

  return {
    ...inspection,
    protection: protectionSummary(inspection, desiredMode, observedMode),
  };
}

function successfulMutationStatus(
  codexHome: string,
  mode: CodexLogGuardMode,
): CodexLogGuardStatus {
  const inspection = inspectCodexLogs({ codexHome });
  const state: CodexLogGuardProtectionState = inspection.capabilities.protection.state === "supported"
    ? (mode === "off" ? "off" : "active")
    : "unsupported";
  return {
    ...inspection,
    protection: { desiredMode: mode, observedMode: mode, state },
  };
}

function processRefusal(check: CodexWriterProcessCheck): CodexLogGuardMutationError | null {
  if (check.state === "unknown") return "process_enumeration_failed";
  if (check.processes.length > 0) return "codex_running";
  return null;
}

function mutateOwnedTrigger(
  databasePath: string,
  mode: CodexLogGuardMode,
): { ok: true; previousTriggers: readonly OwnedTriggerSnapshot[] } | { ok: false; error: CodexLogGuardMutationError } {
  let db: Database | undefined;
  let transactionOpen = false;
  try {
    if (!databasePathIsSafe(databasePath)) return { ok: false, error: "unsafe_path" };
    db = openReadWrite(databasePath);
    db.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    transactionOpen = true;
    if (!exactCurrentSchema(db)) {
      // Same reasoning as the caller's gate: installing into an unrecognized
      // schema is refused, but removing a trigger we installed ourselves stays
      // available so a schema upgrade cannot strand it.
      if (mode !== "off") {
        db.exec("ROLLBACK");
        transactionOpen = false;
        return { ok: false, error: "unsupported_schema" };
      }
    }

    const rows = queryReservedTriggers(db);
    const modes = rows.map(ownedModeForRow);
    if (modes.some(item => item === null)) {
      db.exec("ROLLBACK");
      transactionOpen = false;
      return { ok: false, error: "trigger_collision" };
    }
    const previousTriggers: OwnedTriggerSnapshot[] = rows.map(row => ({
      name: row.name,
      sql: row.sql!,
    }));

    for (const row of rows) {
      // Name is from our fixed allow-list; never interpolate arbitrary sqlite_master data.
      db.exec(`DROP TRIGGER ${row.name}`);
    }
    if (mode !== "off") db.exec(SQL_BY_MODE[mode]);

    const observed = observeTriggers(db);
    if (observed !== mode) throw new Error("log_guard_trigger_verification_failed");
    db.exec("COMMIT");
    transactionOpen = false;
    return { ok: true, previousTriggers };
  } catch (error) {
    if (transactionOpen) {
      try { db?.exec("ROLLBACK"); } catch { /* close releases the transaction */ }
    }
    if (isSqliteBusy(error)) return { ok: false, error: "busy" };
    return { ok: false, error: "database_error" };
  } finally {
    try { db?.close(); } catch { /* mutation already settled */ }
  }
}

function restoreOwnedTriggers(databasePath: string, previousTriggers: readonly OwnedTriggerSnapshot[]): void {
  // Best-effort compensation only. Failure is deliberately not hidden by
  // claiming success; the caller returns config_write_failed and status will
  // expose any remaining drift on the next read.
  let db: Database | undefined;
  let transactionOpen = false;
  try {
    if (!databasePathIsSafe(databasePath)) return;
    db = openReadWrite(databasePath);
    db.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    transactionOpen = true;
    if (!exactCurrentSchema(db)) {
      db.exec("ROLLBACK");
      transactionOpen = false;
      return;
    }

    const current = queryReservedTriggers(db);
    if (current.some(row => ownedModeForRow(row) === null)) {
      db.exec("ROLLBACK");
      transactionOpen = false;
      return;
    }
    for (const row of current) db.exec(`DROP TRIGGER ${row.name}`);

    for (const trigger of previousTriggers) {
      if (ownedModeForRow(trigger) === null) throw new Error("invalid_owned_trigger_snapshot");
      db.exec(trigger.sql);
    }

    const restored = queryReservedTriggers(db);
    const expected = new Map(previousTriggers.map(row => [row.name, normalizeSql(row.sql)]));
    if (restored.length !== previousTriggers.length
      || restored.some(row => expected.get(row.name) !== normalizeSql(row.sql))) {
      throw new Error("log_guard_trigger_restore_verification_failed");
    }
    db.exec("COMMIT");
    transactionOpen = false;
  } catch {
    if (transactionOpen) {
      try { db?.exec("ROLLBACK"); } catch { /* close releases the transaction */ }
    }
  } finally {
    try { db?.close(); } catch { /* compensation already settled */ }
  }
}

function performMutation(
  requestedMode: CodexLogGuardMode | (() => CodexLogGuardMode),
  deps: CodexLogGuardProtectionDeps,
): CodexLogGuardMutationResult {
  const codexHome = deps.codexHome ?? getCodexHome();
  const inspection = inspectCodexLogs({ codexHome });
  const databasePath = resolveCodexLogsDbPath({ codexHome });
  // Removal must not be gated on the schema still being recognized. A Codex
  // upgrade that changes the logs schema would otherwise strand an installed
  // trigger: Protect is refused (correctly), but so is Disable, leaving the
  // user with an active OpenCodex trigger and no in-product way to remove it.
  // Installing into an unknown schema stays refused; taking our own trigger
  // back out is always allowed.
  const removingProtection = typeof requestedMode !== "function" && requestedMode === "off";
  if (!removingProtection && inspection.capabilities.protection.state !== "supported") {
    return { ok: false, error: "unsupported_schema" };
  }
  if (!databasePathIsSafe(databasePath)) return { ok: false, error: "unsafe_path" };

  const checkProcesses = deps.processCheck ?? listRunningCodexProcesses;
  const firstRefusal = processRefusal(checkProcesses());
  if (firstRefusal) return { ok: false, error: firstRefusal };

  const withLock = deps.withLock ?? withCodexLogGuardLock;
  const writeDesired = deps.writeDesiredMode ?? writeCodexLogGuardMode;
  let locked: CodexLogGuardLockOutcome<LockedMutationResult>;
  // Repair passes a resolver instead of a value: its target mode must be read
  // INSIDE L. Reading it before acquiring the lock let a Disable complete in
  // the gap, after which the stale Repair reinstalled protection and reported
  // success — the caller saw an honest "off" and got "compat".
  let effectiveMode: CodexLogGuardMode = typeof requestedMode === "function" ? "off" : requestedMode;
  try {
    locked = withLock(codexHome, databasePath, () => {
      // Recheck after acquiring L so a Codex process that starts during lock
      // acquisition cannot race the foreign-schema mutation.
      const secondRefusal = processRefusal(checkProcesses());
      if (secondRefusal) return { ok: false, error: secondRefusal };

      effectiveMode = typeof requestedMode === "function" ? requestedMode() : requestedMode;
      const mutation = mutateOwnedTrigger(databasePath, effectiveMode);
      if (!mutation.ok) return mutation;

      // Desired state belongs to the same logical transition as the trigger.
      // Keep L held through this write so another OpenCodex process cannot
      // interleave a different mode between the DB commit and config commit.
      try {
        writeDesired(effectiveMode);
      } catch {
        restoreOwnedTriggers(databasePath, mutation.previousTriggers);
        return { ok: false, error: "config_write_failed" as const };
      }
      return { ok: true };
    });
  } catch {
    return { ok: false, error: "database_error" };
  }
  if (locked.kind === "unavailable") {
    return {
      ok: false,
      error: locked.reason === "busy"
        ? "busy"
        : locked.reason === "unsafe-path" ? "unsafe_path" : "database_error",
    };
  }
  if (!locked.value.ok) return locked.value;

  // Report the mode that was actually applied under the lock, not the one the
  // caller guessed before acquiring it.
  return { ok: true, status: successfulMutationStatus(codexHome, effectiveMode) };
}

export function protectCodexLogs(
  mode: Exclude<CodexLogGuardMode, "off">,
  deps: CodexLogGuardProtectionDeps = {},
): CodexLogGuardMutationResult {
  return performMutation(mode, deps);
}

export function unprotectCodexLogs(
  deps: CodexLogGuardProtectionDeps = {},
): CodexLogGuardMutationResult {
  return performMutation("off", deps);
}

export function repairCodexLogGuardProtection(
  deps: CodexLogGuardProtectionDeps = {},
): CodexLogGuardMutationResult {
  // Resolve the desired mode under the lock (see performMutation): a Disable
  // that lands between the read and the lock must win, not be silently undone.
  return performMutation(() => (deps.readDesiredMode ?? readCodexLogGuardMode)(), deps);
}
