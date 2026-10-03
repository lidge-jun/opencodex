const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const BLOCKED_FORWARDED_CLIENT_HEADERS = new Set([
  "authorization",
  "chatgpt-account-id",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "expect",
  "host",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-amz-security-token",
  "x-api-key",
  "api-key",
  "x-goog-api-key",
  "x-oai-attestation",
]);

const ALLOWED_FORWARDED_CLIENT_HEADERS = new Set([
  "originator", "x-client-request-id", "x-codex-app-version", "user-agent",
]);
const MAX_FORWARDED_CLIENT_HEADERS = 64;

/** Normalize one opt-in caller header while refusing credential and transport-owned fields. */
export function normalizeForwardedClientHeaderName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().toLowerCase();
  if (!name || !HEADER_NAME_PATTERN.test(name) || !ALLOWED_FORWARDED_CLIENT_HEADERS.has(name)) return null;
  return name;
}

/** Validate provider.forwardClientHeaders without ever admitting credential-bearing headers. */
export function providerForwardClientHeadersConfigError(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return "forwardClientHeaders must be an array of header names";
  if (value.length > MAX_FORWARDED_CLIENT_HEADERS) {
    return `forwardClientHeaders must contain at most ${MAX_FORWARDED_CLIENT_HEADERS} names`;
  }
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string" || !raw.trim() || !HEADER_NAME_PATTERN.test(raw.trim())) {
      return "forwardClientHeaders must use valid HTTP header names";
    }
    const name = raw.trim().toLowerCase();
    if (BLOCKED_FORWARDED_CLIENT_HEADERS.has(name)) {
      return `forwardClientHeaders must not include credential or transport-owned header "${raw.trim()}"`;
    }
    if (!ALLOWED_FORWARDED_CLIENT_HEADERS.has(name)) {
      return "forwardClientHeaders must use the supported client metadata allowlist";
    }
    if (seen.has(name)) return `forwardClientHeaders must not repeat header "${raw.trim()}"`;
    seen.add(name);
  }
  return null;
}
