import {
  OUTCOME_COLORS,
  getModelFamilyColor,
  getProviderColor,
} from "./constants";
import {
  computePercentage,
  finiteNonNegativeInt,
  formatCompactNumber,
  formatExactNumber,
  formatPercent,
  safeAddInt,
} from "./format";
import type {
  DailyChartMetric,
  DailyProviderSeries,
  ErrorCauseRow,
  InstallRow,
  OutcomeClassId,
  OutcomeRow,
  ReliabilitySummary,
  ShareRow,
  StackedDailyChartModel,
  TelemetryStatsV1,
} from "./types";

const DEFAULT_MAX_CHART_SERIES = 6;

export function buildDailyProviderChart(
  dailyByProvider: TelemetryStatsV1["dailyByProvider"] | null | undefined,
  daily: TelemetryStatsV1["daily"] | null | undefined,
  metric: DailyChartMetric = "tokens",
  maxSeries = DEFAULT_MAX_CHART_SERIES,
): StackedDailyChartModel {
  const daySet = new Set<string>();
  for (const d of daily ?? []) {
    if (d && typeof d.day === "string") daySet.add(d.day);
  }
  for (const row of dailyByProvider ?? []) {
    if (row && typeof row.day === "string") daySet.add(row.day);
  }
  const days = [...daySet].sort();
  const dayIndexByKey = new Map<string, number>(days.map((d, i) => [d, i]));

  const byProvider = new Map<string, { total: number; values: number[] }>();
  for (const row of dailyByProvider ?? []) {
    if (!row || typeof row.day !== "string" || typeof row.providerKind !== "string") {
      continue;
    }
    const dayIdx = dayIndexByKey.get(row.day);
    if (dayIdx === undefined) continue;
    const rawVal = metric === "requests" ? row.requests : row.tokens;
    const val = finiteNonNegativeInt(rawVal);
    if (val <= 0) continue;
    let entry = byProvider.get(row.providerKind);
    if (!entry) {
      entry = { total: 0, values: new Array<number>(days.length).fill(0) };
      byProvider.set(row.providerKind, entry);
    }
    entry.values[dayIdx] = safeAddInt(entry.values[dayIdx] ?? 0, val);
    entry.total = safeAddInt(entry.total, val);
  }

  const ranked = [...byProvider.entries()].sort((a, b) => {
    if (b[1].total !== a[1].total) return b[1].total - a[1].total;
    return a[0].localeCompare(b[0]);
  });

  const limit = Math.max(1, Math.floor(maxSeries));
  const top = ranked.slice(0, limit);
  const overflow = ranked.slice(limit);

  const series: DailyProviderSeries[] = top.map(([providerKind, data]) => ({
    providerKind,
    color: getProviderColor(providerKind),
    total: data.total,
    values: data.values,
  }));

  if (overflow.length > 0) {
    const otherValues = new Array<number>(days.length).fill(0);
    let otherTotal = 0;
    for (const [, data] of overflow) {
      otherTotal = safeAddInt(otherTotal, data.total);
      for (let i = 0; i < days.length; i++) {
        otherValues[i] = safeAddInt(otherValues[i] ?? 0, data.values[i] ?? 0);
      }
    }
    const existingOther = series.find((s) => s.providerKind === "other");
    if (existingOther) {
      existingOther.total = safeAddInt(existingOther.total, otherTotal);
      existingOther.values = existingOther.values.map((v, idx) =>
        safeAddInt(v, otherValues[idx] ?? 0),
      );
    } else if (otherTotal > 0) {
      series.push({
        providerKind: "other",
        color: getProviderColor("other"),
        total: otherTotal,
        values: otherValues,
      });
    }
  }

  const total = series.reduce((acc, item) => safeAddInt(acc, item.total), 0);
  return { days, metric, total, series };
}

export function buildProviderShareRows(
  providers: TelemetryStatsV1["providers"] | null | undefined,
  locale = "en-US",
): ShareRow[] {
  const rows = (providers ?? []).map((p) => ({
    key: p.providerKind,
    requests: finiteNonNegativeInt(p.requests),
    tokens: finiteNonNegativeInt(p.tokens),
  }));
  rows.sort((a, b) => {
    if (b.tokens !== a.tokens) return b.tokens - a.tokens;
    if (b.requests !== a.requests) return b.requests - a.requests;
    return a.key.localeCompare(b.key);
  });
  const totalTokens = rows.reduce((acc, r) => safeAddInt(acc, r.tokens), 0);
  const totalRequests = rows.reduce((acc, r) => safeAddInt(acc, r.requests), 0);

  return rows.map((r) => {
    const tokenSharePercent = computePercentage(r.tokens, totalTokens);
    const requestSharePercent = computePercentage(r.requests, totalRequests);
    return {
      key: r.key,
      label: r.key,
      color: getProviderColor(r.key),
      requests: r.requests,
      requestsCompact: formatCompactNumber(r.requests),
      requestsExact: formatExactNumber(r.requests, locale),
      requestSharePercent,
      requestShareLabel: formatPercent(r.requests, totalRequests),
      tokens: r.tokens,
      tokensCompact: formatCompactNumber(r.tokens),
      tokensExact: formatExactNumber(r.tokens, locale),
      tokenSharePercent,
      tokenShareLabel: formatPercent(r.tokens, totalTokens),
    };
  });
}

export function buildModelShareRows(
  models: TelemetryStatsV1["models"] | null | undefined,
  locale = "en-US",
): ShareRow[] {
  const rows = (models ?? []).map((m) => ({
    key: m.modelFamily,
    requests: finiteNonNegativeInt(m.requests),
    tokens: finiteNonNegativeInt(m.tokens),
  }));
  rows.sort((a, b) => {
    if (b.tokens !== a.tokens) return b.tokens - a.tokens;
    if (b.requests !== a.requests) return b.requests - a.requests;
    return a.key.localeCompare(b.key);
  });
  const totalTokens = rows.reduce((acc, r) => safeAddInt(acc, r.tokens), 0);
  const totalRequests = rows.reduce((acc, r) => safeAddInt(acc, r.requests), 0);

  return rows.map((r) => {
    const tokenSharePercent = computePercentage(r.tokens, totalTokens);
    const requestSharePercent = computePercentage(r.requests, totalRequests);
    return {
      key: r.key,
      label: r.key,
      color: getModelFamilyColor(r.key),
      requests: r.requests,
      requestsCompact: formatCompactNumber(r.requests),
      requestsExact: formatExactNumber(r.requests, locale),
      requestSharePercent,
      requestShareLabel: formatPercent(r.requests, totalRequests),
      tokens: r.tokens,
      tokensCompact: formatCompactNumber(r.tokens),
      tokensExact: formatExactNumber(r.tokens, locale),
      tokenSharePercent,
      tokenShareLabel: formatPercent(r.tokens, totalTokens),
    };
  });
}

export function buildVersionRows(
  versions: TelemetryStatsV1["versions"] | null | undefined,
  locale = "en-US",
): InstallRow[] {
  const rows = (versions ?? []).map((v) => ({
    version: v.version,
    installs: finiteNonNegativeInt(v.installs),
    newInstalls: finiteNonNegativeInt(v.newInstalls),
  }));
  rows.sort((a, b) => {
    if (b.installs !== a.installs) return b.installs - a.installs;
    return b.version.localeCompare(a.version);
  });
  const totalInstalls = rows.reduce((acc, r) => safeAddInt(acc, r.installs), 0);
  return rows.map((r) => ({
    key: r.version,
    label: `v${r.version.replace(/^v/i, "")}`,
    installs: r.installs,
    installsCompact: formatCompactNumber(r.installs),
    installsExact: formatExactNumber(r.installs, locale),
    newInstalls: r.newInstalls,
    newInstallsCompact: formatCompactNumber(r.newInstalls),
    newInstallsExact: formatExactNumber(r.newInstalls, locale),
    sharePercent: computePercentage(r.installs, totalInstalls),
    shareLabel: formatPercent(r.installs, totalInstalls),
  }));
}

export function buildPlatformRows(
  platforms: TelemetryStatsV1["platforms"] | null | undefined,
  locale = "en-US",
): InstallRow[] {
  const rows = (platforms ?? []).map((p) => ({
    key: `${p.os}/${p.arch}`,
    installs: finiteNonNegativeInt(p.installs),
  }));
  rows.sort((a, b) => {
    if (b.installs !== a.installs) return b.installs - a.installs;
    return a.key.localeCompare(b.key);
  });
  const totalInstalls = rows.reduce((acc, r) => safeAddInt(acc, r.installs), 0);
  return rows.map((r) => ({
    key: r.key,
    label: r.key,
    installs: r.installs,
    installsCompact: formatCompactNumber(r.installs),
    installsExact: formatExactNumber(r.installs, locale),
    sharePercent: computePercentage(r.installs, totalInstalls),
    shareLabel: formatPercent(r.installs, totalInstalls),
  }));
}

export function buildChannelRows(
  channels: TelemetryStatsV1["channels"] | null | undefined,
  locale = "en-US",
): InstallRow[] {
  const rows = (channels ?? []).map((c) => ({
    channel: c.installChannel,
    installs: finiteNonNegativeInt(c.installs),
    newInstalls: finiteNonNegativeInt(c.newInstalls),
  }));
  rows.sort((a, b) => {
    if (b.installs !== a.installs) return b.installs - a.installs;
    return a.channel.localeCompare(b.channel);
  });
  const totalInstalls = rows.reduce((acc, r) => safeAddInt(acc, r.installs), 0);
  return rows.map((r) => ({
    key: r.channel,
    label: r.channel,
    installs: r.installs,
    installsCompact: formatCompactNumber(r.installs),
    installsExact: formatExactNumber(r.installs, locale),
    newInstalls: r.newInstalls,
    newInstallsCompact: formatCompactNumber(r.newInstalls),
    newInstallsExact: formatExactNumber(r.newInstalls, locale),
    sharePercent: computePercentage(r.installs, totalInstalls),
    shareLabel: formatPercent(r.installs, totalInstalls),
  }));
}

const OUTCOME_KEYS: readonly OutcomeClassId[] = [
  "completed",
  "incomplete",
  "aborted",
  "failed",
];

export function buildReliabilitySummary(
  outcomes: TelemetryStatsV1["outcomes"] | null | undefined,
  errors: TelemetryStatsV1["errors"] | null | undefined,
  locale = "en-US",
): ReliabilitySummary {
  const counts: Record<OutcomeClassId, number> = {
    completed: finiteNonNegativeInt(outcomes?.completed),
    incomplete: finiteNonNegativeInt(outcomes?.incomplete),
    aborted: finiteNonNegativeInt(outcomes?.aborted),
    failed: finiteNonNegativeInt(outcomes?.failed),
  };
  const totalRequests = safeAddInt(
    safeAddInt(counts.completed, counts.incomplete),
    safeAddInt(counts.aborted, counts.failed),
  );
  const completedRatioPercent = computePercentage(counts.completed, totalRequests);
  const completedRatioLabel = formatPercent(counts.completed, totalRequests);

  const outcomeRows: OutcomeRow[] = OUTCOME_KEYS.map((key) => ({
    key,
    count: counts[key],
    compact: formatCompactNumber(counts[key]),
    exact: formatExactNumber(counts[key], locale),
    sharePercent: computePercentage(counts[key], totalRequests),
    shareLabel: formatPercent(counts[key], totalRequests),
    color: OUTCOME_COLORS[key],
  }));

  const rawErrors = (errors ?? [])
    .map((e) => ({
      cause: e.cause,
      count: finiteNonNegativeInt(e.count),
    }))
    .filter((e) => e.count > 0)
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.cause.localeCompare(b.cause);
    });

  const totalErrors = rawErrors.reduce((acc, e) => safeAddInt(acc, e.count), 0);
  const errorRows: ErrorCauseRow[] = rawErrors.map((e) => ({
    cause: e.cause,
    count: e.count,
    compact: formatCompactNumber(e.count),
    exact: formatExactNumber(e.count, locale),
    sharePercent: computePercentage(e.count, totalErrors),
    shareLabel: formatPercent(e.count, totalErrors),
  }));

  return {
    totalRequests,
    completedRatioPercent,
    completedRatioLabel,
    outcomes: outcomeRows,
    errors: errorRows,
    totalErrors,
  };
}
