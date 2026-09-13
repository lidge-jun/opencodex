/**
 * Singleton lock for desktop-app restarts.
 *
 * Two restarts running at once are not merely wasteful, they are destructive: the
 * first quits the app and relaunches it, the second re-enumerates during that window,
 * sees the FRESHLY STARTED shell as a target, and kills it. Two
 * `ocx sync --restart-codex` runs, or one handoff racing an ssh-issued direct run,
 * are enough to produce it.
 *
 * Contended callers do not queue. Queueing would rebuild the same race one step
 * later, so a caller that cannot take the lock reports `restart_in_flight` and stops.
 *
 * Two properties make the wp5 handoff work on top of this:
 *
 * - **Own-pid reentrancy.** A lock already naming this pid counts as held, not as
 *   contention. That is what lets the detached helper run the ordinary ladder — the
 *   caller hands it a lock already made out to it, and the helper takes no special
 *   path. Without this the feature deadlocks: the caller holds the lock, discovers
 *   it is inside the tree, and spawns a helper that waits for a lock its own parent
 *   is holding.
 * - **Compare-and-delete release.** A process only ever deletes a lock naming
 *   itself. An unconditional unlink would let a late release destroy somebody else's
 *   live lock, which is exactly the mutual exclusion this file exists to provide.
 *
 * Design: `devlog/_plan/260913_cross_platform_desktop_app_restart/020_phase2_detached_self_handoff.md` §4.1.
 */
import { mkdirSync, openSync, closeSync, writeSync, readFileSync, unlinkSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { getConfigDir } from "../../config/paths";

/** A lock older than this is stale regardless of what its owner pid says. */
const LOCK_MAX_AGE_MS = 5 * 60_000;

export interface DesktopRestartLockRecord {
  ownerPid: number;
  createdAtMs: number;
}

export interface DesktopRestartLockIo {
  lockPath?: string;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  pid?: number;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readRecord(path: string): DesktopRestartLockRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const view = parsed as Record<string, unknown>;
    const ownerPid = view.ownerPid;
    const createdAtMs = view.createdAtMs;
    if (typeof ownerPid !== "number" || !Number.isSafeInteger(ownerPid) || ownerPid <= 0) return null;
    if (typeof createdAtMs !== "number" || !Number.isFinite(createdAtMs)) return null;
    return { ownerPid, createdAtMs };
  } catch {
    // Unreadable or malformed: treat as absent so a corrupted file cannot wedge every
    // future restart. The staleness rules below still bound how long a real lock holds.
    return null;
  }
}

/**
 * Exclusive create ON THE LOCK PATH. This is the whole mutual exclusion.
 *
 * The obvious-looking alternative - write a staging file with `wx` and `rename` it
 * over the lock - is NOT exclusive: `wx` on a unique staging name always succeeds, and
 * both racers then rename, so both believe they hold the lock and each kills the
 * other's freshly relaunched app. The exclusivity has to come from `O_EXCL` on the
 * contended path itself.
 */
function tryCreateExclusive(path: string, record: DesktopRestartLockRecord): boolean {
  mkdirSync(dirname(path), { recursive: true });
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch {
    return false;
  }
  try {
    writeSync(fd, JSON.stringify(record));
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Atomic replace, used ONLY by an owner handing the lock to its helper.
 *
 * Safe there precisely because it is not the contended path: the caller already holds
 * the lock, so there is no race to lose.
 */
function writeRecord(path: string, record: DesktopRestartLockRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  const staging = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  const fd = openSync(staging, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify(record));
  } finally {
    closeSync(fd);
  }
  renameSync(staging, path);
}

export type DesktopRestartLockAcquisition =
  | { acquired: true; record: DesktopRestartLockRecord }
  | { acquired: false; heldBy: number };

/**
 * Take the lock, or report who holds it.
 *
 * Staleness is decided by owner liveness first and age second. Both read liveness by
 * pid, so both inherit a small exposure: a recycled pid inside the window reads as
 * "still alive" and produces a false `restart_in_flight`. That fails in the safe
 * direction — a restart that did not happen, rather than one that happened to the
 * wrong process — and the age bound stops it lasting.
 */
export function acquireDesktopRestartLock(
  io: DesktopRestartLockIo = {},
): DesktopRestartLockAcquisition {
  const path = io.lockPath ?? defaultLockPath();
  const isAlive = io.isAlive ?? defaultIsAlive;
  const now = io.now ?? Date.now;
  const self = io.pid ?? process.pid;

  const existing = readRecord(path);
  if (existing) {
    // Own-pid reentrancy: a lock handed to us, or one we already hold.
    if (existing.ownerPid === self) return { acquired: true, record: existing };
    const stale = !isAlive(existing.ownerPid) || now() - existing.createdAtMs > LOCK_MAX_AGE_MS;
    if (!stale) return { acquired: false, heldBy: existing.ownerPid };
    // Stale. Clear it and then compete for the exclusive create like anyone else rather
    // than writing straight over it: two processes can observe the same stale lock, and
    // only O_EXCL decides which of them actually gets it.
    try {
      unlinkSync(path);
    } catch {
      /* somebody else cleared it first, which is fine - the create below still decides */
    }
  }

  const record: DesktopRestartLockRecord = { ownerPid: self, createdAtMs: now() };
  if (tryCreateExclusive(path, record)) return { acquired: true, record };

  const winner = readRecord(path);
  if (winner && winner.ownerPid === self) return { acquired: true, record: winner };
  if (winner) {
    // Lost the race fairly. Reporting contention is the honest answer; retrying would be
    // the queue this deliberately avoids, and queueing rebuilds the same race one step
    // later.
    return { acquired: false, heldBy: winner.ownerPid };
  }

  // The file exists but names nobody: truncated, corrupt, or left behind by a writer
  // that died between creating it and writing it. Without this it would block every
  // future restart forever, reported as contention with an owner of 0 - a lock nobody
  // holds and nobody can clear. Remove it and make exactly one more attempt, so a real
  // winner that appears in between still keeps the lock.
  try {
    unlinkSync(path);
  } catch {
    /* somebody else cleared it first */
  }
  if (tryCreateExclusive(path, record)) return { acquired: true, record };
  const successor = readRecord(path);
  if (successor && successor.ownerPid === self) return { acquired: true, record: successor };
  return { acquired: false, heldBy: successor?.ownerPid ?? 0 };
}

/**
 * Hand the lock to a process that does not exist yet as far as the lock is concerned.
 *
 * Called only after a successful helper spawn. Doing it before would strand the lock
 * on a pid that never came into being, and the next restart would have to wait out
 * the staleness window for no reason.
 */
export function transferDesktopRestartLock(
  toPid: number,
  io: DesktopRestartLockIo = {},
): boolean {
  const path = io.lockPath ?? defaultLockPath();
  const now = io.now ?? Date.now;
  const self = io.pid ?? process.pid;
  const existing = readRecord(path);
  if (!existing || existing.ownerPid !== self) return false;
  try {
    writeRecord(path, { ownerPid: toPid, createdAtMs: now() });
    return true;
  } catch {
    return false;
  }
}

/** Who currently holds the lock, or null when nobody does or it is unreadable. */
export function readDesktopRestartLockOwner(io: DesktopRestartLockIo = {}): number | null {
  return readRecord(io.lockPath ?? defaultLockPath())?.ownerPid ?? null;
}

/** Compare-and-delete. Never removes a lock owned by another process. */
export function releaseDesktopRestartLock(io: DesktopRestartLockIo = {}): void {
  const path = io.lockPath ?? defaultLockPath();
  const self = io.pid ?? process.pid;
  const existing = readRecord(path);
  if (!existing || existing.ownerPid !== self) return;
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

export function defaultLockPath(): string {
  // getConfigDir owns OPENCODEX_HOME resolution, including ~ expansion and the caching
  // every other consumer sees. Re-deriving it here would drift from it.
  return join(getConfigDir(), "desktop-restart.lock");
}
