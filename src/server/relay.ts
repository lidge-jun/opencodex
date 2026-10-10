import type { ResponsesTerminalStatus } from "../bridge";
import {
  cyberPolicyErrorType,
  CYBER_POLICY_ERROR_CODE,
  CYBER_POLICY_FALLBACK_MESSAGE,
  isCyberPolicyCode,
  isCyberPolicyMessage,
  isTerminalRefusalCode,
  recognizedUpstreamError,
  safetyRefusalCodeFromMessage,
  terminalRefusalFallbackMessage,
  upstreamErrorMessageFromPayload,
} from "../lib/errors";
import { redactSecretString } from "../lib/redact";
import { isTranslatorBudgetExceededError } from "../lib/translator-budget";
import { carryReplayRefusal, isReplayRefusalResponse } from "../lib/upstream-retry";
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
  EMPTY_BYTES,
  joinSseFrameBytes,
  MAX_CLIENT_SSE_FRAME_BYTES,
  SseFrameCountLimitError,
  sseDelimiterLengthAt,
} from "./sse-frame-buffer";
import { replaceSseDataPayload, splitSseBlock, sseDataPayload } from "./sse-payload-rewrite";
import { createBoundedResponseLogBody } from "./response-log-body";
import { clientWireLogOf } from "./inference/client-wire";
import { recordClientWireRequestLog } from "./inference/client-wire-log";
import { nativeResponseFingerprint } from "./responses/native-response-json";
import { nativeResponseOutput } from "./responses/native-response-output";

const nativePassthroughSseResponses = new WeakSet<Response>();
const eagerRelaySseResponses = new WeakSet<Response>();
const preinspectedJsonResponses = new WeakSet<Response>();

export const MAX_INSPECTION_SSE_FRAME_BYTES = MAX_CLIENT_SSE_FRAME_BYTES;
export const MAX_COMPLETED_OUTPUT_ITEMS = 256;
export const MAX_COMPLETED_OUTPUT_ITEM_SOURCE_BYTES = 8 * 1024 * 1024;
export const MAX_TAIL_ERROR_MESSAGE_CHARS = 512;
const ADAPTER_EOF_INCOMPLETE_PAYLOAD = JSON.stringify({
  type: "response.incomplete",
  response: {
    status: "incomplete",
    incomplete_details: { reason: "adapter_eof" },
  },
});
const DONE_SSE_FRAME_TEXT = "data: [DONE]\n\n";
const FAILED_TAIL_FALLBACK_PAYLOAD = JSON.stringify({
  type: "response.failed",
  response: {
    status: "failed",
    error: {
      type: "upstream_error",
      code: "upstream_reset",
      message: "Upstream stream terminated unexpectedly",
    },
    last_error: {
      type: "upstream_error",
      code: "upstream_reset",
      message: "Upstream stream terminated unexpectedly",
    },
  },
});

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

export function buildFailedTailPayload(err: unknown, maskCredential?: (text: string) => string): string {
  const translatorOverflow = isTranslatorBudgetExceededError(err);
  const diagnostic = redactSecretString((translatorOverflow
    ? "upstream translation buffer exceeded the safe limit"
    : `Upstream stream terminated unexpectedly: ${err instanceof Error ? err.message : String(err)}`));
  const message = (maskCredential?.(diagnostic) ?? diagnostic).slice(0, MAX_TAIL_ERROR_MESSAGE_CHARS);
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

function buildFailedTailPayloadOrFallback(err: unknown, maskCredential?: (text: string) => string): string {
  try {
    return buildFailedTailPayload(err, maskCredential);
  } catch {
    // Error.message and String(error) may execute hostile accessors. Preserve a
    // bounded protocol terminal even when diagnostic serialization is unsafe.
    return FAILED_TAIL_FALLBACK_PAYLOAD;
  }
}

export function failedTailFrame(encoder: TextEncoder, err: unknown, maskCredential?: (text: string) => string): Uint8Array {
  const payload = buildFailedTailPayloadOrFallback(err, maskCredential);
  return encoder.encode(`\n\nevent: response.failed\ndata: ${payload}\n\n${DONE_SSE_FRAME_TEXT}`);
}

/**
 * Close a turn the upstream ended without a Responses terminal.
 *
 * `refusalCode` carries the upstream's own verdict when it gave one. Codex
 * classifies this terminal by `error.code` alone and retries everything outside
 * its fatal set (codex-rs/codex-api/src/sse/responses.rs:423-450), so stamping
 * `upstream_server_error` on a refusal delivered it as a retryable disconnect
 * and drove the reconnect loop in #5176. Without a refusal code the terminal
 * carries only recognized rate-limit/overload classes; unknown codes stay generic.
 */
export function upstreamErrorTailFrame(
  encoder: TextEncoder,
  message: string,
  refusalCode?: string,
  maskCredential?: (text: string) => string,
  errorType?: string,
  errorCode?: string,
): Uint8Array {
  return encoder.encode(
    `event: response.failed\ndata: ${upstreamErrorFailedPayload(message, refusalCode, maskCredential, errorType, errorCode)}\n\n`,
  );
}

function upstreamErrorFailedPayload(message: string, refusalCode?: string, maskCredential?: (text: string) => string, errorType?: string, errorCode?: string): string {
  const diagnostic = redactSecretString(message);
  const recognized = recognizedUpstreamError({ type: errorType, code: errorCode });
  const error = {
    type: refusalCode === undefined ? (recognized?.type ?? "upstream_error") : "invalid_request_error",
    code: refusalCode === undefined ? (recognized?.code ?? "upstream_server_error") : (maskCredential?.(refusalCode) ?? refusalCode),
    message: (maskCredential?.(diagnostic) ?? diagnostic).slice(0, MAX_TAIL_ERROR_MESSAGE_CHARS),
  };
  return JSON.stringify({
    type: "response.failed",
    response: {
      status: "failed",
      error,
      last_error: error,
      ...(refusalCode === undefined ? {} : { retryable: false }),
    },
  });
}

/**
 * Terminal for a read that failed after the upstream had already refused.
 *
 * Framed exactly like {@link failedTailFrame} — leading blank line to close a
 * partial block, then the sentinel — but carrying the refusal instead of the
 * generic reset. The refusal is the real outcome of the turn and the socket
 * teardown that followed it is not, so reporting `upstream_reset` here would
 * restart a turn the upstream has already ended (#5176).
 */
export function refusalFailedTailFrame(
  encoder: TextEncoder,
  message: string,
  refusalCode: string,
  maskCredential?: (text: string) => string,
): Uint8Array {
  const payload = upstreamErrorFailedPayload(message, refusalCode, maskCredential);
  return encoder.encode(
    `\n\nevent: response.failed\ndata: ${payload}\n\n${DONE_SSE_FRAME_TEXT}`,
  );
}

function boundedBareUpstreamErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || (payload as { type?: unknown }).type !== "error") return undefined;
  const message = upstreamErrorMessageFromPayload(payload);
  return message ? redactSecretString(message).slice(0, MAX_TAIL_ERROR_MESSAGE_CHARS) : undefined;
}

/**
 * A bare upstream `error` event reduced to what the synthesized terminal needs.
 *
 * The structured code is authoritative whenever the upstream sent one: a code
 * that is not a refusal means the upstream did not refuse, whatever its
 * diagnostic text happens to quote. Recognized refusal copy is read only when
 * no code was carried anywhere on the event, which is the shape #5176 reports.
 * A refusal code with no message still yields a terminal, because Codex accepts
 * that shape and supplies its own copy for it.
 *
 * The candidate topology mirrors {@link upstreamErrorMessageFromPayload}: code
 * and message must be read from the same places, or an event whose message is
 * nested under `response.error` would contribute text while its verdict went
 * unseen.
 */
function boundedBareUpstreamError(payload: unknown): {
  message: string;
  refusalCode: string | undefined;
  errorType: string | undefined;
  errorCode: string | undefined;
} | undefined {
  const root = asJsonRecord(payload);
  if (!root || root.type !== "error") return undefined;
  const message = boundedBareUpstreamErrorMessage(payload);
  const response = asJsonRecord(root.response);
  // Precedence is {@link upstreamErrorMessageFromPayload}'s, so the envelope
  // that supplied the message also supplies the verdict. Taking the FIRST code
  // rather than searching for a refusal is what stops a refusal nested below a
  // transient one from overruling it.
  const candidates = [
    asJsonRecord(root.error),
    asJsonRecord(root.last_error),
    asJsonRecord(response?.error),
    asJsonRecord(response?.incomplete_details),
    root,
  ];
  const code = candidates.map(candidate => stringField(candidate, "code"))
    .find(candidate => candidate !== undefined)?.slice(0, 128);
  // Root `type` is the SSE event discriminator (`"error"`), not an error class. Only nested
  // error records can authoritatively name classes such as rate_limit_error or server_error.
  const errorType = candidates.slice(0, -1).map(candidate => stringField(candidate, "type"))
    .find(candidate => candidate !== undefined)?.slice(0, 128);
  const refusalCode = code !== undefined
    ? (isTerminalRefusalCode(code) ? code : undefined)
    : message === undefined ? undefined : safetyRefusalCodeFromMessage(message);
  if (message !== undefined) return { message, refusalCode, errorType, errorCode: code };
  if (refusalCode === undefined) return undefined;
  return {
    message: terminalRefusalFallbackMessage(refusalCode),
    refusalCode,
    errorType,
    errorCode: code,
  };
}

export type SseTerminalOutputBoundary = {
  feed(chunk: Uint8Array): Uint8Array;
  finish(): Uint8Array;
  terminalSeen(): boolean;
  doneSeen(): boolean;
  upstreamError(): string | undefined;
  upstreamRefusalCode(): string | undefined;
  upstreamErrorType(): string | undefined;
  upstreamErrorCode(): string | undefined;
  dispose(): void;
};

export class SseAggregateLimitError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`upstream SSE transcript exceeded ${maxBytes} bytes`);
    this.name = "SseAggregateLimitError";
    this.maxBytes = maxBytes;
  }
}

export type SseTerminalOutputBoundaryOptions = CodexSafetyBufferingFilterOptions & {
  /** Optional raw bytes admitted before the first terminal; omitted keeps streaming behavior. */
  maxInputBytes?: number;
  /** Optional client-facing bytes emitted through the first terminal. */
  maxOutputBytes?: number;
  /** Optional aggregate frame count through the first terminal. */
  maxFrames?: number;
};

/**
 * Frame-aware client output boundary shared by both native Responses relays.
 * It buffers only the current incomplete SSE block under the same hard byte
 * cap as inspection, forwards complete blocks through the first Responses
 * terminal, and drops every later block/byte. A premature [DONE] is held until
 * a terminal arrives so clean EOF can synthesize one terminal and one sentinel.
 */
export function createSseTerminalOutputBoundary(
  options?: SseTerminalOutputBoundaryOptions,
): SseTerminalOutputBoundary {
  const dropSafetyBuffering = options?.dropCodexSafetyBuffering === true;
  const maxInputBytes = options?.maxInputBytes;
  const maxOutputBytes = options?.maxOutputBytes;
  const maxFrames = options?.maxFrames;
  if (maxInputBytes !== undefined && (!Number.isSafeInteger(maxInputBytes) || maxInputBytes <= 0)) {
    throw new RangeError("maxInputBytes must be a positive safe integer");
  }
  if (maxOutputBytes !== undefined && (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0)) {
    throw new RangeError("maxOutputBytes must be a positive safe integer");
  }
  if (maxFrames !== undefined && (!Number.isSafeInteger(maxFrames) || maxFrames <= 0)) {
    throw new RangeError("maxFrames must be a positive safe integer");
  }
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const framer = new BoundedSseFrameBuffer(MAX_INSPECTION_SSE_FRAME_BYTES);
  let terminal = false;
  let done = false;
  let pendingDone: { block: Uint8Array; delimiter: Uint8Array } | null = null;
  let disposed = false;
  let upstreamError: string | undefined;
  let upstreamRefusalCode: string | undefined;
  let upstreamErrorType: string | undefined;
  let upstreamErrorCode: string | undefined;
  let inputBytes = 0;
  let outputBytes = 0;
  let framesSeen = 0;

  const processFrames = (
    frames: ReturnType<BoundedSseFrameBuffer["feed"]>,
  ): Uint8Array => {
    if (disposed || terminal || frames.length === 0) return EMPTY_BYTES;
    const completedFrames = frames.reduce((count, frame) => count + (frame.continuation ? 0 : 1), 0);
    if (maxFrames !== undefined && completedFrames > maxFrames - framesSeen) {
      throw new SseFrameCountLimitError(maxFrames);
    }
    framesSeen += completedFrames;
    const output: Uint8Array[] = [];
    const appendOutput = (...parts: Uint8Array[]): void => {
      for (const part of parts) {
        if (maxOutputBytes !== undefined && part.byteLength > maxOutputBytes - outputBytes) {
          throw new SseAggregateLimitError(maxOutputBytes);
        }
        outputBytes += part.byteLength;
        output.push(part);
      }
    };
    let responsesTerminal = false;
    for (const frame of frames) {
      const payload = sseDataPayload(decoder.decode(frame.block));
      const isDone = payload === "[DONE]";
      const parsed = payload === null ? undefined : parseSsePayload(payload);
      // Observe on the client reader itself: a tee inspection branch may lag
      // behind EOF, so its log context cannot determine the outgoing terminal.
      const bare = boundedBareUpstreamError(parsed);
      if (bare !== undefined) {
        upstreamError = bare.message;
        upstreamRefusalCode = bare.refusalCode;
        upstreamErrorType = bare.errorType;
        upstreamErrorCode = bare.errorCode;
      }
      const safetyBuffering = dropSafetyBuffering && parsed !== undefined
        ? codexSafetyBufferingBlockAction(parsed) : "keep";
      if (safetyBuffering === "drop") continue;
      const policyError = parsed !== undefined && isPolicyRewriteType(parsed)
        ? cyberPolicyTerminalError(parsed)
        : undefined;
      const policyPayload = policyError ? policyFailurePayload(policyError, parsed) : undefined;
      let outboundBlock = policyPayload !== undefined
        ? encoder.encode(rewritePolicyTerminalBlock(decoder.decode(frame.block), policyPayload))
        : frame.block;
      if (safetyBuffering === "strip") {
        outboundBlock = encoder.encode(stripCodexSafetyBufferingField(
          decoder.decode(outboundBlock),
          policyPayload !== undefined ? parseSsePayload(policyPayload) : parsed,
        ));
      }
      if (isDone) {
        done = true;
        if (responsesTerminal) {
          appendOutput(outboundBlock, frame.delimiter);
        } else if (!pendingDone) {
          // Do not expose a sentinel before a Responses terminal. If EOF
          // follows, the synthetic incomplete path owns the one sentinel;
          // if a terminal arrives later, this pending frame is emitted then.
          pendingDone = { block: outboundBlock, delimiter: frame.delimiter };
        }
        continue;
      }
      // Preserve every frame through the first Responses terminal. Every
      // later non-DONE frame is dropped.
      if (!responsesTerminal) appendOutput(outboundBlock, frame.delimiter);
      if (!responsesTerminal && payload && terminalStatusFromParsed(parsed)) {
        responsesTerminal = true;
        if (pendingDone) {
          appendOutput(pendingDone.block, pendingDone.delimiter);
          pendingDone = null;
        }
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
      if (disposed || terminal) return EMPTY_BYTES;
      if (maxInputBytes === undefined) return processFrames(framer.feed(chunk));
      // A fetch implementation may hand us one multi-megabyte chunk containing thousands of
      // complete frames. Slice BEFORE framing so neither the frame array nor the final join can be
      // allocated past the explicit transcript budget. Once a valid terminal appears, trailing
      // bytes in the same network chunk retain the ordinary terminal-authoritative behavior.
      const slices: Uint8Array[] = [];
      for (let offset = 0; offset < chunk.byteLength && !terminal;) {
        const remaining = maxInputBytes - inputBytes;
        if (remaining <= 0) throw new SseAggregateLimitError(maxInputBytes);
        const length = Math.min(64 * 1024, remaining, chunk.byteLength - offset);
        const slice = chunk.subarray(offset, offset + length);
        inputBytes += slice.byteLength;
        offset += length;
        const processed = processFrames(framer.feed(slice));
        if (processed.byteLength > 0) slices.push(processed);
        if (!terminal && offset < chunk.byteLength && inputBytes >= maxInputBytes) {
          throw new SseAggregateLimitError(maxInputBytes);
        }
      }
      return joinSseFrameBytes(slices);
    },
    finish() {
      if (disposed || terminal) return EMPTY_BYTES;
      const tail = framer.finish();
      if (tail.byteLength === 0) return EMPTY_BYTES;
      // EOF may cut off the final SSE block before its blank-line delimiter.
      // Feed it through the exact same parser/rewrite/terminal path as a
      // complete frame, using a synthetic delimiter so the client receives a
      // dispatchable event rather than an unterminated tail.
      const tailText = decoder.decode(tail);
      const delimiter = encoder.encode(tailText.includes("\r\n") ? "\r\n\r\n" : "\n\n");
      return processFrames([{ block: tail, delimiter }]);
    },
    terminalSeen: () => terminal,
    doneSeen: () => done,
    upstreamError: () => upstreamError,
    upstreamRefusalCode: () => upstreamRefusalCode,
    upstreamErrorType: () => upstreamErrorType,
    upstreamErrorCode: () => upstreamErrorCode,
    dispose() {
      if (disposed) return;
      disposed = true;
      pendingDone = null;
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
  opts?: { upstreamError?: string; terminalBoundary?: CodexSafetyBufferingFilterOptions; maskCredential?: (text: string) => string },
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const encoder = new TextEncoder();
  const terminalBoundary = createSseTerminalOutputBoundary(opts?.terminalBoundary);
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
      controller.enqueue(doneFrame(encoder));
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
            if (terminalBoundary.terminalSeen()) {
              if (!terminalBoundary.doneSeen()) controller.enqueue(doneFrame(encoder));
            } else {
              // A clean upstream EOF is still a failed Responses turn when no
              // protocol terminal arrived. Make that state explicit so Codex
              // does not treat HTTP 200 + bare EOF as a retryable disconnect.
              const upstreamError = terminalBoundary.upstreamError() ?? opts?.upstreamError;
              controller.enqueue(upstreamError === undefined
                ? adapterEofIncompleteFrame(encoder)
                : upstreamErrorTailFrame(
                  encoder,
                  upstreamError,
                  terminalBoundary.upstreamRefusalCode(),
                  opts?.maskCredential,
                  terminalBoundary.upstreamErrorType(),
                  terminalBoundary.upstreamErrorCode(),
                ));
              controller.enqueue(doneFrame(encoder));
            }
            terminalBoundary.dispose();
            controller.close();
            return;
          }
          const result = relayChunk(controller, value);
          if (result !== "buffered") return;
        }
      } catch (err) {
        let partial: Uint8Array = EMPTY_BYTES;
        let tailTerminal = false;
        try {
          partial = terminalBoundary.finish();
          tailTerminal = terminalBoundary.terminalSeen();
        } catch {
          // A near-cap ambiguous delimiter tail may itself overflow at EOF.
          // Preserve the original read/framing failure and continue emitting
          // the bounded failed tail instead of letting cleanup throw again.
        }
        terminalBoundary.dispose();
        if (closed) return;
        try {
          if (partial.byteLength > 0) controller.enqueue(partial);
          if (tailTerminal) {
            if (!terminalBoundary.doneSeen()) controller.enqueue(doneFrame(encoder));
          } else {
            // Leading blank line terminates a partial SSE block so the failed frame parses cleanly.
            const refusalCode = terminalBoundary.upstreamRefusalCode();
            const refusalMessage = terminalBoundary.upstreamError();
            controller.enqueue(refusalCode !== undefined && refusalMessage !== undefined
              ? refusalFailedTailFrame(encoder, refusalMessage, refusalCode, opts?.maskCredential)
              : failedTailFrame(encoder, err, opts?.maskCredential));
          }
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

export { nextSseBlock, sseDataPayload } from "./sse-payload-rewrite";

type JsonRecord = Record<string, unknown>;

function asJsonRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function stringField(record: JsonRecord | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Return a high-confidence policy error carried by an upstream terminal shape.
 * Deliberately inspect structured error fields and known refusal copy only — a
 * bare `cyber_policy` token in an unrelated payload is not sufficient.
 */
function cyberPolicyTerminalError(parsed: unknown): { message: string; type?: string } | undefined {
  const root = asJsonRecord(parsed);
  if (!root) return undefined;
  const response = asJsonRecord(root.response);
  const candidates = [
    asJsonRecord(root.error),
    asJsonRecord(root.last_error),
    asJsonRecord(response?.error),
    asJsonRecord(response?.incomplete_details),
    root,
    response,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (isCyberPolicyCode(stringField(candidate, "code"))) {
      return {
        message: stringField(candidate, "message")
          ?? CYBER_POLICY_FALLBACK_MESSAGE,
        ...(stringField(candidate, "type") ? { type: stringField(candidate, "type") } : {}),
      };
    }
  }
  for (const candidate of candidates) {
    const message = stringField(candidate, "message");
    if (message && isCyberPolicyMessage(message)) {
      return {
        message,
        ...(stringField(candidate, "type") ? { type: stringField(candidate, "type") } : {}),
      };
    }
  }
  return undefined;
}

function parseSsePayload(payload: string): unknown | undefined {
  if (payload === "[DONE]") return undefined;
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}

function isPolicyRewriteType(parsed: unknown): boolean {
  const type = asJsonRecord(parsed)?.type;
  return type === "response.failed" || type === "response.incomplete" || type === "error";
}

/**
 * Codex emits its safety-buffering hint in the SSE body as well as in headers:
 * a `response.metadata` event whose `metadata.type` is `safety_buffering`, or a
 * `safety_buffering` field on another event. The metadata event is dropped whole;
 * the field is stripped so the carrying event is otherwise relayed unchanged.
 */
function codexSafetyBufferingBlockAction(parsed: unknown): "keep" | "drop" | "strip" {
  const root = asJsonRecord(parsed);
  if (!root) return "keep";
  if (root.type === "response.metadata") {
    const metadata = asJsonRecord(root.metadata);
    if (metadata?.type === "safety_buffering") return "drop";
  }
  return Object.hasOwn(root, "safety_buffering") ? "strip" : "keep";
}

function stripCodexSafetyBufferingField(block: string, parsed: unknown): string {
  const root = asJsonRecord(parsed);
  if (!root) return block;
  const { safety_buffering: _safetyBuffering, ...rest } = root;
  return replaceSseDataPayload(block, JSON.stringify(rest));
}

function rewritePolicyTerminalBlock(block: string, payload: string): string {
  const rewritten = replaceSseDataPayload(block, payload);
  const { newline, lines } = splitSseBlock(rewritten);
  let eventRewritten = false;
  const withEvent = lines.map(line => {
    if (!eventRewritten && line.startsWith("event:")) {
      eventRewritten = true;
      return "event: response.failed";
    }
    return line;
  });
  if (!eventRewritten) withEvent.unshift("event: response.failed");
  return withEvent.join(newline);
}

function policyFailurePayload(policyError: { message: string; type?: string }, parsed: unknown): string {
  const error = {
    type: cyberPolicyErrorType(policyError.type),
    code: CYBER_POLICY_ERROR_CODE,
    message: redactSecretString(policyError.message).slice(0, MAX_TAIL_ERROR_MESSAGE_CHARS),
  };
  const root = asJsonRecord(parsed);
  const originalResponse = asJsonRecord(root?.response);
  const preservedResponse = Object.fromEntries(
    Object.entries(originalResponse ?? {}).filter(([key]) => key !== "incomplete_details"),
  );
  const response = {
    ...preservedResponse,
    status: "failed",
    error,
    last_error: error,
    retryable: false,
  };
  // Responses event metadata such as sequence_number is normally top-level.
  // Keep it (and any other non-error, non-response fields) while replacing only
  // the protocol type and error envelope.
  const preservedRoot = root
    ? Object.fromEntries(Object.entries(root).filter(([key]) => (
      key !== "type"
      && key !== "response"
      && key !== "error"
      && key !== "last_error"
      && key !== "retryable"
    )))
    : {};
  return JSON.stringify({
    ...preservedRoot,
    type: "response.failed",
    retryable: false,
    response,
  });
}

export function adapterEofIncompleteFrame(encoder: TextEncoder): Uint8Array {
  return encoder.encode(`event: response.incomplete\ndata: ${ADAPTER_EOF_INCOMPLETE_PAYLOAD}\n\n`);
}

export function doneFrame(encoder: TextEncoder): Uint8Array {
  return encoder.encode(DONE_SSE_FRAME_TEXT);
}

export function terminalStatusFromSsePayload(payload: string): ResponsesTerminalStatus | null {
  if (payload === "[DONE]") return null;
  return terminalStatusFromParsed(parseSsePayload(payload));
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
    || event.type === "response.reasoning_text.delta"
    || event.type === "response.function_call_arguments.delta"
    || event.type === "response.custom_tool_call_input.delta")
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
  const type = asJsonRecord(parsed)?.type;
  switch (type) {
    case "response.completed":
      return "completed";
    case "response.failed":
      return "failed";
    case "response.incomplete":
      return cyberPolicyTerminalError(parsed) ? "failed" : "incomplete";
    case "error":
      return cyberPolicyTerminalError(parsed) ? "failed" : null;
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
  // A synthetic 429 is a transport verdict, not evidence that the provider declined the turn.
  if (isReplayRefusalResponse(response)) {
    logCtx.causeHint = "transport-ambiguous";
    logCtx.terminalSource = "synthetic";
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (isUsageDebugEnabled() && !logCtx.usageDebugContentType && contentType) {
    logCtx.usageDebugContentType = contentType;
  }
  if (isNativePassthroughSseResponse(response)) {
    return response;
  }
  // A body already in the client's wire is not Responses SSE or JSON; its producer reports the
  // facts the tap below would read (PF-09 direct encoders).
  const clientWireLog = clientWireLogOf(response);
  if (clientWireLog) {
    recordClientWireRequestLog(clientWireLog, requestId, start, logCtx, addLog);
    return response;
  }
  if (!response.body || !contentType.includes("text/event-stream")) {
    if (response.body && (contentType.includes("application/json") || response.status >= 400)) {
      // Some delivery paths already parsed the bounded body while constructing the client JSON.
      // Retain EOF/cancel logging there, but do not materialize and parse the same near-limit
      // response a second time merely for metadata the first pass already published.
      const preinspectedJson = contentType.includes("application/json")
        && preinspectedJsonResponses.has(response);
      const body = createBoundedResponseLogBody(response.body, {
        json: contentType.includes("application/json"),
        ...(preinspectedJson ? { maxInspectionBytes: 0 } : {}),
        inspect: preinspectedJson ? () => undefined : text => inspectResponseLogJson(logCtx, text),
        finalize: reason => {
          // Preserve wire status; request history follows the adjacent SSE
          // convention for a client cancellation or upstream read failure.
          const status = reason === "cancel" ? 499 : reason === "read_error" ? 502 : response.status;
          addFinalRequestLog(requestId, start, logCtx, status, {
            ...(reason === "eof" && logCtx.observedTerminalStatus
              ? { terminalStatus: logCtx.observedTerminalStatus }
              : {}),
            closeReason: reason === "cancel" ? "client_cancel" : "non_stream",
          }, addLog);
        },
      });
      // Logging re-wraps the response, and an in-process verdict does not survive a re-wrap on
      // its own. A replay refusal that lost it here would read to a later quota recorder or
      // Retry-After synthesizer as a 429 some upstream produced.
      return carryReplayRefusal(response, new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }));
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

/** Mark bounded JSON whose request-log metadata was already derived from its source events. */
export function markPreinspectedJsonResponse(response: Response): Response {
  preinspectedJsonResponses.add(response);
  return response;
}

export function isPreinspectedJsonResponse(response: Response): boolean {
  return preinspectedJsonResponses.has(response);
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
  /** A reconstructed snapshot for any valid terminal kind; unlike persistence, includes failures. */
  onTerminalResponse?: (
    status: ResponsesTerminalStatus,
    response: { id?: unknown; output?: unknown; status?: unknown },
  ) => void;
  /**
   * Opt-in reconstruction policy for a caller that must materialize the whole terminal response.
   * Persistence inspectors omit this and retain their smaller historical caps/merge semantics.
   */
  terminalReconstruction?: {
    maxItems: number;
    maxSourceBytes: number;
    requireCompleteOutputIndices?: boolean;
    mergeSparseTerminalOutput?: boolean;
  };
  /**
   * Every parsed SSE payload, delivered BEFORE any onCompletedResponse derived from that same
   * payload. A caller that must decide on the whole turn -- not just its terminal snapshot --
   * needs to see the incremental events, because a stream can announce an item and then close
   * with an empty `output`.
   */
  onParsedPayload?: (payload: unknown) => void;
  /**
   * A complete data payload that did not parse as a JSON event, `[DONE]` included.
   *
   * An inspector that only hears about parsed events cannot tell "nothing has been emitted"
   * from "something was emitted that I could not read", and a replay decision needs that
   * difference: an unreadable payload is a payload the caller may already have seen.
   * The payload lets bounded collectors distinguish the valid `[DONE]` sentinel from malformed
   * JSON without adding a second SSE parser; existing observers may ignore the argument.
   */
  onOpaquePayload?: (payload: string | null) => void;
  onFirstOutput?: () => void;
  /**
   * Provider-scoped compatibility: persist the completed snapshot under the
   * first response id exposed to the client when an upstream changes ids
   * between `response.created` and `response.completed`.
   */
  pinCompletedResponseIdToFirstSeen?: boolean;
};

type CompletedOutputItem = { item: unknown; sourceBytes: number };

function outputBearingSseEvent(event: { type?: unknown; output_index?: unknown } | null): boolean {
  if (!event || typeof event.type !== "string") return false;
  if (Object.hasOwn(event, "output_index")) return true;
  return /^response\.(?:output_item|content_part|output_text|refusal|reasoning_[^.]+|function_call_arguments|custom_tool_call_input|image_generation_call|code_interpreter_call|file_search_call|web_search_call|computer_call|tool_search_call)\./
    .test(event.type);
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
  let delimiterTail: Uint8Array = EMPTY_BYTES;
  let pendingLineFeed = false;
  let candidate: Uint8Array = EMPTY_BYTES;
  let candidateBytes = 0;
  let discardingOversizedFrame = false;
  const reportFirstOutput = createFirstOutputReporter(handlers.onFirstOutput);
  const reconstructionPolicy = handlers.terminalReconstruction;
  if (reconstructionPolicy
    && (!Number.isSafeInteger(reconstructionPolicy.maxItems) || reconstructionPolicy.maxItems <= 0
      || !Number.isSafeInteger(reconstructionPolicy.maxSourceBytes) || reconstructionPolicy.maxSourceBytes <= 0)) {
    throw new RangeError("terminal reconstruction limits must be positive safe integers");
  }
  const maxCompletedItems = reconstructionPolicy?.maxItems ?? MAX_COMPLETED_OUTPUT_ITEMS;
  const maxCompletedItemSourceBytes = reconstructionPolicy?.maxSourceBytes
    ?? MAX_COMPLETED_OUTPUT_ITEM_SOURCE_BYTES;
  // Allocate reconstruction state only for snapshot-capable inspectors.
  const completedItemsByOutputIndex = handlers.onCompletedResponse || handlers.onTerminalResponse
    ? new Map<number, CompletedOutputItem>()
    : null;
  let aggregateItemBytes = 0;
  let reconstructionTainted = false;
  const observedOutputIndices = reconstructionPolicy?.requireCompleteOutputIndices
    ? new Set<number>()
    : null;
  let firstResponseId: string | undefined;

  const clearFrameState = (): void => {
    delimiterTail = EMPTY_BYTES;
    pendingLineFeed = false;
    candidate = EMPTY_BYTES;
    candidateBytes = 0;
    discardingOversizedFrame = false;
  };

  const clearCompletedItems = (): void => {
    completedItemsByOutputIndex?.clear();
    observedOutputIndices?.clear();
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
    if (candidateBytes === 0) return EMPTY_BYTES;
    const frame = candidate.slice(0, candidateBytes);
    candidate = EMPTY_BYTES;
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
      candidate = EMPTY_BYTES;
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
      if (reconstructionPolicy?.mergeSparseTerminalOutput === true) {
        // Repeated identical done frames are harmless, but a later frame must never rewrite an
        // already-completed index. The strict buffered path treats that contradiction as taint.
        if (nativeResponseFingerprint(previous.item) !== nativeResponseFingerprint(item)) {
          reconstructionTainted = true;
        }
        return;
      }
      aggregateItemBytes -= previous.sourceBytes;
      completedItemsByOutputIndex!.delete(index);
    }
    if (sourceBytes > maxCompletedItemSourceBytes) {
      reconstructionTainted = true;
      inspectionCounters.itemCapEvictions += 1;
      return;
    }
    completedItemsByOutputIndex!.set(index, { item, sourceBytes });
    aggregateItemBytes += sourceBytes;
    while (completedItemsByOutputIndex!.size > maxCompletedItems
      || aggregateItemBytes > maxCompletedItemSourceBytes) {
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
    // The other half of the same observation. A payload that did not parse still reached the
    // caller, so a consumer deciding whether anything has been emitted has to hear about it.
    if (handlers.onOpaquePayload && parsed === undefined) {
      try { handlers.onOpaquePayload(payload); } catch { /* inspection must never throw into the pump */ }
    }
    reportFirstOutput.parsed(parsed);
    const status = terminalStatusFromParsed(parsed);
    type ParsedSseEvent = { type?: unknown; output_index?: unknown; item?: unknown; response?: unknown };
    const parsedEvent = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as ParsedSseEvent
      : null;
    if (observedOutputIndices && outputBearingSseEvent(parsedEvent)) {
      const outputIndex = parsedEvent?.output_index;
      if (Number.isInteger(outputIndex) && (outputIndex as number) >= 0
        && (outputIndex as number) < maxCompletedItems) {
        observedOutputIndices.add(outputIndex as number);
      } else {
        reconstructionTainted = true;
      }
    }
    let reconstructedTerminalResponse: { id?: unknown; output?: unknown; status?: unknown } | null = null;
    if (completedItemsByOutputIndex) {
      const responseRecord = parsedEvent
        && typeof parsedEvent.response === "object"
        && parsedEvent.response !== null
        && !Array.isArray(parsedEvent.response)
        ? parsedEvent.response as { id?: unknown; output?: unknown; status?: unknown }
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
        && (!observedOutputIndices || (parsedEvent.output_index as number) < maxCompletedItems)
        && typeof doneItem === "object"
        && doneItem !== null
        && !Array.isArray(doneItem)
        && typeof (doneItem as { type?: unknown }).type === "string") {
        retainCompletedItem(parsedEvent.output_index as number, doneItem, sourceBytes);
      }
      if (status && responseRecord) {
        reconstructedTerminalResponse = responseRecord;
        if (handlers.pinCompletedResponseIdToFirstSeen
          && firstResponseId !== undefined
          && reconstructedTerminalResponse.id !== firstResponseId) {
          reconstructedTerminalResponse = { ...reconstructedTerminalResponse, id: firstResponseId };
        }
        const explicitTerminalOutput = reconstructedTerminalResponse.output;
        const terminalOutput = Array.isArray(explicitTerminalOutput)
          ? explicitTerminalOutput
          : null;
        if (explicitTerminalOutput !== undefined && explicitTerminalOutput !== null && !terminalOutput) {
          reconstructionTainted = true;
        }
        if (terminalOutput && terminalOutput.length > maxCompletedItems) reconstructionTainted = true;
        const hasAuthoritativeOutput = terminalOutput !== null && terminalOutput.length > 0;
        if (reconstructionPolicy?.mergeSparseTerminalOutput === true) {
          if (terminalOutput?.some(item => !item || typeof item !== "object" || Array.isArray(item)
            || typeof (item as { type?: unknown }).type !== "string")) reconstructionTainted = true;
          let output: Record<string, unknown>[] = [];
          if (!reconstructionTainted) {
            try {
              output = nativeResponseOutput(
                new Map([...completedItemsByOutputIndex.entries()].map(([index, retained]) => [
                  index,
                  retained.item as Record<string, unknown>,
                ])),
                terminalOutput,
              );
            } catch {
              reconstructionTainted = true;
            }
          }
          if (output.length > maxCompletedItems) reconstructionTainted = true;
          for (const index of observedOutputIndices ?? []) {
            if (index >= output.length) reconstructionTainted = true;
          }
          reconstructedTerminalResponse = reconstructionTainted
            ? null
            : { ...reconstructedTerminalResponse, output };
        } else if (!hasAuthoritativeOutput && reconstructionTainted) {
          reconstructedTerminalResponse = null;
        } else if (!hasAuthoritativeOutput && completedItemsByOutputIndex.size > 0) {
          reconstructedTerminalResponse = {
            ...reconstructedTerminalResponse,
            output: [...completedItemsByOutputIndex.entries()]
              .sort(([left], [right]) => left - right)
              .map(([, retained]) => retained.item),
          };
        }
      }
    }
    const policyTerminal = status === "failed"
      && isPolicyRewriteType(parsed)
      && cyberPolicyTerminalError(parsed) !== undefined;
    if (status) sawTerminal = true;
    try {
      if (!reported && handlers.onTerminal && status) {
        reported = true;
        if (handlers.logCtx) {
          handlers.logCtx.transportPhase = "terminal_sse";
          handlers.logCtx.terminalSource = "upstream";
        }
        handlers.onTerminal(status, policyTerminal ? 400 : undefined);
      }
      if (status === "completed" && reconstructedTerminalResponse && handlers.onCompletedResponse) {
        handlers.onCompletedResponse(reconstructedTerminalResponse);
      }
      if (status && reconstructedTerminalResponse && handlers.onTerminalResponse) {
        handlers.onTerminalResponse(status, reconstructedTerminalResponse);
      }
    } finally {
      if (status) clearCompletedItems();
    }
  };

  const completeCandidate = (): void => {
    if (discardingOversizedFrame) {
      discardingOversizedFrame = false;
      return;
    }
    const sourceBytes = candidateBytes;
    const frame = takeCandidate();
    if (reported && !handlers.onCompletedResponse && !handlers.onTerminalResponse) return;
    const decoded = decoder!.decode(frame);
    scanPayload(sseDataPayload(decoded), sourceBytes);
  };

  const scanChunk = (chunk: Uint8Array): void => {
    const previousTail = delimiterTail;
    delimiterTail = EMPTY_BYTES;
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
    let index = pendingLineFeed && byteAt(0) === 10 ? 1 : 0;
    if (totalLength > 0) pendingLineFeed = false;
    let retainedThrough = index;
    while (index < totalLength) {
      const delimiterLength = sseDelimiterLengthAt(index, totalLength, byteAt);
      if (delimiterLength === undefined) break;
      if (delimiterLength > 0) {
        retainRange(retainedThrough, index);
        completeCandidate();
        index += delimiterLength;
        pendingLineFeed = index === totalLength && byteAt(index - 1) === 13;
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
        delimiterTail = EMPTY_BYTES;
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
        // Hard cancellation settles a pending read as EOF. Do not flush a
        // partial terminal after the owner already finalized cancellation.
        if (cancelled) break;
        if (clientGoneSignal?.aborted) markClientGone();
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
      // Bun can settle a fetch body read before dispatching all abort listeners.
      // Observe the signal itself before classifying that rejection as upstream.
      if (clientGoneSignal?.aborted) markClientGone();
      // A read error can follow a final SSE block without its blank-line
      // delimiter. Flush that candidate before classifying the transport as a
      // synthetic reset; otherwise a real completed/failed/policy terminal is
      // downgraded to 502 on the inspection branch.
      if (!cancelled) {
        try { inspector.finish(); } catch { /* preserve the original read error */ }
      }
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
  let bareUpstreamError: string | undefined;
  const inspector = (options?.inspectorFactory ?? createSseInspector)({
    onTerminal,
    logCtx,
    onCompletedResponse,
    onParsedPayload: payload => {
      const message = boundedBareUpstreamErrorMessage(payload);
      if (message !== undefined) bareUpstreamError = message;
      options?.onParsedPayload?.(payload);
    },
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
        if (bareUpstreamError !== undefined) {
          onTerminal("failed", httpStatusForRequestLogTerminal("failed", logCtx));
        } else {
          onTerminal("incomplete");
        }
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
export const CODEX_SAFETY_BUFFERING_HEADERS = [
  "x-codex-safety-buffering-enabled",
  "x-codex-safety-buffering-faster-model",
] as const;

const CODEX_SAFETY_BUFFERING_HEADER_SET: ReadonlySet<string> = new Set(CODEX_SAFETY_BUFFERING_HEADERS);

const PASSTHROUGH_DROP_HEADERS: ReadonlySet<string> = new Set([
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

export interface CodexSafetyBufferingFilterOptions {
  /**
   * Drop Codex safety-buffering hints: the `x-codex-safety-buffering-*` response
   * headers and the `safety_buffering` SSE metadata event / field. Absent and
   * `false` relay everything unchanged.
   */
  dropCodexSafetyBuffering?: boolean;
}

/** Resolve the passthrough header policy from the loaded config (absent means "forward everything"). */
export function codexSafetyBufferingFilterOptions(
  config: { dropCodexSafetyBuffering?: boolean },
): CodexSafetyBufferingFilterOptions {
  return { dropCodexSafetyBuffering: config.dropCodexSafetyBuffering === true };
}

export function sanitizePassthroughHeaders(upstream: Headers, options?: CodexSafetyBufferingFilterOptions): Headers {
  const dropSafetyBuffering = options?.dropCodexSafetyBuffering === true;
  const out = new Headers();
  upstream.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (PASSTHROUGH_DROP_HEADERS.has(lower)) return;
    if (dropSafetyBuffering && CODEX_SAFETY_BUFFERING_HEADER_SET.has(lower)) return;
    out.set(key, value);
  });
  return out;
}
