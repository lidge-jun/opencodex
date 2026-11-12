import {
  codexAccountModelRefusal,
  codexAccountModelRefusalPayload,
  envelopeErrorRecord,
  envelopeRecordCode,
  hasConflictingCodexModelRefusalEnvelopes,
  isMalformedResponseFormatRecord,
  isOpenRouterOpaque400EnvelopeRoot,
  isOpenRouterOpaque400Record,
  type CodexAccountModelRefusal,
} from "../../combos/failover";
import type { ResponsesTerminalStatus } from "../../bridge";
import { comboFailureDecision } from "../../combos";
import { httpStatusFromTerminalError } from "../../lib/errors";
import { hasResponseMediaType } from "../../lib/http-response-semantics";
import type { RequestFailureStage } from "../../lib/request-failure-model";
import type { RequestLogContext } from "../request-log";
import { carryResponseToolOwnership } from "./response-tool-ownership";
import { createSseInspector } from "../relay";
import { MAX_CLIENT_SSE_FRAME_BYTES } from "../sse-frame-buffer";
import { REQUIRED_TOOL_CONTRACT_CODE } from "../../lib/errors";
import { isPausedTurn } from "../../lib/client-error-body";
import { requiredToolReasoningPrelude } from "./combo-required-tool-stream";

const COMBO_STREAM_PREFLIGHT_MAX_BYTES = MAX_CLIENT_SSE_FRAME_BYTES;
// Required-tool reasoning may delay delivery, but never for an unbounded/trickling prelude.
const COMBO_REQUIRED_TOOL_REASONING_HOLD_MS = 1_000;
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

// The Codex WebSocket metadata channel (`codex-ws-metadata.ts`) writes these into the same SSE
// body, typically ahead of `response.created`. They are rebuilt field by field from quota and
// header metadata, so they are neither output nor a terminal. Committing on them made a native
// target that declined before any output (#8107) final for the whole combo. Every other unknown
// type still commits.
const CODEX_METADATA_CONTROL_EVENTS = new Set([
  "codex.rate_limits",
  "codex.response.metadata",
]);

const TERMINAL_EVENTS = new Set([
  "response.completed",
  "response.failed",
  "response.incomplete",
]);

// A failed terminal carrying one of these codes is a contract verdict, not a transient
// upstream failure: another target would spend a request the adapter already refused.
const NON_REPLAYABLE_FAILED_CODES = new Set(["required_tool_not_called"]);

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
  const rawCode = error.code ?? event.code;
  const code = typeof rawCode === "string"
    ? rawCode
    : typeof rawCode === "number" && Number.isFinite(rawCode)
      ? String(rawCode)
      : null;
  if (explicitStatus === undefined && code === "invalid_request_error") return 400;
  // Status is the record's own evidence; whether that record speaks for the envelope is the
  // decision's question, so a root hard stop still reports 400 instead of inventing a 5xx.
  if (explicitStatus === undefined && isOpenRouterOpaque400Record(envelopeErrorRecord(event))) {
    return 400;
  }
  // OpenRouter-style envelopes carry the HTTP status as a bare numeric `code` (e.g. `code: 400`)
  // with no separate status field. `httpStatusFromTerminalError` only understands symbolic codes,
  // so without this the opaque 400 stringifies to "400", reads as unknown, and falls back to 502 —
  // which cools the target on the generic 5xx path instead of taking the intended no-cool hop.
  if (explicitStatus === undefined
    && typeof rawCode === "number" && Number.isInteger(rawCode) && rawCode >= 400 && rawCode <= 599) {
    return rawCode;
  }
  return explicitStatus ?? httpStatusFromTerminalError({
    type: typeof error.type === "string" && error.type !== "error" ? error.type : undefined,
    code,
    message: typeof error.message === "string"
      ? error.message
      : typeof event.message === "string" ? event.message : undefined,
  });
}

/** Match the selected SSE error envelope before projection drops competing fields. */
function terminalModelRefusal(status: number, event: Record<string, unknown>): CodexAccountModelRefusal {
  if (hasConflictingCodexModelRefusalEnvelopes(status, event)) return "ambiguous";
  const outer = codexAccountModelRefusalPayload(status, event);
  if (outer === "ambiguous") return outer;
  const nested = event.response;
  if (event.type !== "error" && nested && typeof nested === "object" && !Array.isArray(nested)) {
    const nestedKind = codexAccountModelRefusalPayload(status, nested);
    if (nestedKind === "ambiguous") return nestedKind;
    const nestedError = (nested as Record<string, unknown>).error;
    if (nestedError && typeof nestedError === "object" && !Array.isArray(nestedError)) {
      return nestedKind;
    }
  }
  if (event.type === "error" && !Object.hasOwn(event, "error") && typeof event.message === "string") {
    return codexAccountModelRefusal(status, event.message, { allowNestedResponse: false });
  }
  return outer;
}

function bareErrorIsRetryable(payload: unknown): boolean {
  const status = bareErrorStatus(payload);
  if (status === undefined || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const event = payload as Record<string, unknown>;
  // The record selection, the opaque verdict and the code conflict rule are shared with the HTTP
  // consumer; only the carrier (one parsed frame here, one body there) differs.
  const record = envelopeErrorRecord(event);
  const error = record ?? event;
  const rootCode = envelopeRecordCode(event);
  const recordCode = envelopeRecordCode(record);
  const message = typeof error.message === "string"
    ? error.message
    : typeof event.message === "string" ? event.message : "";
  const rawRecord = {
    ...(error as Record<string, unknown>),
    ...(typeof event.detail === "string" ? { detail: event.detail } : {}),
  };
  const malformedResponseFormat = status === 400 ? isMalformedResponseFormatRecord(rawRecord, message) : undefined;
  const openRouterOpaque400 = status === 400 ? isOpenRouterOpaque400EnvelopeRoot(event) : undefined;
  // A conflicting root and record code hop only when each would hop on its own, so a root hard
  // stop is never hidden behind a retryable record code (and a retryable pair keeps dev's hop).
  return comboFailureDecision(status, message, {
    code: recordCode ?? rootCode, rootCode,
    codexModelRefusal: terminalModelRefusal(status, event),
    malformedResponseFormat, openRouterOpaque400,
  }) === "hop";
}

/**
 * Only text and reasoning items, which the required-tool guard holds back until it decides. Both the
 * snapshot's and the event's own `output` are read; an absent or empty one contributes nothing.
 */
function heldOnlyOutput(...outputs: unknown[]): boolean {
  const items = outputs.flatMap(output => Array.isArray(output) ? output : []);
  if (outputs.some(output => output !== undefined && !Array.isArray(output))) return false;
  return items.length > 0 && items.every(item => item !== null && typeof item === "object"
    && !Array.isArray(item) && ["message", "reasoning"].includes((item as { type?: unknown }).type as string));
}

function retryableZeroOutputTerminal(payload: unknown, context?: object): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const event = payload as {
    type?: unknown;
    status?: unknown;
    end_turn?: unknown;
    incomplete_details?: { reason?: unknown; retryable?: unknown };
    output?: unknown;
    error?: { code?: unknown; retryable?: unknown };
    response?: {
      status?: unknown;
      end_turn?: unknown;
      incomplete_details?: { reason?: unknown; retryable?: unknown };
      output?: unknown;
      error?: { code?: unknown; retryable?: unknown };
    };
  };
  if (bareErrorIsRetryable(event)) return true;
  const target = (event.response && typeof event.response === "object" && !Array.isArray(event.response))
    ? event.response as Record<string, unknown>
    : event as Record<string, unknown>;
  const emptyOutput = (!Array.isArray(event.output) || event.output.length === 0)
    && (!Array.isArray(target.output) || target.output.length === 0);

  if (event.type === "response.failed" || event.status === "failed") {
    const error = (event.response as { error?: { code?: unknown; retryable?: unknown } } | undefined)?.error
      ?? event.error;
    const code = error?.code;
    // The required-tool guard synthesizes this terminal over output it held back from the client,
    // so held text and reasoning are not evidence of anything sent; it keeps the retryability it
    // carries. Any other output item (a tool call, an action) still commits it.
    if (code === REQUIRED_TOOL_CONTRACT_CODE) {
      return error?.retryable !== false && (emptyOutput || heldOnlyOutput(target.output, event.output));
    }
    if (!emptyOutput) return false;
    return !(typeof code === "string" && NON_REPLAYABLE_FAILED_CODES.has(code));
  }
  const isIncomplete = event.type === "response.incomplete" || event.status === "incomplete";
  if (!isIncomplete) return false;
  if (!emptyOutput) return false;
  const details = (target.incomplete_details && typeof target.incomplete_details === "object" && !Array.isArray(target.incomplete_details))
    ? target.incomplete_details as { reason?: unknown; retryable?: unknown }
    : undefined;
  const reason = details?.reason;
  if (reason === undefined) return true;
  if (reason === "max_output_tokens") {
    // Same evidence the run-turn classifier requires before it treats an output limit as a
    // replayable zero-output terminal: an explicitly unfinished turn or an explicitly
    // non-retryable limit is an answer, not a target failure. A normalized Anthropic
    // `pause_turn` also reads as max_output_tokens on the wire, so the request-scoped marker
    // keeps a paused turn the client must continue from hopping to another provider.
    if (isPausedTurn(context)) return false;
    const endTurn = target.end_turn ?? event.end_turn;
    if (endTurn === false) return false;
    if (details?.retryable === false) return false;
    return true;
  }
  return typeof reason === "string" && RETRYABLE_ZERO_OUTPUT_INCOMPLETE_REASONS.has(reason);
}

/**
 * Decide when replaying the request on another combo target would risk duplicating
 * client-visible output or a tool-side effect. Unknown event types commit the child
 * conservatively; only the small Responses lifecycle preamble and Codex metadata control frames
 * remain replayable.
 */
export function comboStreamPayloadCommitsOutput(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return true;
  const type = (payload as { type?: unknown }).type;
  if (typeof type !== "string") return true;
  if (type === "response.created") {
    // A created event is a control frame only while its snapshot is empty. An origin that
    // resumes a turn can put completed items in it, and treating that as a prelude would let
    // a replacement re-emit output the caller already received.
    const response = (payload as { response?: unknown }).response;
    if (response && typeof response === "object" && !Array.isArray(response)) {
      const output = (response as { output?: unknown }).output;
      if (Array.isArray(output) && output.length > 0) return true;
    }
  }
  if (type === "response.output_text.delta") {
    const delta = (payload as { delta?: unknown }).delta;
    if (delta === undefined || (typeof delta === "string" && delta.length === 0)) return false;
  }
  return !PRE_OUTPUT_CONTROL_EVENTS.has(type) && !CODEX_METADATA_CONTROL_EVENTS.has(type)
    && !TERMINAL_EVENTS.has(type);
}

/**
 * How far this SSE body got, in the vocabulary of src/lib/request-failure-model.ts.
 *
 * The preflight cannot separate `semantic-output` from `side-effect`: it classifies any event
 * that is not a lifecycle control frame as committing, without reading item types. Both stages
 * refuse a resend, so the distinction would change no decision -- it is named here so a later
 * reader does not mistake the collapse for an omission.
 *
 * A terminal that settled carrying no output is `protocol-prelude`, not `terminal`. That is
 * the failure model's own rule: `terminal` means the answer was delivered, and an empty
 * completion delivered none.
 *
 * Only the two nothing-observed stages actually reach a read error today: the loop below hands
 * the body back as `accepted` the moment output commits or a terminal arrives, so a stream
 * that committed anything never reports a stage at all. The committed branches stay because
 * this has to be total for any other caller, and because a later change to that loop must not
 * be able to promote a committed stream into a replaceable one by omission.
 */
function observedResponsesStage(state: {
  readonly outputCommitted: boolean;
  readonly terminalStatus: ResponsesTerminalStatus | undefined;
  readonly responseCreated: boolean;
}): RequestFailureStage {
  if (state.outputCommitted) return "semantic-output";
  if (state.terminalStatus === "completed") return "terminal";
  if (state.responseCreated || state.terminalStatus !== undefined) return "protocol-prelude";
  return "headers-only";
}

function replayBufferedResponse(
  response: Response,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffered: Uint8Array[],
  pendingRead?: ReturnType<typeof reader.read>,
): Response {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < buffered.length) {
        controller.enqueue(buffered[index++]!);
        return;
      }
      try {
        const next = await (pendingRead ?? reader.read());
        pendingRead = undefined;
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
  return carryResponseToolOwnership(response, new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  }));
}

function failedTerminalResponse(
  response: Response,
  terminalPayload: Record<string, unknown>,
  logCtx: RequestLogContext,
): Response {
  const nested = terminalPayload.response;
  const terminalResponse = nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : terminalPayload;
  const nestedError = (nested as Record<string, unknown> | undefined)?.error;
  const topLevelError = terminalPayload.error;
  const error = nestedError && typeof nestedError === "object" && !Array.isArray(nestedError)
    ? nestedError as Record<string, unknown>
    : topLevelError && typeof topLevelError === "object" && !Array.isArray(topLevelError)
      ? topLevelError as Record<string, unknown>
    : isOpenRouterOpaque400Record(terminalPayload)
      ? {
        message: terminalPayload.message,
        code: terminalPayload.code,
        metadata: terminalPayload.metadata,
      }
    : {
      // A caller-validated flat error can carry its identity beside type:error.
      // Retain it when that caller established a 400, rather than discarding the
      // rejection code before the single-shot opaque-state recovery sees it.
      type: terminalPayload.type === "error" && logCtx.terminalHttpStatus === 400
        ? "invalid_request_error" : "upstream_error",
      code: terminalPayload.type === "error" && logCtx.terminalHttpStatus === 400
        ? (typeof terminalPayload.code === "string"
            ? terminalPayload.code
            : typeof terminalPayload.code === "number" && Number.isFinite(terminalPayload.code)
              ? String(terminalPayload.code)
              : null)
        : ((terminalPayload.type === "response.incomplete" || terminalPayload.status === "incomplete")
          && (terminalResponse.incomplete_details as { reason?: unknown } | undefined)?.reason === "max_output_tokens"
            ? "zero_output_token_limit" : "upstream_server_error"),
      message: typeof terminalPayload.message === "string"
        ? terminalPayload.message
        : ((terminalPayload.type === "response.incomplete" || terminalPayload.status === "incomplete")
          && (terminalResponse.incomplete_details as { reason?: unknown } | undefined)?.reason === "max_output_tokens"
            ? "Provider reached its output token limit before producing output"
            : logCtx.upstreamError ?? "Provider stream failed before producing output"),
    };
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  headers.delete("content-encoding");
  const usage = terminalResponse.usage;
  return new Response(JSON.stringify({
    error,
    ...(typeof terminalPayload.detail === "string" ? { detail: terminalPayload.detail } : {}),
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
  | { kind: "failed"; response: Response; codexModelRefusal?: CodexAccountModelRefusal }
  /**
   * The body errored mid-stream and `replayReadErrors` asked for the prefix back rather than
   * a rethrow. `stage` is how far the inspection actually got; whether that permits a
   * replacement is the resend gate's decision, not this function's. Callers that only act on
   * a projected terminal can treat this exactly as `accepted`, which is what it was before
   * the stage became observable.
   */
  | { kind: "read-error"; response: Response; error: unknown; stage: RequestFailureStage };

/**
 * Buffer a Responses SSE only until the request becomes unsafe to replay or reaches a
 * terminal. Combo failover and native post-header reset recovery share this protocol
 * boundary, because they are asking the same question about the same bytes. This owns exactly
 * one body reader. The aggregate buffer is capped by bytes and retained chunks; hitting either
 * cap commits the current target instead of growing memory or guessing that replay is safe.
 */
export async function preflightComboStreamResponse(
  response: Response,
  logCtx: RequestLogContext,
  retryableTerminal?: (payload: unknown) => boolean,
  options?: {
    allowMissingContentType?: boolean;
    replayReadErrors?: boolean;
    requiredToolPrelude?: boolean;
    signal?: AbortSignal;
  },
): Promise<ComboStreamPreflightResult> {
  const retryableTerminalFor = retryableTerminal ?? ((payload: unknown) => retryableZeroOutputTerminal(payload, logCtx));
  const contentType = response.headers.get("content-type");
  const isEventStream = hasResponseMediaType(response.headers, "text/event-stream")
    || (!contentType && options?.allowMissingContentType === true);
  if (!response.ok || !response.body) {
    return { kind: "accepted", response };
  }
  if (!isEventStream) {
    return { kind: "accepted", response };
  }

  const reader = response.body.getReader();
  const cancelRead = () => { reader.cancel(options?.signal?.reason).catch(() => undefined); };
  if (options?.signal?.aborted) cancelRead();
  else options?.signal?.addEventListener("abort", cancelRead, { once: true });
  const buffered: Uint8Array[] = [];
  let bufferedBytes = 0;
  let outputCommitted = false;
  let responseCreated = false;
  let terminalStatus: ResponsesTerminalStatus | undefined;
  let retryableTerminalPayload: Record<string, unknown> | undefined;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let holdDeadline: Promise<"hold-expired"> | undefined;
  const inspector = createSseInspector({
    logCtx,
    // A payload the inspector could not parse still reached this proxy, and it may be output.
    // Committing on it is what keeps an unreadable frame from reading as an empty prelude.
    onOpaquePayload: () => { outputCommitted = true; },
    onParsedPayload: payload => {
      if (terminalStatus !== undefined || outputCommitted || retryableTerminalPayload) return;
      if (payload !== null && typeof payload === "object" && !Array.isArray(payload)
        && (payload as { type?: unknown }).type === "response.created") responseCreated = true;
      const retryable = retryableTerminalFor(payload);
      const matchedBareError = retryable && payload !== null && typeof payload === "object"
        && !Array.isArray(payload) && (payload as { type?: unknown }).type === "error";
      // A zero-output bare error is terminal evidence. Explicit client errors stay
      // committed; unknown and retryable upstream failures may advance the combo.
      const heldReasoning = options?.requiredToolPrelude && requiredToolReasoningPrelude(payload);
      if (heldReasoning) holdDeadline ??= new Promise(resolve => {
        holdTimer = setTimeout(() => resolve("hold-expired"), COMBO_REQUIRED_TOOL_REASONING_HOLD_MS);
      });
      if (comboStreamPayloadCommitsOutput(payload) && !matchedBareError && !heldReasoning) outputCommitted = true;
      if (options?.requiredToolPrelude && payload && typeof payload === "object") {
        const event = payload as { type?: unknown; response?: { output?: unknown; error?: { code?: unknown; retryable?: unknown } } };
        const output = event.response?.output;
        const contractFailure = event.type === "response.failed" && event.response?.error?.code === REQUIRED_TOOL_CONTRACT_CODE
          && event.response.error.retryable !== false && Array.isArray(output) && output.every(item =>
            item !== null && typeof item === "object" && !Array.isArray(item)
            && ["message", "reasoning"].includes((item as { type: string }).type));
        // Other lifecycle/terminal snapshots can hide effects too. Only our checked contract
        // failure may discard a terminal-only text snapshot that was held in its entirety.
        if (output !== undefined && (!Array.isArray(output) || output.length > 0) && !contractFailure) outputCommitted = true;
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
      if (retryable) retryableTerminalPayload = payload as Record<string, unknown>;
    },
    onTerminal: status => { terminalStatus = status; },
  });

  try {
    for (;;) {
      options?.signal?.throwIfAborted();
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        const pendingRead = reader.read();
        const observed = await (holdDeadline ? Promise.race([pendingRead, holdDeadline]) : pendingRead);
        options?.signal?.throwIfAborted();
        if (observed === "hold-expired") {
          // Expiry commits this child. Hand the in-flight read to the relay so its
          // eventual chunk/error is delivered exactly once, never lost to the race.
          return { kind: "accepted", response: replayBufferedResponse(response, reader, buffered, pendingRead) };
        }
        next = observed;
      } catch (error) {
        if (!options?.replayReadErrors) throw error;
        // The native relay still owns post-header transport failures. Preserve
        // the bounded prefix and the errored reader; cancelling it here would
        // erase the failure before either client relay or inspection sees it.
        const replay = replayBufferedResponse(response, reader, buffered);
        const stage = observedResponsesStage({ outputCommitted, terminalStatus, responseCreated });
        return { kind: "read-error", response: replay, error, stage };
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
        const failed = failedTerminalResponse(response, retryableTerminalPayload, logCtx);
        return { kind: "failed", response: failed,
          ...(failed.status === 400
            ? { codexModelRefusal: terminalModelRefusal(failed.status, retryableTerminalPayload) } : {}) };
      }
      if (next.done || terminalStatus !== undefined || outputCommitted
        || bufferedBytes >= COMBO_STREAM_PREFLIGHT_MAX_BYTES
        || buffered.length >= COMBO_STREAM_PREFLIGHT_MAX_CHUNKS) {
        return { kind: "accepted", response: replayBufferedResponse(response, reader, buffered) };
      }
    }
  } finally {
    if (holdTimer !== undefined) clearTimeout(holdTimer);
    options?.signal?.removeEventListener("abort", cancelRead);
    inspector.dispose();
  }
}

/** Produce a replacement body for a mid-stream failure at `stage`, or null to keep the error. */
export type ProtocolSafeResetRecovery = (
  error: unknown,
  stage: RequestFailureStage,
) => Promise<Response | null>;

/**
 * Defer protocol inspection until the downstream actually pulls the body.
 *
 * Direct passthrough must return response headers before the first SSE event arrives, so the
 * inspection cannot be awaited at the dispatch site the way combo routing awaits it. Wrapping
 * the body moves it to the first pull, which is the earliest moment the client is willing to
 * wait anyway.
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
    if (preflight.kind === "read-error") {
      const replacement = await recover(preflight.error, preflight.stage);
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
      } else if (initialization === undefined) {
        // Nothing has read the upstream yet, so this body is still ours to cancel.
        cancelBody(response.body, reason);
      }
      // A cancel while the preflight is mid-flight falls through deliberately. That body is
      // locked by the preflight's own reader, so cancelling it here would reject and be
      // swallowed; `initialize` sees `closed` when it settles and releases whichever body it
      // ended up selecting, which is the one that actually has to be let go.
    },
  }, { highWaterMark: 0 });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
