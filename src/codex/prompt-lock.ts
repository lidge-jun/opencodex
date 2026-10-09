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
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { checkEntry, guarded, type Entry } from "./prompt-lock-evidence";
import { randomBytes } from "node:crypto";
import { UnsafeLockNamespace, withLockClaim } from "./prompt-lock-claim";

import { ownerDefaults, ownEvidence, ownerState, safeNamespace, type OwnerDeps, type OwnerEvidence } from "./prompt-lock-owner";

import { LockFileBusy, lockFileOperation } from "./prompt-lock-io";

const FILE_MODE = 0o600;

/** A lock younger than this is respected even if its pid looks gone. */
export const STALE_AFTER_MS = 10_000;

export interface LockRecord extends OwnerEvidence {
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
  | { ok: false; error: "locked" }
  | { ok: false; error: "unsafe"; detail: string };

export interface LockDeps extends Partial<OwnerDeps> {
  isProcessAlive: (pid: number) => boolean | undefined;
  now: () => number;
  onClaimInitialized?: () => void;
}
const defaultDeps: LockDeps = { ...ownerDefaults, now: () => Date.now() };

function readRecord(path: string, platform: NodeJS.Platform): LockRecord | null {
  try {
    const parsed = JSON.parse(lockFileOperation(() => readFileSync(path, "utf8"), platform)) as LockRecord;
    if (typeof parsed?.token !== "string" || typeof parsed?.pid !== "number") return null;
    return parsed;
  } catch (error) {
    if (error instanceof LockFileBusy) throw error;
    return null;
  }
}

/** One attempt, including namespace validation and serialized stale observation. */
export function tryAcquire(path: string, deps: LockDeps = defaultDeps): AcquireResult {
  const resolved = { ...ownerDefaults, ...deps };
  const token = randomBytes(8).toString("hex");
  try {
    if (!safeNamespace(path, "file", resolved, true)) throw new UnsafeLockNamespace(path);
    const reserved = withLockClaim(path, token, resolved,
      () => acquireReserved(path, token, resolved), deps.onClaimInitialized);
    return reserved.ok ? reserved.value : { ok: false, error: "locked" };
  } catch (error) {
    if (error instanceof LockFileBusy) return { ok: false, error: "locked" };
    if (error instanceof UnsafeLockNamespace) return { ok: false, error: "unsafe", detail: error.path };
    throw error;
  }
}

function acquireReserved(path: string, token: string, deps: OwnerDeps & LockDeps): AcquireResult {
  const parentPath = dirname(path);
  if (!safeNamespace(parentPath, "directory", deps)) throw new UnsafeLockNamespace(parentPath);
  const parents = [{ path: parentPath, stat: lockFileOperation(() => deps.lstat(parentPath), deps.platform) }];
  const io = <R>(operation: () => R): R => guarded(parents, [], deps, operation);
  const record: LockRecord = { token, ...ownEvidence(deps), acquiredAt: deps.now() };
  const body = JSON.stringify(record);

  try {
    io(() => writeFileSync(path, body, { encoding: "utf8", mode: FILE_MODE, flag: "wx" }));
    return { ok: true, handle: { path, token } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const observed = io(() => {
    const entry: Entry = { path, stat: deps.lstat(path), body: readFileSync(path, "utf8") };
    checkEntry(entry, deps);
    return entry;
  });
  let previous: LockRecord | null;
  // Same shape gate as readRecord: a malformed record is evidence, never a takeover target.
  try {
    const parsed = JSON.parse(observed.body) as LockRecord;
    previous = typeof parsed?.token === "string" && typeof parsed?.pid === "number" ? parsed : null;
  } catch { previous = null; }
  const state = ownerState(previous, deps);
  if (state === "unsafe") return { ok: false, error: "unsafe", detail: path };
  if (state !== "dead" || !previous || !Number.isFinite(previous.acquiredAt)
    || deps.now() - previous.acquiredAt <= STALE_AFTER_MS) return { ok: false, error: "locked" };

  // The reservation excludes cooperating writers; fence external replacements
  // and parent retargets again on every sharing-error retry.
  const quarantine = `${path}.stale-${token}`;
  try {
    guarded(parents, [observed], deps, () => renameSync(path, quarantine));
  } catch {
    // Someone else won the rename, or the owner released between our checks.
    // Either way we do NOT touch the path — retry from the top.
    return { ok: false, error: "locked" };
  }

  const moved = { ...observed, path: quarantine };
  const cleanup = () => {
    try { guarded(parents, [moved], deps, () => unlinkSync(quarantine)); } catch { /* Preserve changed or busy debris. */ }
  };
  try {
    io(() => writeFileSync(path, body, { encoding: "utf8", mode: FILE_MODE, flag: "wx" }));
  } catch (error) {
    // A successor acquired the real lock between our rename and this create.
    // Its lock is live and is not ours to remove.
    cleanup();
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return { ok: false, error: "locked" };
    throw error;
  }

  cleanup();
  return { ok: true, handle: { path, token } };
}

/**
 * Release. Deletes nothing unless the on-disk token is still ours; returns false
 * when we were superseded, which the caller surfaces as `write_superseded`.
 */
export function release(handle: LockHandle): boolean {
  try {
    const deps = ownerDefaults;
    if (!safeNamespace(handle.path, "file", deps) || !safeNamespace(dirname(handle.path), "directory", deps)) return false;
    const parents = [{ path: dirname(handle.path), stat: lockFileOperation(() => deps.lstat(dirname(handle.path)), deps.platform) }];
    const entry = guarded(parents, [], deps, () => {
      const saved = { path: handle.path, stat: deps.lstat(handle.path), body: readFileSync(handle.path, "utf8") };
      checkEntry(saved, deps);
      return saved;
    });
    if (JSON.parse(entry.body)?.token !== handle.token) return false;
    return guarded(parents, [entry], deps, () => { unlinkSync(handle.path); return true; });
  } catch { return false; }
}

/** True when the on-disk lock is still the one this handle acquired. */
export function stillHeld(handle: LockHandle): boolean {
  try {
    return safeNamespace(handle.path, "file", ownerDefaults)
      && readRecord(handle.path, ownerDefaults.platform)?.token === handle.token;
  } catch { return false; }
}
