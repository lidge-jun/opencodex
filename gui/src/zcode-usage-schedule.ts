/** Advisory only: never changes routing, measured usage or billing estimates.
 * Official rules verified 2026-09-11; Singapore has a fixed UTC+8 offset.
 */
export const ZCODE_USAGE_SOURCE = "https://docs.z.ai/devpack/overview";
export const ZCODE_CAMPAIGN_SOURCE = "https://docs.z.ai/devpack/notice/event-glm-5.3-flash";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const OFFSET = 8 * HOUR;
export const CAMPAIGN_START = Date.parse("2026-09-03T00:00:00+08:00");
// The notice does not explicitly extend the final night into September 21.
// Conservatively stop advertising free usage at the end of September 20 SGT.
export const CAMPAIGN_END = Date.parse("2026-09-21T00:00:00+08:00");

export function zcodeUsageScope(provider: { adapter: string; baseUrl: string; disabled?: boolean }): "zcode" | "coding-plan" | undefined {
  if (provider.disabled) return;
  if (provider.adapter === "zcode") return "zcode";
  try {
    const url = new URL(provider.baseUrl);
    if (url.protocol === "https:" && url.hostname === "api.z.ai" && !url.username && !url.password
      && /^\/api\/coding\/paas\/v4\/?$/.test(url.pathname)) return "coding-plan";
  } catch { /* Non-HTTP local adapters are not Coding Plan endpoints. */ }
}

export function zcodeUsageSchedule(now: number) {
  if (!Number.isFinite(now)) throw new RangeError("Invalid schedule timestamp");
  const shifted = new Date(now + OFFSET);
  const dayStart = Math.floor((now + OFFSET) / DAY) * DAY - OFFSET;
  const weekday = shifted.getUTCDay();
  const hour = shifted.getUTCHours();
  const peak = weekday >= 1 && weekday <= 5 && hour >= 14 && hour < 18;
  let nextPeakStart = dayStart + 14 * HOUR;
  while (nextPeakStart <= now || [0, 6].includes(new Date(nextPeakStart + OFFSET).getUTCDay())) nextPeakStart += DAY;
  const rateChangesAt = peak ? dayStart + 18 * HOUR : nextPeakStart;
  let flashStart = hour < 9 ? dayStart - HOUR : dayStart + 23 * HOUR;
  flashStart = Math.max(flashStart, CAMPAIGN_START);
  const flashEnd = Math.min(hour < 9 ? dayStart + 9 * HOUR : dayStart + DAY + 9 * HOUR, CAMPAIGN_END);
  const campaign = now >= CAMPAIGN_START && now < CAMPAIGN_END;
  return { peak, rateChangesAt, campaign, flashActive: campaign && now >= flashStart && now < flashEnd,
    flashStart, flashEnd };
}

export function formatZcodeLocalTime(timestamp: number, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(timestamp);
}

export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
