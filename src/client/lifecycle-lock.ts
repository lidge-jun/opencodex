/** Client/Desktop lifecycle exclusion. Lock order: N -> L -> C; never acquire N inside L. */
import { Database } from "bun:sqlite";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveEffectiveUserIdentity, resolveEffectiveUserRuntimeRoot } from "../codex/user-identity";
import { hardenSecretDir, hardenSecretPath } from "../lib/windows-secret-acl";

declare const lifecycleLease: unique symbol;
export interface ClientLifecycleHeld { readonly [lifecycleLease]: true }
export interface ClientLifecycleLockDeps { lockPath?: string }

const activeLeases = new WeakSet<object>();

class ClientLifecycleError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "ClientLifecycleError";
  }
}

/** A type assertion, copied property or expired callback cannot manufacture exclusion. */
export function assertClientLifecycleHeld(held: ClientLifecycleHeld): void {
  if (!activeLeases.has(held)) throw new ClientLifecycleError("client_lifecycle_lease_invalid");
}

function errorCode(error: unknown): unknown {
  return error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
}

function assertPath(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) {
    throw new ClientLifecycleError("client_lifecycle_path_unsafe");
  }
  if (process.platform !== "win32" && stat.uid !== process.getuid!()) {
    throw new ClientLifecycleError("client_lifecycle_path_unsafe");
  }
}

function preparePath(lockPath: string): void {
  const directory = dirname(lockPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertPath(directory, true);
  if (process.platform !== "win32") chmodSync(directory, 0o700);
  hardenSecretDir(directory, { required: true });
  // Create privately before SQLite opens it; refuse an existing symlink or hardlink
  // before chmod/ACL operations or the database constructor can follow it.
  try { closeSync(openSync(lockPath, "wx", 0o600)); }
  catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
  assertPath(lockPath, false);
  if (process.platform !== "win32") chmodSync(lockPath, 0o600);
  hardenSecretPath(lockPath, { required: true });
  assertPath(directory, true);
  assertPath(lockPath, false);
}

function acquire(deps: ClientLifecycleLockDeps): Database {
  let database: Database | undefined;
  try {
    // The production namespace belongs to the effective OS user, never HOME,
    // OPENCODEX_HOME, Desktop library overrides or an environment test switch.
    const path = deps.lockPath === undefined
      ? join(resolveEffectiveUserRuntimeRoot(resolveEffectiveUserIdentity()), "client-desktop-lifecycle.sqlite")
      : resolve(deps.lockPath);
    preparePath(path);
    database = new Database(path, { create: true });
    database.exec("PRAGMA locking_mode = NORMAL; PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    return database;
  } catch (error) {
    try { database?.close(); } catch { /* preserve acquisition failure */ }
    const code = errorCode(error);
    if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED"
      || (error instanceof Error && /database (?:is|table is) locked/i.test(error.message))) {
      throw new ClientLifecycleError("client_lifecycle_busy");
    }
    throw new ClientLifecycleError("client_lifecycle_lock_failed", { cause: error });
  }
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

function finish<T>(database: Database, outcome: Outcome<T>): T {
  let release: Outcome<void> = { ok: true, value: undefined };
  try { database.exec("ROLLBACK"); }
  catch (error) { release = { ok: false, error }; }
  // Always close, including when rollback throws. SQLite/OS owns crash release;
  // never unlink a lock database or infer lock ownership from a stale PID.
  try { database.close(); }
  catch (error) { if (release.ok) release = { ok: false, error }; }
  if (!outcome.ok) throw outcome.error; // Includes a literal `throw undefined`.
  if (!release.ok) throw new ClientLifecycleError("client_lifecycle_lock_failed", { cause: release.error });
  return outcome.value;
}

export async function withClientLifecycle<T>(
  work: (held: ClientLifecycleHeld) => Promise<T>,
  deps: ClientLifecycleLockDeps = {},
): Promise<T> {
  const database = acquire(deps);
  const held = Object.freeze({}) as ClientLifecycleHeld;
  activeLeases.add(held);
  let outcome: Outcome<T>;
  try { outcome = { ok: true, value: await work(held) }; }
  catch (error) { outcome = { ok: false, error }; }
  finally { activeLeases.delete(held); }
  return finish(database, outcome);
}

export function withClientLifecycleSync<T>(
  work: (held: ClientLifecycleHeld) => T,
  deps: ClientLifecycleLockDeps = {},
): T {
  const database = acquire(deps);
  const held = Object.freeze({}) as ClientLifecycleHeld;
  activeLeases.add(held);
  let outcome: Outcome<T>;
  try {
    const value = work(held);
    if (value !== null && (typeof value === "object" || typeof value === "function")
      && typeof (value as { then?: unknown }).then === "function") {
      // Observe native rejected promises without invoking arbitrary thenables.
      if (value instanceof Promise) void Promise.prototype.then.call(value, undefined, () => undefined);
      throw new ClientLifecycleError("client_lifecycle_async_callback");
    }
    outcome = { ok: true, value };
  } catch (error) { outcome = { ok: false, error }; }
  finally { activeLeases.delete(held); }
  return finish(database, outcome);
}
