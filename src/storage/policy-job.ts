/**
 * Single-flight controller for storage cleanup policy runs.
 *
 * Manual, startup, and scheduled evaluations share one in-flight slot. Heavy
 * work (archive scan, FS cleanup, SQLite reconcile) runs in a Bun Worker so the
 * proxy event loop stays responsive.
 */
import type { CleanupMode, CleanupResult } from "./cleanup";
import { resolveCodexHomeDir } from "../codex/home";
import {
  tryBeginStorageMutation,
} from "./storage-mutation-coordinator";
import type { AdmissionLease } from "../lib/admission";
import {
  isPolicyDue,
  readStorageCleanupPolicyFromConfig,
  type PolicyRunReason,
  type PolicyRunResult,
  type PolicySkipReason,
} from "./policy";
import {
  cancelQueuedStorageWorkerSpawns,
  drainStorageWorkers,
  StorageWorkerAdmissionBusyError,
  terminateStorageWorker,
  tryReserveStorageWorker,
  withStorageWorkerSpawnGate,
} from "./worker-lifecycle";

export type PolicyJobStatus = "idle" | "running";

export interface PolicyJobOutcome {
  ok: boolean;
  skipped?: PolicySkipReason;
  deferred?: "codex_busy";
  error?: CleanupResult["error"] | "evaluation_failed" | "worker_failed" | "storage_mutation_busy";
  mode?: CleanupMode;
  freedBytes?: number;
  removed?: number;
  trashDir?: string;
}

export interface PolicyJobState {
  status: PolicyJobStatus;
  reason?: PolicyRunReason;
  startedAt?: number;
  finishedAt?: number;
  lastError?: string;
  lastOutcome?: PolicyJobOutcome;
}

export interface RequestPolicyRunOptions {
  reason: PolicyRunReason;
  force?: boolean;
  codexHome?: string;
  busyTimeoutMs?: number;
}

export interface PolicyJobTestHooks {
  /**
   * Block the worker (or in-process run) this many ms after the start-of-job
   * policy load, so concurrent PUTs can race completion metadata writes.
   */
  blockMs?: number;
  /**
   * When true, run on the main thread via `queueMicrotask` + optional sleep.
   * Used only for unit tests that cannot spawn workers; responsiveness tests
   * must leave this unset so work stays in a Worker.
   */
  runInProcess?: boolean;
  /** Expose GET /api/storage/cleanup-policy/test-stream for responsiveness tests. */
  enableTestStream?: boolean;
}

const WORKER_TIMEOUT_MS = 10 * 60 * 1000;

let state: PolicyJobState = { status: "idle" };
let inflight: Promise<void> | null = null;
let activeWorker: Worker | null = null;
let testHooks: PolicyJobTestHooks | null = null;
/** Optional mirror so completed worker runs refresh the live server config. */
let livePolicyApply: ((policy: PolicyRunResult["policy"]) => void) | undefined;
/** Settles the active `runInWorker` promise (clears watchdog) before hard terminate. */
let cancelActiveRun: (() => void) | null = null;
/** Bumped on abort/reset so a late worker completion cannot clobber newer job state. */
let runGeneration = 0;
/** CODEX_HOME whose mutation slot this job holds (parent thread only). */
let heldMutationLease: AdmissionLease | undefined;

function releaseHeldMutationSlot(): void {
  heldMutationLease?.release();
  heldMutationLease = undefined;
}

export function setStorageCleanupPolicyJobLiveApply(
  apply: ((policy: PolicyRunResult["policy"]) => void) | null,
): void {
  livePolicyApply = apply ?? undefined;
}

export function getStorageCleanupPolicyJobState(): PolicyJobState {
  return { ...state, ...(state.lastOutcome ? { lastOutcome: { ...state.lastOutcome } } : {}) };
}

/** Test-only SSE/text stream served from the proxy while a worker is blocked. */
export function getStorageCleanupPolicyTestStreamResponse(): Response | null {
  if (!testHooks?.enableTestStream) return null;
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      async start(controller) {
        for (let i = 0; i < 8; i++) {
          controller.enqueue(encoder.encode(`chunk-${i}\n`));
          await Bun.sleep(50);
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/plain; charset=utf-8" } },
  );
}

export function setStorageCleanupPolicyJobTestHooks(hooks: PolicyJobTestHooks | null): void {
  testHooks = hooks;
}

function disownActiveRun(): void {
  runGeneration += 1;
  const cancel = cancelActiveRun;
  cancelActiveRun = null;
  cancel?.();
}

/**
 * Fire-and-forget reset. Prefer {@link resetStorageCleanupPolicyJobForTestsAsync}
 * from test beforeEach/afterEach — sync terminate races Windows
 * `bun test --isolate` reclaim when the next case spawns immediately.
 */
export function resetStorageCleanupPolicyJobForTests(): void {
  disownActiveRun();
  // Invalidate spawnGate callbacks that have not created a Worker yet — otherwise
  // they can still spawn after this sync path releases the mutation slot.
  cancelQueuedStorageWorkerSpawns();
  if (activeWorker) {
    void terminateStorageWorker(activeWorker);
    activeWorker = null;
  }
  inflight = null;
  testHooks = null;
  releaseHeldMutationSlot();
  state = { status: "idle" };
}

/**
 * Await-able sibling of the reset above, for test teardown.
 *
 * `bun test --isolate` reclaims a file's realm at the file boundary. A storage
 * worker still exiting at that moment trips a Bun-internal assertion on Windows
 * and takes the whole run down, so a suite that spawns workers must be able to
 * wait for them rather than fire-and-forget.
 *
 * Do not route through the sync reset's `void terminate(...)`: that used to
 * deregister the worker before the thread exited, so a follow-up drain saw an
 * empty registry and returned while Windows was still reclaiming the thread.
 */
export async function resetStorageCleanupPolicyJobForTestsAsync(): Promise<void> {
  disownActiveRun();
  cancelQueuedStorageWorkerSpawns();
  const worker = activeWorker;
  activeWorker = null;
  inflight = null;
  testHooks = null;
  state = { status: "idle" };
  // Join the worker before releasing the mutation slot so a concurrent run
  // cannot acquire CODEX_HOME while the aborted thread is still mutating.
  try {
    if (worker) await terminateStorageWorker(worker);
    await drainStorageWorkers();
  } finally {
    releaseHeldMutationSlot();
  }
}

/** Terminate an in-flight worker during process shutdown. */
export function abortStorageCleanupPolicyJob(): void {
  disownActiveRun();
  cancelQueuedStorageWorkerSpawns();
  if (activeWorker) {
    void terminateStorageWorker(activeWorker);
    activeWorker = null;
  }
  // Sync path cannot join; prefer abortStorageCleanupPolicyJobAsync when the
  // caller can await so the mutation slot stays held until the thread exits.
  releaseHeldMutationSlot();
  if (state.status === "running") {
    state = {
      ...state,
      status: "idle",
      finishedAt: Date.now(),
      lastError: "aborted",
      lastOutcome: {
        ok: false,
        error: "evaluation_failed",
      },
    };
  }
  inflight = null;
}

/**
 * Shutdown path that joins worker threads. Prefer this over the sync abort when
 * the caller can await (server drain, test teardown) so Windows isolate reclaim
 * does not race a still-exiting storage worker.
 */
export async function abortStorageCleanupPolicyJobAsync(): Promise<void> {
  disownActiveRun();
  cancelQueuedStorageWorkerSpawns();
  const worker = activeWorker;
  activeWorker = null;
  if (state.status === "running") {
    state = {
      ...state,
      status: "idle",
      finishedAt: Date.now(),
      lastError: "aborted",
      lastOutcome: {
        ok: false,
        error: "evaluation_failed",
      },
    };
  }
  inflight = null;
  try {
    if (worker) await terminateStorageWorker(worker);
    await drainStorageWorkers();
  } finally {
    releaseHeldMutationSlot();
  }
}

function outcomeFromResult(result: PolicyRunResult): PolicyJobOutcome {
  return {
    ok: result.ok,
    ...(result.skipped ? { skipped: result.skipped } : {}),
    ...(result.deferred ? { deferred: result.deferred } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.mode ? { mode: result.mode } : {}),
    ...(result.freedBytes !== undefined ? { freedBytes: result.freedBytes } : {}),
    ...(result.removed !== undefined ? { removed: result.removed } : {}),
    ...(result.trashDir ? { trashDir: result.trashDir } : {}),
  };
}

function applyFinished(result: PolicyRunResult): void {
  // Prefer the latest persisted policy over `result.policy`. The worker (or
  // in-process run) already merged run metadata into disk; a concurrent PUT
  // may also have landed after that write. Re-reading avoids applying a stale
  // start-of-job snapshot when the run skipped without saving.
  try {
    livePolicyApply?.(readStorageCleanupPolicyFromConfig());
  } catch {
    livePolicyApply?.(result.policy);
  }
  state = {
    status: "idle",
    reason: state.reason,
    startedAt: state.startedAt,
    finishedAt: Date.now(),
    lastOutcome: outcomeFromResult(result),
  };
}

function applyFailed(message: string): void {
  state = {
    status: "idle",
    reason: state.reason,
    startedAt: state.startedAt,
    finishedAt: Date.now(),
    lastError: message,
    lastOutcome: { ok: false, error: "worker_failed" },
  };
}

function applyMutationBusy(): void {
  state = {
    status: "idle",
    reason: state.reason,
    startedAt: state.startedAt,
    finishedAt: Date.now(),
    lastError: "storage_mutation_busy",
    lastOutcome: { ok: false, error: "storage_mutation_busy" },
  };
}

function runInWorker(opts: RequestPolicyRunOptions & { blockMs?: number }): Promise<PolicyRunResult> {
  const reservation = tryReserveStorageWorker();
  if (!reservation) return Promise.reject(new StorageWorkerAdmissionBusyError());
  return withStorageWorkerSpawnGate(() => new Promise<PolicyRunResult>((resolve, reject) => {
    const requestId = crypto.randomUUID();
    let settled = false;
    let worker: Worker;
    try {
      worker = new Worker(new URL("./policy-worker.ts", import.meta.url).href);
      reservation.bind(worker);
    } catch (error) {
      reservation.release();
      reject(error);
      return;
    }
    activeWorker = worker;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cancelActiveRun = null;
      clearTimeout(timer);
      if (activeWorker === worker) activeWorker = null;
      // Settle the caller only after the thread is actually gone, so a suite
      // that awaits its request cannot reach the next test file with a worker
      // still exiting behind it. Also keeps executeJob's finally from releasing
      // the mutation slot while the thread may still mutate CODEX_HOME.
      void terminateStorageWorker(worker).then(fn, fn);
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error("storage_cleanup_worker_timeout")));
    }, WORKER_TIMEOUT_MS);

    cancelActiveRun = () => {
      finish(() => reject(new Error("aborted")));
    };

    worker.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      const msg = data as Record<string, unknown>;
      if (msg.requestId !== requestId) return;
      if (msg.type === "done" && msg.result && typeof msg.result === "object") {
        finish(() => resolve(msg.result as PolicyRunResult));
        return;
      }
      if (msg.type === "error") {
        const message = typeof msg.message === "string" ? msg.message : "worker_failed";
        finish(() => reject(new Error(message)));
      }
    };

    worker.onerror = (err: ErrorEvent) => {
      finish(() => reject(err.error instanceof Error ? err.error : new Error(err.message || "worker_failed")));
    };

    worker.postMessage({
      type: "run",
      requestId,
      reason: opts.reason,
      force: opts.force === true,
      ...(opts.codexHome ? { codexHome: opts.codexHome } : {}),
      ...(opts.busyTimeoutMs !== undefined ? { busyTimeoutMs: opts.busyTimeoutMs } : {}),
      ...(opts.blockMs !== undefined ? { blockMs: opts.blockMs } : {}),
      env: {
        ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
        ...(process.env.OPENCODEX_HOME ? { OPENCODEX_HOME: process.env.OPENCODEX_HOME } : {}),
      },
    });
  })).catch(error => {
    reservation.release();
    throw error;
  });
}

async function executeJob(opts: RequestPolicyRunOptions): Promise<void> {
  const generation = ++runGeneration;
  const codexHome = opts.codexHome ?? resolveCodexHomeDir();
  const gate = tryBeginStorageMutation("policy", codexHome);
  if (!gate.acquired) {
    if (generation === runGeneration) {
      applyMutationBusy();
    }
    return;
  }
  heldMutationLease = gate.lease;
  try {
    const blockMs = testHooks?.blockMs;
    let result: PolicyRunResult;

    if (testHooks?.runInProcess) {
      // Dynamic import keeps the sync engine out of the hot path for the default Worker mode.
      const { runStorageCleanupPolicy } = await import("./policy");
      result = runStorageCleanupPolicy({
        reason: opts.reason,
        force: opts.force === true,
        codexHome,
        ...(opts.busyTimeoutMs !== undefined ? { busyTimeoutMs: opts.busyTimeoutMs } : {}),
        ...(typeof blockMs === "number" && blockMs > 0 ? { holdAfterLoadMs: blockMs } : {}),
      });
    } else {
      result = await runInWorker({
        ...opts,
        codexHome,
        ...(typeof blockMs === "number" && blockMs > 0 ? { blockMs } : {}),
      });
    }

    if (generation !== runGeneration) return;
    applyFinished(result);
  } catch (err) {
    if (generation !== runGeneration) return;
    if (err instanceof StorageWorkerAdmissionBusyError) applyMutationBusy();
    else applyFailed(err instanceof Error ? err.message : "worker_failed");
  } finally {
    releaseHeldMutationSlot();
  }
}

/**
 * Start a cleanup evaluation if idle. Returns immediately; poll GET for outcome.
 */
export function requestStorageCleanupPolicyRun(
  opts: RequestPolicyRunOptions,
): { accepted: true; state: PolicyJobState } | { accepted: false; error: "already_running"; state: PolicyJobState } {
  if (inflight || state.status === "running") {
    return { accepted: false, error: "already_running", state: getStorageCleanupPolicyJobState() };
  }

  state = {
    status: "running",
    reason: opts.reason,
    startedAt: Date.now(),
    lastError: undefined,
    ...(state.lastOutcome ? { lastOutcome: state.lastOutcome } : {}),
  };

  const job = executeJob(opts);
  inflight = job;
  void job.finally(() => {
    if (inflight === job) inflight = null;
  });
  return { accepted: true, state: getStorageCleanupPolicyJobState() };
}

/**
 * Fire-and-forget entry for startup / schedule ticks.
 * Skips the single-flight slot when disabled or not due so manual runs stay free.
 */
export function maybeRequestStorageCleanupPolicyRun(
  reason: PolicyRunReason,
  opts?: Omit<RequestPolicyRunOptions, "reason">,
): void {
  try {
    const policy = readStorageCleanupPolicyFromConfig();
    if (!policy.enabled) return;
    if (!isPolicyDue(policy, Date.now(), reason)) return;
    requestStorageCleanupPolicyRun({ ...opts, reason });
  } catch {
    // Keep scheduler/startup non-throwing.
  }
}
