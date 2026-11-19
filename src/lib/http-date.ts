const IMF_FIXDATE_RE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT(?![\s\S])/;
const RFC850_DATE_RE = /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT(?![\s\S])/;
const ASCTIME_DATE_RE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( \d|\d{2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})(?![\s\S])/;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HTTP_MONTH_INDEX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const LEGACY_IMF_FIXDATE_RE = new RegExp(IMF_FIXDATE_RE.source, "i");
const LEGACY_RFC850_DATE_RE = new RegExp(RFC850_DATE_RE.source, "i");
const LEGACY_ASCTIME_DATE_RE = new RegExp(ASCTIME_DATE_RE.source, "i");

function parseUtcDateParts(
  year: number,
  monthName: string,
  day: number,
  hour: number,
  minute: number,
  second: number,
  weekday: string | undefined,
): number | undefined {
  const month = HTTP_MONTH_INDEX[monthName.toLowerCase()];
  if (month === undefined) return undefined;
  // Date has no leap-second representation. Normalize the final UTC second of the day.
  const leapSecond = weekday !== undefined && hour === 23 && minute === 59 && second === 60;
  const clockSecond = leapSecond ? 59 : second;
  const timestamp = Date.UTC(year, month, day, hour, minute, clockSecond);
  const parsed = new Date(timestamp);
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month
    && parsed.getUTCDate() === day
    && parsed.getUTCHours() === hour
    && parsed.getUTCMinutes() === minute
    && parsed.getUTCSeconds() === clockSecond
    && (weekday === undefined || (year >= 1900 && WEEKDAYS[parsed.getUTCDay()] === weekday))
    ? timestamp + (leapSecond ? 1000 : 0)
    : undefined;
}

/** Parse the three HTTP-date forms from RFC 9110 §5.6.7.
 * Legacy mode preserves the combo cooldown parser's case-insensitive syntax and calendar rules.
 */
export function parseHttpDate(
  value: string,
  now: number,
  options?: { legacy?: boolean },
): number | undefined {
  const legacy = options?.legacy === true;
  const weekday = legacy ? undefined : value.slice(0, 3);
  const imf = (legacy ? LEGACY_IMF_FIXDATE_RE : IMF_FIXDATE_RE).exec(value);
  if (imf) {
    return parseUtcDateParts(
      Number(imf[3]), imf[2]!, Number(imf[1]),
      Number(imf[4]), Number(imf[5]), Number(imf[6]), weekday,
    );
  }
  const rfc850 = (legacy ? LEGACY_RFC850_DATE_RE : RFC850_DATE_RE).exec(value);
  if (rfc850) {
    const current = new Date(now);
    const currentYear = current.getUTCFullYear();
    const month = HTTP_MONTH_INDEX[rfc850[2]!.toLowerCase()];
    if (month === undefined) return undefined;
    let year = Math.floor(currentYear / 100) * 100 + Number(rfc850[3]);
    const yearDelta = year - currentYear;
    const candidateTimeOfYear = Date.UTC(
      2000, month, Number(rfc850[1]),
      Number(rfc850[4]), Number(rfc850[5]), Number(rfc850[6]),
    );
    const currentTimeOfYear = Date.UTC(
      2000, current.getUTCMonth(), current.getUTCDate(),
      current.getUTCHours(), current.getUTCMinutes(), current.getUTCSeconds(),
      current.getUTCMilliseconds(),
    );
    if (yearDelta < -50 || (yearDelta === -50 && candidateTimeOfYear < currentTimeOfYear)) {
      year += 100;
    } else if (yearDelta > 50 || (yearDelta === 50 && candidateTimeOfYear > currentTimeOfYear)) {
      year -= 100;
    }
    return parseUtcDateParts(
      year, rfc850[2]!, Number(rfc850[1]),
      Number(rfc850[4]), Number(rfc850[5]), Number(rfc850[6]), weekday,
    );
  }
  const asctime = (legacy ? LEGACY_ASCTIME_DATE_RE : ASCTIME_DATE_RE).exec(value);
  if (!asctime) return undefined;
  return parseUtcDateParts(
    Number(asctime[6]), asctime[1]!, Number(asctime[2]),
    Number(asctime[3]), Number(asctime[4]), Number(asctime[5]), weekday,
  );
}
