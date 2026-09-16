/** A response-body guard owns one reader, never the request-wide abort controller. */
export interface ResponseBodyInactivityGuard {
  response: Response;
  /** Stop an abandoned parser without waiting for a broken source's cancel promise. */
  dispose: () => void;
}

export class ResponseBodyInactivityError extends DOMException {
  constructor(timeoutMs: number) {
    super(`Upstream response body stalled for ${timeoutMs}ms`, "TimeoutError");
  }
}

/**
 * Bound silence only while the consumer is waiting for upstream bytes.
 *
 * A zero high-water mark prevents this wrapper from speculatively reading while
 * the consumer is paused. Empty chunks neither count as progress nor reset the
 * deadline. Cancellation is local to this body: aborting a shared request signal
 * here would suppress the failure terminal in the enclosing Responses bridge.
 */
export function guardResponseBodyInactivity(
  response: Response,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): ResponseBodyInactivityGuard {
  const source = response.body;
  if (!source) return { response, dispose: () => {} };

  const reader = source.getReader();
  const timeoutEnabled = Number.isFinite(timeoutMs) && timeoutMs > 0;
  const timeoutError = new ResponseBodyInactivityError(timeoutMs);
  let output!: ReadableStreamDefaultController<Uint8Array>;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: number | undefined;

  const pause = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    deadline = undefined;
  };
  const release = (): void => {
    try { reader.releaseLock(); } catch { /* a source may already have torn down */ }
  };
  const settle = (): boolean => {
    if (settled) return false;
    settled = true;
    pause();
    signal?.removeEventListener("abort", onAbort);
    return true;
  };
  const cancelSource = (reason?: unknown): void => {
    // reader.cancel settles outstanding reads before its source cleanup completes.
    // Never await that cleanup; custom transports can leave it pending forever.
    try { void reader.cancel(reason).catch(() => {}); } catch { /* already released */ }
    release();
  };
  const fail = (reason: unknown): void => {
    if (!settle()) return;
    // Publish the failure before cancellation can synchronously tear down relays.
    try { output.error(reason); } catch { /* downstream is already closed */ }
    cancelSource(reason);
  };
  const onAbort = (): void => {
    fail(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
  };
  const arm = (): void => {
    if (settled || deadline === undefined) return;
    // Avoid the platform's signed-32-bit setTimeout overflow for large settings.
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      fail(timeoutError);
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      arm();
    }, Math.min(2_147_483_647, Math.max(1, remaining)));
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller;
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    },
    async pull(controller) {
      if (settled) return;
      if (timeoutEnabled) {
        deadline = performance.now() + timeoutMs;
        arm();
      }
      try {
        let emptyReads = 0;
        for (;;) {
          // A producer of immediately resolved empty chunks can starve timers.
          // The monotonic deadline check also bounds that microtask-only loop.
          if (deadline !== undefined && performance.now() >= deadline) {
            fail(timeoutError);
            return;
          }
          const { done, value } = await reader.read();
          if (settled) return;
          if (done) {
            settle();
            release();
            controller.close();
            return;
          }
          if (value.byteLength === 0) {
            // Empty chunks are not progress, so the deadline keeps running. Hand the
            // macrotask queue a turn periodically: otherwise a long configured timeout
            // lets this microtask chain hold timers and unrelated requests.
            emptyReads += 1;
            if (emptyReads % 64 === 0) {
              await new Promise<void>(resolve => { setTimeout(resolve, 0); });
              if (settled) return;
            }
            continue;
          }
          emptyReads = 0;
          pause();
          controller.enqueue(value);
          return;
        }
      } catch (error) {
        fail(error);
      }
    },
    cancel(reason) {
      if (!settle()) return;
      cancelSource(reason);
    },
  }, { highWaterMark: 0 });

  return {
    response: new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
    dispose: () => {
      if (!settle()) return;
      try { output.close(); } catch { /* parser already settled */ }
      cancelSource();
    },
  };
}

/** Native SSE and bounded JSON/error readers retain their existing ownership. */
export function guardDirectPassthroughBodyInactivity(
  response: Response,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Response {
  const redirect = response.status >= 300 && response.status < 400;
  const contentType = response.headers.get("content-type")?.toLowerCase();
  if (!redirect && (!response.ok
    || contentType?.includes("text/event-stream")
    || contentType?.includes("application/json"))) return response;
  return guardResponseBodyInactivity(response, signal, timeoutMs).response;
}

/** Scope a buffered adapter parser, including throws and early successful returns. */
export async function readResponseBodyWithInactivity<T>(
  response: Response,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  parse: (response: Response) => Promise<T>,
): Promise<T> {
  const guarded = guardResponseBodyInactivity(response, signal, timeoutMs);
  try {
    return await parse(guarded.response);
  } finally {
    guarded.dispose();
  }
}

/** Scope an adapter stream, including continuation legs and iterator abandonment. */
export async function* readResponseStreamWithInactivity<T>(
  response: Response,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  parse: (response: Response) => AsyncIterable<T>,
): AsyncGenerator<T> {
  const guarded = guardResponseBodyInactivity(response, signal, timeoutMs);
  try {
    yield* parse(guarded.response);
  } finally {
    guarded.dispose();
  }
}
