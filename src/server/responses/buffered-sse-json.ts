import type { ResponsesTerminalStatus } from "../../bridge";
import {
  createSseInspector,
  createSseTerminalOutputBoundary,
  SseAggregateLimitError,
  terminalStatusFromParsed,
  type CodexSafetyBufferingFilterOptions,
  type SseInspector,
} from "../relay";
import { SseFrameCountLimitError, SseFrameTooLargeError } from "../sse-frame-buffer";
import {
  MAX_UPSTREAM_JSON_BODY_BYTES,
  UPSTREAM_JSON_BODY_INACTIVITY_TIMEOUT_MS,
  UPSTREAM_JSON_BODY_TOTAL_TIMEOUT_MS,
} from "./core-lifetime";

/** Larger than persistence inspection because this path must return the whole bounded response. */
export const MAX_BUFFERED_RESPONSES_OUTPUT_ITEMS = 10_000;
export const MAX_BUFFERED_RESPONSES_RECONSTRUCTION_BYTES = MAX_UPSTREAM_JSON_BODY_BYTES;
export const MAX_BUFFERED_RESPONSES_SSE_FRAMES = 100_000;
/**
 * A buffered caller cannot consume partial output, so keep one independent lifetime ceiling even
 * when the operator disables the ordinary silence clock. Fifteen minutes is intentionally much
 * larger than the public default stall budget while still releasing an abandoned body eventually.
 */
export const BUFFERED_RESPONSES_TOTAL_TIMEOUT_MS = 15 * 60_000;
const BUFFERED_SSE_PROCESSING_SLICE_BYTES = 64 * 1024;

export type BufferedResponsesTerminal = {
  status: ResponsesTerminalStatus;
  response: Record<string, unknown>;
};

export type BufferedResponsesSseFailure = {
  ok: false;
  kind: "aborted" | "malformed" | "missing_terminal" | "oversized" | "read_error" | "timeout";
  error?: unknown;
  /** Bounded diagnostic captured from a bare upstream `error` event. */
  upstreamError?: string;
  /** Fatal provider refusal verdict that must not be flattened into a retryable transport error. */
  upstreamRefusalCode?: string;
  /** Bounded structured class from the same bare error envelope as `upstreamError`. */
  upstreamErrorType?: string;
  /** Bounded structured code; unknown codes remain transport failures instead of message guesses. */
  upstreamErrorCode?: string;
};

export type BufferedResponsesSseResult = {
  ok: true;
  /** Present only when the caller needs to replay the bounded transcript through rewrites. */
  bytes?: Uint8Array;
  terminal: BufferedResponsesTerminal;
} | BufferedResponsesSseFailure;

type BufferedReadOptions = {
  maxBytes?: number;
  maxFrames?: number;
  totalTimeoutMs?: number;
  /** Absolute whole-turn deadline shared by every validation pass. */
  deadlineAt?: number;
  inactivityTimeoutMs?: number;
  firstByteTimeoutMs?: number;
};

export type BufferedResponsesReadOptions = BufferedReadOptions & { deadlineAt: number };

/**
 * Resolve the read clocks for canonical SSE that must be folded into client JSON.
 *
 * A positive stall budget owns both time-to-first-byte and inter-chunk silence. A disabled budget
 * must not become an immediate timeout, so both clocks fall back to the independent total ceiling.
 * The ceiling remains separate because a JSON caller has no partial body to keep alive forever.
 */
export function bufferedResponsesReadOptions(
  stallTimeoutMs: number,
  totalTimeoutMs = BUFFERED_RESPONSES_TOTAL_TIMEOUT_MS,
  startedAt = Date.now(),
): BufferedResponsesReadOptions {
  if (!Number.isFinite(stallTimeoutMs)) throw new RangeError("stallTimeoutMs must be finite");
  if (!Number.isSafeInteger(totalTimeoutMs) || totalTimeoutMs <= 0) {
    throw new RangeError("totalTimeoutMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(startedAt) || startedAt < 0 || startedAt > Number.MAX_SAFE_INTEGER - totalTimeoutMs) {
    throw new RangeError("startedAt must produce a safe deadline");
  }
  const silenceTimeoutMs = stallTimeoutMs > 0 ? Math.ceil(stallTimeoutMs) : totalTimeoutMs;
  return {
    totalTimeoutMs,
    deadlineAt: startedAt + totalTimeoutMs,
    firstByteTimeoutMs: silenceTimeoutMs,
    inactivityTimeoutMs: silenceTimeoutMs,
  };
}

type Uint8ReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;

class BufferedSseTimeoutError extends Error {
  constructor(deadline: "total" | "inactivity") {
    super(`buffered Responses SSE ${deadline} timeout`);
    this.name = "BufferedSseTimeoutError";
  }
}

function createBufferedTerminalInspector(maxSourceBytes: number): {
  inspector: SseInspector;
  result: () => { ok: true; terminal: BufferedResponsesTerminal } | BufferedResponsesSseFailure;
} {
  let malformed = false;
  let terminalCount = 0;
  let status: ResponsesTerminalStatus | undefined;
  let terminalResponse: Record<string, unknown> | undefined;
  const inspector = createSseInspector({
    terminalReconstruction: {
      maxItems: MAX_BUFFERED_RESPONSES_OUTPUT_ITEMS,
      maxSourceBytes,
      requireCompleteOutputIndices: true,
      mergeSparseTerminalOutput: true,
    },
    onParsedPayload(payload) {
      const candidateStatus = terminalStatusFromParsed(payload);
      if (!candidateStatus) return;
      terminalCount += 1;
      status ??= candidateStatus;
    },
    onOpaquePayload(payload) {
      if (payload !== "[DONE]") malformed = true;
    },
    onTerminalResponse(candidateStatus, response) {
      if (candidateStatus === status && terminalResponse === undefined) {
        if (response.status !== undefined && response.status !== candidateStatus) {
          malformed = true;
          return;
        }
        if (response.output !== undefined && !Array.isArray(response.output)) {
          malformed = true;
          return;
        }
        terminalResponse = {
          ...response,
          status: candidateStatus,
          output: response.output ?? [],
        } as Record<string, unknown>;
      }
    },
  });
  return {
    inspector,
    result: () => {
      if (malformed) return { ok: false, kind: "malformed" };
      if (terminalCount !== 1 || status === undefined) return { ok: false, kind: "missing_terminal" };
      if (!terminalResponse || terminalResponse.status !== status || !Array.isArray(terminalResponse.output)) {
        return { ok: false, kind: "malformed" };
      }
      return { ok: true, terminal: { status, response: terminalResponse } };
    },
  };
}

/** Strict synchronous seam for terminal/reconstruction tests; production feeds bytes incrementally. */
export function inspectBufferedResponsesTerminal(text: string):
  | { ok: true; terminal: BufferedResponsesTerminal }
  | BufferedResponsesSseFailure {
  const state = createBufferedTerminalInspector(MAX_BUFFERED_RESPONSES_RECONSTRUCTION_BYTES);
  try {
    state.inspector.feed(new TextEncoder().encode(text));
    state.inspector.finish();
    return state.result();
  } finally {
    state.inspector.dispose();
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>, reason?: unknown): void {
  try { void reader.cancel(reason).catch(() => undefined); } catch { /* non-conforming stream */ }
}

async function deadlineRead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
  deadlineAt: number,
  deadline: "total" | "inactivity",
): Promise<Uint8ReadResult> {
  if (signal?.aborted) throw signal.reason;
  return await new Promise<Uint8ReadResult>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(signal?.reason));
    timer = setTimeout(
      () => finish(() => reject(new BufferedSseTimeoutError(deadline))),
      Math.max(0, deadlineAt - Date.now()),
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    void reader.read().then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    );
  });
}

/**
 * Consume through the first terminal, which must validate, with bounded framing and deadlines.
 * `retainTranscript:false` feeds the strict assembler directly and never materializes the second,
 * client-facing SSE transcript. Side effects remain the delivery owner's responsibility.
 */
export async function collectBufferedResponsesSse(
  body: ReadableStream<Uint8Array>,
  upstream: AbortController,
  options: {
    signal?: AbortSignal;
    terminalBoundary?: CodexSafetyBufferingFilterOptions;
    read?: BufferedReadOptions;
    retainTranscript?: boolean;
  } = {},
): Promise<BufferedResponsesSseResult> {
  const maxBytes = options.read?.maxBytes ?? MAX_UPSTREAM_JSON_BODY_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }
  const maxFrames = options.read?.maxFrames ?? MAX_BUFFERED_RESPONSES_SSE_FRAMES;
  const totalTimeoutMs = options.read?.totalTimeoutMs ?? UPSTREAM_JSON_BODY_TOTAL_TIMEOUT_MS;
  const inactivityTimeoutMs = options.read?.inactivityTimeoutMs ?? UPSTREAM_JSON_BODY_INACTIVITY_TIMEOUT_MS;
  const firstByteTimeoutMs = options.read?.firstByteTimeoutMs ?? totalTimeoutMs;
  const absoluteDeadlineAt = options.read?.deadlineAt;
  if (absoluteDeadlineAt !== undefined && (!Number.isSafeInteger(absoluteDeadlineAt) || absoluteDeadlineAt < 0)) {
    throw new RangeError("deadlineAt must be a non-negative safe integer");
  }
  const retainTranscript = options.retainTranscript === true;
  const reader = body.getReader();
  const boundary = createSseTerminalOutputBoundary({
    ...options.terminalBoundary,
    maxInputBytes: maxBytes,
    maxOutputBytes: maxBytes,
    maxFrames,
  });
  const state = createBufferedTerminalInspector(Math.min(
    maxBytes,
    MAX_BUFFERED_RESPONSES_RECONSTRUCTION_BYTES,
  ));
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  let retained = retainTranscript ? new Uint8Array(Math.min(maxBytes, 64 * 1024)) : undefined;
  let retainedBytes = 0;
  const startedAt = Date.now();
  const totalDeadlineAt = absoluteDeadlineAt ?? startedAt + totalTimeoutMs;
  let inactivityDeadlineAt = startedAt + firstByteTimeoutMs;

  const withBoundaryError = <T extends BufferedResponsesSseFailure>(failure: T): T => {
    const upstreamError = boundary.upstreamError();
    const upstreamRefusalCode = boundary.upstreamRefusalCode();
    const upstreamErrorType = boundary.upstreamErrorType();
    const upstreamErrorCode = boundary.upstreamErrorCode();
    return {
      ...failure,
      ...(upstreamError === undefined ? {} : { upstreamError }),
      ...(upstreamRefusalCode === undefined ? {} : { upstreamRefusalCode }),
      ...(upstreamErrorType === undefined ? {} : { upstreamErrorType }),
      ...(upstreamErrorCode === undefined ? {} : { upstreamErrorCode }),
    };
  };

  const inspect = (chunk: Uint8Array): void => {
    if (chunk.byteLength === 0) return;
    // Validate incrementally without retaining a second decoded transcript. The shared inspector
    // independently owns SSE framing and JSON reconstruction over the same bytes.
    utf8.decode(chunk, { stream: true });
    state.inspector.feed(chunk);
    if (!retained) return;
    if (chunk.byteLength > maxBytes - retainedBytes) throw new SseAggregateLimitError(maxBytes);
    const required = retainedBytes + chunk.byteLength;
    if (required > retained.byteLength) {
      const grown = new Uint8Array(Math.min(maxBytes, Math.max(required, retained.byteLength * 2)));
      grown.set(retained.subarray(0, retainedBytes));
      retained = grown;
    }
    retained.set(chunk, retainedBytes);
    retainedBytes = required;
  };

  try {
    for (;;) {
      const deadlineAt = Math.min(totalDeadlineAt, inactivityDeadlineAt);
      const deadline = totalDeadlineAt <= inactivityDeadlineAt ? "total" : "inactivity";
      const { done, value } = await deadlineRead(reader, options.signal, deadlineAt, deadline);
      if (options.signal?.aborted) throw options.signal.reason;
      if (done) {
        inspect(boundary.finish());
        break;
      }
      if (!value || value.byteLength === 0) continue;
      inactivityDeadlineAt = Date.now() + inactivityTimeoutMs;
      // Slice the reader's chunk before framing. This keeps one oversized network read from
      // producing a transcript-sized array of frames/output buffers and gives the total deadline
      // and aggregate frame cap a checkpoint between bounded pieces of synchronous work.
      for (let offset = 0; offset < value.byteLength && !boundary.terminalSeen();) {
        if (Date.now() >= totalDeadlineAt) throw new BufferedSseTimeoutError("total");
        const end = Math.min(value.byteLength, offset + BUFFERED_SSE_PROCESSING_SLICE_BYTES);
        inspect(boundary.feed(value.subarray(offset, end)));
        offset = end;
      }
      if (boundary.terminalSeen()) {
        cancelReader(reader, "Responses terminal event received");
        break;
      }
    }
    utf8.decode();
    state.inspector.finish();
    if (options.signal?.aborted) throw options.signal.reason;
    const terminal = state.result();
    if (!terminal.ok) {
      upstream.abort(new Error(`buffered Responses SSE ${terminal.kind}`));
      return withBoundaryError(terminal);
    }
    return {
      ...terminal,
      ...(retained ? { bytes: retained.subarray(0, retainedBytes) } : {}),
    };
  } catch (error) {
    upstream.abort(error);
    cancelReader(reader, error);
    return withBoundaryError({
      ok: false,
      kind: options.signal?.aborted
        ? "aborted"
        : error instanceof BufferedSseTimeoutError
          ? "timeout"
          : error instanceof SseAggregateLimitError
            || error instanceof SseFrameTooLargeError
            || error instanceof SseFrameCountLimitError
            ? "oversized"
            : "read_error",
      error,
    });
  } finally {
    boundary.dispose();
    state.inspector.dispose();
    try { reader.releaseLock(); } catch { /* a cancelled pending read may still own it briefly */ }
  }
}
