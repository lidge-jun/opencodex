import { parseHttpDate } from "../lib/http-date";

export const MAX_COOLDOWN_MS = 10 * 60_000;
export const MAX_SERVER_DELAY_MS = 24 * 60 * 60_000;

/** Parse a Retry-After delay, optionally retaining an upstream delay up to one day. */
export function parseRetryAfterMs(
  value: string | null | undefined,
  now = Date.now(),
  options?: { preserveImmediate?: boolean; preserveServerDelay?: boolean },
): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  // Keep legacy bounded parsing for other callers. Combo cooldowns preserve
  // multi-hour upstream delays, but never quarantine a target beyond one day.
  const maximum = options?.preserveServerDelay === true
    ? MAX_SERVER_DELAY_MS
    : MAX_COOLDOWN_MS;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    if (
      Number.isFinite(seconds)
      && (seconds > 0 || (options?.preserveImmediate && seconds === 0))
    ) {
      return Math.min(Math.max(Math.ceil(seconds * 1000), 1), maximum);
    }
  }
  const timestamp = parseHttpDate(text, now, { legacy: true });
  if (timestamp === undefined) return undefined;
  const delay = timestamp - now;
  if (delay > 0) return Math.min(delay, maximum);
  return options?.preserveImmediate ? 1 : undefined;
}
