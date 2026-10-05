import { isNonReplayableResponse, isReplayRefusalResponse, markResponseNonReplayable } from "../../lib/upstream-retry";
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

/** Client projection never grants another send or turns a real upstream error into our refusal. */
export async function sanitizeNonReplayableUpstreamError(
  response: Response,
  signal: AbortSignal,
): Promise<Response> {
  if (response.ok || !isNonReplayableResponse(response) || isReplayRefusalResponse(response)) return response;
  const text = await readDisplaySafeErrorText(response, signal, "");
  if (signal.aborted) {
    const cancelled = clientCancelledResponse();
    markResponseNonReplayable(cancelled);
    return cancelled;
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
  if (response.headers.get("x-should-retry") === "false") headers.set("x-should-retry", "false");
  const safe = new Response(response.status === 304 ? null : body, {
    status: response.status, headers,
  });
  markResponseNonReplayable(safe);
  return safe;
}
