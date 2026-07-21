import type { ResponsesTerminalStatus } from "../bridge";
import { isUsageDebugEnabled } from "../usage/debug";
import {
  addRequestLog,
  addFinalRequestLog,
  httpStatusForRequestLogTerminal,
  inspectResponseLogJson,
  inspectResponseLogSsePayload,
  recordFirstOutput,
  type RequestLogContext,
  type RequestLogEntry,
} from "./request-log";

const nativePassthroughSseResponses = new WeakSet<Response>();

export function relayWithAbort(
  body: ReadableStream<Uint8Array> | null,
  upstream: AbortController,
): ReadableStream<Uint8Array> | null {
  if (!body) return null;
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        try { controller.error(err); } catch { /* already torn down */ }
      }
    },
    cancel(reason) {
      // Client disconnected: abort the upstream fetch and release the reader so we do not leak it.
      upstream.abort(reason);
      reader.cancel(reason).catch(() => {});
    },
  });
}

/**
 * Relay a passthrough SSE body like relayWithAbort, but convert a MID-STREAM failure (upstream
 * reset after headers) into a clean terminal: any partial block is closed off, then a synthetic
 * `response.failed` event and `data: [DONE]` are emitted and the stream closes. Without this the
 * client sees a raw socket teardown with no terminal SSE event. Deliberately NOT a resend: the
 * upstream already committed the request (duplicate-completion risk — same policy as cursor's
 * committed=non-replayable transport retry).
 */
export function relaySseWithFailedTail(
  body: ReadableStream<Uint8Array>,
  upstream: AbortController,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        const failure = {
          type: "upstream_error",
          code: "upstream_reset",
          message: `Upstream stream terminated unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
        };
        const payload = JSON.stringify({
          type: "response.failed",
          response: { status: "failed", error: failure, last_error: failure },
        });
        try {
          // Leading blank line terminates a partial SSE block so the failed frame parses cleanly.
          controller.enqueue(encoder.encode(`\n\nevent: response.failed\ndata: ${payload}\n\ndata: [DONE]\n\n`));
          controller.close();
        } catch { /* client already torn down */ }
        upstream.abort();
      }
    },
    cancel(reason) {
      upstream.abort(reason);
      reader.cancel(reason).catch(() => {});
    },
  });
}

export function nextSseBlock(buffer: string): { block: string; rest: string } | null {
  const match = buffer.match(/\r?\n\r?\n/);
  if (!match || match.index === undefined) return null;
  return {
    block: buffer.slice(0, match.index),
    rest: buffer.slice(match.index + match[0].length),
  };
}

export function sseDataPayload(block: string): string | null {
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const value = line.slice(5);
    data.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  return data.length > 0 ? data.join("\n") : null;
}

export function terminalStatusFromSsePayload(payload: string): ResponsesTerminalStatus | null {
  return terminalStatusFromSsePayloadInner(payload);
}

/** True when a native Responses SSE payload carries the FIRST kind of non-empty model output. */
export function isFirstOutputSsePayload(payload: string | null): boolean {
  if (!payload || payload === "[DONE]") return false;
  try {
    const event = JSON.parse(payload) as { type?: unknown; delta?: unknown };
    return (event.type === "response.output_text.delta"
      || event.type === "response.reasoning_summary_text.delta"
      || event.type === "response.reasoning_text.delta")
      && typeof event.delta === "string"
      && event.delta.length > 0;
  } catch {
    return false;
  }
}

function createFirstOutputReporter(onFirstOutput?: () => void): (payload: string | null) => void {
  let reported = false;
  return payload => {
    if (reported || !isFirstOutputSsePayload(payload)) return;
    reported = true;
    try { onFirstOutput?.(); } catch { /* metrics must not break the stream */ }
  };
}

function terminalStatusFromSsePayloadInner(payload: string): ResponsesTerminalStatus | null {
  if (payload === "[DONE]") return null;
  try {
    const json = JSON.parse(payload) as { type?: unknown };
    switch (json.type) {
      case "response.completed":
        return "completed";
      case "response.failed":
        return "failed";
      case "response.incomplete":
        return "incomplete";
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Extract the response object from a `response.completed` SSE payload, or null. */
export function completedResponseFromSsePayload(payload: string): { id?: unknown; output?: unknown; status?: unknown } | null {
  if (payload === "[DONE]") return null;
  try {
    const json = JSON.parse(payload) as { type?: unknown; response?: unknown };
    if (json.type !== "response.completed") return null;
    const response = json.response;
    if (!response || typeof response !== "object" || Array.isArray(response)) return null;
    return response as { id?: unknown; output?: unknown; status?: unknown };
  } catch {
    return null;
  }
}

export function trackSseForRequestLog(
  body: ReadableStream<Uint8Array>,
  onTerminal: (status: ResponsesTerminalStatus) => void,
  onCancel: () => void,
  logCtx?: RequestLogContext,
  onFirstOutput?: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminalReported = false;
  const reportFirstOutput = createFirstOutputReporter(onFirstOutput);

  const reportTerminal = (status: ResponsesTerminalStatus) => {
    if (terminalReported) return;
    terminalReported = true;
    onTerminal(status);
  };

  const inspectPayload = (payload: string | null) => {
    if (!payload) return;
    if (logCtx) inspectResponseLogSsePayload(logCtx, payload);
    reportFirstOutput(payload);
    const status = terminalStatusFromSsePayload(payload);
    if (status) reportTerminal(status);
  };

  const inspectChunk = (value: Uint8Array) => {
    buffer += decoder.decode(value, { stream: true });
    let next: { block: string; rest: string } | null;
    while ((next = nextSseBlock(buffer))) {
      buffer = next.rest;
      inspectPayload(sseDataPayload(next.block));
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          if (buffer.trim()) inspectPayload(sseDataPayload(buffer));
          if (!terminalReported) reportTerminal("incomplete");
          controller.close();
          return;
        }
        inspectChunk(value);
        controller.enqueue(value);
      } catch (err) {
        if (!terminalReported) reportTerminal("incomplete");
        try { controller.error(err); } catch { /* already torn down */ }
      }
    },
    cancel(reason) {
      onCancel();
      reader.cancel(reason).catch(() => {});
    },
  });
}

export function responseWithDeferredRequestLog(
  response: Response,
  requestId: string,
  start: number,
  logCtx: RequestLogContext,
  addLog: (entry: RequestLogEntry) => void = addRequestLog,
): Response {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (isUsageDebugEnabled() && !logCtx.usageDebugContentType && contentType) {
    logCtx.usageDebugContentType = contentType;
  }
  if (isNativePassthroughSseResponse(response)) {
    return response;
  }
  if (!response.body || !contentType.includes("text/event-stream")) {
    if (response.body && (contentType.includes("application/json") || response.status >= 400)) {
      const finalizeJsonLog = async () => {
        const text = await response.text();
        // Non-JSON error bodies: inspect/log only a bounded prefix (the stored
        // upstreamError is 500 chars anyway); the FULL text is still forwarded to the
        // client below, unchanged. JSON bodies keep full inspection (usage parsing).
        const isJson = contentType.includes("application/json");
        inspectResponseLogJson(logCtx, isJson ? text : text.slice(0, 8192));
        addFinalRequestLog(requestId, start, logCtx, response.status, { closeReason: "non_stream" }, addLog);
        return text;
      };
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            controller.enqueue(new TextEncoder().encode(await finalizeJsonLog()));
            controller.close();
          } catch (err) {
            addFinalRequestLog(requestId, start, logCtx, 502, { closeReason: "non_stream" }, addLog);
            try { controller.error(err); } catch { /* already torn down */ }
          }
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
    if (isUsageDebugEnabled() && logCtx.usageDebugBodyKind === undefined) {
      logCtx.usageDebugBodyKind = response.body ? "other" : "none";
    }
    addFinalRequestLog(requestId, start, logCtx, response.status, { closeReason: "non_stream" }, addLog);
    return response;
  }

  let logged = false;
  const body = trackSseForRequestLog(
    response.body,
    status => {
      if (logged) return;
      logged = true;
      addFinalRequestLog(requestId, start, logCtx, httpStatusForRequestLogTerminal(status, logCtx), {
        terminalStatus: status,
        closeReason: "terminal",
      }, addLog);
    },
    () => {
      if (logged) return;
      logged = true;
      addFinalRequestLog(requestId, start, logCtx, 499, { closeReason: "client_cancel" }, addLog);
    },
    logCtx,
    () => recordFirstOutput(logCtx, start),
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function markNativePassthroughSseResponse(response: Response): Response {
  nativePassthroughSseResponses.add(response);
  return response;
}

export function isNativePassthroughSseResponse(response: Response): boolean {
  return nativePassthroughSseResponses.has(response);
}

export function relaySseWithHeartbeat(
  body: ReadableStream<Uint8Array> | null,
  upstream: AbortController,
  heartbeatMs = 15_000,
  onTerminal?: (status: ResponsesTerminalStatus) => void,
  options?: { onStart?: () => void; onDone?: () => void },
): ReadableStream<Uint8Array> | null {
  if (!body) return null;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const heartbeat = new TextEncoder().encode(": opencodex keepalive\n\n");
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let clientCancelled = false;
  let terminalReported = false;
  let buffer = "";

  const reportTerminal = (status: ResponsesTerminalStatus) => {
    if (terminalReported || clientCancelled || closed) return;
    terminalReported = true;
    onTerminal?.(status);
  };

  const inspectPayload = (payload: string | null) => {
    if (!payload) return;
    const status = terminalStatusFromSsePayload(payload);
    if (status) reportTerminal(status);
  };

  const inspectChunk = (value: Uint8Array) => {
    buffer += decoder.decode(value, { stream: true });
    let next: { block: string; rest: string } | null;
    while ((next = nextSseBlock(buffer))) {
      buffer = next.rest;
      inspectPayload(sseDataPayload(next.block));
    }
  };

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    timer = undefined;
    options?.onDone?.();
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      options?.onStart?.();
      timer = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(heartbeat);
        } catch {
          cleanup();
        }
      }, heartbeatMs);
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          if (buffer.trim()) inspectPayload(sseDataPayload(buffer));
          if (!terminalReported && !clientCancelled) reportTerminal("incomplete");
          cleanup();
          controller.close();
          return;
        }
        inspectChunk(value);
        controller.enqueue(value);
      } catch (err) {
        if (!clientCancelled) reportTerminal("incomplete");
        cleanup();
        try { controller.error(err); } catch { /* already torn down */ }
      }
    },
    cancel(reason) {
      clientCancelled = true;
      cleanup();
      upstream.abort(reason);
      reader.cancel(reason).catch(() => {});
    },
  });
}

/**
 * Background-consume an SSE stream purely for terminal-outcome inspection (quota tracking).
 * Does not produce output; safe to ignore errors (the client-facing stream is separate).
 */
export function consumeForInspection(
  body: ReadableStream<Uint8Array>,
  onTerminal: (status: ResponsesTerminalStatus, httpStatusOverride?: number) => void,
  signal?: AbortSignal,
  onDone?: () => void,
  logCtx?: RequestLogContext,
  onCancel?: () => void,
  onCompletedResponse?: (response: { id?: unknown; output?: unknown; status?: unknown }) => void,
  onFirstOutput?: () => void,
): void {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reported = false;
  let cancelled = false;
  const reportFirstOutput = createFirstOutputReporter(onFirstOutput);
  if (signal) {
    if (signal.aborted) {
      // Aborted before we could read anything (Codex disconnects the instant it finishes reading).
      // Finalize as a client-cancel and release the turn — the early return skips pump()'s finally,
      // so onDone/onCancel must run here or the entry is silently dropped (#44).
      cancelled = true;
      reader.cancel(signal.reason).catch(() => {});
      onCancel?.();
      onDone?.();
      return;
    }
    signal.addEventListener("abort", () => {
      // Mid-drain disconnect: record a client-cancel entry (idempotent downstream) instead of the
      // suppressed onTerminal path. onDone still fires via pump()'s finally after the read rejects.
      cancelled = true;
      reader.cancel(signal.reason).catch(() => {});
      onCancel?.();
    }, { once: true });
  }
  const pump = async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          if (buffer.trim() && !reported) {
            const payload = sseDataPayload(buffer);
            if (logCtx) inspectResponseLogSsePayload(logCtx, payload);
            reportFirstOutput(payload);
            if (payload) {
              const status = terminalStatusFromSsePayload(payload);
              if (status) {
                reported = true;
                if (logCtx) {
                  logCtx.transportPhase = "terminal_sse";
                  logCtx.terminalSource = "upstream";
                }
                onTerminal(status);
              }
              if (onCompletedResponse) {
                const response = completedResponseFromSsePayload(payload);
                if (response) onCompletedResponse(response);
              }
            }
          }
          if (!reported && !cancelled) {
            if (logCtx) logCtx.terminalSource = "synthetic";
            onTerminal("incomplete");
          }
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        let next: { block: string; rest: string } | null;
        while ((next = nextSseBlock(buffer))) {
          buffer = next.rest;
          if (reported && !onCompletedResponse) continue;
          const payload = sseDataPayload(next.block);
          if (!reported && logCtx) inspectResponseLogSsePayload(logCtx, payload);
          reportFirstOutput(payload);
          if (!payload) continue;
          if (!reported) {
            const status = terminalStatusFromSsePayload(payload);
            if (status) {
              reported = true;
              if (logCtx) {
                logCtx.transportPhase = "terminal_sse";
                logCtx.terminalSource = "upstream";
              }
              onTerminal(status);
            }
          }
          if (onCompletedResponse) {
            const response = completedResponseFromSsePayload(payload);
            if (response) onCompletedResponse(response);
          }
        }
      }
    } catch {
      // Upstream read failure after HTTP 200 (mid-stream socket reset) is not a
      // protocol `response.incomplete` terminal. Report a synthetic 502 so account
      // health treats it as transient; abort-driven client cancellation still wins.
      if (!reported && !cancelled) {
        if (logCtx) {
          logCtx.transportPhase = "mid_stream";
          logCtx.terminalSource = "synthetic";
        }
        onTerminal("failed", 502);
      }
    } finally {
      onDone?.();
    }
  };
  pump();
}

export function consumeForResponseLogMetadata(
  body: ReadableStream<Uint8Array>,
  logCtx: RequestLogContext,
  signal?: AbortSignal,
  onDone?: () => void,
  onCompletedResponse?: (response: { id?: unknown; output?: unknown; status?: unknown }) => void,
  onFirstOutput?: () => void,
): void {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const reportFirstOutput = createFirstOutputReporter(onFirstOutput);
  if (signal) {
    if (signal.aborted) {
      reader.cancel(signal.reason).catch(() => {});
      onDone?.();
      return;
    }
    signal.addEventListener("abort", () => {
      reader.cancel(signal.reason).catch(() => {});
    }, { once: true });
  }
  const pump = async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          if (buffer.trim()) {
            const payload = sseDataPayload(buffer);
            inspectResponseLogSsePayload(logCtx, payload);
            reportFirstOutput(payload);
            if (payload && onCompletedResponse) {
              const response = completedResponseFromSsePayload(payload);
              if (response) onCompletedResponse(response);
            }
          }
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        let next: { block: string; rest: string } | null;
        while ((next = nextSseBlock(buffer))) {
          buffer = next.rest;
          const payload = sseDataPayload(next.block);
          inspectResponseLogSsePayload(logCtx, payload);
          reportFirstOutput(payload);
          if (payload && onCompletedResponse) {
            const response = completedResponseFromSsePayload(payload);
            if (response) onCompletedResponse(response);
          }
        }
      }
    } catch {
      /* metadata inspection must not affect the client-facing stream */
    } finally {
      onDone?.();
    }
  };
  pump();
}

/**
 * Bun's fetch auto-decompresses the response body but leaves the upstream `content-encoding`
 * (and a now-stale `content-length`) on `response.headers`. Relaying those with the already-decoded
 * body makes the caller (Codex) double-decode / truncate → "stream error" on every gpt passthrough.
 * Drop encoding + hop-by-hop headers; relay everything else (content-type, etc.) verbatim.
 */
export function sanitizePassthroughHeaders(upstream: Headers): Headers {
  const DROP = new Set([
    "content-encoding",
    "content-length",
    "transfer-encoding",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "set-cookie",
    "set-cookie2",
    "te",
    "trailer",
    "upgrade",
  ]);
  const out = new Headers();
  upstream.forEach((value, key) => {
    if (!DROP.has(key.toLowerCase())) out.set(key, value);
  });
  return out;
}
