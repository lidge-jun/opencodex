import { parseUpstreamJsonPayload, safeUpstreamErrorString, sanitizeUpstreamErrorText } from "./upstream-http-error";

/** Pull the human detail out of the Google API error envelope `{error:{message,status,code}}`. */
function googleErrorDetail(payloadText: string): { message?: string; status?: string } {
  const trimmed = payloadText.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
    return { message: trimmed || undefined };
  }
  const parsed = parseUpstreamJsonPayload(trimmed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const err = (parsed as { error?: { message?: unknown; status?: unknown } }).error;
  return {
    message: safeUpstreamErrorString(err?.message),
    status: safeUpstreamErrorString(err?.status),
  };
}



const GOOGLE_QUOTA_EXHAUSTED_NEEDLES = [
  "quotafailure",
  "quota exceeded",
  "exceeded your current quota",
  "billing",
  "individual quota reached",
  "quota reached",
  "enable overages",
  "exhausted your capacity",
  "daily limit reached",
  "weekly limit reached",
];

// Per-minute / per-second / concurrency limits are transient rate limits: they should be
// retried, not treated as hard quota exhaustion. These guards run before the needles so a
// message like "Per-minute quota exceeded" stays in the retryable bucket.
const GOOGLE_TRANSIENT_RATE_LIMIT_PATTERNS = [
  "per minute",
  "per-minute",
  "per min",
  "rpm",
  "requests per minute",
  "too many requests",
  "rate limit",
  "retry after",
  // Upstream writes the header name both ways in prose ("retry-after: 60"); matching only the
  // spaced spelling let a transient 429 fall through to the exhaustion needles below.
  "retry-after",
  "concurrent request limit",
];

export function isGoogleQuotaExhaustedText(text: string): boolean {
  const lower = text.toLowerCase();
  if (GOOGLE_TRANSIENT_RATE_LIMIT_PATTERNS.some(needle => lower.includes(needle))) return false;
  return GOOGLE_QUOTA_EXHAUSTED_NEEDLES.some(needle => lower.includes(needle));
}


function classifyGoogle(label: string, status: number | undefined, enumStatus: string | undefined, text: string): string {
  const lower = `${enumStatus ?? ""} ${text}`.toLowerCase();
  const quotaExhausted = isGoogleQuotaExhaustedText(lower);
  if ((!enumStatus || enumStatus === "RESOURCE_EXHAUSTED") && quotaExhausted) return `${label} quota exhausted`;
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
  const detail = message ? sanitizeUpstreamErrorText(message).slice(0, 500) : `HTTP ${status}`;
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
  if (status && status !== "RESOURCE_EXHAUSTED") return false;
  return isGoogleQuotaExhaustedText(message ?? payloadText);
}
