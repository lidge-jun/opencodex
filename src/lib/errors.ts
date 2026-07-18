export interface OcxErrorPayload {
  message: string;
  type: string;
  code: string | null;
}

function isSubscriptionGateMessage(text: string): boolean {
  return (
    text.includes("requires a subscription") ||
    text.includes("requires subscription") ||
    text.includes("subscription required") ||
    text.includes("upgrade for access") ||
    text.includes("upgrade to pro") ||
    text.includes("pro subscription") ||
    text.includes("ollama.com/upgrade") ||
    (text.includes("upgrade") && text.includes("subscription"))
  );
}

function isAuthenticationMessage(text: string): boolean {
  const accessDeniedWithCredentialCue = (
    text.includes("access denied") ||
    text.includes("accessdeniedexception")
  ) && (
    text.includes("authentication") ||
    text.includes("credential") ||
    text.includes("api key") ||
    text.includes("token") ||
    text.includes("signature")
  );
  return (
    text.includes("authentication failed") ||
    text.includes("authentication") ||
    text.includes("invalid_api_key") ||
    text.includes("invalid api key") ||
    text.includes("invalid token") ||
    text.includes("unauthorizedexception") ||
    text.includes("unrecognizedclientexception") ||
    text.includes("unrecognizedclient") ||
    text.includes("expired token") ||
    text.includes("expiredtoken") ||
    text.includes("unauthenticated") ||
    text.includes("unauthorized") ||
    accessDeniedWithCredentialCue
  );
}

function isPermissionMessage(text: string): boolean {
  return (
    text.includes("permission_denied") ||
    text.includes("permission denied") ||
    text.includes("forbidden") ||
    text.includes("access denied") ||
    text.includes("accessdeniedexception") ||
    text.includes("not allowed to use") ||
    text.includes("model access")
  );
}

export function classifyError(status: number, type: string, message: string): OcxErrorPayload {
  const text = message.toLowerCase();
  if (
    text.includes("context_length_exceeded") ||
    text.includes("context window") ||
    text.includes("context length") ||
    text.includes("maximum context") ||
    text.includes("too many tokens")
  ) {
    return { message, type: "invalid_request_error", code: "context_length_exceeded" };
  }
  if (
    text.includes("insufficient_quota") ||
    text.includes("exceeded your current quota") ||
    text.includes("quota exhausted") ||
    text.includes("account quota exceeded") ||
    text.includes("monthly quota exceeded") ||
    text.includes("daily quota exceeded")
  ) {
    return { message, type: "insufficient_quota", code: "insufficient_quota" };
  }
  if (
    status === 429 ||
    text.includes("rate limit") ||
    text.includes("rate limited") ||
    text.includes("too many requests") ||
    text.includes("resource_exhausted") ||
    text.includes("resource exhausted") ||
    text.includes("throttlingexception") ||
    text.includes("throttling")
  ) {
    return { message, type: "rate_limit_error", code: "rate_limit_exceeded" };
  }
  if (type === "origin_rejected") {
    return { message, type: "invalid_request_error", code: "origin_rejected" };
  }
  // HTTP 401 and explicit auth failures are authoritative even when provider text
  // also advertises an upgrade or subscription.
  if (
    status === 401 ||
    type === "authentication_error" ||
    isAuthenticationMessage(text)
  ) {
    return { message, type: "authentication_error", code: "invalid_api_key" };
  }
  // Subscription labels are valid only in a known permission context.
  if (
    (status === 403 || type === "permission_error") &&
    isSubscriptionGateMessage(text)
  ) {
    return { message, type: "permission_error", code: "subscription_required" };
  }
  if (
    status === 403 ||
    type === "permission_error" ||
    isPermissionMessage(text)
  ) {
    return { message, type: "permission_error", code: "permission_denied" };
  }
  if (
    status === 503 ||
    text.includes("overloaded") ||
    text.includes("server is busy") ||
    text.includes("temporarily unavailable")
  ) {
    // Codex recognizes "server_is_overloaded" and applies retry-after backoff
    // (responses.rs is_server_overloaded_error); generic "upstream_server_error" is not recognized.
    return { message, type: "server_error", code: "server_is_overloaded" };
  }
  if (
    text.includes("validationexception") ||
    text.includes("invalid request") ||
    text.includes("model unavailable") ||
    text.includes("model not found") ||
    text.includes("unsupported model") ||
    text.includes("profile arn") ||
    text.includes("wrong region") ||
    text.includes("invalid region")
  ) {
    return { message, type: "invalid_request_error", code: "invalid_request_error" };
  }
  if (status >= 500) {
    return { message, type: "server_error", code: "upstream_server_error" };
  }
  if (status === 400 || type === "invalid_request_error") {
    return { message, type: "invalid_request_error", code: "invalid_request_error" };
  }
  return { message, type, code: type || null };
}

/** Best-effort parse of a retry delay embedded in an upstream error message. */
export function parseRetryAfterFromMessage(message: string): number | undefined {
  const patterns = [
    /try again in (\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?/i,
    /retry after (\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?/i,
    /retry[- ]after[:\s]+(\d+)/i,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (!match?.[1]) continue;
    const seconds = Number.parseFloat(match[1]);
    if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
  }
  return undefined;
}

/** Infer HTTP status from adapter terminal error text (provider-agnostic keyword matching). */
export function inferHttpStatusFromAdapterMessage(message: string): number {
  const lower = message.toLowerCase();
  if (
    lower.includes("resource_exhausted") ||
    lower.includes("resource exhausted") ||
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    lower.includes("throttling")
  ) return 429;
  // Strong authentication signals win when a message contains mixed auth and
  // subscription/permission wording.
  if (isAuthenticationMessage(lower)) return 401;
  if (isSubscriptionGateMessage(lower) || isPermissionMessage(lower)) return 403;
  if (
    lower.includes("unavailable") ||
    lower.includes("overloaded") ||
    lower.includes("temporarily") ||
    lower.includes("server is busy")
  ) return 503;
  if (
    lower.includes("invalid") ||
    lower.includes("not found") ||
    lower.includes("unsupported") ||
    lower.includes("malformed") ||
    lower.includes("unimplemented")
  ) return 400;
  if (
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("etimedout") ||
    lower.includes("deadline")
  ) return 504;
  return 502;
}

/** Map an adapter terminal error message to HTTP status + classified Codex error payload. */
export function adapterFailureFromMessage(message: string): { httpStatus: number; error: OcxErrorPayload } {
  const httpStatus = inferHttpStatusFromAdapterMessage(message);
  let finalMessage = message;
  const retryAfterSeconds = parseRetryAfterFromMessage(message);
  if (retryAfterSeconds && !/please try again in /i.test(message)) {
    finalMessage = `${message} Please try again in ${retryAfterSeconds}s.`;
  }
  const errorType = httpStatus === 429
    ? "rate_limit_error"
    : httpStatus === 401
      ? "authentication_error"
      : httpStatus === 403
        ? "permission_error"
        : httpStatus === 503 || httpStatus === 504
          ? "server_error"
          : httpStatus === 400
            ? "invalid_request_error"
            : "upstream_error";
  return {
    httpStatus,
    error: classifyError(httpStatus, errorType, finalMessage),
  };
}

/** Map a terminal Responses error object to the HTTP status we record in /api/logs. */
export function httpStatusFromTerminalError(error: {
  type?: string;
  code?: string | null;
  message?: string;
} | undefined): number {
  if (!error) return 502;
  if (error.type === "rate_limit_error" || error.code === "rate_limit_exceeded") return 429;
  if (error.type === "authentication_error" || error.code === "invalid_api_key") return 401;
  if (
    error.type === "permission_error" ||
    error.code === "permission_denied" ||
    error.code === "subscription_required"
  ) return 403;
  if (error.type === "insufficient_quota" || error.code === "insufficient_quota") return 429;
  if (error.type === "server_error" && error.code === "server_is_overloaded") return 503;
  if (error.type === "invalid_request_error") return 400;
  if (error.type === "proxy_error") return 500;
  const message = error.message ?? "";
  if (message) return inferHttpStatusFromAdapterMessage(message);
  return 502;
}
