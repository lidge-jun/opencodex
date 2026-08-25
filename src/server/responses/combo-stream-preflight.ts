import type { ResponsesTerminalStatus } from "../../bridge";
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

/**
 * Decide when replaying the request on another combo target would risk duplicating
 * client-visible output or a tool-side effect. Unknown event types commit the child
 * conservatively; only the small Responses lifecycle preamble remains replayable.
 */
export function comboStreamPayloadCommitsOutput(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return true;
  const type = (payload as { type?: unknown }).type;
  if (typeof type !== "string") return true;
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
  const error = nestedError && typeof nestedError === "object" && !Array.isArray(nestedError)
    ? nestedError as Record<string, unknown>
    : {
      type: "upstream_error",
      code: "upstream_server_error",
      message: logCtx.upstreamError ?? "Provider stream failed before producing output",
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
    status: logCtx.terminalHttpStatus ?? 502,
    headers,
  });
}

export type ComboStreamPreflightResult =
  | { kind: "accepted"; response: Response }
  | { kind: "failed"; response: Response };

/**
 * Buffer a combo child's downstream SSE only until the request becomes unsafe to
 * replay or reaches a terminal. This owns exactly one body reader. The aggregate
 * buffer is capped by bytes and retained chunks; hitting either cap commits the
 * current target instead of growing memory or guessing that replay is safe.
 */
export async function preflightComboStreamResponse(
  response: Response,
  logCtx: RequestLogContext,
): Promise<ComboStreamPreflightResult> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!response.ok || !response.body || !contentType.includes("text/event-stream")) {
    return { kind: "accepted", response };
  }

  const reader = response.body.getReader();
  const buffered: Uint8Array[] = [];
  let bufferedBytes = 0;
  let outputCommitted = false;
  let terminalStatus: ResponsesTerminalStatus | undefined;
  let failedPayload: Record<string, unknown> | undefined;
  const inspector = createSseInspector({
    logCtx,
    onParsedPayload: payload => {
      if (comboStreamPayloadCommitsOutput(payload)) outputCommitted = true;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
      if ((payload as { type?: unknown }).type === "response.failed") {
        failedPayload = payload as Record<string, unknown>;
      }
    },
    onTerminal: status => { terminalStatus = status; },
  });

  try {
    for (;;) {
      const next = await reader.read();
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

      if (terminalStatus === "failed" && !outputCommitted && failedPayload) {
        await reader.cancel("retrying zero-output combo stream failure").catch(() => undefined);
        return { kind: "failed", response: failedTerminalResponse(response, failedPayload, logCtx) };
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
