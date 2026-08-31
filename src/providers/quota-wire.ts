/**
 * Wire-level helpers shared by every provider quota reader: cache lifetimes, number and
 * timestamp normalisation, and the bounded JSON reader.
 *
 * These lived inside `quota.ts` as module-private functions. A second quota module cannot
 * import them from there without creating a cycle, and copying a TTL constant into a
 * second file is how two copies of the same number drift apart. Everything here is pure or
 * depends only on the bounded-body reader.
 */
import { readBoundedResponseBody } from "../lib/bounded-body";

/** Provider-level quota response cache lifetime (the dashboard/display path). */
export const CACHE_TTL_MS = 5 * 60_000;

/**
 * Per-account quota cache lifetime.
 *
 * Deliberately longer than the provider-level TTL: this path multiplies by account count,
 * and at least one upstream (Anthropic) rate-limits its usage endpoint under repeated
 * probing.
 */
export const ACCOUNT_QUOTA_TTL_MS = 10 * 60_000;

export const REQUEST_TIMEOUT_MS = 8_000;

export const QUOTA_RESPONSE_MAX_BYTES = 512 * 1024;

export const QUOTA_JSON_READ_FAILURE = Symbol("quota-json-read-failure");

/** Unix 0 / negative values are sentinels, not reset clocks (Command Code fiveHour.resetAt: 0). */
export function epochMillis(value: number): number | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const milliseconds = value > 10_000_000_000 ? value : value * 1000;
  // A finite number is not necessarily a representable date. ECMAScript caps time values at
  // ±8.64e15 ms, and `Intl.DateTimeFormat.format()` throws a RangeError past that instead of
  // rendering something wrong. A provider that reports a bogus expiry must not become a
  // rendering fault in every consumer that formats it.
  return Number.isFinite(new Date(milliseconds).getTime()) ? milliseconds : undefined;
}

export function normalizeResetAt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return epochMillis(value);
  if (typeof value === "string" && value.trim()) {
    const trimmed = value.trim();
    // Cursor Connect RPC returns billingCycleEnd as a unix-ms decimal string ("1771077734000").
    // Date.parse treats that as invalid; numeric epoch strings must be handled explicitly.
    if (/^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      return epochMillis(numeric);
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

export function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function normalizePercent(value: unknown): number | undefined {
  const numeric = toFiniteNumber(value);
  return numeric === undefined ? undefined : Math.max(0, Math.min(100, numeric));
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export async function readQuotaJson(
  response: Response,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<unknown | typeof QUOTA_JSON_READ_FAILURE> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > QUOTA_RESPONSE_MAX_BYTES) {
    try {
      void response.body?.cancel(
        new DOMException("Provider quota response is too large", "QuotaExceededError"),
      ).catch(() => undefined);
    } catch {
      // Best-effort cancellation only.
    }
    return QUOTA_JSON_READ_FAILURE;
  }

  try {
    const bounded = await readBoundedResponseBody(response, {
      maxBytes: QUOTA_RESPONSE_MAX_BYTES,
      totalTimeoutMs: timeoutMs,
      inactivityTimeoutMs: timeoutMs,
    });
    if (bounded.oversized || bounded.truncated || !bounded.displaySafe) return QUOTA_JSON_READ_FAILURE;
    return JSON.parse(bounded.text) as unknown;
  } catch {
    return QUOTA_JSON_READ_FAILURE;
  }
}
