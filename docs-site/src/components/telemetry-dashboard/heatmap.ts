import { finiteNonNegativeInt, formatExactNumber, safeAddInt } from "./format";
import type {
  HeatmapCalendar,
  HeatmapCell,
  HeatmapGrade,
  HeatmapMonthMarker,
  TelemetryStatsV1,
} from "./types";

const DAY_MS = 86_400_000;
const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SHORT_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export function formatLocalizedMonthShort(
  monthIndex: number,
  locale = "en-US",
): string {
  const safeMonth = Math.max(0, Math.min(11, Math.floor(monthIndex)));
  try {
    const d = new Date(Date.UTC(2026, safeMonth, 15));
    return new Intl.DateTimeFormat(locale, {
      month: "short",
      timeZone: "UTC",
    }).format(d);
  } catch {
    return SHORT_MONTHS[safeMonth] ?? "Jan";
  }
}

export function getLocalizedWeekdayLabels(locale = "en-US"): {
  mon: string;
  wed: string;
  fri: string;
} {
  try {
    const fmt = new Intl.DateTimeFormat(locale, {
      weekday: "short",
      timeZone: "UTC",
    });
    // 2026-01-05 is Monday, 2026-01-07 is Wednesday, 2026-01-09 is Friday (UTC)
    return {
      mon: fmt.format(new Date(Date.UTC(2026, 0, 5))),
      wed: fmt.format(new Date(Date.UTC(2026, 0, 7))),
      fri: fmt.format(new Date(Date.UTC(2026, 0, 9))),
    };
  } catch {
    return { mon: "Mon", wed: "Wed", fri: "Fri" };
  }
}

export function parseUtcDayMs(day: string): number | null {
  const match = DAY_KEY_RE.exec(day);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const date = Number(match[3]);
  const ms = Date.UTC(year, month, date);
  const check = new Date(ms);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month ||
    check.getUTCDate() !== date
  ) {
    return null;
  }
  return ms;
}

export function formatUtcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * 5-grade intensity bucket adapted from junhoyeo/tokscale `getContributionIntensity` (MIT).
 */
export function computeHeatmapGrade(
  activeInstalls: number,
  maxActiveInstalls: number,
): HeatmapGrade {
  const value = finiteNonNegativeInt(activeInstalls);
  const max = finiteNonNegativeInt(maxActiveInstalls);
  if (value <= 0 || max <= 0) return 0;
  const ratio = value / max;
  if (ratio >= 0.75) return 4;
  if (ratio >= 0.5) return 3;
  if (ratio >= 0.25) return 2;
  return 1;
}

export function buildHeatmapCalendar(
  heatmap: TelemetryStatsV1["heatmap"] | null | undefined,
  locale = "en-US",
): HeatmapCalendar {
  const byDayMs = new Map<number, { date: string; activeInstalls: number }>();
  for (const row of heatmap ?? []) {
    if (!row || typeof row.day !== "string") continue;
    const ms = parseUtcDayMs(row.day);
    if (ms === null) continue;
    const count = finiteNonNegativeInt(row.activeInstalls);
    const prev = byDayMs.get(ms);
    byDayMs.set(ms, {
      date: row.day,
      activeInstalls: prev ? safeAddInt(prev.activeInstalls, count) : count,
    });
  }

  const sortedMs = [...byDayMs.keys()].sort((a, b) => a - b);
  if (sortedMs.length === 0) {
    return {
      cells: [],
      weekCount: 0,
      activeDays: 0,
      totalActiveInstalls: 0,
      maxActiveInstalls: 0,
      peakDay: null,
      startDate: null,
      endDate: null,
      monthMarkers: [],
    };
  }

  const firstMs = sortedMs[0]!;
  const lastMs = sortedMs[sortedMs.length - 1]!;

  let maxActiveInstalls = 0;
  let activeDays = 0;
  let totalActiveInstalls = 0;
  let peakDay: { date: string; activeInstalls: number } | null = null;

  for (const ms of sortedMs) {
    const entry = byDayMs.get(ms)!;
    totalActiveInstalls = safeAddInt(totalActiveInstalls, entry.activeInstalls);
    if (entry.activeInstalls > 0) {
      activeDays += 1;
      if (entry.activeInstalls > maxActiveInstalls) {
        maxActiveInstalls = entry.activeInstalls;
      }
      if (
        !peakDay ||
        entry.activeInstalls > peakDay.activeInstalls ||
        (entry.activeInstalls === peakDay.activeInstalls && entry.date < peakDay.date)
      ) {
        peakDay = { date: entry.date, activeInstalls: entry.activeInstalls };
      }
    }
  }

  const calendarStartMs = firstMs - new Date(firstMs).getUTCDay() * DAY_MS;
  const calendarEndMs = lastMs + (6 - new Date(lastMs).getUTCDay()) * DAY_MS;
  const totalGridDays = Math.round((calendarEndMs - calendarStartMs) / DAY_MS) + 1;
  const weekCount = Math.round(totalGridDays / 7);

  const cells: HeatmapCell[] = [];
  for (let offset = 0; offset < totalGridDays; offset++) {
    const ms = calendarStartMs + offset * DAY_MS;
    const date = formatUtcDayKey(ms);
    const inRange = ms >= firstMs && ms <= lastMs;
    const selectable = inRange;
    const activeInstalls = selectable ? (byDayMs.get(ms)?.activeInstalls ?? 0) : 0;
    const grade = selectable
      ? computeHeatmapGrade(activeInstalls, maxActiveInstalls)
      : 0;
    cells.push({
      date,
      activeInstalls,
      grade,
      inRange,
      selectable,
      weekIndex: Math.floor(offset / 7),
      dayOfWeek: offset % 7,
    });
  }

  const monthMarkers: HeatmapMonthMarker[] = [];
  const seenWeeks = new Set<number>();
  let cursorMs = firstMs;
  while (cursorMs <= lastMs) {
    const d = new Date(cursorMs);
    const monthIndex = d.getUTCMonth();
    const weekIndex = Math.floor((cursorMs - calendarStartMs) / (DAY_MS * 7));
    if (!seenWeeks.has(weekIndex)) {
      const marker: HeatmapMonthMarker = {
        label: formatLocalizedMonthShort(monthIndex, locale),
        monthIndex,
        weekIndex,
      };
      const prev = monthMarkers[monthMarkers.length - 1];
      if (prev && weekIndex - prev.weekIndex < 3) {
        if (prev.weekIndex === 0) {
          monthMarkers[monthMarkers.length - 1] = marker;
        }
      } else {
        monthMarkers.push(marker);
      }
      seenWeeks.add(weekIndex);
    }
    cursorMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }

  return {
    cells,
    weekCount,
    activeDays,
    totalActiveInstalls,
    maxActiveInstalls,
    peakDay,
    startDate: formatUtcDayKey(firstMs),
    endDate: formatUtcDayKey(lastMs),
    monthMarkers,
  };
}

export type HeatmapNavigationKey =
  | "ArrowUp"
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowRight"
  | "Home"
  | "End";

export function navigateHeatmapDate(
  cells: readonly HeatmapCell[],
  currentDate: string,
  key: HeatmapNavigationKey,
): string | null {
  const selectable = cells.filter((cell) => cell.selectable);
  if (selectable.length === 0) return null;
  if (key === "Home") return selectable[0]!.date;
  if (key === "End") return selectable[selectable.length - 1]!.date;

  const idx = selectable.findIndex((cell) => cell.date === currentDate);
  if (idx === -1) return selectable[selectable.length - 1]!.date;

  const delta =
    key === "ArrowUp"
      ? -1
      : key === "ArrowDown"
        ? 1
        : key === "ArrowLeft"
          ? -7
          : 7;
  const nextIdx = Math.max(0, Math.min(selectable.length - 1, idx + delta));
  return selectable[nextIdx]!.date;
}

export function formatHeatmapCellAriaLabel(
  cell: Pick<HeatmapCell, "date" | "activeInstalls" | "grade">,
  locale = "en-US",
  unitLabel = "active installs",
): string {
  const count = formatExactNumber(cell.activeInstalls, locale);
  if (locale.toLowerCase().startsWith("en") && unitLabel === "active installs") {
    return `${cell.date}: ${count} active installs (grade ${cell.grade})`;
  }
  return `${cell.date}: ${count} ${unitLabel} (${cell.grade}/4)`;
}
