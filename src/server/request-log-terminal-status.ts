// Re-exported so request-log.ts reaches the Remote Link turn seam through an import it already has.
export { notifyLinkTurnFinal } from "./link-turn";
export { linkLogField, type LinkRequestLogCarrier } from "../usage/link-log-fields";
import {
  CYBER_POLICY_ERROR_CODE,
  httpStatusFromTerminalError,
  isCyberPolicyCode,
  isCyberPolicyMessage,
  isRateLimitOrQuotaFailureMessage,
  recognizedUpstreamError,
  upstreamErrorMessageFromPayload,
} from "../lib/errors";
import { redactSecretString } from "../lib/redact";
import { SENT_VALUE_GUARD_SCAN_CHARS, outboundCredentials, type OutboundCredentialRegistry } from "../lib/outbound-credential-registry";
import { configuredCredentials, containsConfiguredCredentialExcerpt, type ConfiguredCredentials } from "./configured-credentials";
import { isUntypedBareUpstreamError, reduceBareUpstreamEvidence, wrappedServerErrorStatus, type BareUpstreamError, type BareUpstreamEvidence } from "./bare-upstream-error";

/** First bounded upstream diagnostics shared by request contexts and final rows. */
export interface UpstreamErrorDiagnostics {
  upstreamErrorCode?: string;
  upstreamErrorType?: string;
  upstreamRequestId?: string;
}

interface TerminalStatusContext extends UpstreamErrorDiagnostics {
  terminalHttpStatus?: number;
  terminalErrorCode?: typeof CYBER_POLICY_ERROR_CODE;
  upstreamError?: string;
}

export interface UpstreamErrorPayload {
  type?: unknown;
  code?: unknown;
  message?: unknown;
  /** Codex WebSocket wrapper status (`status_code` is its alias); read only on bare `error` events. */
  status?: unknown;
  status_code?: unknown;
  error?: { type?: unknown; code?: unknown; message?: unknown };
  last_error?: { type?: unknown; code?: unknown; message?: unknown };
  response?: {
    error?: { type?: unknown; code?: unknown; message?: unknown };
    incomplete_details?: { code?: unknown; message?: unknown; reason?: unknown };
  };
}

// Bare error evidence is provisional: only a genuine terminal owns account-health status.
const provisionalStatuses = new WeakMap<TerminalStatusContext, number>();
const genuineTerminals = new WeakSet<TerminalStatusContext>();
// The winning bare verdict owns the row's status, refusal identity and diagnostic copy together,
// so a later losing frame cannot leave the status from one frame beside the copy of another.
const bareEvidence = new WeakMap<TerminalStatusContext, BareUpstreamEvidence>();

const UPSTREAM_DIAGNOSTIC_TOKEN = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * Upstream diagnostics are provider-controlled. The token alphabet alone also admits
 * credential formats (an echoed `sk-...` key fits it), so a value the shared redactor
 * would change is dropped rather than recorded, warned, or projected into log rows.
 */
function isSafeDiagnosticToken(value: unknown): value is string {
  return typeof value === "string" && UPSTREAM_DIAGNOSTIC_TOKEN.test(value) && redactSecretString(value) === value;
}

/**
 * Error classes published by the supported provider APIs (OpenAI/Responses, Anthropic, Gemini).
 * The type is diagnostic only, so the vocabulary is closed: a gateway can echo anything in
 * `error.type`, including a configured credential whose format no redactor recognizes, and a
 * value outside this set is simply not recorded, which is what 2.82.0 did for every type.
 */
const KNOWN_UPSTREAM_ERROR_TYPES: ReadonlySet<string> = new Set([
  "api_error", "authentication_error", "billing_error", "insufficient_quota", "invalid_request_error",
  "not_found_error", "overloaded_error", "permission_error", "rate_limit_error", "request_too_large",
  "requests", "server_error", "timeout_error", "tokens",
  "INVALID_ARGUMENT", "FAILED_PRECONDITION", "PERMISSION_DENIED", "UNAUTHENTICATED", "NOT_FOUND",
  "RESOURCE_EXHAUSTED", "INTERNAL", "UNAVAILABLE", "DEADLINE_EXCEEDED",
]);

/** Bare top-level error codes worth keeping: the rate-limit and overload classes recognizedUpstreamError maps, plus server_error. */
const KNOWN_BARE_ERROR_CODES: ReadonlySet<string> = new Set([
  "rate_limit_exceeded", "rate_limit_error", "server_is_overloaded", "overloaded_error", "server_error",
]);

function noteBoundedDiagnostic(
  logCtx: TerminalStatusContext,
  field: "upstreamErrorCode" | "upstreamErrorType" | "upstreamRequestId",
  value: unknown,
): void {
  if (logCtx[field] !== undefined) return;
  if (!isSafeDiagnosticToken(value)) return;
  if (field === "upstreamErrorType" && !KNOWN_UPSTREAM_ERROR_TYPES.has(value)) return;
  if (!diagnosticValueAllowed(value)) return;
  // Closed vocabulary is public; anything else is refused when it repeats a value this request sent.
  if (!isClosedDiagnosticVocabulary(field, value) && repeatsRequestSentValue(logCtx, value)) return;
  logCtx[field] = value;
  const status = logCtx.terminalHttpStatus;
  if (status === undefined || status >= 500) {
    // Service logs persist too: print only closed-vocabulary values, never an upstream id or code.
    const { upstreamErrorCode: rawCode, upstreamErrorType: type } = upstreamDiagnosticLogFields(logCtx);
    const code = rawCode !== undefined && KNOWN_BARE_ERROR_CODES.has(rawCode) ? rawCode : undefined;
    console.warn(`[opencodex] upstream failure${status ? ` status=${status}` : ""}${type ? ` type=${type}` : ""}${code ? ` code=${code}` : ""}`);
  }
}

/**
 * A diagnostic must not repeat a configured credential or a credential this process sent upstream
 * (an echo). All three fields fail closed while either source cannot vouch for complete coverage:
 * a closed type vocabulary does not prove a member is not also a credential. Applied at capture,
 * again for every retained value interpolated into a warning, and at projection, because a
 * credential can be configured or sent after the value was captured.
 */
export function diagnosticValueAllowed(
  value: string,
  registry: OutboundCredentialRegistry = outboundCredentials(),
  configured: ConfiguredCredentials = configuredCredentials(),
): boolean {
  if (!registry.complete() || !configured.complete) return false;
  return !registry.matches(value) && !configured.matches(value) && !containsConfiguredCredentialExcerpt(value);
}

/**
 * Row copy taken from upstream text: pattern-redacted and bounded, or wholly redacted when it
 * repeats a configured credential or one this process sent. Every row-copy write uses it, so no
 * ordering of frames can store an echoed credential through a pattern-only path.
 */
export function guardedRowCopy(logCtx: TerminalStatusContext, text: string): string {
  const head = text.length > SENT_VALUE_GUARD_SCAN_CHARS ? text.slice(0, SENT_VALUE_GUARD_SCAN_CHARS) : text;
  return diagnosticValueAllowed(head) && !repeatsRequestSentValue(logCtx, head) ? redactSecretString(head).slice(0, 500) : "[REDACTED]";
}

/**
 * The sent-value guard of the request a row belongs to, registered by its delivery path. The global
 * registry can evict a value or miss an excerpt; this request's own headers do not.
 */
const requestSentValueGuards = new WeakMap<object, (text: string) => boolean>();

export function noteRequestSentValueGuard(logCtx: TerminalStatusContext, guard: (text: string) => boolean): void {
  requestSentValueGuards.set(logCtx, guard);
}

function repeatsRequestSentValue(logCtx: object, text: string): boolean {
  return requestSentValueGuards.get(logCtx)?.(text) === true;
}

function isClosedDiagnosticVocabulary(field: string, value: string): boolean {
  return (field === "upstreamErrorType" && KNOWN_UPSTREAM_ERROR_TYPES.has(value))
    || (field === "upstreamErrorCode" && KNOWN_BARE_ERROR_CODES.has(value));
}

export function noteUpstreamRequestId(logCtx: TerminalStatusContext, headers: Headers): void {
  noteBoundedDiagnostic(logCtx, "upstreamRequestId", headers.get("openai-request-id") ?? headers.get("x-request-id"));
}

/**
 * Exact payload texts the relay synthesized as bare-verdict tails for this request, registered by
 * the relay as it frames them (passthrough-delivery's onSyntheticTail). A client-stream reader
 * (the WebSocket log) sees those tails beside upstream frames; only a registered text is the
 * relay's own, however closely a genuine upstream terminal resembles it. Each entry matches once.
 */
const relaySyntheticTails = new WeakMap<TerminalStatusContext, Array<{ payload: string; verdict?: BareUpstreamError }>>();

/**
 * The verdict travels with its tail: the relay withholds an untyped envelope from the client, so a
 * client-stream reader sees only the tail and records the verdict it renders.
 */
export function noteRelaySyntheticTail(logCtx: TerminalStatusContext, payload: string, verdict?: BareUpstreamError): void {
  const tails = relaySyntheticTails.get(logCtx) ?? [];
  tails.push({ payload, verdict });
  if (tails.length > 4) tails.shift();
  relaySyntheticTails.set(logCtx, tails);
}

function consumeRelaySyntheticTail(logCtx: TerminalStatusContext, json: UpstreamErrorPayload): { verdict?: BareUpstreamError } | undefined {
  const tails = relaySyntheticTails.get(logCtx);
  if (!tails?.length) return undefined;
  // The relay serializes with JSON.stringify, so the parsed frame re-serializes to the same text.
  const text = JSON.stringify(json);
  const index = tails.findIndex(tail => tail.payload === text);
  if (index < 0) return undefined;
  const [tail] = tails.splice(index, 1);
  return tail;
}

/**
 * Returns false when the frame is a bare frame after a genuine terminal: it owns nothing on the
 * row, so the caller must not fall back to recording its copy either.
 */
export function captureUpstreamTerminalDiagnostics(logCtx: TerminalStatusContext, json: UpstreamErrorPayload, untypedSse = false): boolean {
  const type = json.type;
  const terminal = type === "response.completed" || type === "response.failed" || type === "response.incomplete";
  if (terminal) {
    // A genuine terminal supersedes every provisional bare verdict: it retires the evidence and
    // owns the row through the terminal classifier. Without this split the reducer's "no new
    // evidence" result would be read as "keep the previous bare verdict" and the terminal would
    // never claim the row.
    const prior = bareEvidence.get(logCtx);
    // A policy verdict is itself the turn's terminal: the client stream ended on it. A reader that
    // keeps inspecting (the metadata consumer, the WS observer) may see a later genuine terminal,
    // which owns nothing on the row, exactly like a bare frame after a genuine terminal.
    if (prior?.terminal === true) return false;
    genuineTerminals.add(logCtx);
    // A reader of the client stream (the WebSocket log) also sees the relay's own synthesized
    // response.failed. It renders the winning bare verdict, so the row keeps that verdict, and the
    // evidence stays for the final row's code, instead of inferring a different class from the
    // provider copy it carries. The relay withholds untyped envelopes from the client, so such a
    // reader may meet the tail first; it records the verdict the tail carries.
    const tail = type === "response.failed" ? consumeRelaySyntheticTail(logCtx, json) : undefined;
    // The tail's verdict is the relay's own, reduced from the provider's original frames. A reader of
    // the client stream may have seen only redacted copies of them, so the tail's verdict owns the row.
    if (tail !== undefined && tail.verdict !== undefined) {
      recordBareEvidence(logCtx, { typed: prior?.typed ?? false, verdict: tail.verdict });
      return true;
    }
    if (tail !== undefined && prior !== undefined) return true;
    bareEvidence.delete(logCtx);
    // The evidence wrote the diagnostics and the copy; the terminal that retires it owns them now,
    // so the row cannot keep a losing verdict's code or copy beside the terminal's status.
    if (prior !== undefined) {
      delete logCtx.upstreamErrorCode;
      delete logCtx.upstreamErrorType;
      delete logCtx.upstreamError;
    }
    // The classifier retires the provisional status it owns; clearing the map first would
    // hide that ownership from it and leave the stale status on the row.
    captureTerminalHttpStatus(logCtx, json);
    noteBoundedDiagnostic(logCtx, "upstreamErrorCode",
      json.error?.code ?? json.last_error?.code ?? json.response?.error?.code
        // A bare top-level code (new in 2.83.0) has no envelope contract, so only a known class is kept.
        ?? (typeof json.code === "string" && KNOWN_BARE_ERROR_CODES.has(json.code) ? json.code : undefined));
    noteBoundedDiagnostic(logCtx, "upstreamErrorType",
      json.error?.type ?? json.last_error?.type ?? json.response?.error?.type);
    return true;
  }
  // A buffered JSON body is not a stream in which a later frame could supersede an earlier one,
  // so it keeps the single-frame classifier. Only an SSE frame enters the reducer.
  if (!untypedSse) {
    captureTerminalHttpStatus(logCtx, json);
    noteBoundedDiagnostic(logCtx, "upstreamErrorCode",
      json.error?.code ?? json.last_error?.code ?? json.response?.error?.code
        // A bare top-level code (new in 2.83.0) has no envelope contract, so only a known class is kept.
        ?? (typeof json.code === "string" && KNOWN_BARE_ERROR_CODES.has(json.code) ? json.code : undefined));
    noteBoundedDiagnostic(logCtx, "upstreamErrorType",
      json.error?.type ?? json.last_error?.type ?? json.response?.error?.type);
    return true;
  }
  // The client already ended on the genuine terminal, so a bare frame after it is not the
  // turn's verdict: it may not restart evidence or touch status, code or type. Readers that
  // keep inspecting past the terminal (the WS EOF observer, the metadata consumer) reach here.
  // Its copy stays guarded as before: untyped text that fails the credential check is redacted.
  if (genuineTerminals.has(logCtx)) {
    if (logCtx.upstreamError === undefined && isUntypedBareUpstreamError(json)) {
      const message = upstreamErrorMessageFromPayload(json);
      if (typeof message === "string" && message.trim() && !diagnosticValueAllowed(message)) logCtx.upstreamError = "[REDACTED]";
    }
    return false;
  }
  const previousEvidence = bareEvidence.get(logCtx);
  const evidence = reduceBareUpstreamEvidence(previousEvidence, json);
  if (evidence === undefined || evidence === previousEvidence) return true;
  recordBareEvidence(logCtx, evidence);
  return true;
}

/** The row writes for a winning bare verdict: status, code, type and guarded copy together. */
function recordBareEvidence(logCtx: TerminalStatusContext, evidence: BareUpstreamEvidence): void {
  bareEvidence.set(logCtx, evidence);
  const previous = provisionalStatuses.get(logCtx);
  // A status set by the caller or another path is not this reducer's to overwrite; only a
  // provisional status this reducer owns is replaceable.
  const replaceable = logCtx.terminalHttpStatus === undefined
    || (provisionalStatuses.has(logCtx) && previous !== undefined && logCtx.terminalHttpStatus === previous);
  if (replaceable) {
    if (logCtx.terminalHttpStatus !== undefined) {
      delete logCtx.terminalHttpStatus;
      delete logCtx.terminalErrorCode;
    }
    // The verdict carries the status every reader uses: a recognized class its own status, an
    // explicit refusal 400, and an unrecognized class the wrapper status the upstream stated. A
    // typed frame with none of those leaves the row open, as before, so combo preflight still
    // reads its wider set of explicit event fields (`bareErrorStatus`) and the row falls back to
    // the synthetic 502 on its own; an untyped envelope keeps its provisional synthetic 502.
    const status = evidence.typed ? evidence.verdict.httpStatus : evidence.verdict.terminalStatus;
    if (status === undefined) {
      provisionalStatuses.delete(logCtx);
    } else {
      logCtx.terminalHttpStatus = status;
      provisionalStatuses.set(logCtx, status);
    }
    if (evidence.verdict.refusalCode === CYBER_POLICY_ERROR_CODE) logCtx.terminalErrorCode = CYBER_POLICY_ERROR_CODE;
    else delete logCtx.terminalErrorCode;
  }
  // The winning verdict owns the bounded diagnostics and the copy together. A losing frame may
  // not leave a code/type from one verdict beside the status and copy of another.
  delete logCtx.upstreamErrorCode;
  delete logCtx.upstreamErrorType;
  // The winning verdict's identity is the one the client tail carries, so a refusal recognized
  // from copy is recorded as that refusal rather than as the wrapper's unrelated code.
  noteBoundedDiagnostic(logCtx, "upstreamErrorCode", evidence.verdict.refusalCode ?? evidence.verdict.errorCode);
  noteBoundedDiagnostic(logCtx, "upstreamErrorType", evidence.verdict.errorType);
  // Typed and untyped copy hold the same guard: the full-text configured check and the retained text.
  if (!evidence.verdict.rowCopyAllowed || !diagnosticValueAllowed(evidence.verdict.message)
    || repeatsRequestSentValue(logCtx, evidence.verdict.message)) {
    logCtx.upstreamError = "[REDACTED]";
  } else {
    logCtx.upstreamError = evidence.verdict.message;
  }
}

/**
 * The final row's error code while a winning bare verdict owns the row and names a provider class
 * whose copy also reads like a policy refusal. The verdict already ruled that the structured class
 * outranks that copy, so the row must not reclassify the same copy as cyber_policy. Undefined
 * otherwise: every other row keeps the ordinary status-and-copy classification.
 */
export function bareVerdictRowErrorCode(logCtx: TerminalStatusContext): string | undefined {
  const verdict = bareEvidence.get(logCtx)?.verdict;
  if (verdict === undefined || verdict.refusalCode !== undefined || verdict.httpStatus === undefined) return undefined;
  return isCyberPolicyMessage(verdict.message) ? verdict.terminalCode : undefined;
}

export function upstreamDiagnosticLogFields(logCtx: UpstreamErrorDiagnostics): UpstreamErrorDiagnostics {
  // One verification per projection: the three fields are checked at the same instant, so they
  // share one snapshot of each source, taken only once a field is actually populated (a row with
  // no upstream diagnostic reads no credential store).
  let sources: { registry: OutboundCredentialRegistry; configured: ConfiguredCredentials } | undefined;
  const allowed = (field: keyof UpstreamErrorDiagnostics): string | undefined => {
    const value = logCtx[field];
    if (!value) return undefined;
    sources ??= { registry: outboundCredentials(), configured: configuredCredentials() };
    if (!diagnosticValueAllowed(value, sources.registry, sources.configured)) return undefined;
    return isClosedDiagnosticVocabulary(field, value) || !repeatsRequestSentValue(logCtx, value) ? value : undefined;
  };
  const code = allowed("upstreamErrorCode");
  const type = allowed("upstreamErrorType");
  const requestId = allowed("upstreamRequestId");
  return {
    ...(code ? { upstreamErrorCode: code } : {}),
    ...(type ? { upstreamErrorType: type } : {}),
    ...(requestId ? { upstreamRequestId: requestId } : {}),
  };
}

function captureTerminalHttpStatus(
  logCtx: TerminalStatusContext,
  json: UpstreamErrorPayload,
): void {
  const type = json.type;
  const terminal = type === "response.failed" || type === "response.completed" || type === "response.incomplete";
  if (!terminal && type !== "error") return;
  if (terminal && provisionalStatuses.has(logCtx)) {
    const provisional = provisionalStatuses.get(logCtx);
    provisionalStatuses.delete(logCtx);
    if (logCtx.terminalHttpStatus === provisional) {
      delete logCtx.terminalHttpStatus;
      delete logCtx.terminalErrorCode;
    }
  }
  if (logCtx.terminalHttpStatus !== undefined || (type === "error" && genuineTerminals.has(logCtx))) return;
  if (terminal) genuineTerminals.add(logCtx);
  const noteStatus = (status: number): void => {
    logCtx.terminalHttpStatus = status;
    if (type === "error") provisionalStatuses.set(logCtx, status);
  };
  // A completed terminal only retires provisional bare-error evidence; it records no status.
  if (type === "response.completed") return;
  const responseError = json.response?.error;
  const responseDetails = json.response?.incomplete_details;
  const candidates: Array<{ type?: unknown; code?: unknown; message?: unknown } | undefined> = [
    json.error, json.last_error, responseError, responseDetails, json,
  ];
  const policy = candidates.some(candidate => (
    candidate?.code === null || typeof candidate?.code === "string"
  ) && isCyberPolicyCode(candidate.code as string | null | undefined))
    || candidates.some(candidate => (
      typeof candidate?.message === "string"
      && candidate.message.trim().length > 0
      && isCyberPolicyMessage(candidate.message)
    ));
  if (policy) {
    logCtx.terminalErrorCode = CYBER_POLICY_ERROR_CODE;
    noteStatus(400);
    return;
  }
  // A quota terminal can carry only a structured reason, without an error message.
  // Keep this separate from normal output limits and from the policy precedence above.
  const quotaTag = (value: unknown): boolean => value === "usage_limit_reached"
    || value === "rate_limit_exceeded" || value === "insufficient_quota";
  const structuredRefusal = candidates.some(candidate => [400, 401, 403, 499].includes(
    httpStatusFromTerminalError({
      type: typeof candidate?.type === "string" ? candidate.type : undefined,
      code: typeof candidate?.code === "string" ? candidate.code : undefined,
    }),
  ));
  const ordinaryIncompleteReason = typeof responseDetails?.reason === "string"
    && ["max_output_tokens", "content_filter", "steered", "upstream_stall_timeout", "adapter_eof"].includes(responseDetails.reason);
  if (type === "response.incomplete" && !structuredRefusal && (quotaTag(responseDetails?.reason) || candidates.some(candidate =>
    quotaTag(candidate?.code)
    || quotaTag(candidate?.type) || candidate?.type === "rate_limit_error"
    || (!ordinaryIncompleteReason && typeof candidate?.message === "string" && isRateLimitOrQuotaFailureMessage(candidate.message))
  ))) {
    // The shared quota classifier also accepts a numeric HTTP status as its message.
    // Preserve explicit payment-required evidence rather than relabeling it as 429.
    noteStatus(candidates.some(candidate => typeof candidate?.message === "string"
      && Number(candidate.message.trim()) === 402) ? 402 : 429);
    return;
  }
  if (type === "error") {
    const structured = recognizedUpstreamError({
      code: candidates.find(candidate => typeof candidate?.code === "string")?.code,
      type: candidates.slice(0, -1).find(candidate => typeof candidate?.type === "string")?.type,
    });
    if (structured) {
      noteStatus(structured.httpStatus);
      return;
    }
    // An unrecognized class keeps only the status the upstream itself stated on the WebSocket
    // wrapper. Nothing is invented here: with no wrapper status the row stays the synthetic 502, and
    // combo preflight still reads its wider set of explicit event fields after this one.
    const wrapped = wrappedServerErrorStatus(json);
    if (wrapped !== undefined) noteStatus(wrapped);
    return;
  }
  if (type !== "response.failed" || !responseError || typeof responseError !== "object") return;
  const responseCode = responseError.code === null || typeof responseError.code === "string"
    ? responseError.code
    : undefined;
  noteStatus(httpStatusFromTerminalError({
    type: typeof responseError.type === "string" ? responseError.type : undefined,
    code: responseCode,
    message: typeof responseError.message === "string" ? responseError.message : undefined,
  }));
}
