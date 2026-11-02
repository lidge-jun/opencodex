/**
 * Client-facing Retry-After formatting, dependency-free so leaf header modules can use it.
 */

/** Longest wait this proxy advertises to a client. Internal cooldowns keep their own parsed values. */
export const MAX_CLIENT_RETRY_AFTER_SECONDS = 3600;

/**
 * Retry advice as bytes this proxy writes: a non-negative integer number of seconds, clamped to
 * {@link MAX_CLIENT_RETRY_AFTER_SECONDS}, or undefined. Accepts delay seconds (including "0" and
 * fractions, rounded up) and HTTP dates (past or current -> "0"). The input string is never echoed.
 * For client headers and bodies only; cooldown and retry scheduling read the parsed evidence.
 */
export function formatClientRetryAfter(value: string | number | null | undefined, now = Date.now()): string | undefined {
  let seconds: number | undefined;
  if (typeof value === "number") {
    seconds = Number.isFinite(value) && value >= 0 ? value : undefined;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 128) return undefined;
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      seconds = Number(trimmed);
    } else if (/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(trimmed)) {
      const at = Date.parse(trimmed);
      if (Number.isFinite(at)) seconds = Math.max(0, (at - now) / 1000);
    }
  }
  if (seconds === undefined || !Number.isFinite(seconds)) return undefined;
  return String(Math.min(MAX_CLIENT_RETRY_AFTER_SECONDS, Math.ceil(seconds)));
}
