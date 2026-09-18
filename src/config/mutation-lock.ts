import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "./paths";
import { hardenSecretDir, windowsSecretAclApplies } from "../lib/windows-secret-acl";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import {
  bumpConfigGenerationAtPath,
  bumpCurrentConfigGeneration,
  initializeConfigGeneration,
  observeConfigGenerationAtPath,
  readConfigGenerationAtPath,
  readConfigGenerationInTransaction,
  type ConfigGenerationObservation,
} from "../codex/generation";
import type {
  BumpConfigGeneration,
  ConfigGeneration,
  ReadConfigGeneration,
  WithExpectedConfigGenerationSync,
} from "../codex/convergence-types";

const CONFIG_MUTATION_DB_FILENAME = "config-mutation.sqlite";
const CONFIG_MUTATION_DB_SIDECARS = ["-journal", "-wal", "-shm"] as const;
let warnedConfigMutationDirectoryAcl = false;

export class ConfigMutationLockError extends Error {
  readonly code = "CONFIG_MUTATION_LOCK_UNAVAILABLE";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ConfigMutationLockError";
  }
}

function configMutationDatabasePath(): string {
  const dir = getConfigDir();
  // First statement on purpose: a rejected mutation must leave nothing behind, not a
  // freshly created/chmod'd directory or database. See src/lib/test-home-guard.ts.
  assertNotRealHomeUnderTest(dir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    try { chmodSync(dir, 0o700); } catch { /* best-effort on existing dir */ }
  }
  if (windowsSecretAclApplies()) {
    try {
      // Distinct timeout memo from management-token directory harden: a required
      // management-dir timeout must not poison config mutation on the same home
      // (windows-latest server-management-auth cases).
      hardenSecretDir(dir, { required: true, timeoutMemoKey: `${dir}::config-mutation` });
    } catch (error) {
      if (!warnedConfigMutationDirectoryAcl) {
        warnedConfigMutationDirectoryAcl = true;
        const diagnostics = error instanceof Error ? error.message : "ACL hardening failed";
        console.warn(
          `[opencodex] Config mutation coordination directory ACL hardening did not complete; continuing without it. ${diagnostics}`,
        );
      }
    }
  }
  const path = join(dir, CONFIG_MUTATION_DB_FILENAME);
  recordOwnedConfigPath(dir, path);
  for (const suffix of CONFIG_MUTATION_DB_SIDECARS) {
    recordOwnedConfigPath(dir, `${path}${suffix}`);
  }
  return path;
}

/** Raised when an independent config-mutation transaction is requested recursively. */
export class NestedConfigMutationError extends Error {
  constructor() {
    super("prepareConfigMutationDatabasePathForWrite must not run inside withConfigMutationLockSync");
    this.name = "NestedConfigMutationError";
  }
}

/**
 * Prepare the shared config-mutation database path for an independent top-level
 * SQLite transaction. Callers must not invoke this while holding
 * {@link withConfigMutationLockSync}; a second `BEGIN IMMEDIATE` deliberately
 * fails busy instead of joining an uncommitted transaction.
 *
 * @throws {NestedConfigMutationError} If a config mutation lock is already held.
 */
export function prepareConfigMutationDatabasePathForWrite(): string {
  if (configMutationLockDepth > 0) {
    throw new NestedConfigMutationError();
  }
  return configMutationDatabasePath();
}

let configMutationLockDepth = 0;
let configMutationDatabase: Database | null = null;

/**
 * Serialize synchronous config and Codex credential-generation commits across processes with an
 * OS-backed SQLite write transaction. `busy_timeout=0` is deliberate: runtime request paths must
 * fail immediately under contention rather than freeze the Bun event loop. Process exit releases
 * SQLite locks without stale-owner deletion or lease recovery races.
 *
 * Reentrancy is limited to the current synchronous call stack; never return a Promise from `fn`.
 */
export function withConfigMutationLockSync<T>(fn: () => T): T {
  if (configMutationLockDepth > 0) {
    configMutationLockDepth += 1;
    try {
      return fn();
    } finally {
      configMutationLockDepth -= 1;
    }
  }
  const path = configMutationDatabasePath();
  let database: Database | undefined;
  let transactionOpen = false;
  try {
    database = new Database(path, { create: true });
    try { chmodSync(path, 0o600); } catch { /* platform may ignore chmod */ }
    database.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    transactionOpen = true;
    initializeConfigGeneration(database);
  } catch (cause) {
    if (transactionOpen) {
      try { database?.exec("ROLLBACK"); } catch { /* close below still releases the OS lock */ }
    }
    try { database?.close(); } catch { /* acquisition already failed */ }
    const code = cause && typeof cause === "object" && "code" in cause
      ? String((cause as { code?: unknown }).code)
      : "";
    throw new ConfigMutationLockError(
      code === "SQLITE_BUSY" ? "Config mutation already in progress" : "Could not acquire config mutation transaction",
      { cause },
    );
  }

  configMutationLockDepth = 1;
  configMutationDatabase = database;
  try {
    const value = fn();
    database.exec("COMMIT");
    transactionOpen = false;
    return value;
  } catch (error) {
    if (transactionOpen) {
      try { database.exec("ROLLBACK"); } catch { /* close below still releases the OS lock */ }
      transactionOpen = false;
    }
    throw error;
  } finally {
    configMutationLockDepth = 0;
    configMutationDatabase = null;
    try { database.close(); } catch { /* the OS lock is released with the handle */ }
  }
}

export function bumpGenerationForCooperatingConfigWrite(): void {
  if (!configMutationDatabase) {
    throw new Error("A cooperating config write requires the config mutation transaction.");
  }
  bumpCurrentConfigGeneration(configMutationDatabase);
}

export const readConfigGeneration: ReadConfigGeneration = () => {
  try {
    return readConfigGenerationAtPath(configMutationDatabasePath());
  } catch {
    return { kind: "unavailable", reason: "database" };
  }
};

export function observeConfigGeneration(): ConfigGenerationObservation {
  return observeConfigGenerationAtPath(join(getConfigDir(), CONFIG_MUTATION_DB_FILENAME));
}

/**
 * Read the generation from the transaction that is open RIGHT NOW.
 *
 * The observer cannot do this job. On the very first acquisition the
 * `BEGIN IMMEDIATE` that creates the table has not committed yet, so a separate
 * read-only connection cannot read a generation from it — measured, not
 * assumed. A caller that compared a pre-lock observation against an observer
 * re-read would therefore refuse every first write as stale.
 *
 * Throwing when no transaction is open is deliberate. Being called outside the
 * lock is broken plumbing, and returning a typed "unavailable" would let that
 * bug arrive disguised as an environmental failure — retried forever, on a
 * machine where nothing is wrong.
 */
export function readConfigGenerationInCurrentMutationTransaction(): ConfigGeneration {
  if (configMutationLockDepth < 1 || !configMutationDatabase) {
    throw new Error(
      "readConfigGenerationInCurrentMutationTransaction requires an open config mutation transaction.",
    );
  }
  return readConfigGenerationInTransaction(configMutationDatabase);
}

export const bumpConfigGeneration: BumpConfigGeneration = expected => {
  try {
    return bumpConfigGenerationAtPath(configMutationDatabasePath(), expected);
  } catch {
    return { kind: "unavailable", reason: "database" };
  }
};

function configGenerationFailureReason(error: unknown): "busy" | "database" {
  const cause = error instanceof ConfigMutationLockError ? error.cause : error;
  const code = cause && typeof cause === "object" && "code" in cause
    ? String((cause as { code?: unknown }).code)
    : "";
  const message = cause instanceof Error ? cause.message : "";
  return code === "SQLITE_BUSY"
    || code === "SQLITE_LOCKED"
    || /database (?:is|table is) locked/i.test(message)
    ? "busy"
    : "database";
}

export const withExpectedConfigGenerationSync: WithExpectedConfigGenerationSync = (
  expected,
  commit,
) => {
  let callbackThrew = false;
  let callbackError: unknown;
  try {
    return withConfigMutationLockSync(() => {
      const database = configMutationDatabase;
      if (!database) throw new Error("Config mutation transaction database is unavailable.");
      const current = readConfigGenerationInTransaction(database);
      if (current.value !== expected.value) return { kind: "conflict", current };
      try {
        return { kind: "matched", generation: current, value: commit() };
      } catch (error) {
        callbackThrew = true;
        callbackError = error;
        throw error;
      }
    });
  } catch (error) {
    if (callbackThrew && error === callbackError) throw error;
    return { kind: "unavailable", reason: configGenerationFailureReason(error) };
  }
};
