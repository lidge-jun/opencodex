export interface LinkedAbortSignal {
  signal: AbortSignal;
  cleanup: () => void;
}

export interface ClearableDeadline {
  /** Parent-linked signal passed to fetch; remains parent-linked after clear(). */
  signal: AbortSignal;
  /** Stable reason object used when this deadline wins the abort race. */
  timeoutReason: DOMException;
  /** True only when this deadline, rather than the parent, fired first. */
  didExpire: () => boolean;
  /** Clear only the timer. Never aborts the deadline controller or detaches the parent. */
  clear: () => void;
}

/**
 * Response-header deadline whose timer can be cleared without severing body-lifetime cancellation.
 *
 * `signalWithTimeout().cleanup()` intentionally removes its parent listener and is therefore suited
 * to operations that are completely finished at cleanup. A fetch response body is different: once
 * headers arrive the deadline ends, but the original parent/client signal must remain attached to
 * the body. `AbortSignal.any()` supplies that direct lifetime link while `clear()` owns only the
 * timer.
 */
export function clearableDeadline(timeoutMs: number, parent?: AbortSignal): ClearableDeadline {
  const deadline = new AbortController();
  const timeoutReason = new DOMException("Timeout elapsed", "TimeoutError");
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    timer = undefined;
    if (!deadline.signal.aborted) deadline.abort(timeoutReason);
  }, timeoutMs);
  const signal = parent ? AbortSignal.any([parent, deadline.signal]) : deadline.signal;

  return {
    signal,
    timeoutReason,
    didExpire: () => signal.aborted && signal.reason === timeoutReason,
    clear: () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
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
