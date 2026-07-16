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

export interface IdleDeadline {
  /** (Re-)arm the timer for one idle window. Call when a wait for progress BEGINS. No-op after fire/cancel. */
  reset: () => void;
  /** Disarm the timer WITHOUT retiring the deadline (call when the awaited progress arrives). No-op after fire/cancel. */
  pause: () => void;
  /** Retire permanently (success/teardown paths). Idempotent. */
  cancel: () => void;
}

/**
 * Resettable inactivity deadline (devlog 260716_passthrough_followups/010).
 *
 * Fires `onIdle` at most ONCE after `idleMs` elapses with no `reset()`/`pause()`.
 * Contract:
 * - `idleMs <= 0` returns an inert no-op deadline — the 0-disable responsibility
 *   lives here so callers cannot mis-handle it.
 * - The timer starts DISARMED: callers arm it with `reset()` when a wait begins and
 *   `pause()` it when the wait settles, so pull-based relays never count downstream
 *   backpressure (no pending read) as upstream inactivity.
 * - First terminal wins: after `onIdle` runs or `cancel()` is called, every method
 *   is a no-op and `onIdle` never runs again.
 * - Never linked to fetch signals — the consumer decides how to kill its stream
 *   (e.g. reader.cancel), keeping body-lifetime semantics unchanged.
 */
export function idleDeadline(idleMs: number, onIdle: () => void): IdleDeadline {
  if (idleMs <= 0) return { reset: () => {}, pause: () => {}, cancel: () => {} };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const disarm = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return {
    reset: () => {
      if (done) return;
      disarm();
      timer = setTimeout(() => {
        if (done) return;
        done = true;
        timer = undefined;
        onIdle();
      }, idleMs);
    },
    pause: () => {
      if (done) return;
      disarm();
    },
    cancel: () => {
      if (done) return;
      done = true;
      disarm();
    },
  };
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
