import { codexAccountModelRefusal, codexAccountModelRefusalPayload, hasConflictingCodexModelRefusalEnvelopes, type CodexAccountModelRefusal } from "../../combos/failover";
import type { ResponsesTerminalStatus } from "../../bridge";
import { comboFailureDecision } from "../../combos";
import { httpStatusFromTerminalError } from "../../lib/errors";
import { hasResponseMediaType } from "../../lib/http-response-semantics";
import type { RequestFailureStage } from "../../lib/request-failure-model";
import type { RequestLogContext } from "../request-log";
import { carryResponseToolOwnership } from "./response-tool-ownership";
import { createSseInspector } from "../relay";
import { sseDataPayload } from "../sse-payload-rewrite";
import { MAX_CLIENT_SSE_FRAME_BYTES } from "../sse-frame-buffer";
import { REQUIRED_TOOL_CONTRACT_CODE } from "../../lib/errors";
import { requiredToolReasoningPrelude } from "./combo-required-tool-stream";
import { ProtocolPreOutputEof } from "../../lib/upstream-retry";

const COMBO_STREAM_PREFLIGHT_MAX_BYTES = MAX_CLIENT_SSE_FRAME_BYTES;
// Required-tool reasoning may delay delivery, but never for an unbounded/trickling prelude.
const COMBO_REQUIRED_TOOL_REASONING_HOLD_MS = 1_000;
const RESET_PREFLIGHT_HEARTBEAT_MS = 15_000;
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

const PRE_OUTPUT_EVENT_FIELDS = new Set([
  "type", "response", "sequence_number", "replayUnsafe", "error", "last_error",
  "incomplete_details", "status", "output", "item", "delta", "content", "message", "code",
]);

// These are response identity and request-configuration fields, not output carriers.
// Unknown snapshot extensions commit the original instead of guessing whether they hide output.
const PRE_OUTPUT_SNAPSHOT_FIELDS = new Set([
  "id", "object", "created_at", "completed_at", "status", "model", "output", "error", "last_error",
  "incomplete_details", "usage", "background", "instructions", "max_output_tokens", "max_tool_calls",
  "metadata", "parallel_tool_calls", "previous_response_id", "prompt", "prompt_cache_key",
  "prompt_cache_retention", "reasoning", "safety_identifier", "service_tier", "store", "temperature",
  "text", "tool_choice", "tools", "top_p", "top_logprobs", "truncation", "user", "end_turn", "replayUnsafe",
]);

const PRE_OUTPUT_STRING_FIELDS = [
  "id", "object", "model", "prompt_cache_key", "prompt_cache_retention", "safety_identifier",
  "service_tier", "truncation", "user",
] as const;
const PRE_OUTPUT_NUMBER_FIELDS = ["created_at", "max_output_tokens", "max_tool_calls", "temperature", "top_p", "top_logprobs"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recordWithOnly(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).every(key => fields.includes(key));
}

function safeSnapshotTools(value: unknown, budget: { remaining: number }, depth = 0): boolean {
  if (!Array.isArray(value) || depth > 4) return false;
  return value.every(tool => {
    if (--budget.remaining < 0 || !isRecord(tool)) return false;
    if (tool.type === "function") {
      return recordWithOnly(tool, ["type", "name", "description", "parameters", "strict"])
        && typeof tool.name === "string"
        && (tool.description == null || typeof tool.description === "string")
        && (tool.parameters == null || isRecord(tool.parameters))
        && (tool.strict == null || typeof tool.strict === "boolean");
    }
    if (tool.type === "custom") {
      if (!recordWithOnly(tool, ["type", "name", "description", "format"])
        || typeof tool.name !== "string"
        || (tool.description != null && typeof tool.description !== "string")) return false;
      if (tool.format == null) return true;
      return recordWithOnly(tool.format, ["type", "syntax", "definition"])
        && (tool.format.type === "text" || tool.format.type === "grammar")
        && (tool.format.syntax == null || typeof tool.format.syntax === "string")
        && (tool.format.definition == null || typeof tool.format.definition === "string");
    }
    if (tool.type === "tool_search") {
      return recordWithOnly(tool, ["type", "execution", "description"])
        && tool.execution === "client" && (tool.description == null || typeof tool.description === "string");
    }
    return tool.type === "namespace" && recordWithOnly(tool, ["type", "name", "description", "tools"])
      && typeof tool.name === "string" && (tool.description == null || typeof tool.description === "string")
      && safeSnapshotTools(tool.tools, budget, depth + 1);
  });
}

function safeSnapshotUsage(value: unknown): boolean {
  if (!recordWithOnly(value, ["input_tokens", "output_tokens", "total_tokens", "input_tokens_details", "output_tokens_details"])) return false;
  for (const key of ["input_tokens", "output_tokens", "total_tokens"]) {
    if (value[key] != null && !(typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] >= 0)) return false;
  }
  for (const [key, fields] of [
    ["input_tokens_details", ["cached_tokens"]],
    ["output_tokens_details", ["reasoning_tokens"]],
  ] as const) {
    const detail = value[key];
    if (detail != null && (!recordWithOnly(detail, fields)
      || Object.values(detail).some(count => !(typeof count === "number" && Number.isFinite(count) && count >= 0)))) return false;
  }
  return true;
}

function snapshotMetadataIsSafe(snapshot: Record<string, unknown>): boolean {
  if (PRE_OUTPUT_STRING_FIELDS.some(key => snapshot[key] != null && typeof snapshot[key] !== "string")) return false;
  if (snapshot.object != null && snapshot.object !== "response") return false;
  if (PRE_OUTPUT_NUMBER_FIELDS.some(key => snapshot[key] != null
    && !(typeof snapshot[key] === "number" && Number.isFinite(snapshot[key])))) return false;
  if (snapshot.parallel_tool_calls != null && typeof snapshot.parallel_tool_calls !== "boolean") return false;
  if (snapshot.tools != null && !safeSnapshotTools(snapshot.tools, { remaining: 4096 })) return false;
  if (snapshot.instructions != null && typeof snapshot.instructions !== "string") return false;
  if (snapshot.prompt != null) {
    if (!recordWithOnly(snapshot.prompt, ["id", "version", "variables"])
      || typeof snapshot.prompt.id !== "string"
      || (snapshot.prompt.version != null && typeof snapshot.prompt.version !== "string")
      || (snapshot.prompt.variables != null && (!isRecord(snapshot.prompt.variables)
        || Object.values(snapshot.prompt.variables).some(value => typeof value !== "string")))) return false;
  }
  if (typeof snapshot.tool_choice === "string" && !["none", "auto", "required"].includes(snapshot.tool_choice)) return false;
  if (snapshot.tool_choice != null && typeof snapshot.tool_choice !== "string") {
    if (!recordWithOnly(snapshot.tool_choice, ["type", "name", "namespace", "function"])
      || !["function", "custom", "tool_search"].includes(String(snapshot.tool_choice.type))
      || (snapshot.tool_choice.name != null && typeof snapshot.tool_choice.name !== "string")
      || (snapshot.tool_choice.namespace != null && typeof snapshot.tool_choice.namespace !== "string")) return false;
    const selected = snapshot.tool_choice.function;
    if (selected != null && (!recordWithOnly(selected, ["name"]) || typeof selected.name !== "string")) return false;
  }
  if (snapshot.usage != null && !safeSnapshotUsage(snapshot.usage)) return false;
  if (snapshot.metadata != null && (!isRecord(snapshot.metadata)
    || Object.values(snapshot.metadata).some(value => typeof value !== "string"))) return false;
  if (snapshot.reasoning != null) {
    if (!recordWithOnly(snapshot.reasoning, ["effort", "summary", "generate_summary"])
      || Object.values(snapshot.reasoning).some(value => value != null && typeof value !== "string")) return false;
    if (snapshot.reasoning.effort != null
      && !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(snapshot.reasoning.effort))) return false;
    if ([snapshot.reasoning.summary, snapshot.reasoning.generate_summary].some(value => value != null
      && !["auto", "concise", "detailed"].includes(String(value)))) return false;
  }
  if (snapshot.text != null) {
    if (!recordWithOnly(snapshot.text, ["format", "verbosity"])
      || (snapshot.text.verbosity != null && typeof snapshot.text.verbosity !== "string")) return false;
    const format = snapshot.text.format;
    if (format != null && (!recordWithOnly(format, ["type", "name", "description", "schema", "strict"])
      || !["text", "json_object", "json_schema"].includes(String(format.type))
      || (format.name != null && typeof format.name !== "string")
      || (format.description != null && typeof format.description !== "string")
      || (format.schema != null && !isRecord(format.schema))
      || (format.strict != null && typeof format.strict !== "boolean"))) return false;
  }
  return true;
}

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

// SSE uses the last event field, with an empty value resetting it to the default.
// A mismatched or unreadable frame is not a proven lifecycle prelude.
function ambiguousSseFrame(frame: string): boolean {
  let event: string | undefined;
  let hasNonComment = false;
  for (const line of frame.split(/\r\n|\r|\n/)) {
    if (!line || line.startsWith(":")) continue;
    hasNonComment = true;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    if (field === "event") {
      const value = colon < 0 ? "" : line.slice(colon + 1);
      event = value.startsWith(" ") ? value.slice(1) : value;
    }
  }
  const data = sseDataPayload(frame);
  if (data === null || data === "") return hasNonComment;
  if (!event) return false;
  try {
    const payload: unknown = JSON.parse(data);
    return !payload || typeof payload !== "object" || Array.isArray(payload)
      || (payload as { type?: unknown }).type !== event;
  } catch {
    return true;
  }
}

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
  return comboFailureDecision(status, message, {
    code, codexModelRefusal: terminalModelRefusal(status, event),
  }) === "hop";
}

function retryableZeroOutputTerminal(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const event = payload as {
    type?: unknown;
    response?: { incomplete_details?: { reason?: unknown }; output?: unknown };
  };
  if (bareErrorIsRetryable(event)) return true;
  if (event.type === "response.failed") {
    const error = (event.response as { error?: { code?: unknown; retryable?: unknown } } | undefined)?.error;
    const code = error?.code;
    if (code === REQUIRED_TOOL_CONTRACT_CODE && error?.retryable === false) return false;
    return !(typeof code === "string" && NON_REPLAYABLE_FAILED_CODES.has(code));
  }
  if (event.type !== "response.incomplete") return false;
  const reason = event.response?.incomplete_details?.reason;
  // A terminal-only upstream can carry output without preceding delta/item events.
  if (reason === undefined) return !Array.isArray(event.response?.output) || event.response.output.length === 0;
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
  if (PRE_OUTPUT_CONTROL_EVENTS.has(type)) {
    // Lifecycle snapshots may already carry output or an error. Neither can be discarded
    // for a replacement, even if the event name otherwise describes only a prelude.
    const event = payload as Record<string, unknown>;
    const conflictingStatus = (status: unknown) => status != null && status !== "queued" && status !== "in_progress";
    if (Object.keys(event).some(key => !PRE_OUTPUT_EVENT_FIELDS.has(key))) return true;
    if (Object.hasOwn(event, "replayUnsafe") && event.replayUnsafe !== false) return true;
    if (event.sequence_number !== undefined && !(typeof event.sequence_number === "number"
      && Number.isSafeInteger(event.sequence_number) && event.sequence_number >= 0)) return true;
    if (event.error != null || event.last_error != null || event.incomplete_details != null
      || event.item != null || event.delta != null || event.content != null
      || event.message != null || event.code != null || conflictingStatus(event.status)) return true;
    if (event.output !== undefined && (!Array.isArray(event.output) || event.output.length > 0)) return true;
    const response = event.response;
    if (response != null && (typeof response !== "object" || Array.isArray(response))) return true;
    if (response && typeof response === "object" && !Array.isArray(response)) {
      const snapshot = response as Record<string, unknown>;
      if (Object.keys(snapshot).some(key => !PRE_OUTPUT_SNAPSHOT_FIELDS.has(key))) return true;
      if (!snapshotMetadataIsSafe(snapshot)) return true;
      if (snapshot.output !== undefined && (!Array.isArray(snapshot.output) || snapshot.output.length > 0)) return true;
      if (Object.hasOwn(snapshot, "replayUnsafe") && snapshot.replayUnsafe !== false) return true;
      if (snapshot.error != null || snapshot.last_error != null || snapshot.incomplete_details != null
        || conflictingStatus(snapshot.status)) return true;
      if (snapshot.completed_at != null || (snapshot.end_turn != null && snapshot.end_turn !== false)
        || (snapshot.background != null && snapshot.background !== false)
        || (snapshot.store != null && snapshot.store !== false) || snapshot.previous_response_id != null) return true;
    }
  }
  return !PRE_OUTPUT_CONTROL_EVENTS.has(type) && !TERMINAL_EVENTS.has(type);
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
    : {};
  const nestedError = terminalResponse.error;
  const topLevelError = terminalPayload.error;
  const error = nestedError && typeof nestedError === "object" && !Array.isArray(nestedError)
    ? nestedError as Record<string, unknown>
    : topLevelError && typeof topLevelError === "object" && !Array.isArray(topLevelError)
      ? topLevelError as Record<string, unknown>
    : {
      // A caller-validated flat error can carry its identity beside type:error.
      // Retain it when that caller established a 400, rather than discarding the
      // rejection code before the single-shot opaque-state recovery sees it.
      type: terminalPayload.type === "error" && logCtx.terminalHttpStatus === 400
        ? "invalid_request_error" : "upstream_error",
      code: terminalPayload.type === "error" && logCtx.terminalHttpStatus === 400
        ? (typeof terminalPayload.code === "string" ? terminalPayload.code : null) : "upstream_server_error",
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
  | { kind: "failed"; response: Response; codexModelRefusal?: CodexAccountModelRefusal }
  /**
   * The body errored mid-stream and `replayReadErrors` asked for the prefix back rather than
   * a rethrow. `stage` is how far the inspection actually got; whether that permits a
   * replacement is the resend gate's decision, not this function's. Callers that only act on
   * a projected terminal can treat this exactly as `accepted`, which is what it was before
   * the stage became observable.
   */
  | { kind: "read-error"; response: Response; error: unknown; stage: RequestFailureStage }
  /** A clean EOF after control frames, retained for an explicitly opted-in recovery owner. */
  | { kind: "pre-output-eof"; response: Response; error: ProtocolPreOutputEof; stage: RequestFailureStage };

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
  retryableTerminal: (payload: unknown) => boolean = retryableZeroOutputTerminal,
  options?: { allowMissingContentType?: boolean; replayReadErrors?: boolean; replayCleanEof?: boolean; requiredToolPrelude?: boolean; signal?: AbortSignal; onUpstreamActivity?: () => void },
): Promise<ComboStreamPreflightResult> {
  const contentType = response.headers.get("content-type");
  const isEventStream = hasResponseMediaType(response.headers, "text/event-stream")
    || (!contentType && options?.allowMissingContentType === true);
  if (!response.ok || !response.body || !isEventStream) {
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
    onFrame: frame => {
      if (terminalStatus === undefined && !outputCommitted && !retryableTerminalPayload
        && ambiguousSseFrame(frame)) outputCommitted = true;
    },
    // A payload the inspector could not parse still reached this proxy, and it may be output.
    // Committing on it is what keeps an unreadable frame from reading as an empty prelude.
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
        // A rejected read can leave an output, terminal or opaque frame buffered
        // in the inspector. Flush it before deciding whether recovery is safe.
        inspector.finish();
        // The native relay still owns post-header transport failures. Preserve
        // the bounded prefix and the errored reader; cancelling it here would
        // erase the failure before either client relay or inspection sees it.
        const replay = replayBufferedResponse(response, reader, buffered);
        if (outputCommitted || terminalStatus !== undefined || retryableTerminalPayload) {
          return { kind: "accepted", response: replay };
        }
        const stage = observedResponsesStage({ outputCommitted, terminalStatus, responseCreated });
        return { kind: "read-error", response: replay, error, stage };
      }
      if (next.done) {
        inspector.finish();
        if (options?.replayCleanEof && !outputCommitted && terminalStatus === undefined) {
          return {
            kind: "pre-output-eof",
            response: replayBufferedResponse(response, reader, buffered),
            error: new ProtocolPreOutputEof(),
            stage: observedResponsesStage({ outputCommitted, terminalStatus, responseCreated }),
          };
        }
      } else {
        if (next.value.byteLength > 0) options?.onUpstreamActivity?.();
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
  signal: AbortSignal,
  /** Whether the selection can still publish this candidate; it narrows once a head is committed. */
  accepts: (candidate: Response) => boolean,
) => Promise<Response | null>;

/** A deferred body cannot change the response head already returned to its caller. */
export function sameDeferredResponseMetadata(original: Response, replacement: Response): boolean {
  if (original.status !== replacement.status || original.statusText !== replacement.statusText) return false;
  const first = original.headers.entries();
  const second = replacement.headers.entries();
  for (;;) {
    const a = first.next();
    const b = second.next();
    if (a.done || b.done) return a.done === b.done;
    if (a.value[0] !== b.value[0] || a.value[1] !== b.value[1]) return false;
  }
}

export interface DeferredResetRecoveryOptions {
  allowMissingContentType?: boolean;
  heartbeatIntervalMs?: number;
  /**
   * `periodic` comments a waiting client once per heartbeat. `upstream-activity` comments only when
   * the upstream reads non-empty bytes or a replacement head lands behind a committed head, for a
   * consumer whose silence clock sees only delivered bytes; its owner still bounds real silence.
   */
  keepalive?: "periodic" | "upstream-activity" | "none";
}

/** Which physical attempt produced the head a reset selection published. */
export type ResetSelectionOwner = "original" | "replacement";

export interface ResetSelectionOptions extends DeferredResetRecoveryOptions {
  /** Upper bound on the pre-head wait. The wait never exceeds one heartbeat interval either. */
  maxSelectionMs?: number;
  /**
   * Upper bound on how long the original's own inspection may hold the head. When it expires
   * before the original settles, the original head is committed and inspection continues behind
   * it. A replacement requested after the original failed inside this window is still bounded by
   * `maxSelectionMs`, because no healthy source is waiting behind that head.
   */
  inspectionWindowMs?: number;
  /** Ends the selection, the committed hold and an in-flight replacement without awaiting cleanup. */
  signal?: AbortSignal;
  /** Called once, synchronously, before the caller receives the published response. */
  onCommit?: (published: Response, owner: ResetSelectionOwner) => void;
}

const positiveMs = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;

// A fresh chunk per enqueue: a consumer may transfer the buffer it receives.
const resetPreflightKeepalive = (): Uint8Array => new TextEncoder().encode(": keepalive\n\n");

/**
 * One protocol preflight and at most one replacement for a native SSE body, behind a head that is
 * either still open (`early`) or already committed. While the head is open, any replacement the
 * caller's recovery accepts can be published with its own status and headers. Once a head is
 * committed, a replacement must match it exactly, and the original keeps its bytes and error.
 */
function createResetSelection(
  response: Response,
  logCtx: RequestLogContext,
  recover: ProtocolSafeResetRecovery,
  options: ResetSelectionOptions | undefined,
  early: boolean,
): { held: Response; selected?: Promise<Response> } {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let selection: { response: Response; owner: ResetSelectionOwner } | undefined;
  let initialization: Promise<void> | undefined;
  let initializationResult: { kind: "ready" } | { kind: "failed"; error: unknown } | undefined;
  let notifyInitialization: (() => void) | undefined;
  let commitEarly: ((published: Response, owner: ResetSelectionOwner) => void) | undefined;
  let inspectionTimer: ReturnType<typeof setTimeout> | undefined;
  const endInspectionWindow = (): void => {
    if (inspectionTimer !== undefined) clearTimeout(inspectionTimer);
    inspectionTimer = undefined;
  };
  let activityPending = false;
  // A replacement head behind a committed head is upstream activity the held stream must report.
  let replacementHeadPending = false;
  let heartbeatDue = false;
  let closed = false;
  let headCommitted = !early;
  let output!: ReadableStreamDefaultController<Uint8Array>;
  const preflightAbort = new AbortController();
  const heartbeatMs = positiveMs(options?.heartbeatIntervalMs) ?? RESET_PREFLIGHT_HEARTBEAT_MS;
  const keepalive = options?.keepalive ?? "periodic";
  const signal = options?.signal;
  const accepts = (candidate: Response): boolean => !headCommitted || sameDeferredResponseMetadata(response, candidate);

  const cancelBody = (body: ReadableStream<Uint8Array> | null, reason?: unknown): void => {
    try { void body?.cancel(reason).catch(() => {}); } catch { /* already locked or closed */ }
  };
  const initialize = async (): Promise<void> => {
    const preflight = await preflightComboStreamResponse(
      response,
      logCtx,
      () => false,
      { allowMissingContentType: options?.allowMissingContentType === true, replayReadErrors: true,
        replayCleanEof: true, signal: preflightAbort.signal,
        onUpstreamActivity: keepalive === "upstream-activity" ? () => {
          activityPending = true;
          notifyInitialization?.();
        } : undefined },
    );
    // The original settled, so it no longer holds the head; only a replacement can from here.
    endInspectionWindow();
    let chosen: { response: Response; owner: ResetSelectionOwner } = { response: preflight.response, owner: "original" };
    if (!closed && (preflight.kind === "read-error" || preflight.kind === "pre-output-eof")) {
      const replacement = await recover(preflight.error, preflight.stage, preflightAbort.signal, accepts);
      if (replacement) {
        // Checked again here: the head may have been committed while the replacement was in flight.
        if (!closed && accepts(replacement)) {
          cancelBody(chosen.response.body, "using protocol-safe replacement stream");
          chosen = { response: replacement, owner: "replacement" };
          replacementHeadPending = headCommitted && keepalive === "upstream-activity";
        } else {
          cancelBody(replacement.body, "declining protocol-safe replacement stream");
          if (!closed) console.warn("[upstream-retry] replacement response metadata differs from the committed head; preserving original stream");
        }
      }
    }
    if (closed) {
      cancelBody(chosen.response.body, "downstream cancelled before protocol preflight completed");
      return;
    }
    selection = chosen;
  };
  const start = (): Promise<void> => initialization ??= initialize().then(
    () => { initializationResult = { kind: "ready" }; notifyInitialization?.(); },
    error => { initializationResult = { kind: "failed", error }; notifyInitialization?.(); },
  );
  const detach = (): void => signal?.removeEventListener("abort", onAbort);
  const release = (reason: unknown): boolean => {
    if (closed) return false;
    closed = true;
    detach();
    preflightAbort.abort(reason);
    notifyInitialization?.();
    if (reader) {
      try { void reader.cancel(reason).catch(() => {}); } catch { /* already closed */ }
      try { reader.releaseLock(); } catch { /* already released */ }
      reader = undefined;
    } else if (selection) {
      cancelBody(selection.response.body, reason);
    } else if (initialization === undefined) {
      // Nothing has read the upstream yet, so this body is still ours to cancel.
      cancelBody(response.body, reason);
    }
    // Otherwise aborting cancels the preflight's locked reader or the in-flight replacement, and
    // initialization releases whichever body it ends up choosing. Nothing here awaits cleanup.
    return true;
  };
  function onAbort(): void {
    const reason = signal?.reason;
    if (release(reason)) {
      try { output.error(reason); } catch { /* already closed */ }
    }
    commitEarly?.(held, "original");
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) { output = controller; },
    async pull(controller) {
      try {
        void start();
        // Keep only one waiter on the initialization; racing it afresh for every heartbeat
        // would retain one promise callback per interval until a quiet upstream settles.
        if (initializationResult === undefined && !heartbeatDue && !(keepalive === "upstream-activity" && activityPending)) {
          await new Promise<void>(resolve => {
            const timer = keepalive === "periodic"
              ? setTimeout(() => { notifyInitialization = undefined; resolve(); }, heartbeatMs)
              : undefined;
            notifyInitialization = () => { if (timer !== undefined) clearTimeout(timer); notifyInitialization = undefined; resolve(); };
          });
        }
        if (closed) return;
        if (initializationResult === undefined) {
          activityPending = false;
          heartbeatDue = false;
          controller.enqueue(resetPreflightKeepalive());
          return;
        }
        if (initializationResult.kind === "failed") throw initializationResult.error;
        if (replacementHeadPending) {
          // A buffered consumer's silence clock sees only delivered bytes. Without this, a quiet
          // replacement would inherit the original's last activity and be cut short.
          replacementHeadPending = false;
          controller.enqueue(resetPreflightKeepalive());
          return;
        }
        reader ??= selection?.response.body?.getReader();
        if (!reader) {
          closed = true;
          detach();
          controller.close();
          return;
        }
        const next = await reader.read();
        if (closed) return;
        if (next.done) {
          closed = true;
          detach();
          try { reader.releaseLock(); } catch { /* already released */ }
          reader = undefined;
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        if (closed) return;
        closed = true;
        detach();
        try { reader?.releaseLock(); } catch { /* errored reader */ }
        reader = undefined;
        controller.error(error);
      }
    },
    cancel(reason) {
      release(reason);
    },
  }, { highWaterMark: 0 });
  const held = carryResponseToolOwnership(response, new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  }));

  if (!early) {
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    return { held };
  }
  const selected = new Promise<Response>(resolve => {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    commitEarly = (published, owner) => {
      commitEarly = undefined;
      headCommitted = true;
      if (deadline !== undefined) clearTimeout(deadline);
      endInspectionWindow();
      // A published selection owns its own body; the hold and its abort hook are finished.
      if (published !== held) detach();
      try { options?.onCommit?.(published, owner); } finally { resolve(published); }
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    const deadlineMs = Math.min(heartbeatMs, positiveMs(options?.maxSelectionMs) ?? Infinity);
    deadline = setTimeout(() => {
      // The client has waited one heartbeat interval for a head; its first read gets a keepalive.
      if (keepalive === "periodic") heartbeatDue = true;
      commitEarly?.(held, "original");
    }, deadlineMs);
    const inspectionMs = positiveMs(options?.inspectionWindowMs);
    // A quiet original is a healthy slow response as often as a dying one; its head goes out now.
    // Bun's server writes a head only with the first body bytes, so the held body owes a comment.
    if (inspectionMs !== undefined && inspectionMs < deadlineMs) {
      inspectionTimer = setTimeout(() => {
        inspectionTimer = undefined;
        if (keepalive === "periodic") heartbeatDue = true;
        commitEarly?.(held, "original");
      }, inspectionMs);
    }
    void start().then(() => {
      if (selection && !closed) commitEarly?.(selection.response, selection.owner);
      else commitEarly?.(held, "original");
    });
  });
  return { held, selected };
}

/**
 * Defer protocol inspection behind a head the caller has already committed.
 *
 * The inspection starts at the first pull. A replacement is published only when its status and
 * headers match the committed head exactly.
 */
export function deferProtocolSafeResetRecovery(
  response: Response,
  logCtx: RequestLogContext,
  recover: ProtocolSafeResetRecovery,
  options?: DeferredResetRecoveryOptions,
): Response {
  if (!response.body) return response;
  return createResetSelection(response, logCtx, recover, options, false).held;
}

/**
 * Choose the native response before its head is committed, within one heartbeat interval or the
 * shorter `inspectionWindowMs` while the original itself is still being inspected.
 *
 * Inspection starts immediately. If selection finishes first, the caller receives the selected
 * response, a replacement included, with its own status and headers. If the deadline wins, the
 * caller receives the original head and the same preflight continues behind it, where a
 * replacement must match that head. `onCommit` names which attempt owns the published head.
 */
export function selectProtocolSafeResetResponse(
  response: Response,
  logCtx: RequestLogContext,
  recover: ProtocolSafeResetRecovery,
  options: ResetSelectionOptions = {},
): Promise<Response> {
  if (!response.body) {
    options.onCommit?.(response, "original");
    return Promise.resolve(response);
  }
  return createResetSelection(response, logCtx, recover, options, true).selected!;
}
