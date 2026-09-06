import type { OcxConfig } from "../../types";
import type { AdmissionLease } from "../../lib/admission";
import { readBoundedResponseBody } from "../../lib/bounded-body";
import { waitForStrictCodexQuotaChange } from "../../codex/strict-quota-refresh";
import { registerTurn, unregisterTurn } from "../lifecycle";
import { isStrictQuotaWaitResponse } from "./strict-quota-response";

const HEARTBEAT = new TextEncoder().encode(
  'event: response.heartbeat\ndata: {"type":"response.heartbeat"}\n\n',
);

export interface StrictQuotaWaitOptions {
  config: OcxConfig;
  initial: Response;
  stream: boolean;
  signals: readonly (AbortSignal | undefined)[];
  lease?: AdmissionLease;
  canReplay: () => boolean;
  resume: (signal: AbortSignal) => Promise<Response>;
  finishAttempt: (status: number) => void;
  observedRevision?: () => number;
  onFailure?: (status: number) => void;
  /** Test seam: production uses the coalesced, event-driven quota waiter. */
  waitForChange?: typeof waitForStrictCodexQuotaChange;
  heartbeatMs?: number;
}

/** A real rejected replay needs a failed terminal once the heartbeat committed SSE headers. */
async function rejectedResponseFrame(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  let message = response.ok
    ? "The resumed request returned an unexpected non-streaming response"
    : `The resumed request failed (HTTP ${response.status})`;
  let code = response.ok ? "protocol_error" : "upstream_error";
  try {
    const body = await readBoundedResponseBody(response, { signal });
    if (body.displaySafe && !body.truncated) {
      const parsed = JSON.parse(body.text) as { error?: { message?: unknown; code?: unknown; type?: unknown } };
      if (typeof parsed.error?.message === "string") message = parsed.error.message.slice(0, 2048);
      if (typeof parsed.error?.code === "string") code = parsed.error.code.slice(0, 128);
      else if (typeof parsed.error?.type === "string") code = parsed.error.type.slice(0, 128);
    }
  } catch {
    // An unreadable error body keeps the truthful HTTP-status terminal, never a success.
  }
  return new TextEncoder().encode(`event: response.failed\ndata: ${JSON.stringify({
    type: "response.failed", response: { status: "failed", error: { code, message } },
  })}\n\n`);
}

/**
 * Keep one admitted request alive until a fresh quota observation permits another safe attempt.
 * Only process-local refusal evidence enters this owner; it never retries an accepted stream.
 */
export async function waitForStrictQuotaResponse(options: StrictQuotaWaitOptions): Promise<Response> {
  const ac = new AbortController();
  const parentListeners: Array<() => void> = [];
  for (const signal of new Set(options.signals.filter((value): value is AbortSignal => !!value))) {
    const abort = () => ac.abort(signal.reason);
    if (signal.aborted) abort();
    else {
      signal.addEventListener("abort", abort, { once: true });
      parentListeners.push(() => signal.removeEventListener("abort", abort));
    }
  }
  const ownsTurn = !!options.lease && "bindAbortController" in options.lease;
  if (ownsTurn) registerTurn(ac, options.lease);
  let timer: ReturnType<typeof setInterval> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  let waiting = true;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    for (const remove of parentListeners) remove();
    ac.signal.removeEventListener("abort", aborted);
    if (ownsTurn) unregisterTurn(ac);
  };
  const aborted = () => {
    const reason = ac.signal.reason ?? new DOMException("Aborted", "AbortError");
    void reader?.cancel(reason).catch(() => {});
    try { controller?.error(reason); } catch { /* already closed */ }
    cleanup();
  };
  ac.signal.addEventListener("abort", aborted, { once: true });

  const resume = async (): Promise<Response> => {
    let response = options.initial;
    try {
      while (isStrictQuotaWaitResponse(response) && options.canReplay()) {
        ac.signal.throwIfAborted();
        // Subscribe before releasing the old response, so quota updates during disposal wake us.
        const changed = (options.waitForChange ?? waitForStrictCodexQuotaChange)(options.config, ac.signal, options.observedRevision?.());
        void changed.catch(() => {});
        await response.body?.cancel().catch(() => {});
        options.finishAttempt(response.status);
        await changed;
        ac.signal.throwIfAborted();
        response = await options.resume(ac.signal);
      }
      ac.signal.throwIfAborted();
      return response;
    } catch (error) {
      await response.body?.cancel(error).catch(() => {});
      throw error;
    }
  };

  if (!options.stream) {
    try {
      const response = await resume();
      waiting = false;
      if (!response.body) { cleanup(); return response; }
      reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        start(value) { controller = value; },
        async pull(value) {
          try {
            ac.signal.throwIfAborted();
            const next = await reader!.read();
            if (closed) return;
            if (next.done) { cleanup(); value.close(); }
            else value.enqueue(next.value);
          } catch (error) { cleanup(); if (!ac.signal.aborted) value.error(error); }
        },
        async cancel(reason) { ac.abort(reason); await reader?.cancel(reason).catch(() => {}); cleanup(); },
      });
      const headers = new Headers(response.headers);
      headers.delete("x-opencodex-quota-wait");
      return new Response(body, { status: response.status, statusText: response.statusText, headers });
    } catch (error) { cleanup(); throw error; }
  }

  // Start no model work while backpressured: resume waits on metadata, and the final body is
  // read only by pull(). Heartbeats occupy at most one queued chunk while no client is reading.
  const pending = resume();
  void pending.then(response => {
    waiting = false;
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    if (closed) void response.body?.cancel().catch(() => {});
  }, () => {
    waiting = false;
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  });
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      if (ac.signal.aborted) { aborted(); return; }
      value.enqueue(HEARTBEAT);
      timer = setInterval(() => {
        if (!closed && waiting && (value.desiredSize ?? 0) > 0) value.enqueue(HEARTBEAT);
      }, options.heartbeatMs ?? 2_000);
      timer.unref?.();
    },
    async pull(value) {
      try {
        if (!reader) {
          const response = await pending;
          if (closed) { await response.body?.cancel(); return; }
          waiting = false;
          if (timer !== undefined) clearInterval(timer);
          timer = undefined;
          if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
            options.onFailure?.(response.ok ? 502 : response.status);
            value.enqueue(await rejectedResponseFrame(response, ac.signal));
            cleanup(); value.close(); return;
          }
          reader = response.body.getReader();
        }
        const next = await reader.read();
        if (closed) return;
        if (next.done) { cleanup(); value.close(); }
        else value.enqueue(next.value);
      } catch (error) {
        if (closed) return;
        if (ac.signal.aborted) { aborted(); return; }
        options.onFailure?.(502);
        value.enqueue(new TextEncoder().encode('event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"proxy_error","message":"The quota wait could not resume this request"}}}\n\n'));
        cleanup(); value.close();
      }
    },
    async cancel(reason) { ac.abort(reason); await reader?.cancel(reason).catch(() => {}); cleanup(); },
  });
  return new Response(body, { headers: {
    "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache",
    "x-accel-buffering": "no", connection: "keep-alive",
  } });
}
