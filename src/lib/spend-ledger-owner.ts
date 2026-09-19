/** Process-lifetime single-writer ownership for the shared spend journal. */
import { Database } from "bun:sqlite";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { getConfigDir } from "../config/paths";
import { recordOwnedConfigPath } from "./config-ownership";
import { assertNotRealHomeUnderTest } from "./test-home-guard";
import { hardenSecretDir, hardenSecretPath } from "./windows-secret-acl";

export const SPEND_LEDGER_OWNER_FILENAME = "spend-ledger-owner.sqlite";
export const SPEND_LEDGER_RESTART_PARENT_ENV = "OCX_SPEND_LEDGER_RESTART_PARENT_PID";
export const SPEND_LEDGER_RESTART_WAIT_MS = 5_000;
const OWNER_SIDECARS = ["-journal", "-wal", "-shm"] as const;

export type SpendLedgerOwnerErrorCode =
  | "SPEND_LEDGER_OWNER_BUSY"
  | "SPEND_LEDGER_OWNER_UNAVAILABLE"
  | "SPEND_LEDGER_OWNER_HOME_CONFLICT"
  | "SPEND_LEDGER_OWNER_NOT_HELD";

export class SpendLedgerOwnerError extends Error {
  constructor(readonly code: SpendLedgerOwnerErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SpendLedgerOwnerError";
  }
}

export interface SpendLedgerOwnerLease {
  release(): void;
}

interface ActiveOwner {
  readonly home: string;
  readonly database: Database;
  references: number;
}

let activeOwner: ActiveOwner | null = null;
let boundLedgerHome: string | null = null;

function errorCode(error: unknown): unknown {
  return error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
}

function assertPrivateFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new SpendLedgerOwnerError(
      "SPEND_LEDGER_OWNER_UNAVAILABLE",
      "Spend-ledger ownership could not be established safely.",
    );
  }
  if (process.platform !== "win32" && stat.uid !== process.getuid!()) {
    throw new SpendLedgerOwnerError(
      "SPEND_LEDGER_OWNER_UNAVAILABLE",
      "Spend-ledger ownership could not be established safely.",
    );
  }
}

function prepareOwnerPath(configDir: string): { home: string; path: string } {
  const requested = resolve(configDir);
  // First statement before mutation: tests must never acquire against the real user home.
  assertNotRealHomeUnderTest(requested);
  mkdirSync(requested, { recursive: true, mode: 0o700 });
  const home = realpathSync.native(requested);
  if (process.platform !== "win32") chmodSync(home, 0o700);
  hardenSecretDir(home, { required: true });
  const path = join(home, SPEND_LEDGER_OWNER_FILENAME);
  try { closeSync(openSync(path, "wx", 0o600)); }
  catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
  assertPrivateFile(path);
  if (process.platform !== "win32") chmodSync(path, 0o600);
  hardenSecretPath(path, { required: true });
  assertPrivateFile(path);
  recordOwnedConfigPath(home, path);
  for (const suffix of OWNER_SIDECARS) recordOwnedConfigPath(home, `${path}${suffix}`);
  return { home: process.platform === "win32" ? home.toLowerCase() : home, path };
}

function isBusy(error: unknown): boolean {
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : "";
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED"
    || /database (?:is|table is) locked/i.test(message);
}

function stateDirectoryIdentity(configDir: string): string {
  const requested = resolve(configDir);
  assertNotRealHomeUnderTest(requested);
  let canonical = requested;
  try { canonical = realpathSync.native(requested); } catch { /* acquisition owns creation */ }
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function restartHandoffWaitMs(): number {
  const markedParent = process.env[SPEND_LEDGER_RESTART_PARENT_ENV];
  delete process.env[SPEND_LEDGER_RESTART_PARENT_ENV];
  return markedParent === String(process.ppid) ? SPEND_LEDGER_RESTART_WAIT_MS : 0;
}

/** Mark only a parent-exit restart child for bounded lease acquisition. */
export function spendLedgerRestartEnvironment(
  source: NodeJS.ProcessEnv,
  parentPid?: number,
): NodeJS.ProcessEnv {
  const env = { ...source };
  if (parentPid === undefined) delete env[SPEND_LEDGER_RESTART_PARENT_ENV];
  else env[SPEND_LEDGER_RESTART_PARENT_ENV] = String(parentPid);
  return env;
}

/**
 * Hold one SQLite write transaction until the final in-process reference releases it.
 * SQLite and the OS release a crashed process; no PID, timestamp, TTL or lock-file unlink
 * can evict a live owner or mistake a reused process identity for this lease.
 */
export function acquireSpendLedgerOwner(configDir = getConfigDir()): SpendLedgerOwnerLease {
  const requestedHome = stateDirectoryIdentity(configDir);
  const busyTimeout = restartHandoffWaitMs();
  if (boundLedgerHome !== null && boundLedgerHome !== requestedHome) {
    throw new SpendLedgerOwnerError(
      "SPEND_LEDGER_OWNER_HOME_CONFLICT",
      "This process already owns the spend ledger for a different state directory.",
    );
  }
  if (activeOwner) {
    if (activeOwner.home !== requestedHome) {
      throw new SpendLedgerOwnerError(
        "SPEND_LEDGER_OWNER_HOME_CONFLICT",
        "This process already owns the spend ledger for a different state directory.",
      );
    }
    activeOwner.references += 1;
    return leaseFor(activeOwner);
  }

  let prepared: { home: string; path: string };
  try {
    prepared = prepareOwnerPath(configDir);
  } catch (cause) {
    if (cause instanceof SpendLedgerOwnerError) throw cause;
    throw new SpendLedgerOwnerError(
      "SPEND_LEDGER_OWNER_UNAVAILABLE",
      "Spend-ledger ownership could not be established safely.",
      { cause },
    );
  }

  let database: Database | undefined;
  try {
    database = new Database(prepared.path, { create: true });
    database.exec(`PRAGMA locking_mode = NORMAL; PRAGMA busy_timeout = ${busyTimeout}; BEGIN IMMEDIATE`);
  } catch (cause) {
    try { database?.close(); } catch { /* preserve acquisition failure */ }
    if (isBusy(cause)) {
      throw new SpendLedgerOwnerError(
        "SPEND_LEDGER_OWNER_BUSY",
        "Another OpenCodex process already owns this spend ledger. Use a separate OPENCODEX_HOME for an independent instance.",
      );
    }
    throw new SpendLedgerOwnerError(
      "SPEND_LEDGER_OWNER_UNAVAILABLE",
      "Spend-ledger ownership could not be established safely.",
      { cause },
    );
  }

  activeOwner = { home: prepared.home, database, references: 1 };
  return leaseFor(activeOwner);
}

function leaseFor(owner: ActiveOwner): SpendLedgerOwnerLease {
  let released = false;
  return Object.freeze({
    release(): void {
      if (released) return;
      released = true;
      if (activeOwner !== owner || owner.references < 1) return;
      owner.references -= 1;
      if (owner.references > 0) return;
      activeOwner = null;
      let failure: unknown;
      try { owner.database.exec("ROLLBACK"); } catch (error) { failure = error; }
      try { owner.database.close(); } catch (error) { failure ??= error; }
      if (failure !== undefined) {
        throw new SpendLedgerOwnerError(
          "SPEND_LEDGER_OWNER_UNAVAILABLE",
          "Spend-ledger ownership could not be released cleanly.",
          { cause: failure },
        );
      }
    },
  });
}

/** The singleton journal may be touched only while its matching state directory is owned. */
export function assertSpendLedgerOwnerHeld(configDir = getConfigDir()): void {
  let home: string;
  try {
    const canonical = realpathSync.native(resolve(configDir));
    home = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  } catch (cause) {
    throw new SpendLedgerOwnerError(
      "SPEND_LEDGER_OWNER_NOT_HELD",
      "Spend-ledger ownership is required before the shared ledger can be used.",
      { cause },
    );
  }
  if (!activeOwner || activeOwner.home !== home || activeOwner.references < 1) {
    throw new SpendLedgerOwnerError(
      "SPEND_LEDGER_OWNER_NOT_HELD",
      "Spend-ledger ownership is required before the shared ledger can be used.",
    );
  }
}

/** Permanently bind the live process-wide singleton to its first constructed home. */
export function bindSpendLedgerOwnerHome(configDir = getConfigDir()): void {
  assertSpendLedgerOwnerHeld(configDir);
  const home = stateDirectoryIdentity(configDir);
  if (boundLedgerHome !== null && boundLedgerHome !== home) {
    throw new SpendLedgerOwnerError(
      "SPEND_LEDGER_OWNER_HOME_CONFLICT",
      "This process already owns the spend ledger for a different state directory.",
    );
  }
  boundLedgerHome = home;
}

export function spendLedgerOwnerSnapshot(): { readonly ownership: "held" | "unheld" } {
  return { ownership: activeOwner ? "held" : "unheld" };
}

/** Test seam paired with discarding the process-wide ledger singleton. */
export function resetSpendLedgerOwnerBindingForTest(): void {
  boundLedgerHome = null;
}
