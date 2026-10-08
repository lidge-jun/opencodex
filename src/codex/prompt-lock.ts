/**
 * prompt-lock.ts — advisory cross-process lock for prompt-layer mutations.
 *
 * An in-process mutex only serialises browser tabs behind one service. A CLI
 * invocation, a second service, or a stale process can all reach the same
 * files, so the lock lives on disk.
 *
 * STALE TAKEOVER IS A RENAME, NOT AN UNLINK. Naive breaking is racy: A judges
 * the lock stale, B removes it and acquires its own, then A unlinks *B's live
 * lock* and both proceed. Unlinking a path you did not verify is the bug. Here
 * the contender renames the observed stale lock to a token-quarantined name —
 * a serialized operation under a short, unique per-process reservation. The
 * reservation covers observation through creation: rename alone cannot stop
 * an old observation from moving a successor's live lock.
 *
 * RELEASE ONLY DELETES A LOCK WHOSE TOKEN IS STILL OURS. A mismatch means we
 * were superseded, and deleting it would hand the critical section to two
 * writers at once.
 *
 * This does NOT cover Codex, which knows nothing about our lock. That residual
 * is handled by the per-target byte checks in the write path, and the rename
 * window itself is documented as irreducible from user space.
 */
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { withLockClaim } from "./prompt-lock-claim";

const FILE_MODE = 0o600;

/** A lock younger than this is respected even if its pid looks gone. */
export const STALE_AFTER_MS = 10_000;

export interface LockRecord {
  token: string;
  pid: number;
  acquiredAt: number;
}

export interface LockHandle {
  path: string;
  token: string;
}

export type AcquireResult =
  | { ok: true; handle: LockHandle }
  | { ok: false; error: "locked" };

export interface LockDeps {
  /** Injectable so tests can simulate a live or dead owner. */
  isProcessAlive: (pid: number) => boolean;
  now: () => number;
}

const defaultDeps: LockDeps = {
  isProcessAlive: pid => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM means it exists but belongs to another user.
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  now: () => Date.now(),
};

function readRecord(path: string): LockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as LockRecord;
    if (typeof parsed?.token !== "string" || typeof parsed?.pid !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** True when the holder is gone AND the lock is older than the grace window. */
function isStale(path: string, record: LockRecord | null, deps: LockDeps): boolean {
  if (record === null) {
    // wx creates a file before writing its JSON. A fresh empty/truncated
    // record can be an initializing writer, not abandoned debris.
    try { return deps.now() - statSync(path).mtimeMs > STALE_AFTER_MS; }
    catch { return false; }
  }
  if (deps.isProcessAlive(record.pid)) return false;
  return deps.now() - record.acquiredAt > STALE_AFTER_MS;
}

/**
 * One attempt. The caller decides whether to retry — a loser must go back to
 * re-reading the lock rather than assuming its quarantine still applies.
 */
export function tryAcquire(path: string, deps: LockDeps = defaultDeps): AcquireResult {
  const token = randomBytes(8).toString("hex");
  const reserved = withLockClaim(path, token, defaultDeps.isProcessAlive, () => acquireReserved(path, token, deps));
  return reserved.ok ? reserved.value : { ok: false, error: "locked" };
}

function acquireReserved(path: string, token: string, deps: LockDeps): AcquireResult {
  const record: LockRecord = { token, pid: process.pid, acquiredAt: deps.now() };
  const body = JSON.stringify(record);

  try {
    writeFileSync(path, body, { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
    return { ok: true, handle: { path, token } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  if (!isStale(path, readRecord(path), deps)) return { ok: false, error: "locked" };

  // Quarantine under the reservation; no cooperating successor can replace
  // the observed stale record between our check and this rename.
  const quarantine = `${path}.stale-${token}`;
  try {
    renameSync(path, quarantine);
  } catch {
    // Someone else won the rename, or the owner released between our checks.
    // Either way we do NOT touch the path — retry from the top.
    return { ok: false, error: "locked" };
  }

  try {
    writeFileSync(path, body, { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
  } catch (error) {
    // A successor acquired the real lock between our rename and this create.
    // Its lock is live and is not ours to remove.
    try { unlinkSync(quarantine); } catch { /* debris */ }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return { ok: false, error: "locked" };
    throw error;
  }

  try { unlinkSync(quarantine); } catch { /* debris */ }
  return { ok: true, handle: { path, token } };
}

/**
 * Release. Deletes nothing unless the on-disk token is still ours; returns false
 * when we were superseded, which the caller surfaces as `write_superseded`.
 */
export function release(handle: LockHandle): boolean {
  const record = readRecord(handle.path);
  if (record === null || record.token !== handle.token) return false;
  try {
    unlinkSync(handle.path);
    return true;
  } catch {
    return false;
  }
}

/** True when the on-disk lock is still the one this handle acquired. */
export function stillHeld(handle: LockHandle): boolean {
  if (!existsSync(handle.path)) return false;
  return readRecord(handle.path)?.token === handle.token;
}
