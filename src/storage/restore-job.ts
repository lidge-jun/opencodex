/**
 * Single-flight controller for trash restore runs.
 *
 * Heavy work (file moves, SQLite reconcile) runs in a Bun Worker so the proxy
 * event loop stays responsive while the management API awaits the outcome.
 */
import { restoreTrashEntry, type RestoreResult, type RestoreTestHooks } from "./cleanup";

export interface RestoreJobTestHooks {
  /** Block the worker this many ms before restoreTrashEntry (responsiveness tests). */
  blockMs?: number;
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

let chain: Promise<unknown> = Promise.resolve();
let activeWorker: Worker | null = null;
let testHooks: RestoreJobTestHooks | null = null;
let cancelActiveRun: (() => void) | null = null;

export function setRestoreTrashJobTestHooks(hooks: RestoreJobTestHooks | null): void {
  testHooks = hooks;
}

export function resetRestoreTrashJobForTests(): void {
  if (activeWorker) {
    try { activeWorker.terminate(); } catch { /* */ }
    activeWorker = null;
  }
  cancelActiveRun?.();
  cancelActiveRun = null;
  testHooks = null;
  chain = Promise.resolve();
}

/** Terminate an in-flight worker during process shutdown. */
export function abortRestoreTrashJob(): void {
  if (activeWorker) {
    try { activeWorker.terminate(); } catch { /* */ }
    activeWorker = null;
  }
  cancelActiveRun?.();
  cancelActiveRun = null;
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
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    let settled = false;
    const worker = new Worker(new URL("./restore-worker.ts", import.meta.url).href);
    activeWorker = worker;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cancelActiveRun = null;
      try { worker.terminate(); } catch { /* */ }
      if (activeWorker === worker) activeWorker = null;
      reject(new Error("restore_worker_timeout"));
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
  } catch {
    return {
      ok: false,
      count: 0,
      bytes: 0,
      restoredPaths: [],
      error: "restore_failed",
    };
  }
}

/**
 * Run trash restore off the event loop. Restores are serialized — concurrent
 * callers wait for the in-flight job to finish.
 */
export function runRestoreTrashEntryJob(
  trashId: string,
  options?: {
    codexHome?: string;
    busyTimeoutMs?: number;
    _test?: RestoreTestHooks;
  },
): Promise<RestoreResult> {
  const next = chain.then(() => executeRestore({ trashId, ...options }));
  chain = next.catch(() => {});
  return next;
}
