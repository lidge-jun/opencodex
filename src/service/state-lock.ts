import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const SERVICE_STATE_LOCK_WAIT_MS = 2_000;
const SERVICE_STATE_LOCK_POLL_MS = 20;
const SERVICE_STATE_LOCK_STALE_MS = 30_000;
const PROCESS_INSTANCE = randomUUID();

interface ServiceStateLockRecord {
  readonly version: 1;
  readonly pid: number;
  readonly processInstance: string;
  readonly token: string;
  readonly createdAt: number;
}

interface ServiceStateLockSnapshot {
  readonly record: ServiceStateLockRecord;
  readonly ownerPath: string;
  readonly lockIdentity: Pick<Stats, "dev" | "ino">;
  readonly ownerIdentity: Pick<Stats, "dev" | "ino" | "size">;
  readonly mtimeMs: number;
}

export interface ServiceStateLockHooks {
  readonly now?: () => number;
  readonly sleep?: (ms: number) => void;
  readonly processAlive?: (pid: number) => boolean;
  readonly beforeStaleDelete?: (lockPath: string) => void;
  readonly beforeRelease?: (lockPath: string) => void;
}

interface HeldServiceStateLock {
  depth: number;
  readonly snapshot: ServiceStateLockSnapshot;
}

const heldLocks = new Map<string, HeldServiceStateLock>();

function lockPathForStatePath(statePath: string): string {
  try { return `${realpathSync.native(statePath)}.lock`; }
  catch {
    try { return join(realpathSync.native(dirname(statePath)), `${basename(statePath)}.lock`); }
    catch { return `${statePath}.lock`; }
  }
}

function lockOwnerProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but this account cannot signal it. Unknown failures
    // also fail closed: only ESRCH proves the holder is gone.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function sameIdentity(
  left: Pick<Stats, "dev" | "ino">,
  right: Pick<Stats, "dev" | "ino">,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function ownerFileName(record: ServiceStateLockRecord): string {
  return `v1-${record.pid}-${record.processInstance}-${record.token}.json`;
}

function parseOwnerFileName(name: string): { pid: number; pathToken: string } | null {
  const match = /^v1-([1-9][0-9]*)-([0-9a-f-]+)-([0-9a-f-]+)[.]json$/i.exec(name);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? { pid, pathToken: `${match[2]}-${match[3]}` } : null;
}

function readLockSnapshot(lockPath: string): ServiceStateLockSnapshot | null {
  let lockIdentity: Stats;
  let entries: string[];
  try {
    lockIdentity = lstatSync(lockPath);
    if (!lockIdentity.isDirectory()) return null;
    entries = readdirSync(lockPath);
  } catch {
    return null;
  }
  if (entries.length !== 1 || !parseOwnerFileName(entries[0]!)) return null;
  const ownerPath = join(lockPath, entries[0]!);
  try {
    const ownerIdentity = lstatSync(ownerPath);
    if (!ownerIdentity.isFile() || ownerIdentity.size > 4096) return null;
    const value = JSON.parse(readFileSync(ownerPath, "utf8")) as Partial<ServiceStateLockRecord>;
    if (value.version !== 1 || !Number.isSafeInteger(value.pid) || (value.pid ?? 0) <= 0
      || typeof value.processInstance !== "string" || value.processInstance.length === 0
      || typeof value.token !== "string" || value.token.length === 0
      || typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return null;
    const record = value as ServiceStateLockRecord;
    if (entries[0] !== ownerFileName(record)) return null;
    const currentLock = lstatSync(lockPath);
    const currentOwner = lstatSync(ownerPath);
    if (!currentLock.isDirectory() || !sameIdentity(lockIdentity, currentLock)
      || !currentOwner.isFile() || !sameIdentity(ownerIdentity, currentOwner)
      || currentOwner.size !== ownerIdentity.size) return null;
    return { record, ownerPath, lockIdentity, ownerIdentity, mtimeMs: ownerIdentity.mtimeMs };
  } catch {
    return null;
  }
}

function sameLock(left: ServiceStateLockSnapshot, right: ServiceStateLockSnapshot): boolean {
  return left.record.token === right.record.token
    && left.record.pid === right.record.pid
    && left.record.processInstance === right.record.processInstance
    && sameIdentity(left.lockIdentity, right.lockIdentity)
    && sameIdentity(left.ownerIdentity, right.ownerIdentity)
    && left.ownerIdentity.size === right.ownerIdentity.size;
}

function parsedIncompleteOwner(lockPath: string): { ownerPath: string | null; pid: number | null; mtimeMs: number } | null {
  try {
    const lock = lstatSync(lockPath);
    if (!lock.isDirectory()) return null;
    const entries = readdirSync(lockPath);
    if (entries.length === 0) return { ownerPath: null, pid: null, mtimeMs: lock.mtimeMs };
    if (entries.length !== 1) return null;
    const parsed = parseOwnerFileName(entries[0]!);
    if (!parsed) return null;
    const ownerPath = join(lockPath, entries[0]!);
    const owner = lstatSync(ownerPath);
    return owner.isFile() ? { ownerPath, pid: parsed.pid, mtimeMs: owner.mtimeMs } : null;
  } catch {
    return null;
  }
}

function reclaimStaleLock(lockPath: string, hooks: ServiceStateLockHooks): boolean {
  const now = hooks.now ?? Date.now;
  const processAlive = hooks.processAlive ?? lockOwnerProcessAlive;
  const snapshot = readLockSnapshot(lockPath);
  const incomplete = snapshot ? null : parsedIncompleteOwner(lockPath);
  if (!snapshot && !incomplete) return false;
  const ownerPath = snapshot?.ownerPath ?? incomplete!.ownerPath;
  const ownerPid = snapshot?.record.pid ?? incomplete!.pid;
  const createdAt = snapshot ? Math.max(snapshot.record.createdAt, snapshot.mtimeMs) : incomplete!.mtimeMs;
  if (now() - createdAt <= SERVICE_STATE_LOCK_STALE_MS || (ownerPid !== null && processAlive(ownerPid))) {
    return false;
  }
  if (snapshot) {
    const current = readLockSnapshot(lockPath);
    if (!current || !sameLock(snapshot, current)) return false;
  }
  hooks.beforeStaleDelete?.(lockPath);
  try {
    // The owner filename contains the holder's PID, process-instance nonce and token. A
    // successor has a different name, so this unlink cannot delete the successor's owner.
    if (ownerPath) unlinkSync(ownerPath);
    rmdirSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function acquireOne(lockPath: string, hooks: ServiceStateLockHooks, waitMs: number): ServiceStateLockSnapshot {
  const held = heldLocks.get(lockPath);
  if (held) { held.depth += 1; return held.snapshot; }
  const now = hooks.now ?? Date.now;
  const sleep = hooks.sleep ?? (ms => Bun.sleepSync(ms));
  const deadline = now() + waitMs;
  if (!existsSync(dirname(lockPath))) mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  for (;;) {
    const record: ServiceStateLockRecord = {
      version: 1,
      pid: process.pid,
      processInstance: PROCESS_INSTANCE,
      token: randomUUID(),
      createdAt: now(),
    };
    const ownerPath = join(lockPath, ownerFileName(record));
    let createdDirectory = false;
    let descriptor: number | null = null;
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      createdDirectory = true;
      descriptor = openSync(ownerPath, "wx", 0o600);
      writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      const snapshot = readLockSnapshot(lockPath);
      if (!snapshot || snapshot.record.token !== record.token) throw new Error("service state lock ownership could not be verified");
      heldLocks.set(lockPath, { depth: 1, snapshot });
      return snapshot;
    } catch (error) {
      if (descriptor !== null) { try { closeSync(descriptor); } catch { /* best-effort */ } }
      if (createdDirectory) {
        try { unlinkSync(ownerPath); } catch { /* incomplete owner may remain for dead-PID recovery */ }
        try { rmdirSync(lockPath); } catch { /* another entry or uncertain owner remains */ }
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      if (reclaimStaleLock(lockPath, hooks)) continue;
      if (now() >= deadline) {
        throw new Error(`another process owns the service state lock at ${lockPath}; nothing was written`);
      }
      sleep(SERVICE_STATE_LOCK_POLL_MS);
    }
  }
}

function releaseOne(lockPath: string, hooks: ServiceStateLockHooks): void {
  const held = heldLocks.get(lockPath);
  if (!held) return;
  held.depth -= 1;
  if (held.depth > 0) return;
  heldLocks.delete(lockPath);
  hooks.beforeRelease?.(lockPath);
  try {
    const current = readLockSnapshot(lockPath);
    if (!current || !sameLock(held.snapshot, current)) return;
    unlinkSync(held.snapshot.ownerPath);
    rmdirSync(lockPath);
  } catch { /* a verified future holder or stale recovery owns cleanup */ }
}

export function assertServiceStateLocksOwned(statePaths: readonly string[]): void {
  for (const path of statePaths) {
    const lockPath = lockPathForStatePath(path);
    const held = heldLocks.get(lockPath);
    const current = readLockSnapshot(lockPath);
    if (!held || !current || !sameLock(held.snapshot, current)) {
      throw new Error(`service state lock ownership changed before commit: ${lockPath}`);
    }
  }
}

export function withServiceStateLocks<T>(
  statePaths: readonly string[],
  run: () => T,
  options: { readonly waitMs?: number; readonly hooks?: ServiceStateLockHooks } = {},
): T {
  const hooks = options.hooks ?? {};
  const lockPaths = [...new Set(statePaths.map(lockPathForStatePath))].sort();
  const acquired: string[] = [];
  try {
    for (const lockPath of lockPaths) {
      acquireOne(lockPath, hooks, options.waitMs ?? SERVICE_STATE_LOCK_WAIT_MS);
      acquired.push(lockPath);
    }
    return run();
  } finally {
    for (const lockPath of acquired.reverse()) releaseOne(lockPath, hooks);
  }
}
