import { parseUpstreamJsonPayload, safeUpstreamErrorString, sanitizeUpstreamErrorText } from "./upstream-http-error";
const DETAIL_KEYS = ["__type", "code", "error", "name", "reason", "message", "Message", "errorMessage"];

export interface KiroErrorClassification {
  message: string;
  status: number;
  errorType: string;
  code: string;
  retryable: boolean;
}

function headerValue(headers: Headers | Record<string, unknown>, name: string): string | undefined {
  if (headers instanceof Headers) return name.startsWith(":") ? undefined : safeUpstreamErrorString(headers.get(name));
  return safeUpstreamErrorString(headers[name]) || safeUpstreamErrorString(headers[name.toLowerCase()]);
}

function payloadDetails(payloadText: string): string[] {
  const trimmed = payloadText.trim();
  if (!trimmed) return [];
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return [trimmed];
  const parsed = parseUpstreamJsonPayload(trimmed);
  if (parsed === undefined) return [];
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    return DETAIL_KEYS.map(key => safeUpstreamErrorString(obj[key])).filter((v): v is string => !!v);
  }
  if (typeof parsed === "string" && parsed.trim()) return [parsed.trim()];
  return [];
}

function classifyKiroText(status: number | undefined, text: string): string {
  const lower = text.toLowerCase();
  const rateQuota = /requests?\s+per\s+(?:min|minute|second)|rpm|tpm/.test(lower);
  const quotaExhausted =
    lower.includes("insufficient_quota") ||
    lower.includes("quota exhausted") ||
    lower.includes("account quota exceeded") ||
    lower.includes("monthly quota exceeded") ||
    lower.includes("daily quota exceeded") ||
    lower.includes("exceeded your current quota");
  if (quotaExhausted && !rateQuota) return "Kiro quota exhausted";
  if (
    status === 429 ||
    lower.includes("throttlingexception") ||
    lower.includes("too many requests") ||
    lower.includes("rate limited") ||
    lower.includes("rate limit")
  ) return "Kiro rate limit exceeded";
  if (
    status === 401 ||
    status === 403 ||
    lower.includes("accessdenied") ||
    lower.includes("access denied") ||
    lower.includes("unauthorized") ||
    lower.includes("unrecognizedclient") ||
    lower.includes("expiredtoken") ||
    lower.includes("expired token") ||
    lower.includes("invalid token") ||
    lower.includes("authentication")
  ) return "Kiro authentication failed";
  if (
    status === 503 ||
    lower.includes("overloaded") ||
    lower.includes("server is busy") ||
    lower.includes("temporarily unavailable")
  ) return "Kiro server overloaded";
  if (
    status === 400 ||
    lower.includes("validationexception") ||
    lower.includes("invalid request") ||
    lower.includes("profile arn") ||
    lower.includes("model unavailable") ||
    lower.includes("model not found") ||
    lower.includes("unsupported model") ||
    lower.includes("region") ||
    lower.includes("schema") ||
    lower.includes("malformed")
  ) return "Kiro invalid request";
  return "Kiro upstream error";
}

function normalizedKiroErrorMessage(headers: Headers | Record<string, unknown>, payloadText: string, status?: number): string {
  const headerType = headerValue(headers, ":exception-type") || headerValue(headers, ":error-type");
  const parts = [headerType, ...payloadDetails(payloadText)].filter((part): part is string => !!part);
  const detail = parts.length > 0 ? sanitizeUpstreamErrorText(parts.join(": ")).slice(0, 500) : status ? `HTTP ${status}` : "";
  const prefix = classifyKiroText(status, [detail, headerType].filter(Boolean).join(" "));
  return detail ? `${prefix}: ${detail}` : prefix;
}

function isContentLengthError(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes("content_length_exceeds_threshold") || lower.includes("content length exceeds");
}

function classifyKiroFailure(
  headers: Headers | Record<string, unknown>,
  payloadText: string,
  status?: number,
): KiroErrorClassification {
  const message = normalizedKiroErrorMessage(headers, payloadText, status);
  const headerType = headerValue(headers, ":exception-type") || headerValue(headers, ":error-type") || "";
  const evidence = [headerType, ...payloadDetails(payloadText), message].join(" ").toLowerCase();
  if (isContentLengthError(evidence)) {
    return {
      message: "Kiro rejected the request because the conversation exceeds the model's context window. Compact or reduce the history, or start a new session.",
      status: 400,
      errorType: "invalid_request_error",
      code: "context_length_exceeded",
      retryable: false,
    };
  }
  if (
    evidence.includes("insufficient_quota")
    || evidence.includes("quota exhausted")
    || evidence.includes("quota exceeded")
  ) {
    return { message, status: 429, errorType: "insufficient_quota", code: "insufficient_quota", retryable: false };
  }
  if (
    status === 429
    || evidence.includes("throttlingexception")
    || evidence.includes("too many requests")
    || evidence.includes("rate limit")
  ) {
    return { message, status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded", retryable: true };
  }
  if (
    status === 401
    || status === 403
    || evidence.includes("accessdenied")
    || evidence.includes("unauthorized")
    || evidence.includes("unrecognizedclient")
    || evidence.includes("expiredtoken")
    || evidence.includes("expired token")
    || evidence.includes("invalid token")
    || evidence.includes("authentication")
  ) {
    return { message, status: status === 403 ? 403 : 401, errorType: status === 403 ? "permission_error" : "authentication_error", code: status === 403 ? "permission_denied" : "invalid_api_key", retryable: false };
  }
  if (
    status === 400
    || evidence.includes("validationexception")
    || evidence.includes("invalid request")
    || evidence.includes("model unavailable")
    || evidence.includes("model not found")
    || evidence.includes("unsupported model")
    || evidence.includes("profile arn")
    || evidence.includes("malformed")
  ) {
    return { message, status: 400, errorType: "invalid_request_error", code: "invalid_request_error", retryable: false };
  }
  if (
    status === 503
    || evidence.includes("overloaded")
    || evidence.includes("server is busy")
    || evidence.includes("temporarily unavailable")
  ) {
    return { message, status: 503, errorType: "server_error", code: "server_is_overloaded", retryable: true };
  }
  return {
    message,
    status: status && status >= 500 ? status : 502,
    errorType: "server_error",
    code: "upstream_server_error",
    retryable: true,
  };
}

export function safeKiroErrorMessage(headers: Record<string, unknown>, payloadText: string): string {
  return normalizedKiroErrorMessage(headers, payloadText);
}

export function classifyKiroStreamError(
  headers: Record<string, unknown>,
  payloadText: string,
): KiroErrorClassification {
  return classifyKiroFailure(headers, payloadText);
}

export function classifyKiroHttpError(
  status: number,
  headers: Headers | Record<string, unknown>,
  payloadText: string,
): KiroErrorClassification {
  return classifyKiroFailure(headers, payloadText, status);
}

export function classifyKiroEventError(reason: string | undefined, message: string | undefined): KiroErrorClassification {
  const safeReason = reason ? sanitizeUpstreamErrorText(reason).slice(0, 160) : "";
  const safeMessage = message ? sanitizeUpstreamErrorText(message).slice(0, 500) : "Kiro request failed";
  const payload = JSON.stringify({ reason: safeReason, message: safeMessage });
  return classifyKiroFailure({}, payload);
}

export function safeKiroHttpErrorMessage(status: number, headers: Headers | Record<string, unknown>, payloadText: string): string {
  return classifyKiroFailure(headers, payloadText, status).message;
}
