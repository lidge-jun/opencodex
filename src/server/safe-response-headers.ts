import { formatClientRetryAfter } from "../lib/client-retry-after";
import { knownModelIdentity } from "../lib/model-identity";
import { isLiveTurnStateHandle, issueTurnStateHandle } from "./turn-state-handles";

/**
 * Upstream response headers a client may receive as response metadata (WebSocket frames, the
 * WS-to-HTTP projection). Each name is listed explicitly and each value is validated or rebuilt
 * against its contract; a value that does not fit is dropped. No value is copied: numbers and
 * booleans are reformatted, a model header is kept only as a model id the proxy already knows for
 * the request, and the turn-state token is replaced by a handle bound to the request. Request ids,
 * the models etag and quota limit labels are not relayed.
 */
export type ResponseMetadataContext = {
  /** Binding of the send that produced these headers; without one, a turn-state token is dropped. */
  turnStateBinding?: string;
  /** Model ids the request already names (requested and routed); the bundled catalog also counts. */
  knownModels?: readonly string[];
  /** Provider (or metadata vendor) whose bundled model catalog also counts as known. */
  provider?: string;
};
type Normalize = (value: string, context: ResponseMetadataContext) => string | undefined;

const OPAQUE_TOKEN = /^[A-Za-z0-9._~+/=:-]{1,8192}$/;
const NUMBER = /^\d{1,15}(?:\.\d{1,6})?$/;

function bool(value: string): string | undefined {
  const folded = value.trim().toLowerCase();
  return folded === "true" || folded === "false" ? folded : undefined;
}

function parseNonNegative(value: string): number | undefined {
  const trimmed = value.trim();
  if (!NUMBER.test(trimmed)) return undefined;
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : undefined;
}

/** A non-negative decimal rebuilt by this proxy (so "1e3", signs and padding never pass through). */
function decimal(max: number): Normalize {
  return value => {
    const number = parseNonNegative(value);
    return number !== undefined && number <= max ? String(number) : undefined;
  };
}

/** A non-negative integer formatted by this proxy: fractions round down, large values clamp to max. */
function count(max: number): Normalize {
  return value => {
    const number = parseNonNegative(value);
    return number === undefined ? undefined : String(Math.min(Math.floor(number), max));
  };
}

/** A non-negative integer exact to the contract (an epoch or window length); anything else drops. */
function integer(max: number): Normalize {
  return value => {
    const trimmed = value.trim();
    if (!/^\d{1,15}$/.test(trimmed)) return undefined;
    const number = Number(trimmed);
    return number <= max ? String(number) : undefined;
  };
}

const DURATION_PART = /(\d{1,9}(?:\.\d{1,6})?)(h|ms|m|s)/gy;
const DURATION_UNIT_MS = new Map<string, number>([["h", 3_600_000], ["m", 60_000], ["s", 1_000], ["ms", 1]]);
const MAX_RESET_MS = 8 * 24 * 60 * 60 * 1000;

/**
 * A rate-limit reset: plain seconds, or a Go-style duration ("6m0s", "20ms"). Both are rebuilt from
 * whole units — seconds round up, sub-second durations become whole milliseconds — and clamp to 8 days.
 */
function resetDuration(value: string): string | undefined {
  const trimmed = value.trim();
  const seconds = parseNonNegative(trimmed);
  if (seconds !== undefined) return String(Math.min(Math.ceil(seconds), MAX_RESET_MS / 1000));
  if (!trimmed || trimmed.length > 64) return undefined;
  let ms = 0;
  let offset = 0;
  DURATION_PART.lastIndex = 0;
  for (let match = DURATION_PART.exec(trimmed); match; match = DURATION_PART.exec(trimmed)) {
    ms += Number(match[1]) * DURATION_UNIT_MS.get(match[2]!)!;
    offset = DURATION_PART.lastIndex;
  }
  if (offset === 0 || offset !== trimmed.length || !Number.isFinite(ms)) return undefined;
  const clamped = Math.min(ms, MAX_RESET_MS);
  if (clamped < 1000) return `${Math.ceil(clamped)}ms`;
  const whole = Math.ceil(clamped / 1000);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  return `${hours ? `${hours}h` : ""}${hours || minutes ? `${minutes}m` : ""}${secs}s`;
}

const COUNT = count(1e12);

// A Map, so a header named after an Object.prototype member ("constructor", "__proto__",
// "toString") can never resolve to an inherited value.
const EXACT: ReadonlyMap<string, Normalize> = new Map<string, Normalize>([
  ["retry-after", value => formatClientRetryAfter(value)],
  // Codex echoes the turn-state token on later requests of the turn; it receives a handle bound to
  // this send, which src/server/turn-state-handles.ts maps back only for a send with the same binding.
  ["x-codex-turn-state", (value, context) => !OPAQUE_TOKEN.test(value) ? undefined
    : isLiveTurnStateHandle(value) ? value
    : context.turnStateBinding ? issueTurnStateHandle(value, context.turnStateBinding) : undefined],
  ["openai-model", (value, context) => knownModelIdentity(value, context.knownModels, context.provider)],
  ["x-codex-safety-buffering-faster-model", (value, context) => knownModelIdentity(value, context.knownModels, context.provider)],
  ["x-reasoning-included", bool],
  ["x-codex-credits-has-credits", bool],
  ["x-codex-credits-unlimited", bool],
  ["x-codex-credits-balance", decimal(1e12)],
  ["x-codex-safety-buffering-enabled", bool],
  ["x-ratelimit-limit", COUNT],
  ["x-ratelimit-remaining", COUNT],
  ["x-ratelimit-reset", resetDuration],
  ["x-ratelimit-limit-requests", COUNT],
  ["x-ratelimit-limit-tokens", COUNT],
  ["x-ratelimit-remaining-requests", COUNT],
  ["x-ratelimit-remaining-tokens", COUNT],
  ["x-ratelimit-reset-requests", resetDuration],
  ["x-ratelimit-reset-tokens", resetDuration],
  ["x-ratelimit-limit-req-minute", COUNT],
  ["x-ratelimit-remaining-req-minute", COUNT],
  ["x-ratelimit-limit-tokens-minute", COUNT],
  ["x-ratelimit-remaining-tokens-minute", COUNT],
  ["x-ratelimit-limit-tokens-month", COUNT],
  ["x-ratelimit-remaining-tokens-month", COUNT],
  ["x-ratelimit-tokens-query-cost", COUNT],
]);

/**
 * Codex quota limit families this proxy relays: the ordinary windows (`x-codex-primary-...`) and the
 * metered `bengalfox` family (`x-codex-bengalfox-primary-...`, native `codex_bengalfox`). A header
 * name is upstream text too, so any other family is dropped rather than echoed.
 */
export const CODEX_QUOTA_FAMILIES = ["bengalfox"] as const;
const QUOTA_WINDOW = new RegExp(`^x-codex(?:-(?:${CODEX_QUOTA_FAMILIES.join("|")}))?-(?:primary|secondary|tertiary)-(used-percent|window-minutes|reset-at)$`);
const QUOTA_VALUE: ReadonlyMap<string, Normalize> = new Map<string, Normalize>([
  ["used-percent", decimal(100)],
  ["window-minutes", integer(1e7)],
  ["reset-at", integer(1e11)],
]);

function normalizer(lower: string): Normalize | undefined {
  if (lower.length > 96) return undefined;
  const exact = EXACT.get(lower);
  if (exact) return exact;
  const window = QUOTA_WINDOW.exec(lower);
  if (window) return QUOTA_VALUE.get(window[1]!);
  return undefined;
}

/** True for a header name this proxy may relay as response metadata. */
export function isSafeResponseHeader(name: string): boolean {
  return typeof name === "string" && normalizer(name.toLowerCase()) !== undefined;
}

/** The value this proxy relays for an allowlisted header, rebuilt or validated; undefined drops it. */
export function normalizeSafeResponseHeader(name: string, value: string, context: ResponseMetadataContext = {}): string | undefined {
  if (typeof name !== "string" || typeof value !== "string") return undefined;
  const normalize = normalizer(name.toLowerCase());
  const normalized = normalize?.(value, context);
  return typeof normalized === "string" ? normalized : undefined;
}

export function safeResponseHeaders(headers: Headers, context: ResponseMetadataContext = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers) {
    const normalized = normalizeSafeResponseHeader(name, value, context);
    if (normalized !== undefined) out[name.toLowerCase()] = normalized;
  }
  return out;
}
