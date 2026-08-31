import { Database } from "bun:sqlite";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolveEffectiveUserIdentity, resolveEffectiveUserRuntimeRoot } from "../codex/user-identity";
import { hardenSecretDir, hardenSecretPath } from "./windows-secret-acl";

type LockDatabase = Pick<Database, "exec" | "close">;

export interface WindowsServiceMutationLockDeps {
  lockPath?: string;
  openDatabase?: (path: string) => LockDatabase;
  hardenDirectory?: (path: string) => void;
  hardenFile?: (path: string) => void;
}

export class WindowsServiceMutationBusyError extends Error {
  readonly code = "WINDOWS_SERVICE_MUTATION_BUSY";

  constructor() {
    super("Another OpenCodex Windows service operation is already in progress. Wait for it to finish, then retry.");
    this.name = "WindowsServiceMutationBusyError";
  }
}

export class WindowsServiceMutationLockError extends Error {
  readonly code = "WINDOWS_SERVICE_MUTATION_LOCK_FAILED";

  constructor(operation: "acquire" | "release", cause: unknown) {
    super(`The Windows service mutation lock could not be ${operation === "acquire" ? "acquired" : "released"}.`, { cause });
    this.name = "WindowsServiceMutationLockError";
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function isBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return errorCode(error) === "SQLITE_BUSY"
    || errorCode(error) === "SQLITE_LOCKED"
    || /database (?:is|table is) locked/i.test(message);
}

/**
 * Stable per-user lock namespace for the fixed `opencodex-proxy` task name.
 *
 * Deliberately outside OPENCODEX_HOME: creating the lock must not make a genuinely fresh
 * config root look pre-existing before the installer records its uninstall ownership. The
 * effective-user runtime root ignores LOCALAPPDATA/USERPROFILE overrides, so two processes
 * running as the same SID cannot split the lock by changing their environment or config home.
 */
export function windowsServiceMutationLockPath(): string {
  const identity = resolveEffectiveUserIdentity();
  if (identity.platform !== "win32") {
    throw new Error("The Windows service mutation lock is only available on Windows.");
  }
  return join(resolveEffectiveUserRuntimeRoot(identity), "windows-service-mutation.sqlite");
}

function assertRegularPath(path: string, kind: "directory" | "file"): void {
  const entry = lstatSync(path);
  const valid = kind === "directory" ? entry.isDirectory() : entry.isFile();
  if (!valid || entry.isSymbolicLink()) {
    throw new Error(`The Windows service mutation lock ${kind} is not a regular ${kind}.`);
  }
}

/**
 * Serialize one complete Windows service mutation across OpenCodex processes.
 *
 * The SQLite write transaction is the lock. It stays held across UAC and async verification,
 * and the OS releases it if the process exits, so no stale lock file needs unsafe reclamation.
 */
export async function withWindowsServiceMutationLock<T>(
  operation: () => Promise<T>,
  deps: WindowsServiceMutationLockDeps = {},
): Promise<T> {
  const lockPath = deps.lockPath ?? windowsServiceMutationLockPath();
  const lockDir = dirname(lockPath);
  let database: LockDatabase | undefined;
  let acquired = false;

  try {
    mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    assertRegularPath(lockDir, "directory");
    try { chmodSync(lockDir, 0o700); } catch { /* Windows ACL below is authoritative. */ }
    (deps.hardenDirectory ?? (path => { hardenSecretDir(path, { required: true }); }))(lockDir);

    try {
      database = (deps.openDatabase ?? (path => new Database(path, { create: true })))(lockPath);
      assertRegularPath(lockPath, "file");
      try { chmodSync(lockPath, 0o600); } catch { /* Windows ACL below is authoritative. */ }
      (deps.hardenFile ?? (path => { hardenSecretPath(path, { required: true }); }))(lockPath);
      database.exec("PRAGMA locking_mode = NORMAL; PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
      acquired = true;
    } catch (error) {
      try { database?.close(); } catch { /* acquisition already failed */ }
      database = undefined;
      if (isBusy(error)) throw new WindowsServiceMutationBusyError();
      throw new WindowsServiceMutationLockError("acquire", error);
    }

    let result: T;
    let operationError: unknown;
    try {
      result = await operation();
    } catch (error) {
      operationError = error;
    }

    let releaseError: unknown;
    if (acquired) {
      try { database.exec("ROLLBACK"); } catch (error) { releaseError = error; }
    }
    try { database.close(); } catch (error) { releaseError ??= error; }
    acquired = false;
    database = undefined;

    if (operationError !== undefined) throw operationError;
    if (releaseError !== undefined) throw new WindowsServiceMutationLockError("release", releaseError);
    return result!;
  } catch (error) {
    if (acquired) {
      try { database?.exec("ROLLBACK"); } catch { /* close still releases the OS lock */ }
    }
    try { database?.close(); } catch { /* preserve the primary error */ }
    throw error;
  }
}
