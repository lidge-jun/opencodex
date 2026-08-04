/**
 * Single-flight controller for trash restore runs.
 *
 * Heavy work (file moves, SQLite reconcile) runs in a Bun Worker so the proxy
 * event loop stays responsive while the management API awaits the outcome.
 *
 * Restore shares the CODEX_HOME storage-mutation coordinator with manual cleanup
 * and (Phase 3) policy-driven cleanup. Concurrent callers receive
 * `storage_mutation_busy` (409) instead of queueing.
 */
import { resolveCodexHomeDir } from "../codex/home";
import { restoreTrashEntry, type RestoreResult, type RestoreTestHooks } from "./cleanup";
import {
  resetStorageMutationCoordinatorForTests,
  setStorageMutationCoordinatorTestHooks,
  withStorageMutationSlot,
  type StorageMutationCoordinatorTestHooks,
} from "./storage-mutation-coordinator";
import {
  cancelQueuedStorageWorkerSpawns,
  drainStorageWorkers,
  StorageWorkerAdmissionBusyError,
  terminateStorageWorker,
  tryReserveStorageWorker,
  withStorageWorkerSpawnGate,
} from "./worker-lifecycle";

export interface RestoreJobTestHooks extends StorageMutationCoordinatorTestHooks {
  /**
   * When true, run on the main thread via dynamic import + optional sleep.
   * Responsiveness tests must leave this unset so work stays in a Worker.
   */
  runInProcess?: boolean;
  /** Expose GET /api/storage/trash/restore/test-stream for responsiveness tests. */
  enableTestStream?: boolean;
  /** Forwarded to restoreTrashEntry _test hooks. */
  restoreTest?: RestoreTestHooks;
}

const WORKER_TIMEOUT_MS = 10 * 60 * 1000;

const WORKER_REJECTION_CODES: Record<string, RestoreResult["error"]> = {
  restore_worker_timeout: "restore_worker_timeout",
  aborted: "restore_worker_aborted",
  worker_failed: "restore_worker_failed",
};

/** Map a rejected worker promise to a precise restore outcome (exported for tests). */
export function restoreResultFromWorkerRejection(err: unknown, trashId: string): RestoreResult {
  const raw = err instanceof Error ? err.message : String(err);
  const error = WORKER_REJECTION_CODES[raw] ?? "restore_worker_failed";
  const detail =
    error === "restore_worker_failed" && raw !== "worker_failed" && raw.trim().length > 0
      ? raw
      : undefined;
  console.error(
    `[storage] trash restore worker failed (${error}) trashId=${trashId}${detail ? `: ${detail}` : ""}`,
  );
  return {
    ok: false,
    count: 0,
    bytes: 0,
    restoredPaths: [],
    error,
    ...(detail ? { message: detail } : {}),
  };
}

let activeWorker: Worker | null = null;
let testHooks: RestoreJobTestHooks | null = null;
let cancelActiveRun: (() => void) | null = null;

export function setRestoreTrashJobTestHooks(hooks: RestoreJobTestHooks | null): void {
  testHooks = hooks;
  setStorageMutationCoordinatorTestHooks(hooks);
}

/**
 * Fire-and-forget reset. Prefer {@link resetRestoreTrashJobForTestsAsync} from
 * test beforeEach/afterEach under `bun test --isolate` on Windows.
 */
export function resetRestoreTrashJobForTests(): void {
  cancelQueuedStorageWorkerSpawns();
  if (activeWorker) {
    void terminateStorageWorker(activeWorker);
    activeWorker = null;
  }
  cancelActiveRun?.();
  cancelActiveRun = null;
  testHooks = null;
  resetStorageMutationCoordinatorForTests();
}

/**
 * Await-able reset for test teardown; see policy-job's equivalent for why.
 * Awaits the active worker directly so drain cannot race a fire-and-forget
 * deregister from the sync reset.
 */
export async function resetRestoreTrashJobForTestsAsync(): Promise<void> {
  cancelQueuedStorageWorkerSpawns();
  const worker = activeWorker;
  activeWorker = null;
  cancelActiveRun?.();
  cancelActiveRun = null;
  testHooks = null;
  // Join the worker before clearing the mutation coordinator so a concurrent
  // run cannot acquire CODEX_HOME while the aborted thread is still mutating.
  try {
    if (worker) await terminateStorageWorker(worker);
    await drainStorageWorkers();
  } finally {
    resetStorageMutationCoordinatorForTests();
  }
}

/** Terminate an in-flight worker during process shutdown. */
export function abortRestoreTrashJob(): void {
  cancelQueuedStorageWorkerSpawns();
  if (activeWorker) {
    void terminateStorageWorker(activeWorker);
    activeWorker = null;
  }
  cancelActiveRun?.();
  cancelActiveRun = null;
}

/** Await-able shutdown sibling; joins the restore worker thread before returning. */
export async function abortRestoreTrashJobAsync(): Promise<void> {
  cancelQueuedStorageWorkerSpawns();
  const worker = activeWorker;
  activeWorker = null;
  cancelActiveRun?.();
  cancelActiveRun = null;
  if (worker) await terminateStorageWorker(worker);
  await drainStorageWorkers();
}

/** Test-only SSE/text stream served from the proxy while a worker is blocked. */
export function getRestoreTrashTestStreamResponse(): Response | null {
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

function runInWorker(opts: {
  trashId: string;
  codexHome?: string;
  busyTimeoutMs?: number;
  blockMs?: number;
  restoreTest?: RestoreTestHooks;
}): Promise<RestoreResult> {
  const reservation = tryReserveStorageWorker();
  if (!reservation) return Promise.reject(new StorageWorkerAdmissionBusyError());
  return withStorageWorkerSpawnGate(() => new Promise<RestoreResult>((resolve, reject) => {
    const requestId = crypto.randomUUID();
    let settled = false;
    let worker: Worker;
    try {
      worker = new Worker(new URL("./restore-worker.ts", import.meta.url).href);
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
      // Join before settle so mutation coordination inside the restore worker
      // cannot overlap a follow-on run after a watchdog timeout.
      void terminateStorageWorker(worker).then(fn, fn);
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error("restore_worker_timeout")));
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
        finish(() => resolve(msg.result as RestoreResult));
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
      trashId: opts.trashId,
      ...(opts.codexHome ? { codexHome: opts.codexHome } : {}),
      ...(opts.busyTimeoutMs !== undefined ? { busyTimeoutMs: opts.busyTimeoutMs } : {}),
      ...(opts.blockMs !== undefined ? { blockMs: opts.blockMs } : {}),
      ...(opts.restoreTest ? { restoreTest: opts.restoreTest } : {}),
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

async function executeRestore(opts: {
  trashId: string;
  codexHome?: string;
  busyTimeoutMs?: number;
  _test?: RestoreTestHooks;
}): Promise<RestoreResult> {
  const blockMs = testHooks?.blockMs;
  const restoreTest = opts._test ?? testHooks?.restoreTest;

  if (testHooks?.runInProcess) {
    if (typeof blockMs === "number" && blockMs > 0) await Bun.sleep(blockMs);
    return restoreTrashEntry(opts.trashId, {
      ...(opts.codexHome ? { codexHome: opts.codexHome } : {}),
      ...(opts.busyTimeoutMs !== undefined ? { busyTimeoutMs: opts.busyTimeoutMs } : {}),
      ...(restoreTest ? { _test: restoreTest } : {}),
    });
  }

  try {
    return await runInWorker({
      trashId: opts.trashId,
      ...(opts.codexHome ? { codexHome: opts.codexHome } : {}),
      ...(opts.busyTimeoutMs !== undefined ? { busyTimeoutMs: opts.busyTimeoutMs } : {}),
      ...(typeof blockMs === "number" && blockMs > 0 ? { blockMs } : {}),
      ...(restoreTest ? { restoreTest } : {}),
    });
  } catch (err) {
    if (err instanceof StorageWorkerAdmissionBusyError) return busyRestoreResult();
    return restoreResultFromWorkerRejection(err, opts.trashId);
  }
}

function busyRestoreResult(): RestoreResult {
  return {
    ok: false,
    count: 0,
    bytes: 0,
    restoredPaths: [],
    error: "storage_mutation_busy",
  };
}

/**
 * Run trash restore off the event loop under the shared storage-mutation gate.
 * Returns `storage_mutation_busy` when cleanup or another restore is in flight.
 */
export async function runRestoreTrashEntryJob(
  trashId: string,
  options?: {
    codexHome?: string;
    busyTimeoutMs?: number;
    _test?: RestoreTestHooks;
  },
): Promise<RestoreResult> {
  const codexHome = options?.codexHome ?? resolveCodexHomeDir();
  const result = await withStorageMutationSlot("restore", codexHome, () =>
    executeRestore({ trashId, ...options }),
  );
  if (result && typeof result === "object" && "ok" in result && result.ok === false
    && "error" in result && result.error === "storage_mutation_busy") {
    return busyRestoreResult();
  }
  return result as RestoreResult;
}
