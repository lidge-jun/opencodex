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
  isModelNotInPlanRefusal,
  markVerifiedModelNotInPlanResponse,
  MODEL_NOT_IN_PLAN_CODE,
  REQUIRED_TOOL_CONTRACT_CODE,
  SPEND_LEDGER_STORAGE_UNAVAILABLE_CODE,
  UNDECLARED_TOOL_CALL_ERROR_CODE,
  type OcxErrorPayload,
} from "../lib/errors";

const PINNED_VERDICT_CODES = new Set([CYBER_POLICY_ERROR_CODE, "client_closed_request"]);

// A serialized classifier verdict is not an upstream code. Keep the original code out of
// the wire body so a combo cannot mistake prose-derived insufficient_quota for evidence.
const formattedQuotaSources = new WeakMap<Response, string | null>();
const STRUCTURED_QUOTA_CODES = new Set(["usage_limit_exceeded", "usage_limit_reached", "1308", "insufficient_quota"]);

export function upstreamCodeForComboFailure(response: Response, bodyCode: string | undefined): string | undefined {
  return bodyCode === "insufficient_quota" && formattedQuotaSources.has(response)
    ? formattedQuotaSources.get(response) ?? undefined
    : bodyCode;
}

export function formatErrorResponse(
  status: number,
  type: string,
  message: string,
  options?: { code?: string | null; retryAfter?: string | null; classified?: boolean; upstreamCode?: string | null },
): Response {
  const validationStatus = status === 400 || status === 422;
  const error = classifyError(status, type, message);
  // A combo child holding an adapterFailureFromEvent verdict has already classified this
  // failure. Re-deriving it from the status folded insufficient_quota into rate_limit_exceeded
  // and a 400 modality refusal into invalid_request_error, so the combo loop cooled and hopped
  // on the wrong evidence. The child body reaches only that loop, whose consumer re-applies
  // this formatter's allowlist before anything reaches a client. The overrides below still win.
  // The caller's code fills in only where its type and message add nothing to what the status
  // alone says. A verdict read from the full message (quota, credentials, cyber policy, context
  // overflow, catalog size) outranks a generic adapter code: the consumer sees only the first
  // 500 characters, so replacing it turned a late cyber refusal into a hop and spent quota into a
  // target cooldown. The baseline uses a neutral type because an untyped adapter event arrives
  // with a type adapterFailureFromEvent already inferred from that same message.
  const messageVerdict = error.code !== classifyError(status, "upstream_error", "").code;
  if (options?.classified && options.code && !messageVerdict && !PINNED_VERDICT_CODES.has(error.code ?? "")) {
    error.type = type;
    error.code = options.code;
  }
  if (options?.code === SPEND_LEDGER_STORAGE_UNAVAILABLE_CODE) {
    error.type = "server_error";
    error.code = SPEND_LEDGER_STORAGE_UNAVAILABLE_CODE;
  }
  if (isCyberPolicyCode(options?.code)) {
    error.code = CYBER_POLICY_ERROR_CODE;
    error.type = cyberPolicyErrorType(type);
  }
  // Only the adapter event's original code can retain this hop identity. Its classified
  // code may have come from reflected prose, and a generic 422 type can erase a real one.
  if (validationStatus && options?.upstreamCode
    && STRUCTURED_QUOTA_CODES.has(options.upstreamCode.trim().toLowerCase().replaceAll("-", "_"))
    && !PINNED_VERDICT_CODES.has(error.code ?? "")) error.code = options.upstreamCode;
  // The undeclared-tool refusal is deterministic, not a transient upstream failure: its code
  // survives so the Anthropic translator can classify it instead of folding it into a
  // retryable overload (and so clients see the SSE path's rejection identity).
  if (options?.code === UNDECLARED_TOOL_CALL_ERROR_CODE) error.code = options.code;
  if (options?.code === REQUIRED_TOOL_CONTRACT_CODE && error.code !== CYBER_POLICY_ERROR_CODE) error.code = options.code;
  // A plan refusal keeps its wire code so clients can branch on it. The code is not provenance:
  // run-turn combo children pass an adapter event's own code here, so only the boundary that
  // verified the refusal marks the envelope (`markVerifiedModelNotInPlanResponse`).
  if (options?.code === MODEL_NOT_IN_PLAN_CODE) error.code = options.code;
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
  if (error.code === REQUIRED_TOOL_CONTRACT_CODE && finalStatus === 400) applyReplayRefusalClientHeaders(headers);
  const response = new Response(JSON.stringify({ error }), {
    status: finalStatus,
    headers,
  });
  if (validationStatus && error.code === "insufficient_quota") {
    formattedQuotaSources.set(response, options?.upstreamCode !== undefined
      ? options.upstreamCode : options?.classified ? null : options?.code ?? null);
  }
  if (replayBlocked) markResponseNonReplayable(response);
  // Re-wrapping is where the refusal loses its provenance: combo failure consumption parses
  // the JSON and builds a new Response, and the code alone does not tell a later quota
  // recorder that no upstream produced this status. Carry the narrower marker across too.
  if (refusal) retainReplayRefusal(response);
  return response;
}

/**
 * `formatErrorResponse` for an upstream failure that may be the adapter-normalized plan refusal
 * (#7684). Only a verified refusal (`isModelNotInPlanRefusal` on the response the adapter marked)
 * keeps `model_not_in_plan` and carries the in-memory mark policy fallback reads; the wire code
 * alone is never provenance. Every other failure formats exactly as `formatErrorResponse` does.
 */
export function formatUpstreamFailureResponse(
  source: Response,
  sourceCode: string | undefined,
  ...[status, type, message, options]: Parameters<typeof formatErrorResponse>
): Response {
  if (!isModelNotInPlanRefusal(source, sourceCode)) return formatErrorResponse(status, type, message, options);
  const failure = formatErrorResponse(status, type, message, { ...options, code: MODEL_NOT_IN_PLAN_CODE });
  markVerifiedModelNotInPlanResponse(failure);
  return failure;
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
