/** Inclusive epoch-millisecond bounds, independent of the selected preset. */
export interface UsageTimeWindow {
  readonly since: number;
  readonly until: number;
}

const MAX_DATE_MS = 8_640_000_000_000_000;
const ISO_DATETIME = /^(\d{4}|\+\d{6})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|([+-])(\d{2}):(\d{2}))$/;

function parseTimestamp(input: string | number, name: "since" | "until"): number {
  const invalid = (): never => {
    throw new Error(`${name} must be nonnegative integer epoch milliseconds or a valid full ISO datetime with timezone`);
  };
  let timestamp: number;
  if (typeof input === "number") timestamp = input;
  else if (/^\d+$/.test(input)) timestamp = Number(input);
  else {
    const parts = ISO_DATETIME.exec(input);
    if (!parts) return invalid();
    const year = Number(parts[1]);
    const month = Number(parts[2]);
    const day = Number(parts[3]);
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    // Date.parse normalizes some impossible dates (e.g. February 30).
    // Validate the written calendar fields before applying its timezone offset.
    if (month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]!
      || Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6]) > 59
      || (parts[7] !== "Z" && (Number(parts[9]) > 23 || Number(parts[10]) > 59))) {
      return invalid();
    }
    timestamp = Date.parse(input);
  }
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > MAX_DATE_MS) return invalid();
  return timestamp;
}

/** No bounds selects the preset; supplying either bound requires both. */
export function parseUsageTimeWindow(
  since: string | number | null | undefined,
  until: string | number | null | undefined,
): UsageTimeWindow | undefined {
  if (since == null && until == null) return undefined;
  if (since == null || until == null) throw new Error("since and until must be supplied together");
  const window = { since: parseTimestamp(since, "since"), until: parseTimestamp(until, "until") };
  if (window.since > window.until) throw new Error("since must be less than or equal to until");
  return Object.freeze(window);
}
