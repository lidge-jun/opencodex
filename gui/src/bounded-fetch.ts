/**
 * Bound a fetch with AbortSignal.timeout when available; otherwise a manual
 * timer that must be cleared after settlement / unmount.
 */

export type BoundedFetch = {
  controller: AbortController;
  signal: AbortSignal;
  clear: () => void;
};

export function createBoundedFetch(ms: number): BoundedFetch {
  const controller = new AbortController();
  if (
    typeof AbortSignal !== "undefined"
    && typeof AbortSignal.any === "function"
    && typeof AbortSignal.timeout === "function"
  ) {
    return {
      controller,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(ms)]),
      clear: () => undefined,
    };
  }
  const timeoutId = setTimeout(() => controller.abort(), ms);
  return {
    controller,
    signal: controller.signal,
    clear: () => clearTimeout(timeoutId),
  };
}

/** Bound headers and body work even when a transport ignores abort; late writers must check signal. */
export async function withFetchDeadline<T>(ms: number, caller: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  caller?.throwIfAborted();
  const bounded = createBoundedFetch(ms);
  const cancel = () => bounded.controller.abort(caller?.reason);
  caller?.addEventListener("abort", cancel, { once: true });
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(bounded.signal.reason ?? new DOMException("Aborted", "AbortError"));
    bounded.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const operation = (async () => {
      bounded.signal.throwIfAborted();
      return work(bounded.signal);
    })();
    const result = await Promise.race([operation, aborted]);
    bounded.signal.throwIfAborted();
    return result;
  } finally {
    bounded.clear();
    caller?.removeEventListener("abort", cancel);
    bounded.signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Release a response body without letting cleanup delay or replace the caller's
 * status classification: a rejected, stalled, or throwing cancel is ignored.
 */
export function discardResponseBody(response: Response): void {
  try { void response.body?.cancel().catch(() => {}); } catch { /* best effort */ }
}
