import { carryProxyError, ownedChatErrorPayload } from "../../lib/client-error-body";
import { httpStatusFromTerminalError } from "../../lib/errors";
import {
  applyReplayRefusalClientHeaders, carryReplayRefusal, hasNoRetryDirective, isNonReplayableResponse,
  isNonReplayableUpstreamCode, isReplayRefusalCode, isReplayRefusalProjection, isReplayRefusalResponse, replayRefusalBodyCode,
  markResponseNonReplayable, observedReplayRefusalCode, projectReplayRefusal, UPSTREAM_RESET_REPLAY_REFUSED_CODE,
} from "../../lib/upstream-retry";
import { isXaiLegacyPrivacyError, isXaiPrivacyModeRefusal, xaiPrivacyModeRefusal } from "../../providers/xai-privacy-mode";
import type { RequestFailureCause } from "../../usage/telemetry-contract";
import { clientCancelledResponse, readDisplaySafeErrorText } from "./core-errors";

const UPSTREAM_ERROR_TYPES = new Set([
  "invalid_request_error", "authentication_error", "permission_error", "not_found_error",
  "rate_limit_error", "request_too_large", "overloaded_error", "api_error", "server_error", "insufficient_quota",
]);
const UPSTREAM_ERROR_CODES = new Set([
  "context_length_exceeded", "rate_limit_exceeded", "insufficient_quota", "invalid_api_key",
  "model_not_found", "invalid_prompt", "content_policy_violation", "server_error",
  "unsupported_parameter", "invalid_value", "string_above_max_length",
]);

/** A recognized replay code takes precedence over provider-specific guidance. */
export function projectResponsesUpstreamRefusal(
  response: Response, text: string, grokOAuthLogCtx?: { causeHint?: RequestFailureCause },
): Response | undefined {
  const refusalCode = replayRefusalBodyCode(text) ?? observedReplayRefusalCode(response);
  if (refusalCode || isReplayRefusalResponse(response)) {
    return carryReplayRefusal(response, projectReplayRefusal(refusalCode ?? UPSTREAM_RESET_REPLAY_REFUSED_CODE));
  }
  if (grokOAuthLogCtx && isXaiLegacyPrivacyError(response.status, text)) {
    return carryReplayRefusal(response, xaiPrivacyModeRefusal(grokOAuthLogCtx));
  }
}

/** The replacement selector owns this bounded read and carries only the projected verdict forward. */
export async function projectXaiResetRefusal(
  response: Response, signal: AbortSignal, logCtx: { causeHint?: RequestFailureCause },
): Promise<Response | undefined> {
  if (response.status !== 403) return;
  const text = await readDisplaySafeErrorText(response, signal, "");
  if (!signal.aborted) return projectResponsesUpstreamRefusal(response, text, logCtx);
}

/** Client projection never grants another send or turns a real upstream error into our refusal. */
export async function sanitizeNonReplayableUpstreamError(
  response: Response,
  signal: AbortSignal,
  options?: { terminalReplacement?: boolean; grokOAuthLogCtx?: { causeHint?: RequestFailureCause } },
): Promise<Response> {
  if (response.ok || (!options?.terminalReplacement && !isNonReplayableResponse(response))) return response;
  if (isReplayRefusalProjection(response) && !signal.aborted && !response.bodyUsed && !response.body?.locked) {
    applyReplayRefusalClientHeaders(response.headers);
    return response;
  }
  if (isXaiPrivacyModeRefusal(response) && !signal.aborted && !response.bodyUsed && !response.body?.locked) {
    markResponseNonReplayable(response);
    return response;
  }
  const text = await readDisplaySafeErrorText(response, signal, "");
  if (signal.aborted) {
    const cancelled = clientCancelledResponse();
    markResponseNonReplayable(cancelled);
    return cancelled;
  }
  const refusal = projectResponsesUpstreamRefusal(response, text, options?.grokOAuthLogCtx);
  if (refusal) {
    markResponseNonReplayable(refusal);
    return refusal;
  }
  let type = "upstream_error";
  let code: string | undefined;
  try {
    const parsed = JSON.parse(text);
    const upstreamType = parsed?.error?.type;
    const upstreamCode = parsed?.error?.code;
    if (typeof upstreamType === "string" && UPSTREAM_ERROR_TYPES.has(upstreamType)) type = upstreamType;
    if (typeof upstreamCode === "string" && UPSTREAM_ERROR_CODES.has(upstreamCode)) code = upstreamCode;
  } catch {
    // Incomplete or non-JSON bodies retain the generic error type.
  }
  // Upstream text is not forwarded here: no bounded redaction can be proven complete against a client's decoders.
  const body = JSON.stringify({ error: { type, ...(code === undefined ? {} : { code }),
    message: `Provider error ${response.status}: upstream diagnostic withheld for a non-replayable failure`,
  } });
  const headers = new Headers({ "content-type": "application/json" });
  if (hasNoRetryDirective(response)) applyReplayRefusalClientHeaders(headers);
  const safe = new Response(response.status === 304 ? null : body, {
    status: response.status, headers,
  });
  markResponseNonReplayable(safe);
  return carryProxyError(response, safe);
}

/** Project recognized refusals on every native stream, plus other non-retryable combo failures. */
export function rewriteNonRetryableFailurePayload(payload: string, comboAttempt: boolean): string {
  if (!payload.includes('"response.failed"')) return payload;
  try {
    type ErrorRecord = { type?: unknown; code?: unknown };
    const event = JSON.parse(payload) as {
      type?: unknown; retryable?: unknown; error?: ErrorRecord; last_error?: ErrorRecord;
      response?: { retryable?: unknown; error?: ErrorRecord; last_error?: ErrorRecord };
    };
    if (event?.type !== "response.failed") return payload;
    const upstream = event.response?.error ?? event.error ?? event.response?.last_error ?? event.last_error;
    const nonRetryable = event.response?.retryable === false || event.retryable === false
      || isNonReplayableUpstreamCode(upstream?.code);
    if (!isReplayRefusalCode(upstream?.code) && !(comboAttempt && nonRetryable)) return payload;
    const type = typeof upstream?.type === "string" ? upstream.type : undefined;
    const code = typeof upstream?.code === "string" ? upstream.code : undefined;
    const status = httpStatusFromTerminalError({ type, code });
    const { message, type: safeType, code: safeCode } = ownedChatErrorPayload({
      status, type, code, evidence: { status, type, code },
    }).error;
    const error = { type: safeType, code: safeCode, message };
    const { error: _error, last_error: _lastError, ...root } = event;
    return JSON.stringify({ ...root, response: { ...event.response, retryable: false, error, last_error: error } });
  } catch {
    return payload;
  }
}
