import { formatClientRetryAfter } from "../lib/client-retry-after";

const SAFE_RESPONSE_HEADER_EXACT = new Set([
  "retry-after", "x-request-id", "openai-request-id", "x-codex-turn-state",
  "openai-model", "x-models-etag", "x-reasoning-included",
  "x-codex-credits-has-credits", "x-codex-credits-unlimited", "x-codex-credits-balance",
  "x-codex-promo-message", "x-codex-safety-buffering-enabled", "x-codex-safety-buffering-faster-model",
]);

/** Response metadata may carry only the same non-credential headers as native WS errors. */
export function isSafeResponseHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return SAFE_RESPONSE_HEADER_EXACT.has(lower)
    || lower.startsWith("x-ratelimit-")
    || /^x-codex(?:-[a-z0-9-]+)?-(primary|secondary|tertiary)-(used-percent|window-minutes|reset-at)$/.test(lower)
    || /^x-codex(?:-[a-z0-9-]+)?-limit-name$/.test(lower);
}

export function safeResponseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers) {
    if (!isSafeResponseHeader(name)) continue;
    if (name.toLowerCase() === "retry-after") {
      // Retry advice leaves as an integer this proxy formats, never the upstream bytes.
      const advice = formatClientRetryAfter(value);
      if (advice !== undefined) out["retry-after"] = advice;
    } else out[name.toLowerCase()] = value;
  }
  return out;
}
