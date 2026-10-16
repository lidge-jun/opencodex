/** Only an opaque Anthropic request id is carried; arbitrary upstream headers stay private. */
export function upstreamMessagesRequestIdHeaders(upstream: Headers): Record<string, string> {
  const requestId = upstream.get("request-id");
  return requestId && /^req_[A-Za-z0-9_-]{1,128}$/.test(requestId)
    ? { "request-id": requestId }
    : {};
}

/** The response is newly constructed by the Messages handler; preserve its body and markers. */
export function retainUpstreamMessagesRequestId(response: Response, upstream: Headers): Response {
  const requestId = upstreamMessagesRequestIdHeaders(upstream)["request-id"];
  if (requestId) response.headers.set("request-id", requestId);
  return response;
}
