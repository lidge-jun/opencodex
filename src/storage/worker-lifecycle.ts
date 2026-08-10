/**
 * Deterministic teardown for the storage Bun Workers.
 *
 * `Worker.terminate()` returns void and does NOT wait for the thread to be
 * reclaimed. Callers that fire-and-forget leave a window where
 * `bun test --isolate` reclaims the file realm while a Windows worker thread
 * is still exiting — Bun then panics with
 * `workers_spawned(N) workers_terminated(N-1)` / Internal assertion failure.
 *
 * Invariant: every registered worker has a `close` listener attached at spawn
 * time (so we cannot miss `self.close()` / early exit), stays in `liveWorkers`
 * until that close settles, and `drainStorageWorkers()` joins every in-flight
 * terminate. Spawns are serialized through `withStorageWorkerSpawnGate` so the
 * next Worker cannot be created until prior threads have exited. A post-close
 * settle covers the OS/runtime join gap Bun does not expose on Windows, macOS,
 * and Linux (including Bun 1.3.14 isolate crashes and Linux `epoll_ctl` reuse).
 */

import { createAdmissionGate, type AdmissionMetrics, type AdmissionReservation } from "../lib/admission";

type TrackedWorker = {
  worker: Worker;
  closed: Promise<void>;
  resolveClosed: () => void;
  terminatePromise?: Promise<void>;
  reservation?: AdmissionReservation<Worker>;
};

export const MAX_RESERVED_STORAGE_WORKER_SPAWNS = 16;
export class StorageWorkerAdmissionBusyError extends Error {
  readonly code = "storage_mutation_busy";

  constructor() {
    super("storage worker spawn queue is busy");
    this.name = "StorageWorkerAdmissionBusyError";
  }
}

const liveWorkers = new Map<Worker, TrackedWorker>();
const workerGate = createAdmissionGate("storage_worker_reservations", MAX_RESERVED_STORAGE_WORKER_SPAWNS);

/** Serialize spawns so a new Worker never overlaps a still-exiting predecessor. */
let spawnGate: Promise<void> = Promise.resolve();

/**
 * Bumped by teardown so a spawn still queued on `spawnGate` (not yet in
 * `liveWorkers`) cannot create a Worker after reset/shutdown reported idle.
 */
let spawnCancelEpoch = 0;

/**
 * OS-join gap after the `close` event on platforms where Bun's Worker reclaim
 * races the isolate/file boundary (not a CI job-timeout bump).
 * Windows GHA at 250ms and 750ms still left `workers_spawned(N)`
 * `workers_terminated(N-1)` panics under isolate, so Windows keeps 1500ms.
 * Darwin and Linux use a shorter settle for the balanced-count/epoll reclaim
 * window seen on Bun 1.3.14.
 */
export function storageWorkerOsJoinSettleMs(platform = process.platform): number {
  if (platform === "win32") return 1_500;
  if (platform === "darwin" || platform === "linux") return 250;
  return 0;
}

/** Invalidate spawn callbacks still waiting on the gate (reset / server drain). */
export function cancelQueuedStorageWorkerSpawns(): void {
  spawnCancelEpoch += 1;
}

/** Track a freshly spawned worker so teardown can wait for it later. */
export function registerStorageWorker(worker: Worker): void {
  if (liveWorkers.has(worker)) return;

  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => {
    resolveClosed = resolve;
  });

  const tracked: TrackedWorker = { worker, closed, resolveClosed };
  liveWorkers.set(worker, tracked);

  try {
    worker.addEventListener("close", () => {
      resolveClosed();
    }, { once: true });
  } catch {
    // No close event — terminate path will still resolve via timeout/settle.
  }
}

export function tryReserveStorageWorker(): AdmissionReservation<Worker> | null {
  const gateLease = workerGate.tryAcquire();
  if (!gateLease) return null;
  let active = true;
  let bound: Worker | undefined;
  const reservation: AdmissionReservation<Worker> = {
    bind(worker) {
      if (!active) return;
      bound = worker;
      registerStorageWorker(worker);
      const tracked = liveWorkers.get(worker);
      if (tracked) tracked.reservation = reservation;
    },
    release() {
      if (!active) return;
      active = false;
      if (bound) {
        const tracked = liveWorkers.get(bound);
        if (tracked?.reservation === reservation) tracked.reservation = undefined;
      }
      bound = undefined;
      gateLease.release();
    },
  };
  return reservation;
}

export function storageWorkerAdmissionMetrics(): AdmissionMetrics {
  return workerGate.metrics();
}

/**
 * Run `fn` only after every previously gated spawn has finished tearing down.
 * Used around `new Worker(...)` so tests cannot overlap Windows thread exit.
 */
export function withStorageWorkerSpawnGate<T>(fn: () => Promise<T>): Promise<T> {
  const epochAtEnqueue = spawnCancelEpoch;
  const run = spawnGate.then(async () => {
    if (epochAtEnqueue !== spawnCancelEpoch) {
      throw new Error("storage_worker_spawn_cancelled");
    }
    await drainStorageWorkers();
    if (epochAtEnqueue !== spawnCancelEpoch) {
      throw new Error("storage_worker_spawn_cancelled");
    }
    return fn();
  });
  spawnGate = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function queuedStorageWorkerSpawnCount(): number {
  return Math.max(0, workerGate.metrics().active - liveWorkers.size);
}

/**
 * Terminate a worker and resolve once its thread has actually exited.
 *
 * Safe to call twice: the second call joins the in-flight terminate promise.
 */
export function terminateStorageWorker(worker: Worker, timeoutMs = 5_000): Promise<void> {
  const tracked = liveWorkers.get(worker);
  if (!tracked) {
    try { worker.terminate(); } catch { /* already gone */ }
    return Promise.resolve();
  }
  if (tracked.terminatePromise) return tracked.terminatePromise;

  tracked.terminatePromise = (async () => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      tracked.resolveClosed();
    }, timeoutMs);

    try {
      try {
        worker.terminate();
      } catch {
        tracked.resolveClosed();
      }
      await tracked.closed;
      // Disarm before the OS-join settle: a late timer firing during the sleep
      // would set timedOut after close already won and throw a false timeout.
      clearTimeout(timer);
      // Always run the OS-join settle before throwing on timeout: the timer
      // only forces `closed`, it does not prove the OS thread has exited.
      // Callers that catch and continue (e.g. drainAndShutdown) still need
      // that gap before the next isolate reclaim or server.stop.
      const settleMs = storageWorkerOsJoinSettleMs();
      if (settleMs > 0) {
        await Bun.sleep(0);
        await Bun.sleep(settleMs);
      }
      if (timedOut) {
        throw new Error(`storage worker did not exit within ${timeoutMs}ms`);
      }
    } finally {
      clearTimeout(timer);
      liveWorkers.delete(worker);
      tracked.reservation?.release();
      tracked.reservation = undefined;
    }
  })();

  return tracked.terminatePromise;
}

/**
 * Await every worker this module still tracks (including terminations already
 * in flight). Used by test resets so no storage worker outlives the file that
 * spawned it.
 */
export async function drainStorageWorkers(timeoutMs = 5_000): Promise<void> {
  const pending = [...liveWorkers.keys()].map(worker => terminateStorageWorker(worker, timeoutMs));
  await Promise.all(pending);
}

/** Live worker count — exported so a regression test can assert the invariant. */
export function liveStorageWorkerCount(): number {
  return liveWorkers.size;
}
