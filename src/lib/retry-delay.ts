/**
 * Parse a provider's relative retry hint without mistaking a unit prefix for a
 * complete unit. Kept independent of error classification and combo routing.
 */
const UNIT_SECONDS: Readonly<Record<string, number>> = {
  ms: 0.001, msec: 0.001, msecs: 0.001, millisecond: 0.001, milliseconds: 0.001,
  s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
  m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
  h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
  d: 86400, day: 86400, days: 86400,
};

// Read the WHOLE word before looking it up. In particular, ms is not m and
// "months" must not accidentally become minutes. Digits may follow a unit so
// compact, unambiguous durations such as 1h30m remain supported.
const COMPONENT = /^(\d+(?:\.\d+)?)\s*([a-z]+)(?![a-z_])/i;
const SEPARATOR = /^(?:\s*,\s*(?:and\s+)?|\s+and\s+|\s*\+\s*|\s*)/i;
const MAX_COMPONENTS = 16;

function durationSeconds(tail: string, allowBareSeconds: boolean): number | undefined {
  let rest = tail.trimStart();
  let seconds = 0;
  let components = 0;
  while (true) {
    const component = COMPONENT.exec(rest);
    if (!component) {
      if (components !== 0 || !allowBareSeconds) return undefined;
      // A header-style bare number means seconds. Never salvage the numeric
      // prefix of an unsupported unit, exponent, signed value or clock time.
      const bare = /^(\d+(?:\.\d+)?)(?![\w.:+-])(?=\s*(?:$|[.,;!?)\]}]))/.exec(rest);
      if (!bare) return undefined;
      seconds = Number(bare[1]);
      break;
    }
    const unit = UNIT_SECONDS[component[2]!.toLowerCase()];
    if (unit === undefined) return undefined;
    seconds += Number(component[1]) * unit;
    if (!Number.isFinite(seconds) || ++components > MAX_COMPONENTS) return undefined;
    rest = rest.slice(component[0].length);
    const separator = SEPARATOR.exec(rest)![0];
    const next = rest.slice(separator.length);
    if (!/^[+-]?(?:\d|\.\d)/.test(next)) break;
    // A numeric continuation is part of this duration; a malformed second
    // component must reject the hint, not silently shorten it to the first.
    rest = next;
  }
  const rounded = Math.ceil(seconds);
  return Number.isSafeInteger(rounded) && rounded > 0 ? rounded : undefined;
}

/**
 * Supports reset(s) in, try again in and Retry-After/retry after hints; accepts
 * compound durations and rounds UP once after summing all components.
 * A bare number is permitted only for header-style Retry-After hints, never
 * for "reset in 2026". When a message declares several usable lower bounds,
 * honour the longest one rather than re-entering a still-live quota window.
 */
export function parseRetryAfterFromMessage(message: string): number | undefined {
  const hints = /\b(try\s+again\s+in|retry[- ]after|resets?\s+in)\s*:?\s*/gi;
  let result: number | undefined;
  for (const hint of message.matchAll(hints)) {
    const seconds = durationSeconds(
      message.slice(hint.index! + hint[0].length),
      /^retry[- ]after$/i.test(hint[1]!),
    );
    if (seconds !== undefined) result = Math.max(result ?? 0, seconds);
  }
  return result;
}
