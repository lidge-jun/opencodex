import {
  isNonReplayableUpstreamCode,
  isReplayRefusalCode,
  markReplayRefusalResponse,
  markResponseNonReplayable,
  REPLAY_REFUSED_STATUS,
} from "../lib/upstream-retry";
import {
  adapterFailureFromMessage,
  classifyError,
  cyberPolicyErrorType,
  CYBER_POLICY_ERROR_CODE,
  isCyberPolicyCode,
  type OcxErrorPayload,
} from "../lib/errors";

export function formatErrorResponse(
  status: number,
  type: string,
  message: string,
  options?: { code?: string | null; retryAfter?: string | null },
): Response {
  const error = classifyError(status, type, message);
  if (isCyberPolicyCode(options?.code)) {
    error.code = CYBER_POLICY_ERROR_CODE;
    error.type = cyberPolicyErrorType(type);
  }
  // Only the allowlisted transport verdicts survive this formatter. Do not forward
  // arbitrary provider codes, and preserve the existing cyber-policy precedence.
  const replayBlocked = error.code !== CYBER_POLICY_ERROR_CODE
    && isNonReplayableUpstreamCode(options?.code);
  if (replayBlocked) error.code = options!.code!;
  // The replay refusal owns its status as well as its code. A combo or adapter formatter
  // reaches here holding the upstream-shaped status it was about to report, and inheriting
  // that would hand the client a 5xx it is configured to retry four times.
  const finalStatus = error.code === CYBER_POLICY_ERROR_CODE
    ? 400
    : isReplayRefusalCode(error.code) ? REPLAY_REFUSED_STATUS : status;
  const headers = new Headers({ "Content-Type": "application/json" });
  const retryAfter = options?.retryAfter?.trim();
  if (error.code !== CYBER_POLICY_ERROR_CODE
    && !replayBlocked
    && retryAfter
    && retryAfter.length > 0
    && retryAfter.length <= 128) {
    headers.set("Retry-After", retryAfter);
  }
  const response = new Response(JSON.stringify({ error }), {
    status: finalStatus,
    headers,
  });
  if (replayBlocked) markResponseNonReplayable(response);
  // Re-wrapping is where the refusal loses its provenance: combo failure consumption parses
  // the JSON and builds a new Response, and the code alone does not tell a later quota
  // recorder that no upstream produced this status. Carry the narrower marker across too.
  if (replayBlocked && isReplayRefusalCode(error.code)) markReplayRefusalResponse(response);
  return response;
}
