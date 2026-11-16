import type { RequestLogContext } from "../request-log";
import type { HandleResponsesOptions } from "./core-options";
import { hasResponseMediaType } from "../../lib/http-response-semantics";
import { readDisplaySafeErrorText } from "./core-errors";

/**
 * How long a streaming combo may spend choosing a child before the client gets a response head
 * (#8326). Below it nothing changes: the selected child's own head is returned, zero-output
 * failover stays invisible and an all-targets failure keeps its real HTTP status. Once it passes,
 * a 200 SSE head is committed so an idle-limited intermediary sees bytes, and the eventual
 * outcome is delivered inside that stream. It matches the native reset-selection heartbeat.
 */
export const COMBO_SELECTION_KEEPALIVE_THRESHOLD_MS = 15_000;
/** Gap between keepalive comments while selection continues behind a committed head. */
export const COMBO_SELECTION_KEEPALIVE_INTERVAL_MS = 15_000;

const KEEPALIVE = new TextEncoder().encode(": keepalive\n\n");
/** Proxy-owned copy for a ladder that threw after the head was committed; never the error text. */
const THROWN_SELECTION_MESSAGE = "opencodex could not complete this combo request";

/** Timer seam: production uses the global timers, tests advance a manual clock. */
export type ComboSelectionKeepaliveClock = NonNullable<NonNullable<HandleResponsesOptions["comboSelectionKeepalive"]>["clock"]>;

export interface ComboSelectionKeepaliveHooks {
  /** The request's abort signal, also aborted when the client cancels the committed stream. */
  signal: AbortSignal;
  /** True once the keepalive head has been handed to the client. */
  headCommitted(): boolean;
}

const systemClock: ComboSelectionKeepaliveClock = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Only a streaming Responses turn from the HTTP ingress opts in. WebSocket frames carry their own
 * status, Chat and Messages ingresses consume a different failure vocabulary, and internal
 * decision calls read the HTTP status themselves.
 */
export function comboSelectionKeepaliveApplies(
  rawBody: unknown,
  options: Pick<HandleResponsesOptions, "comboSelectionKeepalive" | "inboundTransport" | "inboundWire" | "internalDecisionCall">,
): boolean {
  return options.comboSelectionKeepalive !== undefined
    && (rawBody as { stream?: unknown } | null)?.stream === true
    && options.inboundTransport === undefined
    && (options.inboundWire === undefined || options.inboundWire === "responses")
    && options.internalDecisionCall !== true;
}

/**
 * The ladder's options behind a possible keepalive head. A committed head is an unmarked SSE
 * response, so the ingress request-log tap records its terminal; the native passthrough log
 * callbacks are dropped from then on so one request is never logged twice.
 */
export function comboSelectionKeepaliveLadderOptions<T extends HandleResponsesOptions>(
  options: T,
  hooks: ComboSelectionKeepaliveHooks,
): T {
  const { comboSelectionKeepalive: _optIn, ...rest } = options;
  const onTerminal = options.onNativePassthroughTerminal;
  const onCancel = options.onNativePassthroughCancel;
  return {
    ...rest,
    abortSignal: hooks.signal,
    ...(onTerminal ? { onNativePassthroughTerminal: status => { if (!hooks.headCommitted()) onTerminal(status); } } : {}),
    ...(onCancel ? { onNativePassthroughCancel: () => { if (!hooks.headCommitted()) onCancel(); } } : {}),
  } as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function failedFrame(model: string, error: { type?: string; code: string; message: string }): Uint8Array {
  const failure = { ...(error.type ? { type: error.type } : {}), code: error.code, message: error.message };
  const payload = {
    type: "response.failed",
    sequence_number: 0,
    response: {
      id: `resp_${crypto.randomUUID().replaceAll("-", "")}`,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "failed",
      model,
      output: [],
      error: failure,
      last_error: failure,
    },
  };
  return new TextEncoder().encode(`event: response.failed\ndata: ${JSON.stringify(payload)}\n\n`);
}

/** Restate a non-streamable selection (an error envelope) as the in-stream failure terminal. */
async function failureFromResponse(response: Response, signal: AbortSignal): Promise<{ type?: string; code: string; message: string }> {
  const fallback = `opencodex combo request failed with HTTP ${response.status}`;
  const text = await readDisplaySafeErrorText(response, signal, "");
  let record: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) record = isRecord(parsed.error) ? parsed.error : parsed;
  } catch { /* not JSON: the status-only fallback below applies */ }
  const type = typeof record?.type === "string" && record.type ? record.type : undefined;
  const code = typeof record?.code === "string" && record.code ? record.code
    : typeof record?.code === "number" && Number.isFinite(record.code) ? String(record.code)
    : type ?? (response.ok ? "invalid_response" : "upstream_error");
  const message = typeof record?.message === "string" && record.message.trim() ? record.message : fallback;
  return { ...(type ? { type } : {}), code, message };
}

/**
 * Run combo selection and return its response, or a keepalive SSE response once selection has
 * waited past the threshold. Behind the keepalive head, an accepted SSE child is streamed as is and
 * any other outcome becomes one `response.failed` with the same error code.
 */
export function selectComboWithKeepalive(
  select: (hooks: ComboSelectionKeepaliveHooks) => Promise<Response>,
  context: { model: string; logCtx: RequestLogContext; signal?: AbortSignal; clock?: ComboSelectionKeepaliveClock },
): Promise<Response> {
  const clock = context.clock ?? systemClock;
  const cancel = new AbortController();
  const signal = context.signal ? AbortSignal.any([context.signal, cancel.signal]) : cancel.signal;
  let committed = false;
  let settled = false;
  let closed = false;
  let keepaliveOwed = true;
  let source: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let wake: (() => void) | undefined;
  let timer: unknown;
  const stopTimer = (): void => {
    if (timer !== undefined) clock.clearTimeout(timer);
    timer = undefined;
  };
  const notify = (): void => { const next = wake; wake = undefined; next?.(); };
  const setSource = (stream: ReadableStream<Uint8Array> | null): void => {
    if (closed) {
      void stream?.cancel("client cancelled the committed combo stream").catch(() => {});
      return;
    }
    source = (stream ?? new ReadableStream<Uint8Array>({ start: controller => controller.close() })).getReader();
    notify();
  };
  const deliverFailure = (status: number, failure: { type?: string; code: string; message: string }): void => {
    context.logCtx.terminalHttpStatus = status;
    const frame = failedFrame(context.model, failure);
    setSource(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(frame); controller.close(); } }));
  };
  const deliver = async (response: Response): Promise<void> => {
    if (closed) {
      void response.body?.cancel("client cancelled the committed combo stream").catch(() => {});
      return;
    }
    if (response.ok && hasResponseMediaType(response.headers, "text/event-stream")) {
      setSource(response.body);
      return;
    }
    if (response.status === 499) {
      void response.body?.cancel().catch(() => {});
      setSource(null);
      return;
    }
    const failure = await failureFromResponse(response, signal);
    deliverFailure(response.ok ? 502 : response.status, failure);
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          if (closed) return;
          if (source) {
            const next = await source.read();
            if (closed) return;
            if (next.done) {
              closed = true;
              controller.close();
            } else {
              controller.enqueue(next.value);
            }
            return;
          }
          if (keepaliveOwed) {
            keepaliveOwed = false;
            controller.enqueue(KEEPALIVE);
            return;
          }
          await new Promise<void>(resolve => { wake = resolve; });
        }
      } catch (error) {
        if (closed) return;
        closed = true;
        controller.error(error);
      }
    },
    cancel(reason) {
      closed = true;
      stopTimer();
      cancel.abort(reason);
      notify();
      if (source) void source.cancel(reason).catch(() => {});
    },
  }, { highWaterMark: 0 });

  const scheduleKeepalive = (): void => {
    timer = clock.setTimeout(() => {
      timer = undefined;
      if (closed || settled) return;
      keepaliveOwed = true;
      notify();
      scheduleKeepalive();
    }, COMBO_SELECTION_KEEPALIVE_INTERVAL_MS);
  };

  return new Promise<Response>((resolve, reject) => {
    const selection = select({ signal, headCommitted: () => committed });
    timer = clock.setTimeout(() => {
      timer = undefined;
      // A cancelled request is about to settle as a client cancellation; it needs no head.
      if (settled || signal.aborted) return;
      committed = true;
      scheduleKeepalive();
      resolve(new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      }));
    }, COMBO_SELECTION_KEEPALIVE_THRESHOLD_MS);
    selection.then(response => {
      settled = true;
      stopTimer();
      if (!committed) {
        resolve(response);
        return;
      }
      deliver(response).catch(() => {
        deliverFailure(502, { type: "server_error", code: "server_error", message: THROWN_SELECTION_MESSAGE });
      });
    }, error => {
      settled = true;
      stopTimer();
      if (!committed) {
        reject(error);
        return;
      }
      console.warn(`[combo] selection failed after its keepalive head: ${error instanceof Error ? error.name : typeof error}`);
      deliverFailure(502, { type: "server_error", code: "server_error", message: THROWN_SELECTION_MESSAGE });
    });
  });
}
