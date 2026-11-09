import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { isProcessAlive } from "../lib/process-control";
import { sameFileIdentity, type FileIdentity } from "../lib/file-identity";
import { sameFingerprint, stableShimPathProbe, type ShimPathFingerprint } from "./shim-fingerprint";
import { fileErrorCode } from "./shim-state-file";

const CODEX_SHIM_RESTORE_LOCK_STALE_MS = 30_000;

interface ShimRestoreLock {
  release(): void;
}

interface ShimRestoreLockRecord {
  version: 1;
  token: string;
  pid: number;
  createdAt: number;
}

interface ShimRestoreLockOwner {
  record: ShimRestoreLockRecord;
  ownerPath: string;
  fingerprint: ShimPathFingerprint;
}

interface ShimRestoreLockSnapshot {
  lockIdentity: FileIdentity;
  /** Sorted by owner filename so two snapshots compare entry by entry. */
  owners: ShimRestoreLockOwner[];
}

function restoreLockPath(): string {
  return join(getConfigDir(), "codex-shim.autorestore.lock");
}

function readShimRestoreLockOwner(path: string, entry: string): ShimRestoreLockOwner | null {
  if (!entry.endsWith(".json")) return null;
  const ownerPath = join(path, entry);
  const probe = stableShimPathProbe(ownerPath);
  if (!probe || probe.fingerprint.kind !== "file" || probe.fingerprint.size > 4096) return null;
  try {
    const value = JSON.parse(probe.prefix) as Partial<ShimRestoreLockRecord>;
    if (value.version !== 1 || typeof value.token !== "string" || value.token.length === 0
      || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0
      || typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return null;
    if (entry !== `${value.token}.json`) return null;
    return { record: value as ShimRestoreLockRecord, ownerPath, fingerprint: probe.fingerprint };
  } catch {
    return null;
  }
}

/**
 * Every entry must be a valid token-named owner record; one unaccounted entry (foreign file,
 * unparsable or empty record, mismatched name) makes the whole lock unreadable. A normal lock
 * holds one owner. Two or more are not produced by the current acquire path, but have been
 * observed in the field (#8317) and must stay recoverable rather than block repair forever.
 */
function readShimRestoreLockSnapshot(path: string): ShimRestoreLockSnapshot | null {
  let lockIdentity: BigIntStats;
  let entries: string[];
  try {
    lockIdentity = lstatSync(path, { bigint: true });
    if (!lockIdentity.isDirectory()) return null;
    entries = readdirSync(path).sort();
  } catch {
    return null;
  }
  if (entries.length === 0) return null;
  const owners: ShimRestoreLockOwner[] = [];
  for (const entry of entries) {
    const owner = readShimRestoreLockOwner(path, entry);
    if (!owner) return null;
    owners.push(owner);
  }
  try {
    const currentLockIdentity = lstatSync(path, { bigint: true });
    if (!currentLockIdentity.isDirectory() || !sameFileIdentity(lockIdentity, currentLockIdentity)) return null;
  } catch {
    return null;
  }
  return { lockIdentity, owners };
}

/** Release only ever removes a lock it solely owns; an ambiguous set is left to stale recovery. */
function soleShimRestoreLockOwner(path: string): ShimRestoreLockOwner | null {
  const snapshot = readShimRestoreLockSnapshot(path);
  return snapshot?.owners.length === 1 ? snapshot.owners[0] : null;
}

function sameShimRestoreLock(left: ShimRestoreLockSnapshot, right: ShimRestoreLockSnapshot): boolean {
  return sameFileIdentity(left.lockIdentity, right.lockIdentity)
    && left.owners.length === right.owners.length
    && left.owners.every((owner, index) => owner.record.token === right.owners[index].record.token
      && sameFingerprint(owner.fingerprint, right.owners[index].fingerprint));
}

/**
 * Reclaim requires every owner record to be past the stale window and to name a dead PID.
 * Any live, fresh or unaccounted entry keeps the lock: age alone never evicts a live holder,
 * and an entry this code cannot attribute might belong to an owner it cannot judge.
 */
function reclaimStaleRestoreLock(path: string, beforeDelete?: () => void): boolean {
  const observed = readShimRestoreLockSnapshot(path);
  if (!observed) return false;
  const now = Date.now();
  for (const owner of observed.owners) {
    const createdAt = Math.max(owner.record.createdAt, owner.fingerprint.mtimeMs);
    if (now - createdAt <= CODEX_SHIM_RESTORE_LOCK_STALE_MS) return false;
    if (isProcessAlive(owner.record.pid)) return false;
  }
  const current = readShimRestoreLockSnapshot(path);
  if (!current || !sameShimRestoreLock(observed, current)) return false;
  beforeDelete?.();
  try {
    // The token is part of each owner filename. Even if the lock directory is
    // replaced after the comparison, these unlinks cannot target a successor's
    // differently named owner record. A failure part-way leaves a smaller set
    // of the same dead owners, which the next attempt reclaims.
    for (const owner of observed.owners) unlinkSync(owner.ownerPath);
    rmdirSync(path);
    return true;
  } catch {
    return false;
  }
}

function tryAcquireShimRestoreLock(beforeStaleDelete?: () => void): ShimRestoreLock | null {
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = restoreLockPath();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number | null = null;
    let identity: BigIntStats | null = null;
    let createdDirectory = false;
    const record: ShimRestoreLockRecord = {
      version: 1,
      token: `${process.pid}-${Date.now()}-${randomUUID()}`,
      pid: process.pid,
      createdAt: Date.now(),
    };
    const ownerPath = join(path, `${record.token}.json`);
    try {
      mkdirSync(path, { mode: 0o700 });
      createdDirectory = true;
      fd = openSync(ownerPath, "wx", 0o600);
      identity = fstatSync(fd, { bigint: true });
      writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
      identity = fstatSync(fd, { bigint: true });
      let released = false;
      return {
        release(): void {
          if (released) return;
          released = true;
          try { closeSync(fd!); } catch { /* stale recovery handles an uncertain lock */ }
          try {
            const current = soleShimRestoreLockOwner(path);
            if (identity && current && current.record.token === record.token
              && sameFileIdentity(identity, current.fingerprint.identity)) {
              unlinkSync(ownerPath);
              rmdirSync(path);
            }
          } catch { /* stale recovery handles release failures */ }
        },
      };
    } catch (error) {
      if (fd !== null) {
        try { closeSync(fd); } catch { /* best-effort close before ownership cleanup */ }
        try {
          const current = soleShimRestoreLockOwner(path);
          if (identity && current && current.record.token === record.token
            && sameFileIdentity(identity, current.fingerprint.identity)) {
            unlinkSync(ownerPath);
            rmdirSync(path);
          }
        } catch { /* leave an uncertain lock for stale recovery */ }
      } else if (createdDirectory) {
        try { rmdirSync(path); } catch { /* another owner exists or cleanup is uncertain */ }
      }
      if (fileErrorCode(error) !== "EEXIST") throw error;
      if (attempt === 0 && reclaimStaleRestoreLock(path, beforeStaleDelete)) continue;
      return null;
    }
  }
  return null;
}

export { tryAcquireShimRestoreLock, reclaimStaleRestoreLock };
