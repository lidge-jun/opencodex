import type { CSSProperties } from "react";
import type { SourceFilter } from "./usage-source";
import type { UsageApp as UsageAppClient } from "../../../../src/usage/app-breakdown";
import type { Locale, TFn } from "../../i18n/shared";
import { formatTokens } from "../../format-tokens";
import type { UsageReadMetadata } from "../../usage-summary-resource";

/*
 * Shapes and pure helpers behind the v2 Usage report. The response shapes mirror
 * `src/usage/summary.ts`; every field a proxy may omit stays optional here.
 */

export type Range = "all" | "30d" | "7d";
export type UsageSurface = "all" | "codex" | "claude" | "grok";

export interface UsageSummaryTotals {
  throughputTokensPerSec?: number;
  throughputSamples?: number;
  requests: number;
  measuredRequests: number;
  reportedRequests: number;
  unreportedRequests: number;
  unsupportedRequests: number;
  estimatedRequests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  coverageRatio: number;
  estimatedCostUsd?: number;
  pricedRequests?: number;
  unpricedRequests?: number;
  unmeteredRequests?: number;
}

export interface UsageDayModel {
  model: string;
  provider: string;
  requests: number;
  totalTokens: number;
}

export interface UsageDay {
  date: string;
  requests: number;
  measuredRequests: number;
  reportedRequests: number;
  totalTokens: number;
  /** Newer proxies price each day; older ones omit it. */
  estimatedCostUsd?: number;
  models: UsageDayModel[];
}

export interface UsageModel {
  provider: string;
  model: string;
  resolvedModel?: string;
  requests: number;
  measuredRequests: number;
  reportedRequests: number;
  estimatedRequests: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  throughputTokensPerSec?: number;
  throughputSamples?: number;
  cachedInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheHitRate?: number | null;
  /** Input tokens whose cache detail was observed; hit rate is not model-wide below inputTokens. */
  cacheObservedInputTokens?: number;
  /** API list-price estimate for the priced portion of this row. */
  estimatedCostUsd?: number;
  /** Requests included in the API list-price estimate. */
  pricedRequests?: number;
  /** Requests excluded from the estimate because price or usable usage is unavailable. */
  unpricedRequests?: number;
  shareRatio: number;
}

export interface UsageProvider {
  provider: string;
  requests: number;
  measuredRequests: number;
  reportedRequests: number;
  estimatedRequests: number;
  totalTokens: number;
  throughputTokensPerSec?: number;
  throughputSamples?: number;
  /** API list-price estimate for the priced portion of this row. */
  estimatedCostUsd?: number;
  /** Requests included in the API list-price estimate. */
  pricedRequests?: number;
  /** Requests excluded from the estimate because price or usable usage is unavailable. */
  unpricedRequests?: number;
  shareRatio: number;
}

export interface UsageApp {
  client: UsageAppClient;
  requests: number;
  measuredRequests: number;
  totalTokens: number;
  estimatedCostUsd?: number;
  pricedRequests: number;
  unpricedRequests: number;
  shareRatio: number;
}

export interface UsageResponse extends UsageReadMetadata {
  sourceFilter?: SourceFilter;
  legacyUnclassifiedRequests?: number;
  range: Range;
  surface: UsageSurface;
  since: number | null;
  until?: number;
  customWindow?: boolean;
  generatedAt: number;
  summary: UsageSummaryTotals;
  days: UsageDay[];
  models: UsageModel[];
  providers: UsageProvider[];
  /** Older proxies do not provide a breakdown by app. */
  apps?: UsageApp[];
  historyTruncated: boolean;
  truncatedPrefixBytes: number;
  entriesTruncated: boolean;
  entriesDropped: number;
  // Bounds of the rows the bounded reader loaded, before any range or surface filtering.
  // Describes the read, not the query, and is never a completeness claim (#1497).
  // Optional because a dashboard can talk to a proxy that predates these fields.
  snapshotWindowStart?: number | null;
  snapshotWindowEnd?: number | null;
  error?: string;
}

export function formatPct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function formatOptionalTokens(value: number | undefined, locale: Locale, unavailable: string): string {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? formatTokens(value, locale)
    : unavailable;
}

export function formatOptionalPct(value: number | null | undefined, unavailable: string): string {
  return typeof value === "number" && Number.isFinite(value) ? formatPct(value) : unavailable;
}

/**
 * Why a row's hit rate covers less than its input, or why it has none at all.
 *
 * The rate is an average over the input tokens whose cache detail was actually reported, so a
 * provider that reports reads and never reports writes still has one. Only a row where nothing
 * reported cache detail has nothing to average, and that is the row that shows an em dash.
 */
export function cacheHitRateTitle(model: UsageModel, locale: Locale, t: TFn): string | undefined {
  if (typeof model.cacheHitRate !== "number" || !Number.isFinite(model.cacheHitRate)) {
    return t("usage.cacheHitRate.unmeasured");
  }
  const observed = model.cacheObservedInputTokens;
  if (typeof observed !== "number" || !Number.isFinite(observed) || observed >= model.inputTokens) {
    return undefined;
  }
  return t("usage.cacheHitRate.partial", {
    measured: formatTokens(observed, locale),
    total: formatTokens(model.inputTokens, locale),
  });
}

export function hasThroughput(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function throughputTitle(row: { throughputTokensPerSec?: number; throughputSamples?: number }, t: TFn): string {
  return hasThroughput(row.throughputTokensPerSec)
    ? t("usage.throughput.title", { samples: row.throughputSamples ?? 0 })
    : t("usage.throughput.unmeasured");
}

function isoDate(day: Date): string {
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

/**
 * The last `count` calendar days (oldest → newest), zero-filled. Current proxies already
 * zero-fill their preset windows, but an older one only lists days with activity, and the bar
 * chart needs a stable axis either way.
 */
export function lastDays(days: UsageDay[], count: number): UsageDay[] {
  const byDate = new Map(days.map(d => [d.date, d]));
  const out: UsageDay[] = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  cursor.setDate(cursor.getDate() - (count - 1));
  for (let i = 0; i < count; i++) {
    const iso = isoDate(cursor);
    const d = byDate.get(iso);
    out.push({
      date: iso,
      requests: d?.requests ?? 0,
      measuredRequests: d?.measuredRequests ?? 0,
      reportedRequests: d?.reportedRequests ?? 0,
      totalTokens: d?.totalTokens ?? 0,
      ...(d?.estimatedCostUsd !== undefined ? { estimatedCostUsd: d.estimatedCostUsd } : {}),
      models: d?.models ?? [],
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

export function formatCalendarDate(date: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(`${date}T12:00:00`));
}

export function dayDetail(day: Pick<UsageDay, "date" | "requests" | "totalTokens">, locale: Locale, t: TFn): string {
  return t("usage.chart.dayDetail", {
    date: formatCalendarDate(day.date, locale),
    requests: day.requests,
    tokens: formatTokens(day.totalTokens, locale),
  });
}

/** Fixed-position style that keeps a chart tooltip inside the viewport gutters. */
export function chartTipPosition(rect: DOMRect): CSSProperties {
  const gutter = 8;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const maxWidth = Math.min(240, Math.max(0, viewportWidth - gutter * 2));
  const left = Math.max(gutter, Math.min(rect.left + rect.width / 2 - maxWidth / 2, viewportWidth - gutter - maxWidth));
  const above = rect.top - gutter > viewportHeight - rect.bottom - gutter;
  const vertical = above
    ? (() => {
        const bottom = Math.max(gutter, Math.min(viewportHeight - gutter, viewportHeight - rect.top + gutter));
        return { bottom, maxHeight: Math.max(0, viewportHeight - bottom - gutter) };
      })()
    : (() => {
        const top = Math.max(gutter, Math.min(viewportHeight - gutter, rect.bottom + gutter));
        return { top, maxHeight: Math.max(0, viewportHeight - top - gutter) };
      })();
  return { left, maxWidth, ...vertical };
}

/** A round axis ceiling (1, 2, 2.5 or 5 × 10ⁿ) at or above `max`, so tick labels read cleanly. */
export function niceCeiling(max: number): number {
  if (!(max > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (step * magnitude >= max) return step * magnitude;
  }
  return 10 * magnitude;
}

function quantileBuckets(values: number[]): number[] {
  const positive = values.filter(v => v > 0).sort((a, b) => a - b);
  if (positive.length === 0) return [0, 0, 0, 0];
  const q = (p: number) => positive[Math.min(positive.length - 1, Math.floor(p * positive.length))];
  return [q(0.25), q(0.5), q(0.75), q(0.95)];
}

function bucketLevel(value: number, buckets: number[]): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0) return 0;
  if (value <= buckets[0]) return 1;
  if (value <= buckets[1]) return 2;
  if (value <= buckets[2]) return 3;
  return 4;
}

export interface HeatmapCell {
  date: string;
  requests: number;
  totalTokens: number;
  level: 0 | 1 | 2 | 3 | 4;
  dayOfWeek: number;
}

export interface Heatmap {
  weeks: HeatmapCell[][];
  /** Month index (0 = January) per column it starts in; the view formats it for the locale. */
  months: { month: number; col: number }[];
  buckets: number[];
}

export function buildHeatmap(days: UsageDay[], customWindow = false): Heatmap {
  const buckets = quantileBuckets(days.map(d => d.totalTokens));
  if (customWindow) {
    const weeks: HeatmapCell[][] = [];
    const months: { month: number; col: number }[] = [];
    let week: HeatmapCell[] = [];
    let weekStart: number | undefined;
    let previousMonth = -1;
    let lastMonthCol = -4;
    const pad = (length: number) => {
      while (week.length < length) week.push({ date: "", requests: 0, totalTokens: 0, level: 0, dayOfWeek: week.length });
    };
    // The server already supplied the bounded civil dates. Local midnight stepping
    // can retain a shifted hour across DST and omit the final day of the report.
    for (const day of days) {
      const [year, month, date] = day.date.split("-").map(Number);
      const calendar = new Date(Date.UTC(year, month - 1, date));
      const weekday = calendar.getUTCDay();
      const nextWeekStart = calendar.getTime() - weekday * 86_400_000;
      if (weekStart !== nextWeekStart) {
        if (week.length > 0) { pad(7); weeks.push(week); }
        week = [];
        weekStart = nextWeekStart;
      }
      const monthIndex = calendar.getUTCMonth();
      if (monthIndex !== previousMonth && weeks.length - lastMonthCol >= 4) {
        months.push({ month: monthIndex, col: weeks.length });
        previousMonth = monthIndex;
        lastMonthCol = weeks.length;
      }
      pad(weekday);
      week.push({ date: day.date, requests: day.requests, totalTokens: day.totalTokens,
        level: bucketLevel(day.totalTokens, buckets), dayOfWeek: weekday });
    }
    if (week.length > 0) { pad(7); weeks.push(week); }
    return { weeks, months, buckets };
  }
  const dayMap = new Map(days.map(d => [d.date, d]));

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - 364);
  start.setDate(start.getDate() - start.getDay());

  const weeks: HeatmapCell[][] = [];
  const months: { month: number; col: number }[] = [];
  let lastMonthCol = -4;
  let prevMonthIdx = -1;
  let week: HeatmapCell[] = [];
  const cursor = new Date(start);

  while (cursor <= today) {
    const iso = isoDate(cursor);
    const m = cursor.getMonth();
    if (cursor.getDay() === 0 && m !== prevMonthIdx && weeks.length - lastMonthCol >= 4) {
      months.push({ month: m, col: weeks.length });
      lastMonthCol = weeks.length;
      prevMonthIdx = m;
    }
    const d = dayMap.get(iso);
    week.push({
      date: iso,
      requests: d?.requests ?? 0,
      totalTokens: d?.totalTokens ?? 0,
      level: d ? bucketLevel(d.totalTokens, buckets) : 0,
      dayOfWeek: cursor.getDay(),
    });
    if (cursor.getDay() === 6) {
      weeks.push(week);
      week = [];
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  if (week.length > 0) {
    while (week.length < 7) {
      week.push({ date: "", requests: 0, totalTokens: 0, level: 0, dayOfWeek: week.length });
    }
    weeks.push(week);
  }
  return { weeks, months, buckets };
}
