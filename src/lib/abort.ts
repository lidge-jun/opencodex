export interface LinkedAbortSignal {
  signal: AbortSignal;
  cleanup: () => void;
}

export function signalWithTimeout(timeoutMs: number, parent?: AbortSignal): LinkedAbortSignal {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort(new DOMException("Timeout elapsed", "TimeoutError"));
  }, timeoutMs);

  const abortFromParent = () => {
    if (!controller.signal.aborted) controller.abort(parent?.reason);
  };

  if (parent?.aborted) {
    abortFromParent();
  } else {
    parent?.addEventListener("abort", abortFromParent, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

/**
 * Bind a response body's lifetime to an abort signal.
 *
 * Bun's HTTP client, when a `fetch(..., { signal })` is aborted AFTER the response resolved, tears
 * down the response body stream and rejects any in-flight internal read. If our code hasn't attached
 * a reader yet (e.g. the abort lands between `await fetch()` and the decoder's first read), that
 * rejection is orphaned off the awaited path and Bun reports it as
 * `unhandledRejection: TypeError: null is not an object` (native-only stack) — uncatchable by any
 * caller try/catch. Proactively cancelling the body on abort makes US the consumer that settles it,
 * so the rejection is absorbed. Returns a cleanup to detach the listener on the normal path.
 */
export function cancelBodyOnAbort(body: ReadableStream<Uint8Array> | null, signal?: AbortSignal): () => void {
  if (!body || !signal) return () => {};
  const onAbort = () => { void body.cancel().catch(() => {}); };
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}
