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
 * The mechanics deliberately mirror desktop-app/lock.ts: exclusive O_EXCL create on
 * the contended path, owner-pid liveness first and an age bound second for staleness,
 * and compare-and-delete release so a late holder can never unlink a successor's
 * lease.
 *
 * Deliberately NOT own-pid reentrant: two applies in one process are still two
 * contenders for one global install, and the second must see the lease as held.
 */
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

import { getConfigDir } from "../config/paths";
import { isProcessAlive } from "../lib/process-control";

/**
 * A lease older than this is stale regardless of what its owner pid says. The bound
 * exists for a live pid that no longer names an updater (a recycled pid, or a wedged
 * holder); it is comfortably longer than the pack + install timeouts a real apply can
 * legitimately hold the lease for.
 */
export const CODEX_CLI_UPDATE_LEASE_MAX_AGE_MS = 15 * 60_000;

/** Startup paths poll a held lease for this long before refusing the launch. */
export const CODEX_CLI_UPDATE_LEASE_WAIT_MS = 5_000;

export interface CodexCliUpdateLeaseRecord {
  readonly version: 1;
  readonly ownerPid: number;
  readonly createdAtMs: number;
  /** The plan id being applied. Diagnostics only; exclusion never reads it. */
  readonly planId: string | null;
}

export interface CodexCliUpdateLeaseIo {
  lockPath?: string;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  pid?: number;
}

export interface CodexCliUpdateLeaseWaitIo extends CodexCliUpdateLeaseIo {
  sleep?: (ms: number) => Promise<void>;
}

export type CodexCliUpdateLeaseAcquisition =
  | { acquired: true; record: CodexCliUpdateLeaseRecord }
  /** A live owner inside the age bound holds the lease. */
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

function readRecord(path: string): CodexCliUpdateLeaseRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const view = parsed as Record<string, unknown>;
    const ownerPid = view.ownerPid;
    const createdAtMs = view.createdAtMs;
    if (view.version !== 1) return null;
    if (typeof ownerPid !== "number" || !Number.isSafeInteger(ownerPid) || ownerPid <= 0) return null;
    if (typeof createdAtMs !== "number" || !Number.isFinite(createdAtMs)) return null;
    const planId = view.planId;
    return {
      version: 1,
      ownerPid,
      createdAtMs,
      planId: typeof planId === "string" ? planId : null,
    };
  } catch {
    return null;
  }
}

/** Exclusive create on the contended path — the whole mutual exclusion. */
function tryCreateExclusive(path: string, record: CodexCliUpdateLeaseRecord): boolean {
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

function holderIsLive(record: CodexCliUpdateLeaseRecord, io: CodexCliUpdateLeaseIo): boolean {
  const isAlive = io.isAlive ?? defaultIsAlive;
  const now = io.now ?? Date.now;
  return isAlive(record.ownerPid) && now() - record.createdAtMs <= CODEX_CLI_UPDATE_LEASE_MAX_AGE_MS;
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
    if (holderIsLive(existing, io)) {
      return { acquired: false, reason: "held", heldBy: existing.ownerPid };
    }
    // Stale. Clear it and then compete for the exclusive create like anyone else:
    // two processes can observe the same stale lease, and only O_EXCL decides which
    // one actually holds it.
    try {
      unlinkSync(path);
    } catch {
      /* somebody else cleared it first — the create below still decides */
    }
  }

  const record: CodexCliUpdateLeaseRecord = {
    version: 1,
    ownerPid: self,
    createdAtMs: now(),
    planId: io.planId ?? null,
  };
  if (tryCreateExclusive(path, record)) return { acquired: true, record };

  const winner = readRecord(path);
  if (winner) {
    return holderIsLive(winner, io)
      ? { acquired: false, reason: "held", heldBy: winner.ownerPid }
      : { acquired: false, reason: "unavailable" };
  }

  // The file exists but names nobody: truncated, corrupt, or left by a writer that
  // died between create and write. Remove it and make exactly one more attempt so a
  // lock nobody holds cannot wedge every future update.
  try {
    unlinkSync(path);
  } catch {
    /* somebody else cleared it first */
  }
  if (tryCreateExclusive(path, record)) return { acquired: true, record };
  const successor = readRecord(path);
  return successor && holderIsLive(successor, io)
    ? { acquired: false, reason: "held", heldBy: successor.ownerPid }
    : { acquired: false, reason: "unavailable" };
}

/** Compare-and-delete. Never removes a lease owned by another process. */
export function releaseCodexCliUpdateLease(io: CodexCliUpdateLeaseIo = {}): void {
  const path = io.lockPath ?? defaultCodexCliUpdateLeasePath();
  const self = io.pid ?? process.pid;
  const existing = readRecord(path);
  if (!existing || existing.ownerPid !== self) return;
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

export interface CodexCliUpdateLeaseObservation {
  /** True only while a live owner inside the age bound holds the lease. */
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
  if (!existing || !holderIsLive(existing, io)) return { held: false, ownerPid: null };
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
