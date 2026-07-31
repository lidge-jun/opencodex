/**
 * Deterministic teardown for the storage Bun Workers.
 *
 * `Worker.terminate()` returns void and does NOT wait for the thread to be
 * reclaimed. Every caller here used to fire it and move on, which is fine for
 * the proxy but not for `bun test --isolate`: the harness tears a test file's
 * realm down at the file boundary, and on Windows a worker that has not
 * finished exiting by then trips a Bun-internal assertion and kills the whole
 * run.
 *
 * The crash header names the shape exactly — `workers_spawned(9)
 * workers_terminated(8)`, one worker still alive — and it lands right at the
 * `api-storage-policy` → `api-storage` file boundary, the only suite that
 * spawns policy workers. See `devlog/_plan/260730_remote_issue_merge_round/150`,
 * which reproduced the panic twice against an unchanged tree and left this
 * defence as the follow-up if it ever recurred. It recurred.
 *
 * So: keep a registry of live workers, and give shutdown/reset paths something
 * they can actually await. `close` is Bun's post-exit event for a worker
 * thread, so awaiting it is the real "the thread is gone" signal rather than a
 * timer we hope is long enough. The timeout only exists so a wedged worker
 * cannot hang a test teardown forever.
 */

const liveWorkers = new Set<Worker>();

/** Track a freshly spawned worker so teardown can wait for it later. */
export function registerStorageWorker(worker: Worker): void {
  liveWorkers.add(worker);
}

/**
 * Terminate a worker and resolve once its thread has actually exited.
 *
 * Safe to call twice: the second call finds the worker already deregistered and
 * resolves immediately.
 */
export function terminateStorageWorker(worker: Worker, timeoutMs = 5_000): Promise<void> {
  if (!liveWorkers.has(worker)) {
    try { worker.terminate(); } catch { /* already gone */ }
    return Promise.resolve();
  }
  liveWorkers.delete(worker);

  return new Promise<void>(resolve => {
    let done = false;
    const settle = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    // A worker that refuses to exit must not wedge teardown; the proxy path
    // never awaits this, and a test teardown would rather continue than hang.
    const timer = setTimeout(settle, timeoutMs);
    try {
      worker.addEventListener("close", settle, { once: true });
    } catch {
      // No close event available — fall back to the timeout above.
    }
    try {
      worker.terminate();
    } catch {
      settle();
    }
  });
}

/**
 * Await every worker this module still tracks. Used by test resets so no
 * storage worker outlives the file that spawned it.
 */
export async function drainStorageWorkers(timeoutMs = 5_000): Promise<void> {
  const pending = [...liveWorkers];
  await Promise.all(pending.map(worker => terminateStorageWorker(worker, timeoutMs)));
}

/** Live worker count — exported so a regression test can assert the invariant. */
export function liveStorageWorkerCount(): number {
  return liveWorkers.size;
}
