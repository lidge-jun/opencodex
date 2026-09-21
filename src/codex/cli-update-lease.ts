/**
 * The one cross-process lease behind the Codex CLI update manager.
 *
 * A process scan is a snapshot, not mutual exclusion: an app-server can start after
 * the plan reads the table and before "npm install -g" mutates the global prefix, and
 * two apply commands can pass the same plan concurrently. This lockfile closes that
 * window — apply holds it from before the final scan through the post-install
 * readback, and the Codex startup paths this codebase controls (remote workspace
 * app-server spawn, desktop-app relaunch) observe it and refuse or wait.
 *
 * The record is self-identifying: every holder publishes a random `token`, and every
 * mutating transition (stale reclaim, release, heartbeat) compares that token against
 * what is actually on disk via a compare-and-delete that links the current file to a
 * tombstone before unlinking — a contender that observed record A can never unlink
 * record B, and a late release can never delete a successor that recycled the path.
 *
 * Publication is atomic where the filesystem allows it: the record is written to a
 * staging sibling and `linkSync`'d onto the contended path, so the lock file never
 * exists in the empty/half-written state that `openSync("wx")` + `writeSync` leaves.
 * Filesystems without hardlinks fall back to the O_EXCL create, and a corrupt record
 * younger than PUBLISH_GRACE_MS reads as held rather than deletable, so even there a
 * contender cannot steal the write window of an in-flight publisher.
 *
 * A live owner is never reaped by age alone: staleness needs a dead pid OR a
 * heartbeat older than the bound (`startCodexCliUpdateLeaseHeartbeat` keeps it
 * fresh for the length of a real install). A wedged holder whose heartbeats stopped
 * is still reclaimable; one that is merely slow is not.
 *
 * Deliberately NOT own-pid reentrant: two applies in one process are still two
 * contenders for one global install, and the second must see the lease as held.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { getConfigDir } from "../config/paths";

/**
 * A holder whose heartbeat is older than this is stale regardless of what its owner
 * pid says. The bound exists for a live pid that no longer names an updater (a
 * recycled pid, or a wedged holder); it is comfortably longer than the pack +
 * install timeouts a real apply can legitimately hold the lease for, and a healthy
 * holder heartbeats far below it.
 */
export const CODEX_CLI_UPDATE_LEASE_MAX_AGE_MS = 15 * 60_000;

/** Startup paths poll a held lease for this long before refusing the launch. */
export const CODEX_CLI_UPDATE_LEASE_WAIT_MS = 5_000;

/**
 * A record that exists on disk but fails to parse is treated as held for this long
 * after its mtime. On filesystems without hardlinks the O_EXCL fallback leaves a
 * brief empty window; deleting inside it would hand a second contender the lease
 * while the first is still writing.
 */
const PUBLISH_GRACE_MS = 10_000;

/** Heartbeat interval: comfortably below the staleness bound. */
const HEARTBEAT_INTERVAL_MS = 60_000;

export interface CodexCliUpdateLeaseRecord {
  readonly version: 1;
  readonly ownerPid: number;
  readonly createdAtMs: number;
  /** Self-identifying holder token; every mutating transition verifies it. */
  readonly token: string;
  /** Last heartbeat; older than the staleness bound means wedged even when pid lives. */
  readonly heartbeatAtMs: number;
  /** The plan id being applied. Diagnostics only; exclusion never reads it. */
  readonly planId: string | null;
}

export interface CodexCliUpdateLeaseIo {
  lockPath?: string;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  pid?: number;
  /** Test seam: force the O_EXCL publication fallback (hardlink-less filesystems). */
  forceExclusiveCreateFallback?: boolean;
}

export interface CodexCliUpdateLeaseWaitIo extends CodexCliUpdateLeaseIo {
  sleep?: (ms: number) => Promise<void>;
}

export type CodexCliUpdateLeaseAcquisition =
  | { acquired: true; record: CodexCliUpdateLeaseRecord }
  /** A live owner inside the staleness bound holds the lease. */
  | { acquired: false; reason: "held"; heldBy: number }
  /** The lock path could not be created or observed at all. */
  | { acquired: false; reason: "unavailable" };

export function defaultCodexCliUpdateLeasePath(): string {
  // getConfigDir owns OPENCODEX_HOME resolution; the lease sits beside
  // desktop-restart.lock so every Codex lifecycle guard shares one directory.
  return join(getConfigDir(), "codex-cli-update.lock");
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseRecord(raw: string): CodexCliUpdateLeaseRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const view = parsed as Record<string, unknown>;
  const ownerPid = view.ownerPid;
  const createdAtMs = view.createdAtMs;
  const token = view.token;
  const planId = view.planId;
  if (view.version !== 1) return null;
  if (typeof ownerPid !== "number" || !Number.isSafeInteger(ownerPid) || ownerPid <= 0) return null;
  if (typeof createdAtMs !== "number" || !Number.isFinite(createdAtMs)) return null;
  if (typeof token !== "string" || token.length === 0) return null;
  const heartbeatAtMs = view.heartbeatAtMs;
  return {
    version: 1,
    ownerPid,
    createdAtMs,
    token,
    heartbeatAtMs:
      typeof heartbeatAtMs === "number" && Number.isFinite(heartbeatAtMs)
        ? heartbeatAtMs
        : createdAtMs,
    planId: typeof planId === "string" ? planId : null,
  };
}

function readRecord(path: string): CodexCliUpdateLeaseRecord | null {
  try {
    return parseRecord(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function newToken(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Publish the record atomically: stage the full content on a unique sibling, then
 * hardlink it onto the contended path. `linkSync` fails with EEXIST if the lock
 * already exists, so the file is never observable without its full record. On a
 * filesystem without hardlinks the caller's O_EXCL fallback applies.
 */
function publishViaLink(path: string, record: CodexCliUpdateLeaseRecord): boolean {
  const staging = `${path}.staging-${process.pid}-${record.token}`;
  try {
    const fd = openSync(staging, "wx", 0o600);
    try {
      writeSync(fd, JSON.stringify(record));
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(staging, path);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return false;
      throw err;
    }
  } finally {
    try {
      unlinkSync(staging);
    } catch {
      /* staging already gone, or was never created */
    }
  }
}

/** O_EXCL fallback for filesystems that cannot hardlink (no atomic publish). */
function publishViaExclusiveCreate(path: string, record: CodexCliUpdateLeaseRecord): boolean {
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

/** Exclusive publish on the contended path — the whole mutual exclusion. */
function tryPublish(
  path: string,
  record: CodexCliUpdateLeaseRecord,
  io: CodexCliUpdateLeaseIo,
): boolean {
  mkdirSync(dirname(path), { recursive: true });
  if (io.forceExclusiveCreateFallback) return publishViaExclusiveCreate(path, record);
  try {
    return publishViaLink(path, record);
  } catch {
    return publishViaExclusiveCreate(path, record);
  }
}

/** Rewrite the lock in place. Only safe for the holder: it is not the contended path. */
function rewriteRecord(path: string, record: CodexCliUpdateLeaseRecord): void {
  const staging = `${path}.hb-${process.pid}-${record.token}`;
  const fd = openSync(staging, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify(record));
  } finally {
    closeSync(fd);
  }
  renameSync(staging, path);
}

/**
 * Compare-and-delete: unlink `path` only while it still names `expected.token`.
 *
 * Hardlink the current file to a tombstone first: the link binds the inode we
 * verified, so an owner that rewrote its record (heartbeat) or a successor that
 * never existed cannot be caught by the unlink. Without hardlinks we fall back to
 * re-read + token compare immediately before unlink — the window narrows to syscall
 * granularity, which is the best a lockfile can do there.
 */
function deleteIfToken(path: string, expected: CodexCliUpdateLeaseRecord): boolean {
  const tombstone = `${path}.gone-${expected.token}`;
  try {
    linkSync(path, tombstone);
  } catch {
    // No link support or already gone: verify by re-read and accept the narrow race.
    const current = readRecord(path);
    if (!current || current.token !== expected.token) return false;
    try {
      unlinkSync(path);
      return true;
    } catch {
      return false;
    }
  }
  try {
    const pathIno = statSync(path).ino;
    const tombIno = statSync(tombstone).ino;
    const tombRecord = readRecord(tombstone);
    // A zero inode means the platform cannot express identity — use the token-only check.
    const sameFile = pathIno !== 0 && tombIno !== 0 ? pathIno === tombIno : true;
    if (sameFile && tombRecord && tombRecord.token === expected.token) {
      unlinkSync(path);
      return true;
    }
    return false;
  } finally {
    try {
      unlinkSync(tombstone);
    } catch {
      /* tombstone already gone */
    }
  }
}

function holderIsStale(record: CodexCliUpdateLeaseRecord, io: CodexCliUpdateLeaseIo): boolean {
  const isAlive = io.isAlive ?? defaultIsAlive;
  const now = io.now ?? Date.now;
  if (!isAlive(record.ownerPid)) return true;
  // A live pid is held only while its heartbeat is fresh; age alone never reaps it.
  return now() - record.heartbeatAtMs > CODEX_CLI_UPDATE_LEASE_MAX_AGE_MS;
}

/**
 * Take the update lease, or report why it could not be taken.
 *
 * Contended callers do not queue: a second apply reports "held" and refuses, which is
 * the honest answer — queueing would run two global installs back to back against a
 * plan the second caller read before the first one mutated the installation.
 */
export function acquireCodexCliUpdateLease(
  io: CodexCliUpdateLeaseIo & { planId?: string } = {},
): CodexCliUpdateLeaseAcquisition {
  const path = io.lockPath ?? defaultCodexCliUpdateLeasePath();
  const now = io.now ?? Date.now;
  const self = io.pid ?? process.pid;

  const existing = readRecord(path);
  if (existing) {
    if (!holderIsStale(existing, io)) {
      return { acquired: false, reason: "held", heldBy: existing.ownerPid };
    }
    // Stale. Remove it only while it still names the record we observed: two
    // contenders can see the same stale lease, and an unconditional unlink would
    // let the slower one delete the faster one's fresh lease. After compare-delete,
    // the publish below decides which of us actually holds it.
    if (!deleteIfToken(path, existing)) {
      const successor = readRecord(path);
      if (!successor) return { acquired: false, reason: "unavailable" };
      return holderIsStale(successor, io)
        ? { acquired: false, reason: "unavailable" }
        : { acquired: false, reason: "held", heldBy: successor.ownerPid };
    }
  }

  const record: CodexCliUpdateLeaseRecord = {
    version: 1,
    ownerPid: self,
    createdAtMs: now(),
    token: newToken(),
    heartbeatAtMs: now(),
    planId: io.planId ?? null,
  };
  if (tryPublish(path, record, io)) return { acquired: true, record };

  const winner = readRecord(path);
  if (winner) {
    return holderIsStale(winner, io)
      ? { acquired: false, reason: "unavailable" }
      : { acquired: false, reason: "held", heldBy: winner.ownerPid };
  }

  // The file exists but names nobody: truncated or corrupt. If it is younger than
  // the publish grace it is a contender's in-flight write on the O_EXCL fallback —
  // held, not clearable. Past the grace it is a dead writer's debris: one ownerless
  // file must not wedge every future update, so clear it (compare-delete on the
  // path identity) and make exactly one more attempt.
  try {
    const stat = statSync(path);
    if (now() - stat.mtimeMs < PUBLISH_GRACE_MS) {
      return { acquired: false, reason: "unavailable" };
    }
  } catch {
    return { acquired: false, reason: "unavailable" };
  }
  try {
    unlinkSync(path);
  } catch {
    /* somebody else cleared it first */
  }
  if (tryPublish(path, record, io)) return { acquired: true, record };
  const successor = readRecord(path);
  return successor && !holderIsStale(successor, io)
    ? { acquired: false, reason: "held", heldBy: successor.ownerPid }
    : { acquired: false, reason: "unavailable" };
}

/**
 * Compare-and-delete release bound to the holder's token — a late release can never
 * unlink a successor's lease, and a release naming only a pid (recycled or not)
 * cannot unlink a successor associated with the same pid edge case.
 */
export function releaseCodexCliUpdateLease(
  io: CodexCliUpdateLeaseIo & { token?: string } = {},
): void {
  const path = io.lockPath ?? defaultCodexCliUpdateLeasePath();
  const self = io.pid ?? process.pid;
  const existing = readRecord(path);
  if (!existing || existing.ownerPid !== self) return;
  if (io.token !== undefined && existing.token !== io.token) return;
  deleteIfToken(path, existing);
}

/**
 * Keep a held lease's heartbeat fresh for the duration of a long install. Returns a
 * stop function; the interval is unref'd so it never keeps a process alive. The
 * heartbeat re-verifies its own token before rewriting, so a holder that was already
 * reaped (or superseded) simply stops updating someone else's lease.
 */
export function startCodexCliUpdateLeaseHeartbeat(
  record: CodexCliUpdateLeaseRecord,
  io: CodexCliUpdateLeaseIo = {},
): () => void {
  const path = io.lockPath ?? defaultCodexCliUpdateLeasePath();
  const now = io.now ?? Date.now;
  const timer = setInterval(() => {
    const current = readRecord(path);
    if (!current || current.token !== record.token) return;
    try {
      rewriteRecord(path, { ...current, heartbeatAtMs: now() });
    } catch {
      /* a successor or a cleared lease: the next tick re-verifies and stays inert */
    }
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

export interface CodexCliUpdateLeaseObservation {
  /** True only while a live owner with a fresh heartbeat holds the lease. */
  readonly held: boolean;
  readonly ownerPid: number | null;
}

/**
 * Read-only observation for Codex startup paths. A stale or corrupt record reads as
 * free — reclaiming it is the acquirer's job, and a dead file must not block Codex
 * from ever starting again.
 */
export function observeCodexCliUpdateLease(
  io: CodexCliUpdateLeaseIo = {},
): CodexCliUpdateLeaseObservation {
  const existing = readRecord(io.lockPath ?? defaultCodexCliUpdateLeasePath());
  if (!existing || holderIsStale(existing, io)) return { held: false, ownerPid: null };
  return { held: true, ownerPid: existing.ownerPid };
}

const WAIT_POLL_MS = 250;

/**
 * Bounded wait for the lease to clear, for startup paths that would rather wait out
 * the tail of an install than refuse outright. Resolves true once the lease is free,
 * false when the deadline passed with it still held.
 */
export async function waitForCodexCliUpdateLeaseRelease(
  io: CodexCliUpdateLeaseWaitIo & { timeoutMs?: number } = {},
): Promise<boolean> {
  const now = io.now ?? Date.now;
  const sleep = io.sleep ?? (ms => new Promise<void>(done => setTimeout(done, ms)));
  const deadline = now() + (io.timeoutMs ?? CODEX_CLI_UPDATE_LEASE_WAIT_MS);
  for (;;) {
    if (!observeCodexCliUpdateLease(io).held) return true;
    if (now() >= deadline) return false;
    await sleep(Math.min(WAIT_POLL_MS, Math.max(1, deadline - now())));
  }
}
