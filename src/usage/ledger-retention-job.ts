import { chmodSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { renameAtomicFile } from "../lib/windows-atomic-replace";
import { discardRequestHistoryProjection } from "../routing/history/discard-index";
import { closeRequestHistoryIndex } from "../routing/history/indexer";
import { getActiveTurnCount } from "../server/lifecycle";
import {
  StorageWorkerAdmissionBusyError,
  terminateStorageWorker,
  tryReserveStorageWorker,
  withStorageWorkerSpawnGate,
} from "../storage/worker-lifecycle";
import { usageLogPath } from "./log";
import {
  usageLedgerRevisionFromStat,
  usageLedgerRevisionMatches,
  type PreparedUsageLedgerCompaction,
  type UsageLedgerCompactionPreparation,
} from "./ledger-retention";
import { readUsageLedgerRetentionFromConfig } from "./ledger-retention-config";

export type UsageLedgerRetentionDeferredReason = "active_turns" | "source_changed";

export interface UsageLedgerRetentionJobOutcome {
  ok: boolean;
  skipped?: "disabled" | "missing" | "within_limit";
  deferred?: UsageLedgerRetentionDeferredReason;
  error?: "worker_busy" | "worker_failed" | "commit_failed";
  beforeBytes?: number;
  afterBytes?: number;
  droppedBytes?: number;
}

export interface UsageLedgerRetentionJobState {
  status: "idle" | "running";
  startedAt?: number;
  finishedAt?: number;
  lastError?: string;
  lastOutcome?: UsageLedgerRetentionJobOutcome;
}

export interface UsageLedgerRetentionCommitDeps {
  activeTurnCount?: () => number;
  closeHistoryIndex?: () => void;
  discardHistoryProjection?: (configDir: string) => boolean;
  stat?: typeof statSync;
  rename?: (source: string, destination: string) => void;
  chmod?: typeof chmodSync;
  unlink?: typeof unlinkSync;
}

let state: UsageLedgerRetentionJobState = { status: "idle" };
let inflight: Promise<void> | null = null;
let activeWorker: Worker | null = null;
let cancelActiveRun: (() => void) | null = null;
let runGeneration = 0;
let lastWarningAt = 0;
const WARNING_INTERVAL_MS = 60_000;
const WORKER_TIMEOUT_MS = 10 * 60 * 1000;

/** Remove a Worker candidate without surfacing path-bearing filesystem errors. */
function discardCandidate(path: string, unlink: typeof unlinkSync = unlinkSync): void {
  try { unlink(path); } catch { /* already absent / best effort */ }
}

/** Emit at most one fixed, path-free retention warning per minute. */
function warnRetentionFailure(): void {
  const now = Date.now();
  if (now - lastWarningAt < WARNING_INTERVAL_MS) return;
  lastWarningAt = now;
  console.warn("[usage] usage ledger retention failed; it will be retried later");
}

/**
 * Commit a Worker-prepared candidate only while no data-plane turn is active and
 * only if the canonical ledger is byte-for-byte the same filesystem revision the
 * Worker inspected. This function is intentionally synchronous: after the idle
 * and revision checks, no request callback can interleave before the rename.
 */
export function commitPreparedUsageLedgerCompaction(
  prepared: PreparedUsageLedgerCompaction,
  deps: UsageLedgerRetentionCommitDeps = {},
): UsageLedgerRetentionJobOutcome {
  const activeTurnCount = deps.activeTurnCount ?? getActiveTurnCount;
  const closeHistoryIndex = deps.closeHistoryIndex ?? closeRequestHistoryIndex;
  const discardHistoryProjection = deps.discardHistoryProjection ?? discardRequestHistoryProjection;
  const stat = deps.stat ?? statSync;
  // Keep the final publication synchronous. The shared helper retries the short
  // Windows sharing-violation window with sleepSync, so no request callback can
  // interleave after the revision check and publish a newer append underneath us.
  const rename = deps.rename ?? ((source: string, destination: string) => {
    renameAtomicFile(source, destination, undefined, "usage-retention");
  });
  const chmod = deps.chmod ?? chmodSync;
  const unlink = deps.unlink ?? unlinkSync;

  if (activeTurnCount() !== 0) {
    discardCandidate(prepared.tempPath, unlink);
    return {
      ok: true,
      deferred: "active_turns",
      beforeBytes: prepared.beforeBytes,
      afterBytes: prepared.beforeBytes,
      droppedBytes: 0,
    };
  }

  let currentRevision;
  try {
    currentRevision = usageLedgerRevisionFromStat(stat(prepared.path));
  } catch {
    discardCandidate(prepared.tempPath, unlink);
    return {
      ok: true,
      deferred: "source_changed",
      beforeBytes: prepared.beforeBytes,
      afterBytes: prepared.beforeBytes,
      droppedBytes: 0,
    };
  }

  if (!usageLedgerRevisionMatches(prepared.sourceRevision, currentRevision)) {
    discardCandidate(prepared.tempPath, unlink);
    return {
      ok: true,
      deferred: "source_changed",
      beforeBytes: prepared.beforeBytes,
      afterBytes: currentRevision.size,
      droppedBytes: 0,
    };
  }

  try {
    // The index is a disposable projection of usage.jsonl. Drop its live handle
    // before replacing the canonical source so Windows cannot hold the source-adjacent
    // projection open during publication.
    closeHistoryIndex();
    rename(prepared.tempPath, prepared.path);
    try { chmod(prepared.path, 0o600); } catch { /* platform may ignore chmod */ }

    // Publication succeeded. Reclaim the now-stale derived SQLite projection immediately
    // instead of waiting for a later history query to notice the source identity change.
    // This cleanup must never reverse a successful canonical-ledger commit.
    try {
      const discarded = discardHistoryProjection(dirname(prepared.path));
      if (!discarded) {
        console.warn("[usage] request-history projection cleanup was incomplete; a later history access will rebuild it");
      }
    } catch {
      console.warn("[usage] request-history projection cleanup failed; a later history access will rebuild it");
    }

    return {
      ok: true,
      beforeBytes: prepared.beforeBytes,
      afterBytes: prepared.afterBytes,
      droppedBytes: prepared.droppedBytes,
    };
  } catch {
    discardCandidate(prepared.tempPath, unlink);
    return {
      ok: false,
      error: "commit_failed",
      beforeBytes: prepared.beforeBytes,
      afterBytes: prepared.beforeBytes,
      droppedBytes: 0,
    };
  }
}

/** Return a detached snapshot of the process-local retention controller state. */
export function getUsageLedgerRetentionJobState(): UsageLedgerRetentionJobState {
  return {
    ...state,
    ...(state.lastOutcome ? { lastOutcome: { ...state.lastOutcome } } : {}),
  };
}

/** Allocate the candidate name in the parent before the Worker can create it. */
function retentionCandidatePath(path: string): string {
  return `${path}.retention-${process.pid}-${crypto.randomUUID()}.tmp`;
}

/** Run the expensive scan/copy phase in the shared, admission-controlled Worker lane. */
function runInWorker(path: string, maxBytes: number): Promise<UsageLedgerCompactionPreparation> {
  const reservation = tryReserveStorageWorker();
  if (!reservation) return Promise.reject(new StorageWorkerAdmissionBusyError());
  const tempPath = retentionCandidatePath(path);

  return withStorageWorkerSpawnGate(() => new Promise<UsageLedgerCompactionPreparation>((resolve, reject) => {
    const requestId = crypto.randomUUID();
    let settled = false;
    let worker: Worker;
    try {
      worker = new Worker(new URL("./ledger-retention-worker.ts", import.meta.url).href);
      reservation.bind(worker);
    } catch (error) {
      reservation.release();
      reject(error);
      return;
    }
    activeWorker = worker;

    const finish = (fn: () => void, cleanupCandidate = false) => {
      if (settled) return;
      settled = true;
      cancelActiveRun = null;
      clearTimeout(timer);
      if (activeWorker === worker) activeWorker = null;
      const afterTerminate = () => {
        if (cleanupCandidate) discardCandidate(tempPath);
        fn();
      };
      void terminateStorageWorker(worker).then(afterTerminate, afterTerminate);
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error("usage_ledger_retention_worker_timeout")), true);
    }, WORKER_TIMEOUT_MS);

    cancelActiveRun = () => {
      finish(() => reject(new Error("aborted")), true);
    };

    worker.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (!data || typeof data !== "object" || Array.isArray(data)) return;
      const message = data as Record<string, unknown>;
      if (message.requestId !== requestId) return;
      if (message.type === "done" && message.result && typeof message.result === "object") {
        finish(() => resolve(message.result as UsageLedgerCompactionPreparation));
        return;
      }
      if (message.type === "error") {
        finish(() => reject(new Error("usage_ledger_retention_worker_failed")), true);
      }
    };
    worker.onerror = () => {
      finish(() => reject(new Error("usage_ledger_retention_worker_failed")), true);
    };

    worker.postMessage({
      type: "run",
      requestId,
      path,
      tempPath,
      maxBytes,
      env: {
        ...(process.env.OPENCODEX_HOME ? { OPENCODEX_HOME: process.env.OPENCODEX_HOME } : {}),
      },
    });
  })).catch(error => {
    reservation.release();
    discardCandidate(tempPath);
    throw error;
  });
}

/** Execute one policy snapshot and discard its candidate if that snapshot becomes stale. */
async function executeJob(generation: number): Promise<void> {
  const policy = readUsageLedgerRetentionFromConfig();
  if (!policy.enabled) {
    if (generation === runGeneration) {
      state = {
        status: "idle",
        startedAt: state.startedAt,
        finishedAt: Date.now(),
        lastOutcome: { ok: true, skipped: "disabled" },
      };
    }
    return;
  }

  try {
    const prepared = await runInWorker(usageLogPath(), policy.maxBytes);
    if (generation !== runGeneration) {
      if (prepared.changed) discardCandidate(prepared.tempPath);
      return;
    }
    const outcome: UsageLedgerRetentionJobOutcome = prepared.changed
      ? commitPreparedUsageLedgerCompaction(prepared)
      : {
        ok: true,
        skipped: prepared.reason,
        beforeBytes: prepared.beforeBytes,
        afterBytes: prepared.afterBytes,
        droppedBytes: 0,
      };
    if (!outcome.ok) warnRetentionFailure();
    state = {
      status: "idle",
      startedAt: state.startedAt,
      finishedAt: Date.now(),
      ...(outcome.ok ? {} : { lastError: outcome.error }),
      lastOutcome: outcome,
    };
  } catch (error) {
    if (generation !== runGeneration) return;
    const workerBusy = error instanceof StorageWorkerAdmissionBusyError;
    const outcome: UsageLedgerRetentionJobOutcome = {
      ok: false,
      error: workerBusy ? "worker_busy" : "worker_failed",
    };
    warnRetentionFailure();
    state = {
      status: "idle",
      startedAt: state.startedAt,
      finishedAt: Date.now(),
      lastError: outcome.error,
      lastOutcome: outcome,
    };
  }
}

/**
 * Invalidate the policy snapshot owned by any current run.
 *
 * Policy PUTs call this after persisting/applying the new settings. The old Worker
 * may finish its read-only preparation, but its generation can no longer commit.
 */
export function invalidateUsageLedgerRetentionRun(): void {
  runGeneration += 1;
}

/** Start one asynchronous retention evaluation. */
export function requestUsageLedgerRetentionRun():
  | { accepted: true; state: UsageLedgerRetentionJobState }
  | { accepted: false; error: "already_running"; state: UsageLedgerRetentionJobState } {
  if (inflight || state.status === "running") {
    return { accepted: false, error: "already_running", state: getUsageLedgerRetentionJobState() };
  }
  const generation = ++runGeneration;
  state = {
    status: "running",
    startedAt: Date.now(),
    ...(state.lastOutcome ? { lastOutcome: state.lastOutcome } : {}),
  };
  const job = executeJob(generation);
  inflight = job;
  void job.finally(() => {
    if (inflight !== job) return;
    inflight = null;
    if (generation !== runGeneration && state.status === "running") {
      state = {
        status: "idle",
        startedAt: state.startedAt,
        finishedAt: Date.now(),
        ...(state.lastOutcome ? { lastOutcome: state.lastOutcome } : {}),
      };
    }
  });
  return { accepted: true, state: getUsageLedgerRetentionJobState() };
}

/** Join an active retention Worker during final server teardown. */
export async function abortUsageLedgerRetentionJobAsync(): Promise<void> {
  runGeneration += 1;
  const worker = activeWorker;
  const job = inflight;
  const cancel = cancelActiveRun;
  cancelActiveRun = null;
  cancel?.();
  if (worker) await terminateStorageWorker(worker);
  if (job) await job.catch(() => undefined);
  activeWorker = null;
  inflight = null;
  if (state.status === "running") {
    state = {
      status: "idle",
      startedAt: state.startedAt,
      finishedAt: Date.now(),
      lastError: "aborted",
      lastOutcome: { ok: false, error: "worker_failed" },
    };
  }
}

/** Test reset for the module-local controller state. */
export async function resetUsageLedgerRetentionJobForTests(): Promise<void> {
  await abortUsageLedgerRetentionJobAsync();
  state = { status: "idle" };
  lastWarningAt = 0;
}
