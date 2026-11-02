import { formatClientRetryAfter } from "../lib/client-retry-after";
import { boundedModelIdentity } from "../lib/model-identity";

/**
 * Upstream response headers a client may receive as response metadata (WebSocket frames, the
 * WS-to-HTTP projection). Each name is listed explicitly and each value is validated or rebuilt
 * against its contract; a value that does not fit is dropped. Nothing is copied by prefix.
 */
type Normalize = (value: string) => string | undefined;

const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;
const OPAQUE_TOKEN = /^[A-Za-z0-9._~+/=:-]{1,8192}$/;
const ETAG = /^(?:W\/)?"?[A-Za-z0-9._:-]{1,128}"?$/;
const LIMIT_NAME = /^[A-Za-z0-9 ._()-]{1,64}$/;

function bool(value: string): string | undefined {
  const folded = value.trim().toLowerCase();
  return folded === "true" || folded === "false" ? folded : undefined;
}

/** A non-negative decimal rebuilt by this proxy (so "1e3", signs and padding never pass through). */
function decimal(max: number, integer = false): Normalize {
  return value => {
    const trimmed = value.trim();
    if (!(integer ? /^\d{1,15}$/ : /^\d{1,15}(?:\.\d{1,6})?$/).test(trimmed)) return undefined;
    const number = Number(trimmed);
    return Number.isFinite(number) && number <= max ? String(number) : undefined;
  };
}

const DURATION_PART = /(\d{1,9}(?:\.\d{1,6})?)(h|ms|m|s)/gy;
const DURATION_UNIT_MS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000, ms: 1 };
const MAX_RESET_MS = 8 * 24 * 60 * 60 * 1000;

/** A rate-limit reset: plain seconds, or a Go-style duration ("6m0s", "20ms"), rebuilt in Go style. */
function resetDuration(value: string): string | undefined {
  const trimmed = value.trim();
  const seconds = decimal(MAX_RESET_MS / 1000)(trimmed);
  if (seconds !== undefined) return seconds;
  if (!trimmed || trimmed.length > 64) return undefined;
  let ms = 0;
  let offset = 0;
  DURATION_PART.lastIndex = 0;
  for (let match = DURATION_PART.exec(trimmed); match; match = DURATION_PART.exec(trimmed)) {
    ms += Number(match[1]) * DURATION_UNIT_MS[match[2]!]!;
    offset = DURATION_PART.lastIndex;
  }
  if (offset !== trimmed.length || !Number.isFinite(ms) || ms > MAX_RESET_MS) return undefined;
  const whole = Math.round(ms);
  if (whole < 1000) return `${whole}ms`;
  const hours = Math.floor(whole / 3_600_000);
  const minutes = Math.floor((whole % 3_600_000) / 60_000);
  const secs = (whole % 60_000) / 1000;
  return `${hours ? `${hours}h` : ""}${hours || minutes ? `${minutes}m` : ""}${secs}s`;
}

const COUNT = decimal(1e12);

const EXACT: Readonly<Record<string, Normalize>> = {
  "retry-after": value => formatClientRetryAfter(value),
  "x-request-id": value => REQUEST_ID.test(value) ? value : undefined,
  "openai-request-id": value => REQUEST_ID.test(value) ? value : undefined,
  "x-codex-turn-state": value => OPAQUE_TOKEN.test(value) ? value : undefined,
  "openai-model": boundedModelIdentity,
  "x-codex-safety-buffering-faster-model": boundedModelIdentity,
  "x-models-etag": value => ETAG.test(value) ? value : undefined,
  "x-reasoning-included": bool,
  "x-codex-credits-has-credits": bool,
  "x-codex-credits-unlimited": bool,
  "x-codex-credits-balance": decimal(1e12),
  "x-codex-safety-buffering-enabled": bool,
  "x-ratelimit-limit": COUNT,
  "x-ratelimit-remaining": COUNT,
  "x-ratelimit-reset": resetDuration,
  "x-ratelimit-limit-requests": COUNT,
  "x-ratelimit-limit-tokens": COUNT,
  "x-ratelimit-remaining-requests": COUNT,
  "x-ratelimit-remaining-tokens": COUNT,
  "x-ratelimit-reset-requests": resetDuration,
  "x-ratelimit-reset-tokens": resetDuration,
  "x-ratelimit-limit-req-minute": COUNT,
  "x-ratelimit-remaining-req-minute": COUNT,
  "x-ratelimit-limit-tokens-minute": COUNT,
  "x-ratelimit-remaining-tokens-minute": COUNT,
  "x-ratelimit-limit-tokens-month": COUNT,
  "x-ratelimit-remaining-tokens-month": COUNT,
  "x-ratelimit-tokens-query-cost": COUNT,
};

// Codex quota windows, optionally per limit family (`x-codex-<family>-primary-used-percent`). The
// family segment follows the same bounded grammar the native rate-limit frame uses.
const QUOTA_WINDOW = /^x-codex(?:-[a-z0-9]+(?:-[a-z0-9]+){0,3})?-(?:primary|secondary|tertiary)-(used-percent|window-minutes|reset-at)$/;
const QUOTA_LIMIT_NAME = /^x-codex(?:-[a-z0-9]+(?:-[a-z0-9]+){0,3})?-limit-name$/;
const QUOTA_VALUE: Readonly<Record<string, Normalize>> = {
  "used-percent": decimal(100),
  "window-minutes": decimal(1e7, true),
  "reset-at": decimal(1e11, true),
};

function normalizer(lower: string): Normalize | undefined {
  if (lower.length > 96) return undefined;
  const exact = EXACT[lower];
  if (exact) return exact;
  const window = QUOTA_WINDOW.exec(lower);
  if (window) return QUOTA_VALUE[window[1]!];
  if (QUOTA_LIMIT_NAME.test(lower)) return value => LIMIT_NAME.test(value) ? value : undefined;
  return undefined;
}

/** True for a header name this proxy may relay as response metadata. */
export function isSafeResponseHeader(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(EXACT, name.toLowerCase()) || normalizer(name.toLowerCase()) !== undefined;
}

/** The value this proxy relays for an allowlisted header, rebuilt or validated; undefined drops it. */
export function normalizeSafeResponseHeader(name: string, value: string): string | undefined {
  const normalize = normalizer(name.toLowerCase());
  return normalize ? normalize(value) : undefined;
}

export function safeResponseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers) {
    const normalized = normalizeSafeResponseHeader(name, value);
    if (normalized !== undefined) out[name.toLowerCase()] = normalized;
  }
  return out;
}
