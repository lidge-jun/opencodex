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

/**
 * Classify a Cursor transport/Connect/gRPC error message into an actionable category.
 * The returned prefix string is recognized by `src/errors.ts` `classifyError` keywords,
 * so bridge-level error mapping produces the right Codex error type (rate_limit, auth, etc.).
 */
export function classifyCursorError(message: string): string {
  const lower = message.toLowerCase();

  if (
    lower.includes("resource_exhausted") ||
    lower.includes("resource exhausted") ||
    lower.includes("rate limit") ||
    lower.includes("rate-limit") ||
    lower.includes("too many requests") ||
    lower.includes("quota")
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
  const detail = sanitize(rawMessage).slice(0, 500);
  const prefix = classifyCursorError(rawMessage);
  return detail ? `${prefix}: ${detail}` : prefix;
}
