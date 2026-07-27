/**
 * Single-flight controller for storage cleanup policy runs.
 *
 * Manual, startup, and scheduled evaluations share one in-flight slot. Heavy
 * work (archive scan, FS cleanup, SQLite reconcile) runs in a Bun Worker so the
 * proxy event loop stays responsive.
 */
import type { CleanupMode, CleanupResult } from "./cleanup";
import {
  isPolicyDue,
  readStorageCleanupPolicyFromConfig,
  type PolicyRunReason,
  type PolicyRunResult,
  type PolicySkipReason,
} from "./policy";

export type PolicyJobStatus = "idle" | "running";

export interface PolicyJobOutcome {
  ok: boolean;
  skipped?: PolicySkipReason;
  deferred?: "codex_busy";
  error?: CleanupResult["error"] | "evaluation_failed" | "worker_failed";
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

export function resetStorageCleanupPolicyJobForTests(): void {
  disownActiveRun();
  if (activeWorker) {
    try { activeWorker.terminate(); } catch { /* */ }
    activeWorker = null;
  }
  inflight = null;
  testHooks = null;
  state = { status: "idle" };
}

/** Terminate an in-flight worker during process shutdown. */
export function abortStorageCleanupPolicyJob(): void {
  disownActiveRun();
  if (activeWorker) {
    try { activeWorker.terminate(); } catch { /* */ }
    activeWorker = null;
  }
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

function runInWorker(opts: RequestPolicyRunOptions & { blockMs?: number }): Promise<PolicyRunResult> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    let settled = false;
    const worker = new Worker(new URL("./policy-worker.ts", import.meta.url).href);
    activeWorker = worker;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cancelActiveRun = null;
      try { worker.terminate(); } catch { /* */ }
      if (activeWorker === worker) activeWorker = null;
      reject(new Error("storage_cleanup_worker_timeout"));
    }, WORKER_TIMEOUT_MS);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cancelActiveRun = null;
      clearTimeout(timer);
      if (activeWorker === worker) activeWorker = null;
      try { worker.terminate(); } catch { /* */ }
      fn();
    };

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
  });
}

async function executeJob(opts: RequestPolicyRunOptions): Promise<void> {
  const generation = ++runGeneration;
  try {
    const blockMs = testHooks?.blockMs;
    let result: PolicyRunResult;

    if (testHooks?.runInProcess) {
      // Dynamic import keeps the sync engine out of the hot path for the default Worker mode.
      const { runStorageCleanupPolicy } = await import("./policy");
      result = runStorageCleanupPolicy({
        reason: opts.reason,
        force: opts.force === true,
        ...(opts.codexHome ? { codexHome: opts.codexHome } : {}),
        ...(opts.busyTimeoutMs !== undefined ? { busyTimeoutMs: opts.busyTimeoutMs } : {}),
        ...(typeof blockMs === "number" && blockMs > 0 ? { holdAfterLoadMs: blockMs } : {}),
      });
    } else {
      result = await runInWorker({
        ...opts,
        ...(typeof blockMs === "number" && blockMs > 0 ? { blockMs } : {}),
      });
    }

    if (generation !== runGeneration) return;
    applyFinished(result);
  } catch (err) {
    if (generation !== runGeneration) return;
    applyFailed(err instanceof Error ? err.message : "worker_failed");
  } finally {
    if (generation === runGeneration) inflight = null;
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

  inflight = executeJob(opts);
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
