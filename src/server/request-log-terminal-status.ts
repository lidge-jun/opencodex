import {
  CYBER_POLICY_ERROR_CODE,
  httpStatusFromTerminalError,
  isCyberPolicyCode,
  isCyberPolicyMessage,
  isRateLimitOrQuotaFailureMessage,
  recognizedUpstreamError,
} from "../lib/errors";
import { redactSecretString } from "../lib/redact";

/** First bounded upstream diagnostics shared by request contexts and final rows. */
export interface UpstreamErrorDiagnostics {
  upstreamErrorCode?: string;
  upstreamErrorType?: string;
  upstreamRequestId?: string;
}

interface TerminalStatusContext extends UpstreamErrorDiagnostics {
  terminalHttpStatus?: number;
  terminalErrorCode?: typeof CYBER_POLICY_ERROR_CODE;
}

export interface UpstreamErrorPayload {
  type?: unknown;
  code?: unknown;
  message?: unknown;
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

/** Bare top-level error codes worth keeping: the classes recognizedUpstreamError maps, plus server_error. */
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
  logCtx[field] = value;
  const status = logCtx.terminalHttpStatus;
  if (status === undefined || status >= 500) console.warn(`[opencodex] upstream failure${status ? ` status=${status}` : ""}${logCtx.upstreamErrorCode ? ` code=${logCtx.upstreamErrorCode}` : ""}${logCtx.upstreamRequestId ? ` request_id=${logCtx.upstreamRequestId}` : ""}`);
}

export function noteUpstreamRequestId(logCtx: TerminalStatusContext, headers: Headers): void {
  noteBoundedDiagnostic(logCtx, "upstreamRequestId", headers.get("openai-request-id") ?? headers.get("x-request-id"));
}

export function captureUpstreamTerminalDiagnostics(logCtx: TerminalStatusContext, json: UpstreamErrorPayload): void {
  captureTerminalHttpStatus(logCtx, json);
  noteBoundedDiagnostic(logCtx, "upstreamErrorCode",
    json.error?.code ?? json.last_error?.code ?? json.response?.error?.code
      // A bare top-level code (new in 2.83.0) has no envelope contract, so only a known class is kept.
      ?? (typeof json.code === "string" && KNOWN_BARE_ERROR_CODES.has(json.code) ? json.code : undefined));
  noteBoundedDiagnostic(logCtx, "upstreamErrorType",
    json.error?.type ?? json.last_error?.type ?? json.response?.error?.type);
}

export function upstreamDiagnosticLogFields(logCtx: UpstreamErrorDiagnostics): UpstreamErrorDiagnostics {
  return {
    ...(logCtx.upstreamErrorCode ? { upstreamErrorCode: logCtx.upstreamErrorCode } : {}),
    ...(logCtx.upstreamErrorType ? { upstreamErrorType: logCtx.upstreamErrorType } : {}),
    ...(logCtx.upstreamRequestId ? { upstreamRequestId: logCtx.upstreamRequestId } : {}),
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
    // Unrecognized bare errors leave the status to explicit event fields (combo preflight).
    if (structured) noteStatus(structured.httpStatus);
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
