export type GatewayErrorCategory =
  | "auth_failed"
  | "config_invalid"
  | "request_too_large"
  | "headers_too_large"
  | "unsupported_content_encoding"
  | "model_not_allowed"
  | "concurrency_limited"
  | "upstream_timeout"
  | "client_timeout"
  | "client_aborted"
  | "redirect_rejected"
  | "upstream_error"
  | "internal";

const ERROR_MESSAGES: Record<GatewayErrorCategory, string> = {
  auth_failed: "Gateway authentication failed",
  config_invalid: "Gateway configuration is invalid",
  request_too_large: "Request body exceeds gateway limit",
  headers_too_large: "Request headers exceed gateway limit",
  unsupported_content_encoding: "Request content encoding is not supported",
  model_not_allowed: "Requested model is not allowed",
  concurrency_limited: "Gateway concurrency limit reached",
  upstream_timeout: "Upstream request timed out",
  client_timeout: "Client request timed out",
  client_aborted: "Client request was aborted",
  redirect_rejected: "Upstream redirect rejected",
  upstream_error: "Upstream request failed",
  internal: "Internal gateway error",
};

const ERROR_STATUS: Record<GatewayErrorCategory, number> = {
  auth_failed: 401,
  config_invalid: 500,
  request_too_large: 413,
  headers_too_large: 431,
  unsupported_content_encoding: 415,
  model_not_allowed: 400,
  concurrency_limited: 429,
  upstream_timeout: 504,
  client_timeout: 408,
  client_aborted: 499,
  redirect_rejected: 502,
  upstream_error: 502,
  internal: 500,
};

export interface RelayFailureContext {
  callerAborted: boolean;
  clientTimedOut: boolean;
  upstreamTimedOut: boolean;
}

export function classifyRelayFailure(
  error: unknown,
  context: RelayFailureContext,
): GatewayErrorCategory {
  if (context.callerAborted) return "client_aborted";
  if (context.clientTimedOut) return "client_timeout";
  if (context.upstreamTimedOut) return "upstream_timeout";
  if (error instanceof Error && error.message.includes("redirect_rejected")) {
    return "redirect_rejected";
  }
  if (error instanceof Error && error.name === "AbortError") {
    return "upstream_error";
  }
  return "upstream_error";
}

export function classifyGatewayError(
  error: unknown,
  context: { source: "client" | "upstream"; timedOut?: boolean },
): GatewayErrorCategory {
  if (error instanceof Error && error.name === "AbortError") {
    if (context.source === "client") return "client_aborted";
    if (context.timedOut) return "upstream_timeout";
    if (context.source === "upstream") return "upstream_error";
    return "client_aborted";
  }
  if (error instanceof Error && error.message.includes("redirect_rejected")) {
    return "redirect_rejected";
  }
  if (context.source === "upstream") {
    if (context.timedOut) return "upstream_timeout";
    return "upstream_error";
  }
  return "internal";
}

export function gatewayErrorResponse(
  category: GatewayErrorCategory,
  status = ERROR_STATUS[category],
): Response {
  return Response.json(
    {
      error: {
        type: category,
        message: ERROR_MESSAGES[category],
      },
    },
    { status },
  );
}

export function gatewayErrorStatus(category: GatewayErrorCategory): number {
  return ERROR_STATUS[category];
}
