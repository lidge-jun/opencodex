import type { ProviderAdapter } from "../adapters/base";
import type { AdapterEvent } from "../types";

const DEFAULT_POST_TERMINAL_DRAIN_TIMEOUT_MS = 5_000;

export class RoutedModelInactivityError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Routed model generation timeout after ${timeoutMs}ms without response bytes during web-search`);
    this.name = "RoutedModelInactivityError";
    this.timeoutMs = timeoutMs;
  }
}

export class WebSearchStreamProtocolError extends Error {
  constructor(message: string) {
    super(`Web-search adapter stream protocol error: ${message}`);
    this.name = "WebSearchStreamProtocolError";
  }
}

export interface ParseStreamWithProgressOptions {
  inactivityTimeoutMs: number;
  signal?: AbortSignal;
  /** Kept configurable for focused tests; production callers should use the 5 second default. */
  postTerminalDrainTimeoutMs?: number;
}

type ParseStream = ProviderAdapter["parseStream"];
type Resolver<T> = (value: T | PromiseLike<T>) => void;

interface PendingDelivery {
  event: AdapterEvent;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

/**
 * Capacity-one handoff. Semantic events are lossless and acknowledged when received; raw-byte
 * progress is only a coalesced liveness bit and never displaces a semantic event.
 */
class ProgressHandoff {
  private semantic: PendingDelivery | undefined;
  private progress = false;
  private receiver: { resolve: Resolver<IteratorResult<AdapterEvent>>; reject: (reason: unknown) => void } | undefined;
  private ended = false;
  private failed = false;
  private failure: unknown | undefined;

  async deliver(event: AdapterEvent): Promise<void> {
    if (this.failed) throw this.failure;
    if (this.ended) throw new WebSearchStreamProtocolError("event delivered after collector closed");

    if (this.receiver) {
      const receiver = this.receiver;
      this.receiver = undefined;
      receiver.resolve({ done: false, value: event });
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.semantic = { event, resolve, reject };
    });
  }

  offerProgress(): void {
    if (this.ended || this.failed) return;
    if (this.receiver && !this.semantic) {
      const receiver = this.receiver;
      this.receiver = undefined;
      receiver.resolve({ done: false, value: { type: "heartbeat" } });
      return;
    }
    this.progress = true;
  }

  receive(): Promise<IteratorResult<AdapterEvent>> {
    if (this.failed) return Promise.reject(this.failure);
    if (this.semantic) {
      const delivery = this.semantic;
      this.semantic = undefined;
      delivery.resolve();
      return Promise.resolve({ done: false, value: delivery.event });
    }
    if (this.progress) {
      this.progress = false;
      return Promise.resolve({ done: false, value: { type: "heartbeat" } });
    }
    if (this.ended) return Promise.resolve({ done: true, value: undefined });

    return new Promise<IteratorResult<AdapterEvent>>((resolve, reject) => {
      this.receiver = { resolve, reject };
    });
  }

  fail(reason: unknown): void {
    if (this.ended || this.failed) return;
    this.failed = true;
    this.failure = reason;
    this.progress = false;
    this.semantic?.reject(reason);
    this.semantic = undefined;
    this.receiver?.reject(reason);
    this.receiver = undefined;
  }

  close(): void {
    if (this.ended || this.failed) return;
    this.ended = true;
    this.progress = false;
    this.semantic?.reject(new WebSearchStreamProtocolError("collector closed with a pending event"));
    this.semantic = undefined;
    this.receiver?.resolve({ done: true, value: undefined });
    this.receiver = undefined;
  }
}

function normalizeTimeout(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite number`);
  }
  return value;
}

/**
 * Parse an adapter stream while exposing invisible raw-byte liveness heartbeats.
 *
 * The original body is never cloned or tee'd. This function owns its sole reader and supplies the
 * adapter with a demand-driven, highWaterMark-zero response body.
 */
export async function* parseStreamWithProgress(
  response: Response,
  parseStream: ParseStream,
  options: ParseStreamWithProgressOptions,
): AsyncGenerator<AdapterEvent> {
  const inactivityTimeoutMs = normalizeTimeout(options.inactivityTimeoutMs, "inactivityTimeoutMs");
  const postTerminalDrainTimeoutMs = normalizeTimeout(
    options.postTerminalDrainTimeoutMs ?? DEFAULT_POST_TERMINAL_DRAIN_TIMEOUT_MS,
    "postTerminalDrainTimeoutMs",
  );
  const handoff = new ProgressHandoff();
  const reader = response.body?.getReader();
  if (!reader) throw new WebSearchStreamProtocolError("upstream response has no body");

  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  let tappedController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let settled = false;
  let iterator: AsyncGenerator<AdapterEvent> | undefined;
  let iteratorReturnStarted = false;
  let detachAbort = (): void => {};
  let stopSignalled = false;
  let signalStop!: (reason: unknown) => void;
  const stopped = new Promise<unknown>(resolve => { signalStop = resolve; });

  const clearInactivity = (): void => {
    if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
    inactivityTimer = undefined;
  };

  const cancelReader = (reason: unknown): void => {
    try {
      void reader.cancel(reason).catch(() => {});
    } catch { /* reader cancellation is best-effort and must never replace the foreground outcome */ }
  };

  const closeIterator = (): void => {
    if (!iterator || iteratorReturnStarted) return;
    iteratorReturnStarted = true;
    try {
      const returned = iterator.return(undefined);
      void returned.catch(() => {});
    } catch { /* iterator return is best-effort and must never delay foreground failure */ }
  };

  const stop = (reason: unknown): void => {
    if (stopSignalled) return;
    stopSignalled = true;
    signalStop(reason);
  };

  const fail = (reason: unknown): void => {
    // A second failure may arrive from the parser after reader cancellation. Iterator cleanup is
    // still required even when the foreground failure has already won the settlement race.
    closeIterator();
    if (settled) return;
    settled = true;
    clearInactivity();
    detachAbort();
    stop(reason);
    handoff.fail(reason);
    try { tappedController?.error(reason); } catch { /* already closed/cancelled */ }
    cancelReader(reason);
  };

  const resetInactivity = (): void => {
    if (settled) return;
    clearInactivity();
    inactivityTimer = setTimeout(() => fail(new RoutedModelInactivityError(inactivityTimeoutMs)), inactivityTimeoutMs);
  };

  const onAbort = (): void => fail(options.signal?.reason);
  detachAbort = (): void => options.signal?.removeEventListener("abort", onAbort);
  if (options.signal?.aborted) fail(options.signal.reason);
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  const tappedBody = new ReadableStream<Uint8Array>({
    start(controller) {
      tappedController = controller;
    },
    async pull(controller) {
      try {
        while (!settled) {
          const result = await reader.read();
          if (result.done) {
            controller.close();
            return;
          }
          if (result.value.byteLength === 0) continue;
          resetInactivity();
          handoff.offerProgress();
          controller.enqueue(result.value);
          return;
        }
      } catch (error) {
        fail(error);
      }
    },
    cancel(reason) {
      cancelReader(reason);
      closeIterator();
    },
  }, { highWaterMark: 0 });

  const tappedResponse = new Response(tappedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });

  resetInactivity();

  const parserPump = (async (): Promise<void> => {
    let heldDone: Extract<AdapterEvent, { type: "done" }> | undefined;
    try {
      iterator = parseStream(tappedResponse);
      if (settled) {
        closeIterator();
        return;
      }
      while (true) {
        let result: IteratorResult<AdapterEvent>;
        if (heldDone) {
          let drainTimer: ReturnType<typeof setTimeout> | undefined;
          const drainTimeout = new Promise<never>((_, reject) => {
            drainTimer = setTimeout(() => reject(new WebSearchStreamProtocolError(
              `adapter did not return within ${postTerminalDrainTimeoutMs}ms after done`,
            )), postTerminalDrainTimeoutMs);
          });
          const stoppedDuringDrain = stopped.then(reason => { throw reason; });
          try {
            result = await Promise.race([iterator.next(), drainTimeout, stoppedDuringDrain]);
          } finally {
            if (drainTimer !== undefined) clearTimeout(drainTimer);
          }
        } else {
          result = await iterator.next();
        }

        if (result.done) {
          if (!heldDone) throw new WebSearchStreamProtocolError("adapter returned without a done event");
          await handoff.deliver(heldDone);
          if (!settled) {
            settled = true;
            clearInactivity();
            detachAbort();
            handoff.close();
            cancelReader(undefined);
          }
          return;
        }

        const event = result.value;
        if (heldDone) {
          throw new WebSearchStreamProtocolError(
            event.type === "done" ? "adapter yielded more than one done event" : "adapter yielded an event after done",
          );
        }
        if (event.type === "error") {
          fail(new Error(event.message));
          return;
        }
        if (event.type === "done") {
          heldDone = event;
          continue;
        }
        await handoff.deliver(event);
      }
    } catch (error) {
      fail(error instanceof WebSearchStreamProtocolError
        ? error
        : new WebSearchStreamProtocolError(
          `adapter threw${heldDone ? " after done" : ""}: ${error instanceof Error ? error.message : String(error)}`,
        ));
    }
  })();
  // The foreground intentionally never awaits this task during cancellation; keep every rejection observed.
  void parserPump.catch(() => {});

  try {
    while (true) {
      const result = await handoff.receive();
      if (result.done) return;
      yield result.value;
    }
  } finally {
    detachAbort();
    if (!settled) {
      const reason = new Error("Web-search stream consumer stopped");
      settled = true;
      clearInactivity();
      stop(reason);
      handoff.close();
      cancelReader(reason);
    }
    closeIterator();
    try { reader.releaseLock(); } catch { /* an outstanding read may still own the lock */ }
  }
}
