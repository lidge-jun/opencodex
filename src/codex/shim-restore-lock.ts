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
  type Stats,
} from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { isProcessAlive } from "../lib/process-control";
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

interface ShimRestoreLockSnapshot {
  record: ShimRestoreLockRecord;
  ownerPath: string;
  lockIdentity: Pick<Stats, "dev" | "ino">;
  fingerprint: ShimPathFingerprint;
}

function restoreLockPath(): string {
  return join(getConfigDir(), "codex-shim.autorestore.lock");
}

function sameFileIdentity(left: Pick<Stats, "dev" | "ino">, right: Pick<Stats, "dev" | "ino">): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function readShimRestoreLockSnapshot(path: string): ShimRestoreLockSnapshot | null {
  let lockIdentity: Stats;
  let entries: string[];
  try {
    lockIdentity = lstatSync(path);
    if (!lockIdentity.isDirectory()) return null;
    entries = readdirSync(path);
  } catch {
    return null;
  }
  if (entries.length !== 1 || !entries[0].endsWith(".json")) return null;
  const ownerPath = join(path, entries[0]);
  const probe = stableShimPathProbe(ownerPath);
  if (!probe || probe.fingerprint.kind !== "file" || probe.fingerprint.size > 4096) return null;
  try {
    const value = JSON.parse(probe.prefix) as Partial<ShimRestoreLockRecord>;
    if (value.version !== 1 || typeof value.token !== "string" || value.token.length === 0
      || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0
      || typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return null;
    if (entries[0] !== `${value.token}.json`) return null;
    const currentLockIdentity = lstatSync(path);
    if (!currentLockIdentity.isDirectory() || !sameFileIdentity(lockIdentity, currentLockIdentity)) return null;
    return {
      record: value as ShimRestoreLockRecord,
      ownerPath,
      lockIdentity,
      fingerprint: probe.fingerprint,
    };
  } catch {
    return null;
  }
}

function sameShimRestoreLock(left: ShimRestoreLockSnapshot, right: ShimRestoreLockSnapshot): boolean {
  return left.record.token === right.record.token
    && sameFileIdentity(left.lockIdentity, right.lockIdentity)
    && sameFingerprint(left.fingerprint, right.fingerprint);
}

function reclaimStaleRestoreLock(path: string, beforeDelete?: () => void): boolean {
  const observed = readShimRestoreLockSnapshot(path);
  if (!observed) return false;
  const createdAt = Math.max(observed.record.createdAt, observed.fingerprint.mtimeMs);
  if (Date.now() - createdAt <= CODEX_SHIM_RESTORE_LOCK_STALE_MS) return false;
  if (isProcessAlive(observed.record.pid)) return false;
  const current = readShimRestoreLockSnapshot(path);
  if (!current || !sameShimRestoreLock(observed, current)) return false;
  beforeDelete?.();
  try {
    // The token is part of the owner filename. Even if the lock directory is
    // replaced after the comparison, this unlink cannot target a successor's
    // differently named owner record.
    unlinkSync(observed.ownerPath);
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
    let identity: Stats | null = null;
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
      identity = fstatSync(fd);
      writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
      identity = fstatSync(fd);
      let released = false;
      return {
        release(): void {
          if (released) return;
          released = true;
          try { closeSync(fd!); } catch { /* stale recovery handles an uncertain lock */ }
          try {
            const current = readShimRestoreLockSnapshot(path);
            if (identity && current && current.record.token === record.token
              && sameFileIdentity(identity, current.fingerprint)) {
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
          const current = readShimRestoreLockSnapshot(path);
          if (identity && current && current.record.token === record.token
            && sameFileIdentity(identity, current.fingerprint)) {
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
