import type { ResponsesTerminalStatus } from "../../bridge";
import { comboFailureDecision } from "../../combos";
import { httpStatusFromTerminalError } from "../../lib/errors";
import type { RequestLogContext } from "../request-log";
import { createSseInspector } from "../relay";
import { MAX_CLIENT_SSE_FRAME_BYTES } from "../sse-frame-buffer";

const COMBO_STREAM_PREFLIGHT_MAX_BYTES = MAX_CLIENT_SSE_FRAME_BYTES;
// Keep retained object count proportional to the same byte budget used by the
// shared SSE framer. Tiny or empty upstream reads must not bypass the byte cap.
const COMBO_STREAM_PREFLIGHT_MAX_CHUNKS = Math.max(
  1,
  Math.ceil(COMBO_STREAM_PREFLIGHT_MAX_BYTES / 1024),
);

const PRE_OUTPUT_CONTROL_EVENTS = new Set([
  "response.created",
  "response.in_progress",
  "response.queued",
  "response.heartbeat",
]);

const TERMINAL_EVENTS = new Set([
  "response.completed",
  "response.failed",
  "response.incomplete",
]);

const RETRYABLE_ZERO_OUTPUT_INCOMPLETE_REASONS = new Set([
  "adapter_eof",
  "missing_terminal_event",
  "upstream_stall_timeout",
]);

function bareErrorStatus(payload: unknown): number | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const event = payload as Record<string, unknown>;
  if (event.type !== "error") return undefined;
  const nested = event.error;
  const error = nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : event;
  const explicitStatus = [
    event.status,
    event.status_code,
    event.http_status,
    error.status,
    error.status_code,
    error.http_status,
  ]
    .map(value => typeof value === "number" && Number.isInteger(value)
      ? value
      : typeof value === "string" && /^\d{3}$/.test(value.trim())
        ? Number(value)
        : undefined)
    .find(value => value !== undefined && value >= 400 && value <= 599);
  const code = typeof error.code === "string"
    ? error.code
    : typeof event.code === "string" ? event.code : null;
  if (explicitStatus === undefined && code === "invalid_request_error") return 400;
  return explicitStatus ?? httpStatusFromTerminalError({
    type: typeof error.type === "string" && error.type !== "error" ? error.type : undefined,
    code,
    message: typeof error.message === "string"
      ? error.message
      : typeof event.message === "string" ? event.message : undefined,
  });
}

function bareErrorIsRetryable(payload: unknown): boolean {
  const status = bareErrorStatus(payload);
  if (status === undefined || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const event = payload as Record<string, unknown>;
  const nested = event.error;
  const error = nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : event;
  const code = typeof error.code === "string"
    ? error.code
    : typeof event.code === "string" ? event.code : null;
  const message = typeof error.message === "string"
    ? error.message
    : typeof event.message === "string" ? event.message : "";
  return comboFailureDecision(status, message, { code }) === "hop";
}

function retryableZeroOutputTerminal(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const event = payload as {
    type?: unknown;
    response?: { incomplete_details?: { reason?: unknown } };
  };
  if (bareErrorIsRetryable(event)) return true;
  if (event.type === "response.failed") return true;
  if (event.type !== "response.incomplete") return false;
  const reason = event.response?.incomplete_details?.reason;
  return typeof reason === "string" && RETRYABLE_ZERO_OUTPUT_INCOMPLETE_REASONS.has(reason);
}

/**
 * Decide when replaying the request on another combo target would risk duplicating
 * client-visible output or a tool-side effect. Unknown event types commit the child
 * conservatively; only the small Responses lifecycle preamble remains replayable.
 */
export function comboStreamPayloadCommitsOutput(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return true;
  const type = (payload as { type?: unknown }).type;
  if (typeof type !== "string") return true;
  if (type === "response.created") {
    const response = (payload as { response?: unknown }).response;
    if (response && typeof response === "object" && !Array.isArray(response)) {
      const output = (response as { output?: unknown }).output;
      if (Array.isArray(output) && output.length > 0) return true;
    }
  }
  return !PRE_OUTPUT_CONTROL_EVENTS.has(type) && !TERMINAL_EVENTS.has(type);
}

function replayBufferedResponse(
  response: Response,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffered: Uint8Array[],
): Response {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < buffered.length) {
        controller.enqueue(buffered[index++]!);
        return;
      }
      try {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        try { controller.error(error); } catch { /* consumer already closed */ }
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => undefined);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function failedTerminalResponse(
  response: Response,
  terminalPayload: Record<string, unknown>,
  logCtx: RequestLogContext,
): Response {
  const nested = terminalPayload.response;
  const terminalResponse = nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : {};
  const nestedError = terminalResponse.error;
  const topLevelError = terminalPayload.error;
  const error = nestedError && typeof nestedError === "object" && !Array.isArray(nestedError)
    ? nestedError as Record<string, unknown>
    : topLevelError && typeof topLevelError === "object" && !Array.isArray(topLevelError)
      ? topLevelError as Record<string, unknown>
    : {
      type: "upstream_error",
      code: "upstream_server_error",
      message: typeof terminalPayload.message === "string"
        ? terminalPayload.message
        : logCtx.upstreamError ?? "Provider stream failed before producing output",
    };
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  headers.delete("content-encoding");
  const usage = terminalResponse.usage;
  return new Response(JSON.stringify({
    error,
    // The combo classifier needs only the error and optional usage. Do not carry
    // response ids, provider metadata, or future terminal fields into the client
    // error envelope merely because they shared the terminal snapshot.
    response: {
      error,
      ...(usage && typeof usage === "object" && !Array.isArray(usage) ? { usage } : {}),
    },
  }), {
    status: logCtx.terminalHttpStatus ?? bareErrorStatus(terminalPayload) ?? 502,
    headers,
  });
}

export type ComboStreamPreflightResult =
  | { kind: "accepted"; response: Response }
  | { kind: "failed"; response: Response }
  | { kind: "read-error-before-output"; response: Response; error: unknown };

/**
 * Buffer a Responses SSE only until the request becomes unsafe to replay or reaches
 * a terminal. Combo failover and native reset recovery share this protocol boundary.
 * This owns exactly one body reader. The aggregate
 * buffer is capped by bytes and retained chunks; hitting either cap commits the
 * current target instead of growing memory or guessing that replay is safe.
 */
export async function preflightComboStreamResponse(
  response: Response,
  logCtx: RequestLogContext,
  retryableTerminal: (payload: unknown) => boolean = retryableZeroOutputTerminal,
  options?: { allowMissingContentType?: boolean; replayReadErrors?: boolean },
): Promise<ComboStreamPreflightResult> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const isEventStream = contentType.includes("text/event-stream")
    || (!contentType && options?.allowMissingContentType === true);
  if (!response.ok || !response.body || !isEventStream) {
    return { kind: "accepted", response };
  }

  const reader = response.body.getReader();
  const buffered: Uint8Array[] = [];
  let bufferedBytes = 0;
  let outputCommitted = false;
  let responseCreated = false;
  let terminalStatus: ResponsesTerminalStatus | undefined;
  let retryableTerminalPayload: Record<string, unknown> | undefined;
  const inspector = createSseInspector({
    logCtx,
    onOpaquePayload: () => { outputCommitted = true; },
    onParsedPayload: payload => {
      if (terminalStatus !== undefined || outputCommitted || retryableTerminalPayload) return;
      if (payload !== null && typeof payload === "object" && !Array.isArray(payload)
        && (payload as { type?: unknown }).type === "response.created") responseCreated = true;
      const retryable = retryableTerminal(payload);
      const matchedBareError = retryable && payload !== null && typeof payload === "object"
        && !Array.isArray(payload) && (payload as { type?: unknown }).type === "error";
      // A zero-output bare error is terminal evidence. Explicit client errors stay
      // committed; unknown and retryable upstream failures may advance the combo.
      if (comboStreamPayloadCommitsOutput(payload) && !matchedBareError) outputCommitted = true;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
      if (retryable) retryableTerminalPayload = payload as Record<string, unknown>;
    },
    onTerminal: status => { terminalStatus = status; },
  });

  try {
    for (;;) {
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await reader.read();
      } catch (error) {
        if (!options?.replayReadErrors) throw error;
        // The native relay still owns post-header transport failures. Preserve
        // the bounded prefix and the errored reader; cancelling it here would
        // erase the failure before either client relay or inspection sees it.
        const replay = replayBufferedResponse(response, reader, buffered);
        return responseCreated && !outputCommitted && terminalStatus === undefined
          ? { kind: "read-error-before-output", response: replay, error }
          : { kind: "accepted", response: replay };
      }
      if (next.done) {
        inspector.finish();
      } else {
        if (bufferedBytes + next.value.byteLength > COMBO_STREAM_PREFLIGHT_MAX_BYTES) {
          // Keep the cap about memory the preflight allocates. The upstream chunk already exists;
          // copying it before committing would transiently exceed the boundary for no
          // replay benefit. Preserve it unsliced behind the already-bounded prefix.
          return {
            kind: "accepted",
            response: replayBufferedResponse(response, reader, [...buffered, next.value]),
          };
        }
        const retained = next.value.slice();
        buffered.push(retained);
        bufferedBytes += retained.byteLength;
        inspector.feed(retained);
      }

      // A bare error event is not a protocol terminal (terminalStatus stays undefined),
      // so its retryable classification doubles as the terminal evidence.
      if ((terminalStatus === "failed" || terminalStatus === "incomplete"
        || retryableTerminalPayload?.type === "error")
        && !outputCommitted && retryableTerminalPayload) {
        await reader.cancel("retrying zero-output combo stream terminal").catch(() => undefined);
        return { kind: "failed", response: failedTerminalResponse(response, retryableTerminalPayload, logCtx) };
      }
      if (next.done || terminalStatus !== undefined || outputCommitted
        || bufferedBytes >= COMBO_STREAM_PREFLIGHT_MAX_BYTES
        || buffered.length >= COMBO_STREAM_PREFLIGHT_MAX_CHUNKS) {
        return { kind: "accepted", response: replayBufferedResponse(response, reader, buffered) };
      }
    }
  } finally {
    inspector.dispose();
  }
}

export type ProtocolSafeResetRecovery = (error: unknown) => Promise<Response | null>;

/**
 * Defer protocol inspection until the downstream actually pulls the body. Direct
 * passthrough must return response headers before the first SSE event arrives;
 * combo routing is the only caller that intentionally awaits this preflight.
 */
export function deferProtocolSafeResetRecovery(
  response: Response,
  logCtx: RequestLogContext,
  recover: ProtocolSafeResetRecovery,
  options?: { allowMissingContentType?: boolean },
): Response {
  if (!response.body) return response;

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let initialization: Promise<void> | undefined;
  let closed = false;

  const cancelBody = (body: ReadableStream<Uint8Array> | null, reason?: unknown): void => {
    try { void body?.cancel(reason).catch(() => {}); } catch { /* already locked or closed */ }
  };
  const initialize = async (): Promise<void> => {
    const preflight = await preflightComboStreamResponse(
      response,
      logCtx,
      () => false,
      { allowMissingContentType: options?.allowMissingContentType === true, replayReadErrors: true },
    );
    let selected = preflight.response;
    if (preflight.kind === "read-error-before-output") {
      const replacement = await recover(preflight.error);
      if (replacement) {
        cancelBody(selected.body, "using protocol-safe replacement stream");
        selected = replacement;
      }
    }
    if (closed) {
      cancelBody(selected.body, "downstream cancelled before protocol preflight completed");
      return;
    }
    reader = selected.body?.getReader();
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        initialization ??= initialize();
        await initialization;
        if (closed) return;
        if (!reader) {
          closed = true;
          controller.close();
          return;
        }
        const next = await reader.read();
        if (closed) return;
        if (next.done) {
          closed = true;
          try { reader.releaseLock(); } catch { /* already released */ }
          reader = undefined;
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        if (closed) return;
        closed = true;
        try { reader?.releaseLock(); } catch { /* errored reader */ }
        reader = undefined;
        controller.error(error);
      }
    },
    cancel(reason) {
      if (closed) return;
      closed = true;
      if (reader) {
        try { void reader.cancel(reason).catch(() => {}); } catch { /* already closed */ }
        try { reader.releaseLock(); } catch { /* already released */ }
        reader = undefined;
      } else {
        cancelBody(response.body, reason);
      }
    },
  }, { highWaterMark: 0 });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
