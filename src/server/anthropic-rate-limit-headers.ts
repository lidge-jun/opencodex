type Normalize = (value: string) => string | undefined;
const MAX_EPOCH = 253402300799;
const STATUS: ReadonlyMap<string, string> = new Map([["allowed", "allowed"], ["rejected", "rejected"]]);
const count: Normalize = value => {
  if (!/^[0-9]{1,16}$/.test(value)) return undefined;
  const n = Number(value);
  return n <= 1e12 ? String(n) : undefined;
};
/** Decimal arithmetic keeps half-up rounding independent of binary floating point. */
function decimal(value: string, grammar: RegExp, max: bigint, digits: number): string | undefined {
  if (!grammar.test(value)) return undefined;
  const [whole = "0", fraction = ""] = value.split(".");
  const scale = 10n ** BigInt(fraction.length);
  const exact = BigInt(whole) * scale + BigInt(fraction || "0");
  if (exact > max * scale) return undefined;
  const outputScale = 10n ** BigInt(digits);
  const rounded = (exact * outputScale * 2n + scale) / (scale * 2n);
  const bounded = rounded > max * outputScale ? max * outputScale : rounded;
  const tail = String(bounded % outputScale).padStart(digits, "0").replace(/0+$/, "");
  return `${bounded / outputScale}${tail ? `.${tail}` : ""}`;
}
const epoch: Normalize = value => decimal(value, /^[0-9]{1,12}(\.[0-9]{1,6})?$/, BigInt(MAX_EPOCH), 3);
const utilization: Normalize = value => decimal(value, /^[0-9]{1,6}(\.[0-9]{1,12})?$/, 100n, 4);
const date: Normalize = value => {
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.([0-9]{1,9}))?([Zz]|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const zone = match[8]!;
  const zoneHour = zone.length === 1 ? 0 : Number(zone.slice(1, 3));
  const zoneMinute = zone.length === 1 ? 0 : Number(zone.slice(4, 6));
  if (year < 1970 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59
    || zoneHour > 23 || zoneMinute > 59 || zone === "-00:00") return undefined;
  const monthDays = (y: number, m: number): number => m === 2
    ? (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28)
    : [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
  if (day > monthDays(year, month)) return undefined;
  let utcYear = year, utcMonth = month, utcDay = day;
  const offset = (zoneHour * 60 + zoneMinute) * 60 * (zone[0] === "-" ? -1 : 1);
  let utcSecond = hour * 3600 + minute * 60 + second - offset;
  if (utcSecond < 0) {
    utcSecond += 86400;
    if (--utcDay === 0) {
      if (--utcMonth === 0) { utcMonth = 12; utcYear--; }
      utcDay = monthDays(utcYear, utcMonth);
    }
  } else if (utcSecond >= 86400) {
    utcSecond -= 86400;
    if (++utcDay > monthDays(utcYear, utcMonth)) {
      utcDay = 1;
      if (++utcMonth === 13) { utcMonth = 1; utcYear++; }
    }
  }
  if (utcYear < 1970 || utcYear > 9999) return undefined;
  const pad = (n: number, digits = 2): string => n.toString().padStart(digits, "0");
  const fraction = (match[7] ?? "").replace(/0+$/, "");
  return `${pad(utcYear, 4)}-${pad(utcMonth)}-${pad(utcDay)}T${pad(Math.floor(utcSecond / 3600))}:${pad(Math.floor(utcSecond / 60) % 60)}:${pad(utcSecond % 60)}${fraction ? `.${fraction}` : ""}Z`;
};
const EXACT: ReadonlyMap<string, Normalize> = new Map([
  ...["requests", "tokens", "input-tokens", "output-tokens"].flatMap(family => [
    [`anthropic-ratelimit-${family}-limit`, count],
    [`anthropic-ratelimit-${family}-remaining`, count],
    [`anthropic-ratelimit-${family}-reset`, date],
  ] as [string, Normalize][]),
  ...["", "-5h", "-7d", "-7d_oi"].flatMap(window => [
    [`anthropic-ratelimit-unified${window}-status`, value => STATUS.get(value)],
    [`anthropic-ratelimit-unified${window}-reset`, epoch],
    ...(window ? [[`anthropic-ratelimit-unified${window}-utilization`, utilization] as [string, Normalize]] : []),
  ] as [string, Normalize][]),
]);
export function anthropicRateLimitHeaders(upstream: Headers): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, normalize] of EXACT) {
    const input = upstream.get(name);
    if (input === null || input.length > 128) continue;
    const value = normalize(input.replace(/^[ \t]+|[ \t]+$/g, ""));
    if (value !== undefined) headers[name] = value;
  }
  return headers;
}
