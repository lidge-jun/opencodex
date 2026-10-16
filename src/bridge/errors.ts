import {
  applyReplayRefusalClientHeaders,
  isNonReplayableUpstreamCode,
  isReplayRefusalCode,
  markResponseNonReplayable,
  REPLAY_REFUSED_STATUS,
  retainReplayRefusal,
} from "../lib/upstream-retry";
import {
  adapterFailureFromMessage,
  classifyError,
  cyberPolicyErrorType,
  CYBER_POLICY_ERROR_CODE,
  isCyberPolicyCode,
  SPEND_LEDGER_STORAGE_UNAVAILABLE_CODE,
  UNDECLARED_TOOL_CALL_ERROR_CODE,
  type OcxErrorPayload,
} from "../lib/errors";

export function formatErrorResponse(
  status: number,
  type: string,
  message: string,
  options?: { code?: string | null; retryAfter?: string | null },
): Response {
  const error = classifyError(status, type, message);
  if (options?.code === SPEND_LEDGER_STORAGE_UNAVAILABLE_CODE) {
    error.type = "server_error";
    error.code = SPEND_LEDGER_STORAGE_UNAVAILABLE_CODE;
  }
  if (isCyberPolicyCode(options?.code)) {
    error.code = CYBER_POLICY_ERROR_CODE;
    error.type = cyberPolicyErrorType(type);
  }
  // The undeclared-tool refusal is deterministic, not a transient upstream failure: its code
  // survives so the Anthropic translator can classify it instead of folding it into a
  // retryable overload (and so clients see the SSE path's rejection identity).
  if (options?.code === UNDECLARED_TOOL_CALL_ERROR_CODE) error.code = options.code;
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
    : error.code === SPEND_LEDGER_STORAGE_UNAVAILABLE_CODE ? 503
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
  // The refusal's client policy, restated here for the same reason its status is: this
  // formatter is the last thing several adapter and combo paths touch before the client,
  // and no wait of its own does not stop a client that retries every 429 by default.
  const refusal = isReplayRefusalCode(error.code) && replayBlocked;
  if (refusal) applyReplayRefusalClientHeaders(headers);
  const response = new Response(JSON.stringify({ error }), {
    status: finalStatus,
    headers,
  });
  if (replayBlocked) markResponseNonReplayable(response);
  // Re-wrapping is where the refusal loses its provenance: combo failure consumption parses
  // the JSON and builds a new Response, and the code alone does not tell a later quota
  // recorder that no upstream produced this status. Carry the narrower marker across too.
  if (refusal) retainReplayRefusal(response);
  return response;
}

/**
 * A spent usage window, in the shape the Codex client treats as final (#6991): HTTP 429 with
 * `error.type: "usage_limit_reached"` and, when the reset is known, `resets_at` in epoch
 * seconds. Codex stops (and shows the reset time when present) instead of backing off through its
 * retry budget, which is what it does with `rate_limit_exceeded`. No `plan_type` is sent: Codex
 * would read it as a ChatGPT plan and print that plan's upgrade advice. `formatErrorResponse`
 * cannot build this, because every 429 it classifies becomes `rate_limit_exceeded` and its
 * payload has no `resets_at`.
 */
export function formatUsageLimitReachedResponse(message: string, resetsAtMs: number | null, retryAfterSeconds: number | null): Response {
  const error = {
    message, type: "usage_limit_reached", code: "usage_limit_reached",
    ...(resetsAtMs !== null ? { resets_at: Math.ceil(resetsAtMs / 1000) } : {}),
  };
  const headers = new Headers({ "Content-Type": "application/json" });
  if (retryAfterSeconds !== null) headers.set("Retry-After", String(retryAfterSeconds));
  return new Response(JSON.stringify({ error }), { status: 429, headers });
}
