/**
 * Flexible time parsing and range window resolution for OpenCodex usage analytics.
 */

export interface TimeRangeResolution {
  since: number | null;
  until: number | null;
  rangeLabel: string;
  isCustom: boolean;
}

const RELATIVE_TIME_RE = /^(\d+)\s*(m|min|minute|minutes|h|hr|hour|hours|d|day|days|w|week|weeks)\s*(?:ago)?$/i;
const TIME_OF_DAY_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const DATE_TIME_TO_MINUTE_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}$/;

function startOfLocalDay(ts: number, dayOffset = 0): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  if (dayOffset !== 0) d.setDate(d.getDate() + dayOffset);
  return d.getTime();
}

function endOfLocalDay(ts: number, dayOffset = 0): number {
  const d = new Date(ts);
  d.setHours(23, 59, 59, 999);
  if (dayOffset !== 0) d.setDate(d.getDate() + dayOffset);
  return d.getTime();
}

/**
 * Parse a date/time string, timestamp, or natural language expression into epoch milliseconds.
 */
export function parseTimeBoundary(input: string | number | null | undefined, now = Date.now(), isEndOfWindow = false): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return null;
    // Detect 10-digit seconds timestamp
    return input < 1e11 ? input * 1000 : input;
  }

  const raw = String(input).trim();
  if (!raw) return null;

  // Check pure numeric timestamp
  if (/^\d{10,13}$/.test(raw)) {
    const num = Number(raw);
    return raw.length <= 10 ? num * 1000 : num;
  }

  const lower = raw.toLowerCase();
  if (lower === "now") return now;

  // "today" or "today 14:30"
  if (lower === "today" || lower.startsWith("today ")) {
    const base = startOfLocalDay(now, 0);
    const rest = raw.slice(5).trim();
    if (!rest) return isEndOfWindow ? endOfLocalDay(now, 0) : base;
    const match = rest.match(TIME_OF_DAY_RE);
    if (match) {
      const [_, h, m, s] = match;
      const d = new Date(base);
      d.setHours(Number(h), Number(m), s ? Number(s) : (isEndOfWindow ? 59 : 0), isEndOfWindow ? 999 : 0);
      return d.getTime();
    }
  }

  // "yesterday" or "yesterday 09:17"
  if (lower === "yesterday" || lower.startsWith("yesterday ")) {
    const base = startOfLocalDay(now, -1);
    const rest = raw.slice(9).trim();
    if (!rest) return isEndOfWindow ? endOfLocalDay(now, -1) : base;
    const match = rest.match(TIME_OF_DAY_RE);
    if (match) {
      const [_, h, m, s] = match;
      const d = new Date(base);
      d.setHours(Number(h), Number(m), s ? Number(s) : (isEndOfWindow ? 59 : 0), isEndOfWindow ? 999 : 0);
      return d.getTime();
    }
  }

  // Relative duration like "2h ago", "3d", "30m"
  const relMatch = lower.match(RELATIVE_TIME_RE);
  if (relMatch) {
    const count = Number(relMatch[1]);
    const unit = relMatch[2].toLowerCase();
    let multiplier = 1000;
    if (unit.startsWith("m")) multiplier = 60 * 1000;
    else if (unit.startsWith("h")) multiplier = 3600 * 1000;
    else if (unit.startsWith("d")) multiplier = 86400 * 1000;
    else if (unit.startsWith("w")) multiplier = 7 * 86400 * 1000;
    return now - count * multiplier;
  }

  // Date string with space, e.g. "2026-08-29 09:17:00" -> convert space to T for ISO parsing
  let normalized = raw;
  if (/^\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}/.test(raw)) {
    normalized = raw.replace(/\s+/, "T");
  }

  const parsed = Date.parse(normalized);
  if (!Number.isNaN(parsed)) {
    // If input was date-only like "2026-08-29" and isEndOfWindow is true, extend to end of day
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw) && isEndOfWindow) {
      return endOfLocalDay(parsed, 0);
    }
    if (DATE_TIME_TO_MINUTE_RE.test(raw) && isEndOfWindow) {
      const inclusiveMinute = new Date(parsed);
      inclusiveMinute.setSeconds(59, 999);
      return inclusiveMinute.getTime();
    }
    return parsed;
  }

  return null;
}

/**
 * Resolve window bounds from canonical range and/or custom since/until flags.
 */
export function resolveTimeRange(options: {
  range?: string | null;
  since?: string | number | null;
  until?: string | number | null;
  now?: number;
}): TimeRangeResolution {
  const now = options.now ?? Date.now();
  const customSince = parseTimeBoundary(options.since, now, false);
  const customUntil = parseTimeBoundary(options.until, now, true);

  if (customSince !== null || customUntil !== null) {
    const sinceStr = typeof options.since === "string" ? options.since : (customSince ? new Date(customSince).toISOString().replace("T", " ").slice(0, 19) : "*");
    const untilStr = typeof options.until === "string" ? options.until : (customUntil ? new Date(customUntil).toISOString().replace("T", " ").slice(0, 19) : "*");
    return {
      since: customSince,
      until: customUntil,
      rangeLabel: `${sinceStr} ~ ${untilStr}`,
      isCustom: true,
    };
  }

  const range = (options.range ?? "30d").toLowerCase();
  if (range === "today" || range === "1d") {
    return {
      since: startOfLocalDay(now, 0),
      until: null,
      rangeLabel: "today",
      isCustom: false,
    };
  }
  if (range === "yesterday") {
    return {
      since: startOfLocalDay(now, -1),
      until: endOfLocalDay(now, -1),
      rangeLabel: "yesterday",
      isCustom: false,
    };
  }
  if (range === "7d") {
    return {
      since: startOfLocalDay(now, -6),
      until: null,
      rangeLabel: "7d",
      isCustom: false,
    };
  }
  if (range === "30d") {
    return {
      since: startOfLocalDay(now, -29),
      until: null,
      rangeLabel: "30d",
      isCustom: false,
    };
  }
  if (range === "all") {
    return {
      since: null,
      until: null,
      rangeLabel: "all",
      isCustom: false,
    };
  }

  // Fallback to 30d
  return {
    since: startOfLocalDay(now, -29),
    until: null,
    rangeLabel: "30d",
    isCustom: false,
  };
}
