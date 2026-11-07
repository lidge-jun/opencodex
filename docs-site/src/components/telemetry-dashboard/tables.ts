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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isOtherKey(key: string): boolean {
  return key.trim().toLowerCase() === "other";
}

function normalizeKeyOrOther(key: string): string {
  return isOtherKey(key) ? "other" : key;
}

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
    const rawProvider = nonEmptyKey(row.providerKind);
    if (!rawProvider) continue;
    const providerKind = normalizeKeyOrOther(rawProvider);
    const dayIdx = dayIndexByKey.get(row.day);
    if (dayIdx === undefined) continue;
    const rawVal = metric === "requests" ? row.requests : row.tokens;
    const val = finiteNonNegativeInt(rawVal);
    if (val <= 0) continue;
    let entry = byProvider.get(providerKind);
    if (!entry) {
      entry = { total: 0, values: new Array<number>(days.length).fill(0) };
      byProvider.set(providerKind, entry);
    }
    entry.values[dayIdx] = safeAddInt(entry.values[dayIdx] ?? 0, val);
    entry.total = safeAddInt(entry.total, val);
  }

  const explicitOther = byProvider.get("other");
  const ranked = [...byProvider.entries()]
    .filter(([key]) => key !== "other")
    .sort((a, b) => {
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

  if (explicitOther || overflow.length > 0) {
    const otherValues = new Array<number>(days.length).fill(0);
    let otherTotal = 0;
    if (explicitOther) {
      otherTotal = safeAddInt(otherTotal, explicitOther.total);
      for (let i = 0; i < days.length; i++) {
        otherValues[i] = safeAddInt(otherValues[i] ?? 0, explicitOther.values[i] ?? 0);
      }
    }
    for (const [, data] of overflow) {
      otherTotal = safeAddInt(otherTotal, data.total);
      for (let i = 0; i < days.length; i++) {
        otherValues[i] = safeAddInt(otherValues[i] ?? 0, data.values[i] ?? 0);
      }
    }
    if (otherTotal > 0) {
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

export interface DailyChartAccessibleRow {
  day: string;
  providerKind: string;
  value: number;
  valueCompact: string;
  valueExact: string;
}

export function buildDailyChartAccessibleTable(
  model: StackedDailyChartModel,
  locale = "en-US",
): DailyChartAccessibleRow[] {
  const rows: DailyChartAccessibleRow[] = [];
  for (let dayIdx = 0; dayIdx < model.days.length; dayIdx++) {
    const day = model.days[dayIdx]!;
    for (const s of model.series) {
      const val = finiteNonNegativeInt(s.values[dayIdx]);
      if (val <= 0) continue;
      rows.push({
        day,
        providerKind: s.providerKind,
        value: val,
        valueCompact: formatCompactNumber(val),
        valueExact: formatExactNumber(val, locale),
      });
    }
  }
  return rows;
}

export function buildProviderShareRows(
  providers: TelemetryStatsV1["providers"] | null | undefined,
  locale = "en-US",
): ShareRow[] {
  const merged = new Map<string, { key: string; requests: number; tokens: number }>();
  for (const p of providers ?? []) {
    if (!isRecord(p)) continue;
    const rawKey = nonEmptyKey(p.providerKind);
    if (!rawKey) continue;
    const key = normalizeKeyOrOther(rawKey);
    const requests = finiteNonNegativeInt(p.requests);
    const tokens = finiteNonNegativeInt(p.tokens);
    const prev = merged.get(key);
    if (prev) {
      prev.requests = safeAddInt(prev.requests, requests);
      prev.tokens = safeAddInt(prev.tokens, tokens);
    } else {
      merged.set(key, { key, requests, tokens });
    }
  }
  const rows = [...merged.values()];
  rows.sort((a, b) => {
    if (a.key === "other" && b.key !== "other") return 1;
    if (b.key === "other" && a.key !== "other") return -1;
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
  const merged = new Map<string, { key: string; requests: number; tokens: number }>();
  for (const m of models ?? []) {
    if (!isRecord(m)) continue;
    const rawKey = nonEmptyKey(m.modelFamily);
    if (!rawKey) continue;
    const key = normalizeKeyOrOther(rawKey);
    const requests = finiteNonNegativeInt(m.requests);
    const tokens = finiteNonNegativeInt(m.tokens);
    const prev = merged.get(key);
    if (prev) {
      prev.requests = safeAddInt(prev.requests, requests);
      prev.tokens = safeAddInt(prev.tokens, tokens);
    } else {
      merged.set(key, { key, requests, tokens });
    }
  }
  const rows = [...merged.values()];
  rows.sort((a, b) => {
    if (a.key === "other" && b.key !== "other") return 1;
    if (b.key === "other" && a.key !== "other") return -1;
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
  const merged = new Map<
    string,
    { version: string; installs: number; newInstalls: number }
  >();
  for (const v of versions ?? []) {
    if (!isRecord(v)) continue;
    const rawVersion = nonEmptyKey(v.version);
    if (!rawVersion) continue;
    const version = normalizeKeyOrOther(rawVersion);
    const installs = finiteNonNegativeInt(v.installs);
    const newInstalls = finiteNonNegativeInt(v.newInstalls);
    const prev = merged.get(version);
    if (prev) {
      prev.installs = safeAddInt(prev.installs, installs);
      prev.newInstalls = safeAddInt(prev.newInstalls, newInstalls);
    } else {
      merged.set(version, { version, installs, newInstalls });
    }
  }
  const rows = [...merged.values()];
  rows.sort((a, b) => {
    if (a.version === "other" && b.version !== "other") return 1;
    if (b.version === "other" && a.version !== "other") return -1;
    if (b.installs !== a.installs) return b.installs - a.installs;
    return b.version.localeCompare(a.version);
  });
  const totalInstalls = rows.reduce((acc, r) => safeAddInt(acc, r.installs), 0);
  return rows.map((r) => ({
    key: r.version,
    label: r.version === "other" ? "other" : `v${r.version.replace(/^v/i, "")}`,
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
  const merged = new Map<string, { key: string; installs: number }>();
  for (const p of platforms ?? []) {
    if (!isRecord(p)) continue;
    const os = nonEmptyKey(p.os);
    const arch = nonEmptyKey(p.arch);
    if (!os) continue;
    let key: string;
    if (isOtherKey(os) && (!arch || isOtherKey(arch))) {
      key = "other";
    } else if (!arch) {
      continue;
    } else {
      key = `${os}/${arch}`;
    }
    const installs = finiteNonNegativeInt(p.installs);
    const prev = merged.get(key);
    if (prev) {
      prev.installs = safeAddInt(prev.installs, installs);
    } else {
      merged.set(key, { key, installs });
    }
  }
  const rows = [...merged.values()];
  rows.sort((a, b) => {
    if (a.key === "other" && b.key !== "other") return 1;
    if (b.key === "other" && a.key !== "other") return -1;
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
  const merged = new Map<
    string,
    { channel: string; installs: number; newInstalls: number }
  >();
  for (const c of channels ?? []) {
    if (!isRecord(c)) continue;
    const rawChannel = nonEmptyKey(c.installChannel);
    if (!rawChannel) continue;
    const channel = normalizeKeyOrOther(rawChannel);
    const installs = finiteNonNegativeInt(c.installs);
    const newInstalls = finiteNonNegativeInt(c.newInstalls);
    const prev = merged.get(channel);
    if (prev) {
      prev.installs = safeAddInt(prev.installs, installs);
      prev.newInstalls = safeAddInt(prev.newInstalls, newInstalls);
    } else {
      merged.set(channel, { channel, installs, newInstalls });
    }
  }
  const rows = [...merged.values()];
  rows.sort((a, b) => {
    if (a.channel === "other" && b.channel !== "other") return 1;
    if (b.channel === "other" && a.channel !== "other") return -1;
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

  const mergedErrors = new Map<string, { cause: string; count: number }>();
  for (const e of errors ?? []) {
    if (!isRecord(e)) continue;
    const rawCause = nonEmptyKey(e.cause);
    if (!rawCause) continue;
    const cause = normalizeKeyOrOther(rawCause);
    const count = finiteNonNegativeInt(e.count);
    if (count <= 0) continue;
    const prev = mergedErrors.get(cause);
    if (prev) {
      prev.count = safeAddInt(prev.count, count);
    } else {
      mergedErrors.set(cause, { cause, count });
    }
  }
  const rawErrors = [...mergedErrors.values()];
  rawErrors.sort((a, b) => {
    if (a.cause === "other" && b.cause !== "other") return 1;
    if (b.cause === "other" && a.cause !== "other") return -1;
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
