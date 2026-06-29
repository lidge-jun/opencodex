import { redactSecretString } from "../redact";

const ABSOLUTE_PATH_PATTERN = /(?:\/Users\/[^ "';,]+|\/home\/[^ "';,]+|[A-Za-z]:\\Users\\[^ "';,]+)/g;
const DETAIL_KEYS = ["__type", "code", "error", "name", "message", "Message", "errorMessage"];

function sanitizeKiroErrorText(value: string): string {
  return redactSecretString(value).replace(ABSOLUTE_PATH_PATTERN, "[REDACTED_PATH]");
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function headerValue(headers: Headers | Record<string, unknown>, name: string): string | undefined {
  if (headers instanceof Headers) return name.startsWith(":") ? undefined : safeString(headers.get(name));
  return safeString(headers[name]) || safeString(headers[name.toLowerCase()]);
}

function payloadDetails(payloadText: string): string[] {
  const trimmed = payloadText.trim();
  if (!trimmed) return [];
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return [trimmed];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      return DETAIL_KEYS.map(key => safeString(obj[key])).filter((v): v is string => !!v);
    }
    if (typeof parsed === "string" && parsed.trim()) return [parsed.trim()];
  } catch {
    return [];
  }
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
  const detail = parts.length > 0 ? sanitizeKiroErrorText(parts.join(": ")).slice(0, 500) : status ? `HTTP ${status}` : "";
  const prefix = classifyKiroText(status, [detail, headerType].filter(Boolean).join(" "));
  return detail ? `${prefix}: ${detail}` : prefix;
}

export function safeKiroErrorMessage(headers: Record<string, unknown>, payloadText: string): string {
  return normalizedKiroErrorMessage(headers, payloadText);
}

export function safeKiroHttpErrorMessage(status: number, headers: Headers | Record<string, unknown>, payloadText: string): string {
  return normalizedKiroErrorMessage(headers, payloadText, status);
}
