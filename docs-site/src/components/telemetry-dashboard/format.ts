import {
  DEFAULT_TELEMETRY_RANGE,
  TELEMETRY_RANGES,
  TELEMETRY_RANGE_DAYS,
  TELEMETRY_STATS_ENDPOINT,
  TOKEN_BUCKET_ORDER,
  TOKEN_MIX_COLORS,
} from "./constants";
import type {
  KpiCardItem,
  TelemetryStatsRange,
  TelemetryStatsV1,
  TokenMixSegment,
  TokenMixSummary,
} from "./types";

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export function finiteNonNegativeInt(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n >= MAX_SAFE) return MAX_SAFE;
  return Math.floor(n);
}

export function safeAddInt(a: number, b: number): number {
  return finiteNonNegativeInt(finiteNonNegativeInt(a) + finiteNonNegativeInt(b));
}

/**
 * Compact K/M/B/T formatter adapted from junhoyeo/tokscale `formatTokenCount` (MIT).
 * Promotes boundary values (>= 999.95 of a unit) to the next unit so `999,960`
 * renders as `"1.0M"` instead of `"1000.0K"`.
 */
export function formatCompactNumber(value: number): string {
  const count = finiteNonNegativeInt(value);
  if (count >= 1_000_000_000_000) {
    const val = (count / 1_000_000_000_000).toFixed(2).replace(/\.?0+$/, "");
    return `${val}T`;
  }
  if (count >= 1_000_000_000) {
    const val = count / 1_000_000_000;
    return val >= 999.95 ? `${(val / 1000).toFixed(1)}T` : `${val.toFixed(1)}B`;
  }
  if (count >= 1_000_000) {
    const val = count / 1_000_000;
    return val >= 999.95 ? `${(val / 1000).toFixed(1)}B` : `${val.toFixed(1)}M`;
  }
  if (count >= 1_000) {
    const val = count / 1_000;
    return val >= 999.95 ? `${(val / 1000).toFixed(1)}M` : `${val.toFixed(1)}K`;
  }
  return count.toLocaleString("en-US");
}

export function formatExactNumber(value: number, locale = "en-US"): string {
  return finiteNonNegativeInt(value).toLocaleString(locale);
}

export function computePercentage(part: number, total: number): number {
  const safePart = finiteNonNegativeInt(part);
  const safeTotal = finiteNonNegativeInt(total);
  if (safeTotal <= 0 || safePart <= 0) return 0;
  return Math.min(100, (safePart / safeTotal) * 100);
}

export function formatPercent(part: number, total: number, digits = 1): string {
  return `${computePercentage(part, total).toFixed(digits)}%`;
}

export function formatActiveHours(
  activeMinutes: number,
  locale = "en-US",
): { hours: number; compact: string; exactTitle: string } {
  const minutes = finiteNonNegativeInt(activeMinutes);
  const hours = minutes / 60;
  const exactMinutes = minutes.toLocaleString(locale);
  if (minutes === 0) {
    return {
      hours: 0,
      compact: "0h",
      exactTitle: `0h (${exactMinutes} min)`,
    };
  }
  const roundedHours = Number(hours.toFixed(1));
  const exactHours = roundedHours.toLocaleString(locale, {
    minimumFractionDigits: roundedHours % 1 === 0 ? 0 : 1,
    maximumFractionDigits: 1,
  });
  const compactBase =
    hours >= 1_000
      ? formatCompactNumber(Math.round(hours))
      : hours >= 100
        ? String(Math.round(hours))
        : hours.toFixed(1).replace(/\.0$/, "");
  return {
    hours: roundedHours,
    compact: `${compactBase}h`,
    exactTitle: `${exactHours}h (${exactMinutes} min)`,
  };
}

export function sumDisjointTokens(
  tokens: TelemetryStatsV1["totals"]["tokens"] | null | undefined,
): number {
  if (!tokens) return 0;
  return safeAddInt(
    safeAddInt(
      safeAddInt(tokens.input, tokens.cacheRead),
      safeAddInt(tokens.cacheWrite, tokens.output),
    ),
    tokens.reasoning,
  );
}

export function getStatsRangeDays(
  range?: TelemetryStatsRange | string | null,
): number {
  if (isTelemetryStatsRange(range)) {
    return TELEMETRY_RANGE_DAYS[range];
  }
  return TELEMETRY_RANGE_DAYS[DEFAULT_TELEMETRY_RANGE];
}

export function resolveAvgDailyActiveInstalls(
  stats: Pick<TelemetryStatsV1, "totals"> &
    Partial<Pick<TelemetryStatsV1, "range">>,
): number {
  const explicit = stats.totals.avgDailyActiveInstalls;
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit >= 0) {
    return Math.round(Math.min(explicit, MAX_SAFE) * 10) / 10;
  }
  const installDays = finiteNonNegativeInt(stats.totals.activeInstalls);
  const days = getStatsRangeDays(stats.range);
  if (days <= 0 || installDays <= 0) return 0;
  return Math.round((installDays / days) * 10) / 10;
}

export function formatAvgDailyActiveInstalls(
  avgDailyActiveInstalls: number,
  installDays: number,
  locale = "en-US",
  installDaysLabel = "install-days",
): { avg: number; compact: string; exactTitle: string } {
  const safeInstallDays = finiteNonNegativeInt(installDays);
  const safeAvg =
    typeof avgDailyActiveInstalls === "number" &&
    Number.isFinite(avgDailyActiveInstalls) &&
    avgDailyActiveInstalls > 0
      ? Math.round(Math.min(avgDailyActiveInstalls, MAX_SAFE) * 10) / 10
      : 0;
  const exactInstallDays = safeInstallDays.toLocaleString(locale);
  if (safeAvg === 0 && safeInstallDays === 0) {
    return {
      avg: 0,
      compact: "0",
      exactTitle: `0 (0 ${installDaysLabel})`,
    };
  }
  const exactAvg = safeAvg.toLocaleString(locale, {
    minimumFractionDigits: safeAvg % 1 === 0 ? 0 : 1,
    maximumFractionDigits: 1,
  });
  const compact =
    safeAvg >= 1_000
      ? formatCompactNumber(Math.round(safeAvg))
      : safeAvg.toFixed(1).replace(/\.0$/, "");
  return {
    avg: safeAvg,
    compact,
    exactTitle: `${exactAvg} (${exactInstallDays} ${installDaysLabel})`,
  };
}

export function buildKpiStrip(
  stats: Pick<TelemetryStatsV1, "totals"> &
    Partial<Pick<TelemetryStatsV1, "range">>,
  locale = "en-US",
  installDaysLabel = "install-days",
): KpiCardItem[] {
  const installDays = finiteNonNegativeInt(stats.totals.activeInstalls);
  const avgDaily = resolveAvgDailyActiveInstalls(stats);
  const formattedAvg = formatAvgDailyActiveInstalls(
    avgDaily,
    installDays,
    locale,
    installDaysLabel,
  );
  const newInstalls = finiteNonNegativeInt(stats.totals.newInstalls);
  const requests = finiteNonNegativeInt(stats.totals.requests);
  const totalTokens = sumDisjointTokens(stats.totals.tokens);
  const activeHours = formatActiveHours(stats.totals.activeMinutes, locale);

  return [
    {
      id: "activeInstalls",
      rawValue: formattedAvg.avg,
      compact: formattedAvg.compact,
      exactTitle: formattedAvg.exactTitle,
    },
    {
      id: "newInstalls",
      rawValue: newInstalls,
      compact: formatCompactNumber(newInstalls),
      exactTitle: formatExactNumber(newInstalls, locale),
    },
    {
      id: "requests",
      rawValue: requests,
      compact: formatCompactNumber(requests),
      exactTitle: formatExactNumber(requests, locale),
    },
    {
      id: "tokens",
      rawValue: totalTokens,
      compact: formatCompactNumber(totalTokens),
      exactTitle: formatExactNumber(totalTokens, locale),
    },
    {
      id: "activeHours",
      rawValue: finiteNonNegativeInt(stats.totals.activeMinutes),
      compact: activeHours.compact,
      exactTitle: activeHours.exactTitle,
    },
  ];
}

export function buildTokenMix(
  tokens: TelemetryStatsV1["totals"]["tokens"] | null | undefined,
  locale = "en-US",
): TokenMixSummary {
  const totalTokens = sumDisjointTokens(tokens);
  const segments: TokenMixSegment[] = TOKEN_BUCKET_ORDER.map((id) => {
    const value = finiteNonNegativeInt(tokens?.[id]);
    const percent = computePercentage(value, totalTokens);
    return {
      id,
      value,
      compact: formatCompactNumber(value),
      exactTitle: formatExactNumber(value, locale),
      percent,
      percentLabel: `${percent.toFixed(1)}%`,
      color: TOKEN_MIX_COLORS[id],
    };
  });

  return {
    totalTokens,
    totalCompact: formatCompactNumber(totalTokens),
    totalExactTitle: formatExactNumber(totalTokens, locale),
    segments,
  };
}

export function isTelemetryStatsRange(value: unknown): value is TelemetryStatsRange {
  return (
    typeof value === "string" &&
    (TELEMETRY_RANGES as readonly string[]).includes(value)
  );
}

export function parseStatsRangeParam(
  value: string | null | undefined,
): TelemetryStatsRange {
  if (isTelemetryStatsRange(value)) return value;
  return DEFAULT_TELEMETRY_RANGE;
}

export function buildStatsUrl(
  range: TelemetryStatsRange,
  endpoint: string = TELEMETRY_STATS_ENDPOINT,
): string {
  const url = new URL(endpoint);
  url.searchParams.set("range", range);
  return url.toString();
}

export function formatGeneratedTimestamp(
  iso: string | null | undefined,
  locale = "en-US",
): string | null {
  if (!iso || typeof iso !== "string") return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}
