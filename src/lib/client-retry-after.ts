/**
 * Client-facing Retry-After formatting, dependency-free so leaf header modules can use it.
 */

/**
 * Longest wait this proxy advertises to a client: eight days, so a weekly usage window's reset
 * (a local Codex account cooldown, for example) still reaches the client intact. Internal cooldowns
 * keep their own parsed values.
 */
export const MAX_CLIENT_RETRY_AFTER_SECONDS = 8 * 24 * 60 * 60;

// RFC 9110 HTTP-date forms: IMF-fixdate, obsolete RFC 850, and asctime. All are GMT; they are
// parsed field by field because Date.parse reads a zoneless asctime date in local time.
const IMF_FIXDATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) ([A-Za-z]{3}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
const RFC850_DATE = /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-([A-Za-z]{3})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
const ASCTIME_DATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) ([A-Za-z]{3}) ([ \d]\d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;
const MONTHS = new Map(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].map((name, index) => [name, index]));

function utcMs(day: string, monthName: string, year: number, hour: string, minute: string, second: string): number | undefined {
  const month = MONTHS.get(monthName.toLowerCase());
  const [d, h, m, s] = [Number(day), Number(hour), Number(minute), Number(second)];
  if (month === undefined || d < 1 || h > 23 || m > 59 || s > 60) return undefined;
  const at = Date.UTC(year, month, d, h, m, s);
  return new Date(at).getUTCDate() === d ? at : undefined;
}

/** Milliseconds since the epoch for an RFC 9110 HTTP-date, or undefined. */
function httpDateMs(value: string, now: number): number | undefined {
  let match = IMF_FIXDATE.exec(value);
  if (match) return utcMs(match[1]!, match[2]!, Number(match[3]), match[4]!, match[5]!, match[6]!);
  match = RFC850_DATE.exec(value);
  if (match) {
    // A two-digit year more than 50 years ahead is read as the previous century (RFC 9110 5.6.7).
    let year = 2000 + Number(match[3]);
    if (year > new Date(now).getUTCFullYear() + 50) year -= 100;
    return utcMs(match[1]!, match[2]!, year, match[4]!, match[5]!, match[6]!);
  }
  match = ASCTIME_DATE.exec(value);
  if (match) return utcMs(match[2]!.trim(), match[1]!, Number(match[6]), match[3]!, match[4]!, match[5]!);
  return undefined;
}

/**
 * Retry advice as bytes this proxy writes: a non-negative integer number of seconds, clamped to
 * {@link MAX_CLIENT_RETRY_AFTER_SECONDS}, or undefined. Accepts delay seconds (including "0" and
 * fractions, rounded up) and HTTP dates in any RFC 9110 form (past or current -> "0"). The input
 * string is never echoed. For client headers and bodies only; cooldown and retry scheduling read
 * the parsed evidence.
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
    } else {
      const at = httpDateMs(trimmed, now);
      if (at !== undefined) seconds = Math.max(0, (at - now) / 1000);
    }
  }
  if (seconds === undefined || !Number.isFinite(seconds)) return undefined;
  return String(Math.min(MAX_CLIENT_RETRY_AFTER_SECONDS, Math.ceil(seconds)));
}

/**
 * Compact client-facing wait, e.g. "45s", "2m", "3h", "2d", derived from the same
 * clamped seconds {@link formatClientRetryAfter} would write. For client-visible
 * messages that name the earliest retry; scheduling still reads the parsed evidence.
 */
export function formatClientRetryIn(value: string | number | null | undefined, now = Date.now()): string | undefined {
  const formatted = formatClientRetryAfter(value, now);
  if (formatted === undefined) return undefined;
  const seconds = Math.max(1, Number(formatted));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.ceil(hours / 24)}d`;
}

/**
 * Name the earliest recovery inside a client-visible sentence: " (retry in ~2m)" goes before a
 * trailing period, or at the end when there is none. Unusable advice leaves the message unchanged,
 * so every listener that shows the same refusal shows the same wait.
 */
export function appendClientRetryIn(message: string, value: string | number | null | undefined, now = Date.now()): string {
  const retryIn = formatClientRetryIn(value, now);
  if (retryIn === undefined) return message;
  const suffix = ` (retry in ~${retryIn})`;
  return message.endsWith(".") ? `${message.slice(0, -1)}${suffix}.` : `${message}${suffix}`;
}
