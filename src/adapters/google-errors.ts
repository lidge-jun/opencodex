import { redactSecretString } from "../redact";

const ABSOLUTE_PATH_PATTERN = /(?:\/Users\/[^ "';,]+|\/home\/[^ "';,]+|\/root\/[^ "';,]*|[A-Za-z]:\\Users\\[^ "';,]+)/g;

function sanitizeGoogleErrorText(value: string): string {
  return redactSecretString(value).replace(ABSOLUTE_PATH_PATTERN, "[REDACTED_PATH]");
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Pull the human detail out of the Google API error envelope `{error:{message,status,code}}`. */
function googleErrorDetail(payloadText: string): { message?: string; status?: string } {
  const trimmed = payloadText.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
    return { message: trimmed || undefined };
  }
  try {
    const parsed = JSON.parse(trimmed) as { error?: { message?: unknown; status?: unknown } };
    const err = parsed.error;
    return { message: safeString(err?.message), status: safeString(err?.status) };
  } catch {
    return {};
  }
}

function classifyGoogle(label: string, status: number | undefined, enumStatus: string | undefined, text: string): string {
  const lower = `${enumStatus ?? ""} ${text}`.toLowerCase();
  const quotaExhausted =
    lower.includes("quotafailure") ||
    lower.includes("quota exceeded") ||
    lower.includes("exceeded your current quota") ||
    lower.includes("billing");
  if (enumStatus === "RESOURCE_EXHAUSTED" && quotaExhausted) return `${label} quota exhausted`;
  if (status === 429 || enumStatus === "RESOURCE_EXHAUSTED" || lower.includes("rate limit")) {
    return `${label} rate limit exceeded`;
  }
  if (status === 401 || enumStatus === "UNAUTHENTICATED" || lower.includes("unauthenticated") || lower.includes("invalid authentication") || lower.includes("expired")) {
    return `${label} authentication failed`;
  }
  if (status === 403 || enumStatus === "PERMISSION_DENIED" || lower.includes("permission denied") || lower.includes("access denied")) {
    return `${label} access denied`;
  }
  if (status === 503 || enumStatus === "UNAVAILABLE" || lower.includes("overloaded") || lower.includes("unavailable")) {
    return `${label} server overloaded`;
  }
  if (status === 400 || status === 404 || enumStatus === "INVALID_ARGUMENT" || enumStatus === "NOT_FOUND" || lower.includes("invalid") || lower.includes("not found") || lower.includes("malformed")) {
    return `${label} invalid request`;
  }
  return `${label} upstream error`;
}

/**
 * Normalize a Google/Vertex/Antigravity HTTP error body into a short, classified, secret-redacted
 * message. Mirrors `kiro-errors.ts`. `label` is the provider-facing prefix ("Vertex AI",
 * "Antigravity").
 */
export function safeGoogleHttpErrorMessage(label: string, status: number, payloadText: string): string {
  const { message, status: enumStatus } = googleErrorDetail(payloadText);
  const prefix = classifyGoogle(label, status, enumStatus, [message, enumStatus].filter(Boolean).join(" "));
  const detail = message ? sanitizeGoogleErrorText(message).slice(0, 500) : `HTTP ${status}`;
  return `${prefix}: ${detail}`;
}

/** Vertex AI HTTP error message (label = "Vertex AI"). */
export function safeVertexHttpErrorMessage(status: number, payloadText: string): string {
  return safeGoogleHttpErrorMessage("Vertex AI", status, payloadText);
}

/** Antigravity (Cloud Code Assist) HTTP error message (label = "Antigravity"). */
export function safeAntigravityHttpErrorMessage(status: number, payloadText: string): string {
  return safeGoogleHttpErrorMessage("Antigravity", status, payloadText);
}

/** Google-family retryable HTTP set (mirrors Kiro). Quota-exhausted is classified above and not retried. */
export function retryableGoogleStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/**
 * True when a 429 body indicates hard quota exhaustion (not a transient rate limit). Quota
 * exhaustion is generally not expected to recover for hours (AIP-194), so it must NOT be retried —
 * unlike a plain rate limit. The HTTP status alone can't distinguish the two, so the retry layer
 * inspects the body with this.
 */
export function isQuotaExhaustedBody(payloadText: string): boolean {
  const { message, status } = googleErrorDetail(payloadText);
  if (status !== "RESOURCE_EXHAUSTED") return false;
  const lower = (message ?? "").toLowerCase();
  return lower.includes("quotafailure")
    || lower.includes("quota exceeded")
    || lower.includes("exceeded your current quota")
    || lower.includes("billing");
}
