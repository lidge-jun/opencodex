import { isNonReplayableResponse, isReplayRefusalResponse, markResponseNonReplayable } from "../../lib/upstream-retry";
import { clientCancelledResponse, readDisplaySafeErrorText } from "./core-errors";

const UPSTREAM_ERROR_TYPES = new Set([
  "invalid_request_error", "authentication_error", "permission_error", "not_found_error",
  "rate_limit_error", "request_too_large", "overloaded_error", "api_error", "server_error", "insufficient_quota",
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
  try {
    const parsed = JSON.parse(text);
    const upstreamType = parsed?.error?.type;
    if (typeof upstreamType === "string" && UPSTREAM_ERROR_TYPES.has(upstreamType)) type = upstreamType;
  } catch {
    // Incomplete or non-JSON bodies retain the generic error type.
  }
  // Upstream text is not forwarded here: no bounded redaction can be proven complete against a client's decoders.
  const body = JSON.stringify({ error: { type,
    message: `Provider error ${response.status}: upstream diagnostic withheld after a connection-reset replacement`,
  } });
  const headers = new Headers({ "content-type": "application/json" });
  if (response.headers.get("x-should-retry") === "false") headers.set("x-should-retry", "false");
  const safe = new Response(response.status === 304 ? null : body, {
    status: response.status, headers,
  });
  markResponseNonReplayable(safe);
  return safe;
}
