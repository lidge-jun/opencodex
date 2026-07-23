import { redactSecretString } from "../../lib/redact";

const ABSOLUTE_PATH_PATTERN = /(?:\/Users\/[^ "';,]+|\/home\/[^ "';,]+|[A-Za-z]:\\Users\\[^ "';,]+)/g;
// Cursor error messages can contain raw credential key=value pairs beyond what the shared
// redactSecretString covers. We handle the additional transport-specific patterns locally.
const CURSOR_CREDENTIAL_PATTERN = /\b(authorization|auth[_-]?token|cursor[_-]?token)=([^&\s"',;]+)/gi;

function sanitize(value: string): string {
  return redactSecretString(value)
    .replace(CURSOR_CREDENTIAL_PATTERN, "$1=[REDACTED]")
    .replace(ABSOLUTE_PATH_PATTERN, "[REDACTED_PATH]");
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  return String(value ?? "");
}

function errorCode(value: unknown): string {
  if (typeof value !== "object" || !value || !("code" in value)) return "";
  const code = (value as { code?: unknown }).code;
  return code === undefined || code === null ? "" : String(code);
}

/**
 * True when Cursor intentionally cancelled the HTTP/2 stream after a client-tool suspend.
 * These are expected between multi-turn Responses bridge cycles, not upstream failures.
 */
export function isCursorBenignCancelError(value: unknown): boolean {
  const message = errorMessage(value).toLowerCase();
  const code = errorCode(value).toUpperCase();
  if (code === "NGHTTP2_CANCEL") return true;
  if (message.includes("nghttp2_cancel")) return true;
  if (message.includes("cursor stream suspended")) return true;
  return false;
}

/**
 * True when Cursor Connect rejected the turn with invalid_argument.
 * Seen after stepCompleted on brittle external-model continuations.
 */
export function isCursorInvalidArgumentError(value: unknown): boolean {
  const code = errorCode(value).toLowerCase();
  if (code === "invalid_argument") return true;
  const message = errorMessage(value).toLowerCase();
  return message.includes("invalid_argument");
}

const QUOTA_RATE_CUES = ["too many requests", "quota", "rate limit", "rate-limit", "throttl"];
const REQUEST_TOO_LARGE_PATTERNS: (string | RegExp)[] = [
  "tool catalog too large",
  "tool registration too large",
  "too many tools",
  "message too large",
  "payload too large",
  "request too large",
  // Size cue required somewhere: a bare "request exceeds ... limit" (concurrency/quota
  // shape) must NOT match, but "request body/size exceeds ... limit" and
  // "request exceeds maximum allowed size" are deterministic overflow (WP3 r1/r2).
  /request exceeds .*size/,
  /request (?:body|size) exceeds .*(?:size|limit)/,
  "maximum allowed size",
];

/**
 * True when a resource_exhausted detail names a request-size overflow rather than quota.
 * Quota/rate cues are rejected FIRST: "resource_exhausted while loading tool catalog: quota
 * exhausted" is rate limiting, not a too-large request, even though it mentions the catalog.
 */
export function isCursorRequestTooLargeDetail(lowerMessage: string): boolean {
  if (QUOTA_RATE_CUES.some(cue => lowerMessage.includes(cue))) return false;
  return REQUEST_TOO_LARGE_PATTERNS.some(pattern =>
    typeof pattern === "string" ? lowerMessage.includes(pattern) : pattern.test(lowerMessage),
  );
}

/**
 * Classify a Cursor transport/Connect/gRPC error message into an actionable category.
 * The returned prefix string is recognized by `src/lib/errors.ts` `classifyError` keywords,
 * so bridge-level error mapping produces the right Codex error type (rate_limit, auth, etc.).
 */
export function classifyCursorError(message: string): string {
  const lower = message.toLowerCase();

  if (isCursorBenignCancelError(message)) return "Cursor stream suspended";

  if (
    lower.includes("resource_exhausted") ||
    lower.includes("resource exhausted")
  ) {
    // gRPC RESOURCE_EXHAUSTED is quota/rate exhaustion unless the detail names a
    // request-size overflow (tool catalog/registration). Only the latter is a
    // client-fixable 400; everything else surfaces as a 429 so Codex backs off
    // instead of hammering retries (live evidence: 6x 400 retry storm, devlog
    // 260723_cursor_context_continuity/000_plan.md).
    return isCursorRequestTooLargeDetail(lower)
      ? "Cursor resource limit exceeded"
      : "Cursor rate limit exceeded";
  }

  if (
    lower.includes("rate limit") ||
    lower.includes("rate-limit") ||
    lower.includes("too many requests") ||
    lower.includes("throttling")
  ) return "Cursor rate limit exceeded";

  if (
    lower.includes("unauthenticated") ||
    lower.includes("unauthorized") ||
    lower.includes("permission_denied") ||
    lower.includes("permission denied") ||
    lower.includes("forbidden") ||
    lower.includes("invalid token") ||
    lower.includes("expired token") ||
    lower.includes("authentication") ||
    lower.includes("access denied")
  ) return "Cursor authentication failed";

  if (
    lower.includes("unavailable") ||
    lower.includes("overloaded") ||
    lower.includes("temporarily") ||
    lower.includes("server is busy")
  ) return "Cursor server overloaded";

  if (
    lower.includes("invalid") ||
    lower.includes("not found") ||
    lower.includes("unsupported") ||
    lower.includes("malformed") ||
    lower.includes("unimplemented")
  ) return "Cursor invalid request";

  if (
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("etimedout") ||
    lower.includes("deadline")
  ) return "Cursor request timed out";

  if (
    lower.includes("econnreset") ||
    lower.includes("econnrefused") ||
    lower.includes("goaway") ||
    lower.includes("nghttp2") ||
    lower.includes("socket hang up") ||
    lower.includes("connection reset")
  ) return "Cursor connection failed";

  return "Cursor upstream error";
}

/**
 * Produce a user-facing, secret-safe Cursor error message with an actionable category prefix.
 * Mirrors `safeKiroErrorMessage` / `safeKiroHttpErrorMessage` in kiro-errors.ts.
 */
export function safeCursorErrorMessage(rawMessage: string): string {
  const prefix = classifyCursorError(rawMessage);
  const detail = sanitize(rawMessage)
    .replace(/resource[_ ]exhausted/gi, "resource limit exceeded")
    .slice(0, 500);
  return detail ? `${prefix}: ${detail}` : prefix;
}
