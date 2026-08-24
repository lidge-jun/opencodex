export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

export const SSE_HEARTBEAT_COMMENT = ": heartbeat\n\n";

export const SAFE_UPSTREAM_RESPONSE_HEADERS = new Set([
  "content-type",
  "retry-after",
  "cache-control",
]);

export const OPENAI_FORWARDABLE_REQUEST_HEADERS = new Set(["accept"]);

export const ANTHROPIC_FORWARDABLE_REQUEST_HEADERS = new Set([
  "accept",
  "anthropic-beta",
]);
