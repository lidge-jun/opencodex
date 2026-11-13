/**
 * The per-alias lock that enrollment and revoke of a Home-initiated link take (structure/remote-link.md,
 * "Operation journal"). One private SQLite file per alias (lowercased, hashed) under <configDir>/link/locks, held
 * with BEGIN IMMEDIATE for the whole operation, so a second holder anywhere, this process included, waits. The OS
 * releases it when the holding process dies, which is what lets a repeat recover an open journal entry.
 *
 * Waiting polls with an injected sleep and clock up to a bound; past it the caller answers 409.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { hardenSecretDir, hardenSecretPath } from "../lib/windows-secret-acl";
import { linkDir } from "./paths";

export interface AliasLockDeps {
  /** Defaults to <configDir>/link/locks. */
  lockDir?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** How long a second holder waits; defaults to the enrollment deadline. */
  waitMs?: number;
  pollMs?: number;
}

export interface AliasLock { release(): void }

export const ALIAS_LOCK_WAIT_MS = 360_000;
const ALIAS_LOCK_POLL_MS = 250;

export class AliasLockError extends Error {
  constructor(readonly code: "link_alias_lock_busy" | "link_alias_lock_failed", options?: ErrorOptions) {
    super(code, options);
    this.name = "AliasLockError";
  }
}

export function aliasLockPath(alias: string, lockDir: string = join(linkDir(), "locks")): string {
  return join(lockDir, createHash("sha256").update(alias.toLowerCase()).digest("hex").slice(0, 32) + ".lock");
}

function errorCode(error: unknown): unknown {
  return error !== null && typeof error === "object" && "code" in error ? (error as { code: unknown }).code : undefined;
}

function assertPrivate(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw new AliasLockError("link_alias_lock_failed");
  if (process.platform !== "win32" && stat.uid !== process.getuid!()) throw new AliasLockError("link_alias_lock_failed");
}

function prepare(path: string, directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertPrivate(directory, true);
  if (process.platform !== "win32") chmodSync(directory, 0o700);
  hardenSecretDir(directory, { required: true });
  // Created privately before SQLite opens it; an existing symlink or hard link is refused, never followed.
  try { closeSync(openSync(path, "wx", 0o600)); } catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
  assertPrivate(path, false);
  if (process.platform !== "win32") chmodSync(path, 0o600);
  hardenSecretPath(path, { required: true });
}

function tryAcquire(path: string): Database | null {
  let database: Database | undefined;
  try {
    database = new Database(path, { create: true });
    database.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    return database;
  } catch (error) {
    try { database?.close(); } catch { /* the acquisition failure is what matters */ }
    const code = errorCode(error);
    if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || (error instanceof Error && /database (?:is|table is) locked/i.test(error.message))) return null;
    throw new AliasLockError("link_alias_lock_failed", { cause: error });
  }
}

/** Take the alias lock, waiting while another holder has it; AliasLockError link_alias_lock_busy past the bound. */
export async function acquireAliasLock(alias: string, deps: AliasLockDeps = {}): Promise<AliasLock> {
  const directory = deps.lockDir ?? join(linkDir(), "locks");
  const path = aliasLockPath(alias, directory);
  try { prepare(path, directory); } catch (error) {
    throw error instanceof AliasLockError ? error : new AliasLockError("link_alias_lock_failed", { cause: error });
  }
  const now = deps.now ?? Date.now, sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const deadline = now() + (deps.waitMs ?? ALIAS_LOCK_WAIT_MS);
  for (;;) {
    const database = tryAcquire(path);
    if (database) {
      let held = true;
      return { release() {
        if (!held) return;
        held = false;
        try { database.exec("ROLLBACK"); } catch { /* close releases the OS lock regardless */ }
        database.close();
      } };
    }
    if (now() >= deadline) throw new AliasLockError("link_alias_lock_busy");
    await sleep(deps.pollMs ?? ALIAS_LOCK_POLL_MS);
  }
}

export async function withAliasLock<T>(alias: string, deps: AliasLockDeps, action: () => Promise<T>): Promise<T> {
  const lock = await acquireAliasLock(alias, deps);
  try { return await action(); } finally { lock.release(); }
}
