/** Keep removal behind producer settlement and actual handle release, not a caller timeout. */
export function createTestSandboxCleanup(options: {
  drainProducers(): Promise<void>;
  waitForReaps(): Promise<void>;
  hasPendingReaps(): boolean;
  remove(): void;
}) {
  let complete = false;
  let drained = false;
  let running = false;
  let cleanup: Promise<void> | undefined;
  const remove = () => {
    if (complete) return;
    try {
      options.remove();
      complete = true;
    } catch {
      // A later run can reclaim the marked root; failure never grants stronger removal.
    }
  };
  return {
    afterAll(): Promise<void> {
      return cleanup ??= (async () => {
        running = true;
        try {
          await options.drainProducers();
          await options.waitForReaps();
          drained = true;
          if (!options.hasPendingReaps()) remove();
        } finally {
          running = false;
        }
      })();
    },
    onExit(): void {
      // Exit cannot await. Before the async barrier finishes, even a not-yet-registered
      // reaper may still be produced. Leave that root for ownership-checked stale recovery.
      if (!drained || running || options.hasPendingReaps()) return;
      remove();
    },
  };
}

/** Own asynchronous case work independently of Bun's timeout on the returned promise. */
export function createTestCaseLifecycle() {
  const abort = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const stops: Array<() => Promise<void>> = [];
  let closing: Promise<void> | undefined;
  return {
    abort,
    ownStop(stop: () => void | Promise<void>): () => Promise<void> {
      let stopped: Promise<void> | undefined;
      const once = () => stopped ??= Promise.resolve().then(stop);
      stops.push(once);
      return once;
    },
    run<T>(work: () => Promise<T>): Promise<T | undefined> {
      abort.signal.throwIfAborted();
      const operation = Promise.resolve().then(work).catch(error => {
        // Teardown cancellation is already owned by close(); a timed-out test must not
        // throw its expected abort later as an unrelated error in the following case.
        // Only this lifecycle's own reason is absorbed: fetch and signal listeners reject
        // with it, while any other AbortError is a real failure of the case.
        if (closing && abort.signal.aborted && error === abort.signal.reason) return;
        throw error;
      });
      pending.add(operation);
      // Keep a rejection observer after the runner's timeout. Return the original promise
      // so an ordinary assertion/rejection still fails the test that owns it.
      void operation.then(() => pending.delete(operation), () => pending.delete(operation));
      return operation;
    },
    close(): Promise<void> {
      return closing ??= (async () => {
        abort.abort();
        // Stop listeners while requests settle; a request may be waiting for that stop.
        // Its finally and afterEach share the same stop promise instead of racing teardown.
        const stopped = Promise.allSettled(stops.map(stop => stop()));
        await Promise.allSettled([...pending]);
        const results = await stopped;
        const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
        if (failures.length) throw new AggregateError(failures, "test case listener cleanup failed");
      })();
    },
  };
}
