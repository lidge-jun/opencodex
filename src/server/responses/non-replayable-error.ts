import { carryProxyError } from "../../lib/client-error-body";
import { responsesCompletionError } from "../../lib/errors";
import {
  applyReplayRefusalClientHeaders, withheldReplayDiagnostic, carryReplayRefusal, carryReplayRefusalToClient, hasClientReplayVeto, hasNoRetryDirective, hasUpstreamReplayRefusal, invitesResendAfterReplacement, isNonReplayableResponse,
  isNonReplayableUpstreamCode, replayRefusalVerdict, isReplayRefusalProjection, isReplayRefusalResponse, replayRefusalBodyCode,
  isTerminalResetReplacement, markResponseNonReplayable, observedReplayRefusalCode, projectReplayRefusal, retainReplayRefusal, UPSTREAM_RESET_REPLAY_REFUSED_CODE,
} from "../../lib/upstream-retry";
import { isXaiLegacyPrivacyError, isXaiPrivacyModeRefusal, xaiPrivacyModeRefusal } from "../../providers/xai-privacy-mode";
import type { RequestFailureCause } from "../../usage/telemetry-contract";
import { terminalErrorRecords } from "./codex-ws-wire";
import { clientCancelledResponse, readDisplaySafeErrorText } from "./core-errors";
import { projectNativeTerminalReplayVeto, type NativeTerminalReplayHttpEdits } from "./native-terminal-replay";
export { NON_REPLAYABLE_COMPLETION_MESSAGE, projectNativeTerminalReplayVeto, type NativeTerminalReplayHttpEdits } from "./native-terminal-replay";

const UPSTREAM_ERROR_TYPES = new Set([
  "invalid_request_error", "authentication_error", "permission_error", "not_found_error",
  "rate_limit_error", "request_too_large", "overloaded_error", "api_error", "server_error", "insufficient_quota",
]);
const UPSTREAM_ERROR_CODES = new Set([
  "context_length_exceeded", "rate_limit_exceeded", "insufficient_quota", "invalid_api_key",
  "model_not_found", "invalid_prompt", "content_policy_violation", "server_error",
  "unsupported_parameter", "invalid_value", "string_above_max_length",
]);

/** A recovery boundary retains the response and requires complete evidence before another send. */
export async function observeResponsesRecoveryResponse(response: Response, signal: AbortSignal): Promise<Response> {
  await hasUpstreamReplayRefusal(response, signal, { requireCompleteBody: true });
  return response;
}

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

/** Client projection keeps observed evidence separate from the policy that forbids another send. */
export async function sanitizeNonReplayableUpstreamError(
  response: Response,
  signal: AbortSignal,
  options?: { terminalReplacement?: boolean; grokOAuthLogCtx?: { causeHint?: RequestFailureCause } },
): Promise<Response> {
  const terminalReplacement = options?.terminalReplacement || isTerminalResetReplacement(response);
  if (response.ok || (!terminalReplacement && !isNonReplayableResponse(response))) return response;
  if (isReplayRefusalProjection(response) && !signal.aborted && !response.bodyUsed && !response.body?.locked) {
    applyReplayRefusalClientHeaders(response.headers);
    return response;
  }
  if (isXaiPrivacyModeRefusal(response) && !signal.aborted && !response.bodyUsed && !response.body?.locked) {
    markResponseNonReplayable(response);
    if (hasClientReplayVeto(response)) applyReplayRefusalClientHeaders(response.headers);
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
    return carryReplayRefusalToClient(response, refusal);
  }
  const genuineNoRetry429 = response.status === 429 && hasNoRetryDirective(response);
  if (terminalReplacement && !genuineNoRetry429 && invitesResendAfterReplacement(response.status)) {
    return carryReplayRefusal(response, projectReplayRefusal(UPSTREAM_RESET_REPLAY_REFUSED_CODE));
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
    message: withheldReplayDiagnostic(response.status),
  } });
  const headers = new Headers({ "content-type": "application/json" });
  if (hasClientReplayVeto(response) || hasNoRetryDirective(response)) applyReplayRefusalClientHeaders(headers);
  const safe = new Response(response.status === 304 ? null : body, {
    status: response.status, headers,
  });
  markResponseNonReplayable(safe);
  return carryProxyError(response, safe);
}

const projectedNativeTerminalResponses = new WeakSet<Response>();
const committedPrivacyTerminals = new WeakMap<Response, string>();

/** Preserve the exact frame generated from a local privacy refusal after its HTTP head was sent. */
export function recordCommittedPrivacyTerminal(stream: Response, refusal: Response, payload: string): void {
  if (isXaiPrivacyModeRefusal(refusal)) committedPrivacyTerminals.set(stream, payload);
}

export function markProjectedNativeTerminalResponse(response: Response, coded: boolean): Response {
  projectedNativeTerminalResponses.add(response);
  if (coded) retainReplayRefusal(response);
  else markResponseNonReplayable(response);
  return response;
}

export function isProjectedNativeTerminalResponse(response: Response): boolean {
  return projectedNativeTerminalResponses.has(response);
}

export function rewriteNonRetryableFailurePayload(
  payload: string, comboAttempt: boolean, maskCode: (value: string) => string = value => value,
  buffered?: { status: number; onProjection: (edits: NativeTerminalReplayHttpEdits) => void },
  source?: Response,
): string {
  if (source && committedPrivacyTerminals.get(source) === payload) return payload;
  try {
    const event = JSON.parse(payload) as Record<string, unknown> & { response?: Record<string, unknown> };
    const terminalType = event?.type;
    if (terminalType !== "response.failed" && terminalType !== "response.completed" && terminalType !== "response.incomplete") return payload;
    const failed = terminalType === "response.failed";
    const upstream = failed ? terminalErrorRecords(event)[0] : responsesCompletionError(event, terminalType);
    const verdict = replayRefusalVerdict(event);
    const detailVeto = terminalType === "response.incomplete" && verdict.explicitVeto
      && [event.incomplete_details, event.response?.incomplete_details].some(details =>
        replayRefusalVerdict({ incomplete_details: details }).explicitVeto);
    if (!failed && !upstream && !verdict.refusalCode && !detailVeto) return payload;
    const { error: _error, last_error: _lastError, message: _message, cause: _cause, detail: _detail, details: _details,
      incomplete_details: rootIncompleteDetails, ...root } = event;
    const { message: _responseMessage, cause: _responseCause, detail: _responseDetail, details: _responseDetails,
      incomplete_details: incompleteDetails, ...response } = event.response ?? {};
    const projection = projectNativeTerminalReplayVeto({
      ...verdict,
      explicitVeto: verdict.explicitVeto || (failed && comboAttempt && isNonReplayableUpstreamCode(upstream?.code)),
    }, buffered ? "buffered" : "streamed", upstream,
    { root: rootIncompleteDetails, response: incompleteDetails },
    buffered?.status ?? 200, maskCode);
    if (!projection) return payload;
    const projected = JSON.stringify({
      ...root,
      incomplete_details: projection.rootIncompleteDetails,
      response: { ...response, ...projection.fields },
    });
    if (projection.http) buffered?.onProjection(projection.http);
    return projected;
  } catch {
    return payload;
  }
}
