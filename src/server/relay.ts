import type { ResponsesTerminalStatus } from "../bridge";
import { isTranslatorBudgetExceededError } from "../lib/translator-budget";
import { isUsageDebugEnabled } from "../usage/debug";
import {
  addRequestLog,
  addFinalRequestLog,
  httpStatusForRequestLogTerminal,
  inspectResponseLogJson,
  inspectResponseLogSsePayloadParsed,
  recordFirstOutput,
  type RequestLogContext,
  type RequestLogEntry,
} from "./request-log";
import {
  BoundedSseFrameBuffer,
  joinSseFrameBytes,
  MAX_CLIENT_SSE_FRAME_BYTES,
} from "./sse-frame-buffer";

const nativePassthroughSseResponses = new WeakSet<Response>();
const eagerRelaySseResponses = new WeakSet<Response>();

export const MAX_INSPECTION_SSE_FRAME_BYTES = MAX_CLIENT_SSE_FRAME_BYTES;
export const MAX_COMPLETED_OUTPUT_ITEMS = 256;
export const MAX_COMPLETED_OUTPUT_ITEM_SOURCE_BYTES = 8 * 1024 * 1024;
export const MAX_TAIL_ERROR_MESSAGE_CHARS = 512;

export type InspectionCounters = {
  frameBufferHighWaterBytes: number;
  completedItemsMaxCount: number;
  frameCapOverflows: number;
  itemCapEvictions: number;
  postCancelDrainStops: number;
};

const inspectionCounters: InspectionCounters = {
  frameBufferHighWaterBytes: 0,
  completedItemsMaxCount: 0,
  frameCapOverflows: 0,
  itemCapEvictions: 0,
  postCancelDrainStops: 0,
};

export function getInspectionCounters(): InspectionCounters {
  return { ...inspectionCounters };
}

export function resetInspectionCountersForTest(): void {
  inspectionCounters.frameBufferHighWaterBytes = 0;
  inspectionCounters.completedItemsMaxCount = 0;
  inspectionCounters.frameCapOverflows = 0;
  inspectionCounters.itemCapEvictions = 0;
  inspectionCounters.postCancelDrainStops = 0;
}

export function relayWithAbort(
  body: ReadableStream<Uint8Array> | null,
  upstream: AbortController,
  onClientGone?: (reason?: unknown) => void,
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
      // A tee caller may transfer abort ownership to its bounded inspection pump.
      if (onClientGone) onClientGone(reason);
      else upstream.abort(reason);
      reader.cancel(reason).catch(() => {});
    },
  });
}

export function buildFailedTailPayload(err: unknown): string {
  const translatorOverflow = isTranslatorBudgetExceededError(err);
  const message = (translatorOverflow
    ? "upstream translation buffer exceeded the safe limit"
    : `Upstream stream terminated unexpectedly: ${err instanceof Error ? err.message : String(err)}`)
    .slice(0, MAX_TAIL_ERROR_MESSAGE_CHARS);
  const failure = {
    type: "upstream_error",
    code: translatorOverflow ? "translation_buffer_limit" : "upstream_reset",
    message,
  };
  return JSON.stringify({
    type: "response.failed",
    response: { status: "failed", error: failure, last_error: failure },
  });
}

export type SseTerminalOutputBoundary = {
  feed(chunk: Uint8Array): Uint8Array;
  finish(): Uint8Array;
  terminalSeen(): boolean;
  doneSeen(): boolean;
  dispose(): void;
};

/**
 * Frame-aware client output boundary shared by both native Responses relays.
 * It buffers only the current incomplete SSE block under the same hard byte
 * cap as inspection, forwards complete blocks through the first Responses
 * terminal, and drops every later block/byte.
 */
export function createSseTerminalOutputBoundary(): SseTerminalOutputBoundary {
  const decoder = new TextDecoder();
  const framer = new BoundedSseFrameBuffer(MAX_INSPECTION_SSE_FRAME_BYTES);
  let terminal = false;
  let done = false;
  let disposed = false;

  const processFrames = (
    frames: ReturnType<BoundedSseFrameBuffer["feed"]>,
  ): Uint8Array => {
    if (disposed || terminal || frames.length === 0) return new Uint8Array(0);
    const output: Uint8Array[] = [];
    let responsesTerminal = false;
    for (const frame of frames) {
      const payload = sseDataPayload(decoder.decode(frame.block));
      const isDone = payload === "[DONE]";
      // Preserve every frame through the first Responses terminal. A [DONE]
      // frame is also preserved when it immediately follows that terminal in
      // the same upstream chunk; every later non-DONE frame is dropped.
      if (!responsesTerminal || isDone) output.push(frame.block, frame.delimiter);
      if (isDone) {
        done = true;
        continue;
      }
      if (!responsesTerminal && payload && terminalStatusFromSsePayload(payload)) {
        responsesTerminal = true;
      }
    }
    if (responsesTerminal) {
      terminal = true;
      framer.dispose();
    }
    return joinSseFrameBytes(output);
  };

  return {
    feed(chunk) {
      if (disposed || terminal) return new Uint8Array(0);
      return processFrames(framer.feed(chunk));
    },
    finish() {
      if (disposed || terminal) return new Uint8Array(0);
      return framer.finish();
    },
    terminalSeen: () => terminal,
    doneSeen: () => done,
    dispose() {
      if (disposed) return;
      disposed = true;
      framer.dispose();
    },
  };
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
  onClientGone?: (reason?: unknown) => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const encoder = new TextEncoder();
  const terminalBoundary = createSseTerminalOutputBoundary();
  let closed = false;
  const relayChunk = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    value: Uint8Array,
  ): "terminal" | "output" | "buffered" => {
    const outbound = terminalBoundary.feed(value);
    if (outbound.byteLength > 0) controller.enqueue(outbound);
    if (!terminalBoundary.terminalSeen()) return outbound.byteLength > 0 ? "output" : "buffered";

    // A Responses terminal frame is the protocol boundary. Some compatible
    // gateways leave the HTTP connection open after response.completed, which
    // otherwise leaves Codex waiting forever even though the model turn is done.
    // Preserve through the terminal block only, add the conventional sentinel
    // when there was no real [DONE] data event, then stop reading upstream.
    if (!terminalBoundary.doneSeen()) {
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    }
    closed = true;
    controller.close();
    const reason = "Responses terminal event received";
    // Notify the tee inspection branch as well. It has already received the
    // same terminal-bearing upstream chunk, so its bounded drain records the
    // real terminal and then releases the turn/upstream keep-alive connection.
    onClientGone?.(reason);
    reader.cancel(reason).catch(() => {});
    terminalBoundary.dispose();
    return "terminal";
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            const tail = terminalBoundary.finish();
            if (tail.byteLength > 0) controller.enqueue(tail);
            terminalBoundary.dispose();
            controller.close();
            return;
          }
          const result = relayChunk(controller, value);
          if (result !== "buffered") return;
        }
      } catch (err) {
        let partial: Uint8Array = new Uint8Array(0);
        try {
          partial = terminalBoundary.finish();
        } catch {
          // A near-cap ambiguous delimiter tail may itself overflow at EOF.
          // Preserve the original read/framing failure and continue emitting
          // the bounded failed tail instead of letting cleanup throw again.
        }
        terminalBoundary.dispose();
        if (closed) return;
        const payload = buildFailedTailPayload(err);
        try {
          if (partial.byteLength > 0) controller.enqueue(partial);
          // Leading blank line terminates a partial SSE block so the failed frame parses cleanly.
          controller.enqueue(encoder.encode(`\n\nevent: response.failed\ndata: ${payload}\n\ndata: [DONE]\n\n`));
          controller.close();
        } catch { /* client already torn down */ }
        upstream.abort();
      }
    },
    cancel(reason) {
      terminalBoundary.dispose();
      if (onClientGone) onClientGone(reason);
      else upstream.abort(reason);
      reader.cancel(reason).catch(() => {});
    },
  });
}

export function nextSseBlock(buffer: string): { block: string; delimiter: string; rest: string } | null {
  const match = buffer.match(/\r?\n\r?\n/);
  if (!match || match.index === undefined) return null;
  return {
    block: buffer.slice(0, match.index),
    delimiter: match[0],
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
  if (payload === "[DONE]") return null;
  try {
    return terminalStatusFromParsed(JSON.parse(payload));
  } catch {
    return null;
  }
}

/** True when a native Responses SSE payload carries the FIRST kind of non-empty model output. */
export function isFirstOutputSsePayload(payload: string | null): boolean {
  if (!payload || payload === "[DONE]") return false;
  try {
    return firstOutputFromParsed(JSON.parse(payload));
  } catch {
    return false;
  }
}

export function firstOutputFromParsed(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const event = parsed as { type?: unknown; delta?: unknown };
  return (event.type === "response.output_text.delta"
    || event.type === "response.reasoning_summary_text.delta"
    || event.type === "response.reasoning_text.delta")
    && typeof event.delta === "string"
    && event.delta.length > 0;
}

function createFirstOutputReporter(onFirstOutput?: () => void): {
  payload: (payload: string | null) => void;
  parsed: (parsed: unknown) => void;
} {
  let reported = false;
  const report = (isFirst: boolean) => {
    if (reported || !isFirst) return;
    reported = true;
    try { onFirstOutput?.(); } catch { /* metrics must not break the stream */ }
  };
  return {
    payload: payload => report(isFirstOutputSsePayload(payload)),
    parsed: parsed => report(firstOutputFromParsed(parsed)),
  };
}

export function terminalStatusFromParsed(parsed: unknown): ResponsesTerminalStatus | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  switch ((parsed as { type?: unknown }).type) {
    case "response.completed":
      return "completed";
    case "response.failed":
      return "failed";
    case "response.incomplete":
      return "incomplete";
    default:
      return null;
  }
}

/** Extract the response object from a `response.completed` SSE payload, or null. */
export function completedResponseFromSsePayload(payload: string): { id?: unknown; output?: unknown; status?: unknown } | null {
  if (payload === "[DONE]") return null;
  try {
    const json = JSON.parse(payload) as { type?: unknown; response?: unknown };
    return completedResponseFromParsedEvent(json);
  } catch {
    return null;
  }
}

/** Extract the response object from an already-parsed `response.completed` event, or null. */
export function completedResponseFromParsedEvent(
  json: unknown,
): { id?: unknown; output?: unknown; status?: unknown } | null {
  if (!json || typeof json !== "object" || Array.isArray(json)
    || (json as { type?: unknown }).type !== "response.completed") return null;
  const response = (json as { response?: unknown }).response;
  if (!response || typeof response !== "object" || Array.isArray(response)) return null;
  return response as { id?: unknown; output?: unknown; status?: unknown };
}

export function trackSseForRequestLog(
  body: ReadableStream<Uint8Array>,
  onTerminal: (status: ResponsesTerminalStatus) => void,
  onCancel: () => void,
  logCtx?: RequestLogContext,
  onFirstOutput?: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let terminalReported = false;
  let cancelled = false;

  const reportTerminal = (status: ResponsesTerminalStatus) => {
    if (terminalReported) return;
    terminalReported = true;
    onTerminal(status);
  };
  // Reuse the byte-bounded inspector so translated responses cannot retain an
  // unterminated upstream frame or parse the same event once per observer.
  const inspector = createSseInspector({
    onTerminal: reportTerminal,
    logCtx,
    onFirstOutput,
  });

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (!cancelled) {
            inspector.finish();
            if (!terminalReported) reportTerminal("incomplete");
          }
          inspector.dispose();
          controller.close();
          return;
        }
        inspector.feed(value);
        controller.enqueue(value);
      } catch (err) {
        // The upstream read rejected: the 200 body died mid-flight. Client
        // cancellation is the caller's separate 499 path, so a cancel-drained
        // pending read (cancelled=true) must not carry the truncation marker.
        if (!cancelled && !terminalReported && logCtx?.activeAttempt) {
          logCtx.activeAttempt.streamAborted = true;
        }
        if (!cancelled && !terminalReported) reportTerminal("incomplete");
        inspector.dispose();
        try { controller.error(err); } catch { /* already torn down */ }
      }
    },
    cancel(reason) {
      cancelled = true;
      inspector.dispose();
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

export function markEagerRelaySseResponse(response: Response): Response {
  eagerRelaySseResponses.add(response);
  return response;
}

/** Test-only path identity seam; runtime behavior must not branch on this marker. */
export function isEagerRelaySseResponse(response: Response): boolean {
  return eagerRelaySseResponses.has(response);
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
  const heartbeat = new TextEncoder().encode(": opencodex keepalive\n\n");
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let clientCancelled = false;
  let terminalReported = false;

  const reportTerminal = (status: ResponsesTerminalStatus) => {
    if (terminalReported || clientCancelled || closed) return;
    terminalReported = true;
    onTerminal?.(status);
  };
  const inspector = createSseInspector({ onTerminal: reportTerminal });

  const cleanup = () => {
    if (closed) return;
    closed = true;
    inspector.dispose();
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
          inspector.finish();
          if (!terminalReported && !clientCancelled) reportTerminal("incomplete");
          cleanup();
          controller.close();
          return;
        }
        inspector.feed(value);
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
export type SseInspector = {
  /** Feed one upstream chunk through the SSE scanning state machine. */
  feed(chunk: Uint8Array): void;
  /** Flush the decoder + trailing unterminated buffer (upstream cleanly done). */
  finish(): void;
  /** Drop every retained frame/item reference without parsing. Idempotent. */
  dispose(): void;
  /** True once a protocol terminal was detected and reported. */
  reported(): boolean;
  /** True once any protocol terminal was parsed, including metadata-only inspectors. */
  terminalSeen(): boolean;
};

export type SseInspectorHandlers = {
  onTerminal?: (status: ResponsesTerminalStatus, httpStatusOverride?: number) => void;
  logCtx?: RequestLogContext;
  onCompletedResponse?: (response: { id?: unknown; output?: unknown; status?: unknown }) => void;
  /**
   * Every parsed SSE payload, delivered BEFORE any onCompletedResponse derived from that same
   * payload. A caller that must decide on the whole turn -- not just its terminal snapshot --
   * needs to see the incremental events, because a stream can announce an item and then close
   * with an empty `output`.
   */
  onParsedPayload?: (payload: unknown) => void;
  onFirstOutput?: () => void;
  /**
   * Provider-scoped compatibility: persist the completed snapshot under the
   * first response id exposed to the client when an upstream changes ids
   * between `response.created` and `response.completed`.
   */
  pinCompletedResponseIdToFirstSeen?: boolean;
};

type CompletedOutputItem = { item: unknown; sourceBytes: number };

function delimiterLengthAt(
  index: number,
  length: number,
  byteAt: (index: number) => number,
): number | 0 | undefined {
  const first = byteAt(index);
  if (first === 10) {
    if (index + 1 >= length) return undefined;
    const second = byteAt(index + 1);
    if (second === 10) return 2;
    if (second !== 13) return 0;
    if (index + 2 >= length) return undefined;
    return byteAt(index + 2) === 10 ? 3 : 0;
  }
  if (first !== 13) return 0;
  if (index + 1 >= length) return undefined;
  if (byteAt(index + 1) !== 10) return 0;
  if (index + 2 >= length) return undefined;
  const third = byteAt(index + 2);
  if (third === 10) return 3;
  if (third !== 13) return 0;
  if (index + 3 >= length) return undefined;
  return byteAt(index + 3) === 10 ? 4 : 0;
}

/**
 * Per-chunk SSE inspection state machine shared by consumeForInspection,
 * consumeForResponseLogMetadata, and the eager bounded relay (relay-eager.ts).
 *
 * Extraction-fidelity invariants (devlog/_plan/260723_win_mem_safestream/020):
 * - logCtx SSE inspection is gated on !reported; in the metadata configuration
 *   (no onTerminal) `reported` stays permanently false, which reproduces the
 *   metadata consumer's unconditional inspection through the same gate.
 * - finish() skips the trailing-buffer scan once reported, while per-block
 *   onCompletedResponse continues firing after reported — an intentional
 *   asymmetry inherited from consumeForInspection.
 * - logCtx.transportPhase/terminalSource are mutated BEFORE onTerminal fires.
 * - Synthetic terminals (incomplete / failed-502) are the CALLER's decision:
 *   the caller owns `cancelled` state and reads `reported()` to decide.
 */
export function createSseInspector(handlers: SseInspectorHandlers): SseInspector {
  let decoder: TextDecoder | null = new TextDecoder();
  let reported = false;
  let sawTerminal = false;
  let disposed = false;
  let delimiterTail: Uint8Array = new Uint8Array(0);
  let candidate: Uint8Array = new Uint8Array(0);
  let candidateBytes = 0;
  let discardingOversizedFrame = false;
  const reportFirstOutput = createFirstOutputReporter(handlers.onFirstOutput);
  // Allocate reconstruction state only for persistence-capable inspectors.
  const completedItemsByOutputIndex = handlers.onCompletedResponse
    ? new Map<number, CompletedOutputItem>()
    : null;
  let aggregateItemBytes = 0;
  let reconstructionTainted = false;
  let firstResponseId: string | undefined;

  const clearFrameState = (): void => {
    delimiterTail = new Uint8Array(0);
    candidate = new Uint8Array(0);
    candidateBytes = 0;
    discardingOversizedFrame = false;
  };

  const clearCompletedItems = (): void => {
    completedItemsByOutputIndex?.clear();
    aggregateItemBytes = 0;
    reconstructionTainted = false;
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    decoder = null;
    clearFrameState();
    clearCompletedItems();
    firstResponseId = undefined;
  };

  const ensureCandidateCapacity = (requiredBytes: number): void => {
    if (candidate.byteLength >= requiredBytes) return;
    let capacity = candidate.byteLength === 0
      ? Math.min(MAX_INSPECTION_SSE_FRAME_BYTES, Math.max(requiredBytes, 4096))
      : candidate.byteLength;
    while (capacity < requiredBytes) {
      capacity = Math.min(
        MAX_INSPECTION_SSE_FRAME_BYTES,
        Math.max(requiredBytes, capacity * 2),
      );
    }
    const grown = new Uint8Array(capacity);
    if (candidateBytes > 0) grown.set(candidate.subarray(0, candidateBytes));
    candidate = grown;
  };

  const takeCandidate = (): Uint8Array => {
    if (candidateBytes === 0) return new Uint8Array(0);
    const frame = candidate.slice(0, candidateBytes);
    candidate = new Uint8Array(0);
    candidateBytes = 0;
    return frame;
  };

  const retainCandidateSlice = (slice: Uint8Array): void => {
    if (slice.byteLength === 0 || discardingOversizedFrame) return;
    const nextBytes = candidateBytes + slice.byteLength;
    inspectionCounters.frameBufferHighWaterBytes = Math.max(
      inspectionCounters.frameBufferHighWaterBytes,
      Math.min(nextBytes, MAX_INSPECTION_SSE_FRAME_BYTES),
    );
    if (nextBytes > MAX_INSPECTION_SSE_FRAME_BYTES) {
      candidate = new Uint8Array(0);
      candidateBytes = 0;
      discardingOversizedFrame = true;
      inspectionCounters.frameCapOverflows += 1;
      // The rejected frame may have carried an output item we will never see;
      // any later empty-output terminal must not synthesize a partial replay
      // from the surviving map entries (same taint rule as item eviction).
      reconstructionTainted = true;
      return;
    }
    ensureCandidateCapacity(nextBytes);
    candidate.set(slice, candidateBytes);
    candidateBytes = nextBytes;
  };

  const retainCompletedItem = (index: number, item: unknown, sourceBytes: number): void => {
    const previous = completedItemsByOutputIndex!.get(index);
    if (previous) {
      aggregateItemBytes -= previous.sourceBytes;
      completedItemsByOutputIndex!.delete(index);
    }
    if (sourceBytes > MAX_COMPLETED_OUTPUT_ITEM_SOURCE_BYTES) {
      reconstructionTainted = true;
      inspectionCounters.itemCapEvictions += 1;
      return;
    }
    completedItemsByOutputIndex!.set(index, { item, sourceBytes });
    aggregateItemBytes += sourceBytes;
    while (completedItemsByOutputIndex!.size > MAX_COMPLETED_OUTPUT_ITEMS
      || aggregateItemBytes > MAX_COMPLETED_OUTPUT_ITEM_SOURCE_BYTES) {
      let highestIndex = -1;
      for (const retainedIndex of completedItemsByOutputIndex!.keys()) {
        if (retainedIndex > highestIndex) highestIndex = retainedIndex;
      }
      const evicted = completedItemsByOutputIndex!.get(highestIndex);
      if (!evicted) break;
      completedItemsByOutputIndex!.delete(highestIndex);
      aggregateItemBytes -= evicted.sourceBytes;
      reconstructionTainted = true;
      inspectionCounters.itemCapEvictions += 1;
    }
    inspectionCounters.completedItemsMaxCount = Math.max(
      inspectionCounters.completedItemsMaxCount,
      completedItemsByOutputIndex!.size,
    );
  };

  const scanPayload = (payload: string | null, sourceBytes: number): void => {
    if (!payload) return;
    let parsed: unknown | undefined;
    if (payload !== "[DONE]") {
      try {
        parsed = JSON.parse(payload);
      } catch {
        /* malformed SSE payloads remain best-effort/no-throw */
      }
    }
    if (!reported && handlers.logCtx) {
      inspectResponseLogSsePayloadParsed(handlers.logCtx, payload, parsed);
    }
    // Before any terminal handling: a consumer deciding on the whole turn must observe this
    // payload even when the terminal snapshot that follows no longer mentions it.
    if (handlers.onParsedPayload && parsed !== undefined) {
      try { handlers.onParsedPayload(parsed); } catch { /* inspection must never throw into the pump */ }
    }
    reportFirstOutput.parsed(parsed);
    const status = terminalStatusFromParsed(parsed);
    if (status) sawTerminal = true;
    if (!reported && handlers.onTerminal && status) {
      try {
        reported = true;
        if (handlers.logCtx) {
          handlers.logCtx.transportPhase = "terminal_sse";
          handlers.logCtx.terminalSource = "upstream";
        }
        handlers.onTerminal(status);
      } finally {
        if (status === "failed" || status === "incomplete") clearCompletedItems();
      }
    } else if (status === "failed" || status === "incomplete") {
      clearCompletedItems();
    }
    if (handlers.onCompletedResponse) {
      type ParsedSseEvent = { type?: unknown; output_index?: unknown; item?: unknown; response?: unknown };
      const parsedEvent = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as ParsedSseEvent
        : null;
      const responseRecord = parsedEvent
        && typeof parsedEvent.response === "object"
        && parsedEvent.response !== null
        && !Array.isArray(parsedEvent.response)
        ? parsedEvent.response as { id?: unknown }
        : null;
      if (handlers.pinCompletedResponseIdToFirstSeen
        && responseRecord
        && typeof responseRecord.id === "string") {
        firstResponseId ??= responseRecord.id;
      }
      const doneItem = parsedEvent?.type === "response.output_item.done" ? parsedEvent.item : undefined;
      if (parsedEvent
        && doneItem !== undefined
        && Number.isInteger(parsedEvent.output_index)
        && (parsedEvent.output_index as number) >= 0
        && typeof doneItem === "object"
        && doneItem !== null
        && !Array.isArray(doneItem)
        && typeof (doneItem as { type?: unknown }).type === "string") {
        retainCompletedItem(parsedEvent.output_index as number, doneItem, sourceBytes);
      }

      let response = completedResponseFromParsedEvent(parsedEvent);
      if (response) {
        if (handlers.pinCompletedResponseIdToFirstSeen
          && firstResponseId !== undefined
          && response.id !== firstResponseId) {
          response = { ...response, id: firstResponseId };
        }
        // Authoritative output is a NON-EMPTY ARRAY only. Anything else
        // (missing, null, scalar, object) keeps the historical backfill
        // behavior so a malformed terminal cannot reach rememberResponseState
        // and destroy continuation state (review C1-2).
        const hasAuthoritativeOutput = Array.isArray(response.output)
          && response.output.length > 0;
        if (!hasAuthoritativeOutput && reconstructionTainted) {
          clearCompletedItems();
          return;
        }
        if (!hasAuthoritativeOutput && completedItemsByOutputIndex!.size > 0) {
          response = {
            ...response,
            output: [...completedItemsByOutputIndex!.entries()]
              .sort(([left], [right]) => left - right)
              .map(([, retained]) => retained.item),
          };
        }
        try {
          handlers.onCompletedResponse(response);
        } finally {
          clearCompletedItems();
        }
      } else if (parsedEvent?.type === "response.completed") {
        clearCompletedItems();
      }
    }
  };

  const completeCandidate = (): void => {
    if (discardingOversizedFrame) {
      discardingOversizedFrame = false;
      return;
    }
    const sourceBytes = candidateBytes;
    const frame = takeCandidate();
    if (reported && !handlers.onCompletedResponse) return;
    const decoded = decoder!.decode(frame);
    scanPayload(sseDataPayload(decoded), sourceBytes);
  };

  const scanChunk = (chunk: Uint8Array): void => {
    const previousTail = delimiterTail;
    delimiterTail = new Uint8Array(0);
    const tailLength = previousTail.byteLength;
    const totalLength = tailLength + chunk.byteLength;
    const byteAt = (index: number): number => index < tailLength
      ? previousTail[index]!
      : chunk[index - tailLength]!;
    const retainRange = (start: number, end: number): void => {
      if (end <= start || discardingOversizedFrame) return;
      if (start < tailLength) {
        retainCandidateSlice(previousTail.subarray(start, Math.min(end, tailLength)));
      }
      if (end > tailLength) {
        retainCandidateSlice(chunk.subarray(Math.max(0, start - tailLength), end - tailLength));
      }
    };
    let index = 0;
    let retainedThrough = 0;
    while (index < totalLength) {
      const delimiterLength = delimiterLengthAt(index, totalLength, byteAt);
      if (delimiterLength === undefined) break;
      if (delimiterLength > 0) {
        retainRange(retainedThrough, index);
        completeCandidate();
        index += delimiterLength;
        retainedThrough = index;
        continue;
      }
      index += 1;
    }
    retainRange(retainedThrough, index);
    if (index < totalLength) {
      delimiterTail = new Uint8Array(totalLength - index);
      for (let offset = 0; offset < delimiterTail.byteLength; offset += 1) {
        delimiterTail[offset] = byteAt(index + offset);
      }
    }
  };

  return {
    feed(chunk) {
      if (!disposed) scanChunk(chunk);
    },
    finish() {
      if (disposed) return;
      try {
        retainCandidateSlice(delimiterTail);
        delimiterTail = new Uint8Array(0);
        if (!discardingOversizedFrame && candidateBytes > 0 && !reported) {
          const sourceBytes = candidateBytes;
          const decoded = decoder!.decode(takeCandidate());
          scanPayload(decoded.trim() ? sseDataPayload(decoded) : null, sourceBytes);
        }
      } finally {
        clearFrameState();
        clearCompletedItems();
      }
    },
    dispose,
    reported: () => reported,
    terminalSeen: () => sawTerminal,
  };
}

export type InspectionDrainBounds = { ms: number; bytes: number };

export type InspectionConsumerOptions = {
  clientGoneSignal?: AbortSignal;
  drainBounds?: Partial<InspectionDrainBounds>;
  upstream?: AbortController;
  now?: () => number;
  /** Forward provider-scoped response-id pinning to the owned inspector. */
  pinCompletedResponseIdToFirstSeen?: boolean;
  /** Observe every parsed SSE payload on the inspection side; see SseInspectorHandlers. */
  onParsedPayload?: (payload: unknown) => void;
  /** Test seam for proving both public consumers dispose their owned inspector. */
  inspectorFactory?: (handlers: SseInspectorHandlers) => SseInspector;
};

const DEFAULT_INSPECTION_DRAIN_MS = 15_000;
const DEFAULT_INSPECTION_DRAIN_BYTES = 32 * 1024 * 1024;
type InspectionPumpOptions = InspectionConsumerOptions & {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  inspector: SseInspector;
  signal?: AbortSignal;
  onDone?: () => void;
  onCancel?: () => void;
  onCleanEof?: () => void;
  onReadError?: () => void;
};

function startBoundedInspectionPump(options: InspectionPumpOptions): void {
  const { reader, inspector, signal, clientGoneSignal } = options;
  let cancelled = false;
  let clientGone = false;
  let clientGoneReason: unknown;
  let drainedBytes = 0;
  let drainDeadline = Number.POSITIVE_INFINITY;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  let drainStopped = false;
  const drainMs = options.drainBounds?.ms ?? DEFAULT_INSPECTION_DRAIN_MS;
  const drainBytes = options.drainBounds?.bytes ?? DEFAULT_INSPECTION_DRAIN_BYTES;
  const now = options.now ?? Date.now;
  let cancelFired = false;
  const fireCancel = () => {
    if (cancelFired) return;
    cancelFired = true;
    options.onCancel?.();
  };
  const markClientGone = () => {
    if (clientGone || cancelled) return;
    clientGone = true;
    clientGoneReason = clientGoneSignal?.reason;
    drainDeadline = now() + drainMs;
    if (inspector.terminalSeen() || drainMs <= 0 || drainBytes <= 0) {
      stopDrain();
      return;
    }
    // Do not unref: on Bun/Windows a pending `reader.read()` can be the only
    // wake source; an unref'd timer may never run, so a silent post-cancel
    // drain (time bound, no bytes) hangs the suite until the job timeout.
    drainTimer = setTimeout(stopDrain, drainMs);
  };
  // Ends the bounded drain by cancelling the reader: the pending read settles
  // and the pump loop observes `drainStopped`. Deliberately NOT a shared
  // Promise.race companion — racing every read against one pending promise
  // retains O(chunk-count) reactions on long streams (review C1-1), the exact
  // retention class this phase removes.
  const stopDrain = () => {
    if (drainStopped || cancelled) return;
    drainStopped = true;
    reader.cancel(clientGoneReason).catch(() => {});
  };
  const abortImmediately = () => {
    if (cancelled) return;
    cancelled = true;
    reader.cancel(signal?.reason).catch(() => {});
    fireCancel();
  };

  if (signal?.aborted) {
    cancelled = true;
    reader.cancel(signal.reason).catch(() => {});
    inspector.dispose();
    fireCancel();
    options.onDone?.();
    return;
  }
  signal?.addEventListener("abort", abortImmediately, { once: true });
  clientGoneSignal?.addEventListener("abort", markClientGone, { once: true });
  if (clientGoneSignal?.aborted) markClientGone();

  const pump = async () => {
    let clientGoneWithoutTerminal = false;
    let boundEndedDrain = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (drainStopped) {
          // stopDrain() cancelled the reader; the settled read is the wake-up.
          clientGoneWithoutTerminal = !inspector.terminalSeen();
          boundEndedDrain = clientGoneWithoutTerminal;
          break;
        }
        if (done) {
          inspector.finish();
          if (clientGone) clientGoneWithoutTerminal = !inspector.terminalSeen();
          else if (!cancelled) options.onCleanEof?.();
          break;
        }
        if (!clientGone) {
          inspector.feed(value);
          continue;
        }
        if (now() >= drainDeadline) {
          clientGoneWithoutTerminal = true;
          boundEndedDrain = true;
          break;
        }
        const remainingBytes = Math.max(0, drainBytes - drainedBytes);
        const inspectedValue = value.byteLength > remainingBytes
          ? value.subarray(0, remainingBytes)
          : value;
        if (inspectedValue.byteLength > 0) inspector.feed(inspectedValue);
        drainedBytes += inspectedValue.byteLength;
        if (inspector.terminalSeen()) break;
        if (value.byteLength > remainingBytes
          || drainedBytes >= drainBytes
          || now() >= drainDeadline) {
          clientGoneWithoutTerminal = true;
          boundEndedDrain = true;
          break;
        }
      }
    } catch {
      if (clientGone) clientGoneWithoutTerminal = !inspector.terminalSeen();
      else if (!cancelled) options.onReadError?.();
    } finally {
      if (drainTimer) clearTimeout(drainTimer);
      signal?.removeEventListener("abort", abortImmediately);
      clientGoneSignal?.removeEventListener("abort", markClientGone);
      if (clientGone) {
        if (boundEndedDrain) inspectionCounters.postCancelDrainStops += 1;
        if (clientGoneWithoutTerminal) fireCancel();
        options.upstream?.abort(clientGoneReason);
        reader.cancel(clientGoneReason).catch(() => {});
      }
      inspector.dispose();
      options.onDone?.();
    }
  };
  void pump();
}

export function consumeForInspection(
  body: ReadableStream<Uint8Array>,
  onTerminal: (status: ResponsesTerminalStatus, httpStatusOverride?: number) => void,
  signal?: AbortSignal,
  onDone?: () => void,
  logCtx?: RequestLogContext,
  onCancel?: () => void,
  onCompletedResponse?: (response: { id?: unknown; output?: unknown; status?: unknown }) => void,
  onFirstOutput?: () => void,
  options?: InspectionConsumerOptions,
): void {
  const reader = body.getReader();
  const inspector = (options?.inspectorFactory ?? createSseInspector)({
    onTerminal,
    logCtx,
    onCompletedResponse,
    onParsedPayload: options?.onParsedPayload,
    onFirstOutput,
    pinCompletedResponseIdToFirstSeen: options?.pinCompletedResponseIdToFirstSeen,
  });
  startBoundedInspectionPump({
    ...options,
    reader,
    inspector,
    signal,
    onDone,
    onCancel,
    onCleanEof: () => {
      if (!inspector.reported()) {
        if (logCtx) logCtx.terminalSource = "synthetic";
        onTerminal("incomplete");
      }
    },
    onReadError: () => {
      // Upstream read failure after HTTP 200 (mid-stream socket reset) is not a
      // protocol `response.incomplete` terminal. Report a synthetic 502 so account
      // health treats it as transient; abort-driven client cancellation still wins.
      if (!inspector.reported()) {
        if (logCtx) {
          logCtx.transportPhase = "mid_stream";
          logCtx.terminalSource = "synthetic";
          // A truncated 200 body must not meter as a success the client never
          // received; the router's equivalent turn carries 502 + streamAborted
          // (codex-router #139).
          if (logCtx.activeAttempt) logCtx.activeAttempt.streamAborted = true;
        }
        onTerminal("failed", 502);
      }
    },
  });
}

export function consumeForResponseLogMetadata(
  body: ReadableStream<Uint8Array>,
  logCtx: RequestLogContext,
  signal?: AbortSignal,
  onDone?: () => void,
  onCompletedResponse?: (response: { id?: unknown; output?: unknown; status?: unknown }) => void,
  onFirstOutput?: () => void,
  options?: InspectionConsumerOptions,
): void {
  const reader = body.getReader();
  // No onTerminal → the inspector's `reported` gate stays permanently false,
  // reproducing this consumer's unconditional logCtx inspection.
  const inspector = (options?.inspectorFactory ?? createSseInspector)({
    logCtx,
    onCompletedResponse,
    onParsedPayload: options?.onParsedPayload,
    onFirstOutput,
    pinCompletedResponseIdToFirstSeen: options?.pinCompletedResponseIdToFirstSeen,
  });
  startBoundedInspectionPump({ ...options, reader, inspector, signal, onDone });
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
