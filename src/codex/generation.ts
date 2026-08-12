/**
 * Durable generation ownership for OpenCodex config bytes.
 *
 * The WP8b C-phase review found that config ABA and moved configuration could
 * not be detected because cooperating saves had no durable counter. This module
 * owns the singleton schema and conditional increment in the existing config
 * mutation database; callers that already hold its transaction reuse that
 * Database handle so bytes and generation remain one cooperating commit.
 *
 * A hand edit from a non-cooperating writer deliberately does not increment this
 * counter. The convergence contract detects that case with its post-commit file
 * observation instead of pretending SQLite can coordinate an external editor.
 */
import { chmodSync, statSync } from "node:fs";

import { Database } from "bun:sqlite";

import type {
  ConfigGeneration,
  ConfigGenerationBump,
  ConfigGenerationRead,
} from "./convergence-types";

const CREATE_CONFIG_GENERATION = `
  CREATE TABLE IF NOT EXISTS config_generation (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    value INTEGER NOT NULL CHECK (value >= 0)
  )`;
const INITIALIZE_CONFIG_GENERATION = `
  INSERT OR IGNORE INTO config_generation (singleton, value) VALUES (1, 0)`;
const SELECT_CONFIG_GENERATION = `
  SELECT value FROM config_generation WHERE singleton = 1`;
const BUMP_CONFIG_GENERATION = `
  UPDATE config_generation
     SET value = value + 1
   WHERE singleton = 1 AND value = ?`;

interface ConfigGenerationRow {
  value: unknown;
}

interface SchemaVersionRow {
  schema_version: unknown;
}

/**
 * Observation adds exactly one variant to `ConfigGenerationRead`: `absent`.
 *
 * This used to be deliberately absent itself, on the reasoning that a caller
 * who may only LOOK must not be handed something it could mistake for a
 * known-good baseline of zero. That reasoning still holds, and `absent` does
 * not violate it — because `absent` is not a baseline. It authorizes nothing on
 * its own. A caller may only promote it after taking the config transaction and
 * reading a real zero THERE (`readConfigGenerationInCurrentMutationTransaction`),
 * at which point the zero is observed rather than assumed. A caller with no
 * transaction to open, such as catalog gather, must keep refusing it.
 *
 * What forced the distinction: refusing on absence meant refusing every Codex
 * write on any home whose config predates this database — a permanent refusal
 * for existing users, not a fixture problem.
 *
 * `absent` is returned ONLY for ENOENT on the initial `statSync`. A file that
 * exists but cannot be read, a directory in its place, a bad schema version, or
 * corrupt SQLite all stay `unavailable`, because those are reasons to stop, and
 * collapsing them into absence is how a corrupt coordinator would become a
 * licence to write.
 */
export type ConfigGenerationObservation =
  | ConfigGenerationRead
  | { kind: "absent" };

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
}

function isBusy(error: unknown): boolean {
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : "";
  return code === "SQLITE_BUSY"
    || code === "SQLITE_LOCKED"
    || /database (?:is|table is) locked/i.test(message);
}

function unavailable(error: unknown): Extract<ConfigGenerationRead, { kind: "unavailable" }> {
  return { kind: "unavailable", reason: isBusy(error) ? "busy" : "database" };
}

export function initializeConfigGeneration(database: Database): void {
  database.exec(CREATE_CONFIG_GENERATION);
  database.exec(INITIALIZE_CONFIG_GENERATION);
}

export function readConfigGenerationInTransaction(database: Database): ConfigGeneration {
  const row = database.query<ConfigGenerationRow, []>(SELECT_CONFIG_GENERATION).get();
  if (!row || !Number.isSafeInteger(row.value) || Number(row.value) < 0) {
    throw new Error("The config generation singleton is missing or invalid.");
  }
  return { value: Number(row.value) };
}

export function bumpConfigGenerationInTransaction(
  database: Database,
  expected: ConfigGeneration,
): ConfigGenerationBump {
  const result = database.query(BUMP_CONFIG_GENERATION).run(expected.value);
  if (result.changes === 1) {
    return { kind: "updated", generation: { value: expected.value + 1 } };
  }
  return { kind: "conflict", current: readConfigGenerationInTransaction(database) };
}

export function bumpCurrentConfigGeneration(database: Database): ConfigGeneration {
  const current = readConfigGenerationInTransaction(database);
  const result = bumpConfigGenerationInTransaction(database, current);
  if (result.kind !== "updated") {
    throw new Error("The config generation changed inside its owning transaction.");
  }
  return result.generation;
}

function runGenerationTransaction<T>(databasePath: string, operation: (database: Database) => T): T {
  let database: Database | undefined;
  let transactionOpen = false;
  try {
    database = new Database(databasePath, { create: true });
    try { chmodSync(databasePath, 0o600); } catch { /* platform may ignore chmod */ }
    database.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    transactionOpen = true;
    initializeConfigGeneration(database);
    const result = operation(database);
    database.exec("COMMIT");
    transactionOpen = false;
    return result;
  } catch (error) {
    if (transactionOpen) {
      try { database?.exec("ROLLBACK"); } catch { /* close releases the transaction */ }
    }
    throw error;
  } finally {
    try { database?.close(); } catch { /* operation already completed */ }
  }
}

export function readConfigGenerationAtPath(databasePath: string): ConfigGenerationRead {
  try {
    return {
      kind: "ready",
      generation: runGenerationTransaction(databasePath, readConfigGenerationInTransaction),
    };
  } catch (error) {
    return unavailable(error);
  }
}

/**
 * Observe generation state without preparing the mutation database in any way.
 * Missing storage is a first-class state: only cooperating config writes have
 * authority to create and initialize the generation singleton.
 */
export function observeConfigGenerationAtPath(
  databasePath: string,
): ConfigGenerationObservation {
  try {
    statSync(databasePath);
  } catch (error) {
    // ENOENT alone means absent. Everything else — EACCES, ENOTDIR, EIO — is a
    // reason the question could not be answered, which is not the same answer.
    return errorCode(error) === "ENOENT" ? { kind: "absent" } : unavailable(error);
  }

  let database: Database | undefined;
  try {
    database = new Database(databasePath, { readonly: true });
    const schema = database.query<SchemaVersionRow, []>("PRAGMA schema_version").get();
    if (!schema || !Number.isSafeInteger(schema.schema_version)) {
      throw new Error("The config generation schema version is invalid.");
    }
    return {
      kind: "ready",
      generation: readConfigGenerationInTransaction(database),
    };
  } catch (error) {
    return unavailable(error);
  } finally {
    try { database?.close(); } catch { /* observation already completed */ }
  }
}

export function bumpConfigGenerationAtPath(
  databasePath: string,
  expected: ConfigGeneration,
): ConfigGenerationBump {
  try {
    return runGenerationTransaction(databasePath, database => (
      bumpConfigGenerationInTransaction(database, expected)
    ));
  } catch (error) {
    return unavailable(error);
  }
}
