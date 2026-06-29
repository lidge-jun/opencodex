import { baseProviderLabel } from "./provider-label";
import type { PersistedUsageEntry, UsageStatus } from "./usage-log";

export type UsageRange = "7d" | "30d" | "all";

export interface UsageSummaryTotals {
  requests: number;
  reportedRequests: number;
  unreportedRequests: number;
  unsupportedRequests: number;
  estimatedRequests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  coverageRatio: number;
}

export interface UsageDay {
  date: string;
  requests: number;
  reportedRequests: number;
  totalTokens: number;
  models: UsageDayModel[];
}

export interface UsageDayModel {
  model: string;
  provider: string;
  requests: number;
  totalTokens: number;
}

export interface UsageModel {
  provider: string;
  model: string;
  resolvedModel?: string;
  requests: number;
  reportedRequests: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  shareRatio: number;
}

export interface UsageProvider {
  provider: string;
  requests: number;
  reportedRequests: number;
  totalTokens: number;
  shareRatio: number;
}

export interface UsageSummary {
  range: UsageRange;
  since: number | null;
  generatedAt: number;
  summary: UsageSummaryTotals;
  days: UsageDay[];
  models: UsageModel[];
  providers: UsageProvider[];
}

const DAY_MS = 86_400_000;

export function parseRange(input: string | null | undefined): UsageRange {
  if (input === "7d" || input === "30d" || input === "all") return input;
  return "30d";
}

function rangeWindow(range: UsageRange, now: number): { since: number | null; days: number } {
  if (range === "7d") return { since: now - 7 * DAY_MS, days: 7 };
  if (range === "30d") return { since: now - 30 * DAY_MS, days: 30 };
  return { since: null, days: 0 };
}

function localDateKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dayCountForAllRange(entries: PersistedUsageEntry[], now: number): number {
  if (entries.length === 0) return 1;
  const oldest = entries.reduce((min, e) => Math.min(min, e.timestamp), entries[0].timestamp);
  const days = Math.ceil((now - oldest) / DAY_MS) + 1;
  return Math.max(1, days);
}

function blankTotals(): UsageSummaryTotals {
  return {
    requests: 0,
    reportedRequests: 0,
    unreportedRequests: 0,
    unsupportedRequests: 0,
    estimatedRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    coverageRatio: 0,
  };
}

function bumpStatus(totals: UsageSummaryTotals, status: UsageStatus): void {
  totals.requests += 1;
  if (status === "reported") totals.reportedRequests += 1;
  else if (status === "unreported") totals.unreportedRequests += 1;
  else if (status === "unsupported") totals.unsupportedRequests += 1;
  else if (status === "estimated") totals.estimatedRequests += 1;
}

function addTokens(totals: UsageSummaryTotals, entry: PersistedUsageEntry): void {
  if (!entry.usage) return;
  totals.inputTokens += entry.usage.inputTokens;
  totals.outputTokens += entry.usage.outputTokens;
  if (typeof entry.usage.cachedInputTokens === "number") totals.cachedInputTokens += entry.usage.cachedInputTokens;
  if (typeof entry.usage.reasoningOutputTokens === "number") totals.reasoningOutputTokens += entry.usage.reasoningOutputTokens;
  if (typeof entry.totalTokens === "number") totals.totalTokens += entry.totalTokens;
  else totals.totalTokens += entry.usage.inputTokens + entry.usage.outputTokens;
}

function finalizeCoverage(totals: UsageSummaryTotals): void {
  totals.coverageRatio = totals.requests === 0 ? 0 : totals.reportedRequests / totals.requests;
}

function buildDayGrid(range: UsageRange, since: number | null, now: number, entries: PersistedUsageEntry[]): UsageDay[] {
  const window = rangeWindow(range, now);
  const days = range === "all" ? dayCountForAllRange(entries, now) : window.days;
  const grid = new Map<string, UsageDay>();
  // Per-day model breakdown accumulator, keyed by day then provider/model, so the 7d bar chart can
  // render a per-model stacked bar with a hover tooltip without a second pass over the entries.
  const dayModels = new Map<string, Map<string, UsageDayModel>>();
  const bumpDayModel = (dayKey: string, entry: PersistedUsageEntry): void => {
    let models = dayModels.get(dayKey);
    if (!models) { models = new Map(); dayModels.set(dayKey, models); }
    const mKey = `${entry.provider}/${entry.model}`;
    let m = models.get(mKey);
    if (!m) { m = { model: entry.model, provider: entry.provider, requests: 0, totalTokens: 0 }; models.set(mKey, m); }
    m.requests += 1;
    if (typeof entry.totalTokens === "number") m.totalTokens += entry.totalTokens;
    else if (entry.usage) m.totalTokens += entry.usage.inputTokens + entry.usage.outputTokens;
  };
  for (let i = days - 1; i >= 0; i--) {
    const key = localDateKey(now - i * DAY_MS);
    grid.set(key, { date: key, requests: 0, reportedRequests: 0, totalTokens: 0, models: [] });
  }
  for (const entry of entries) {
    const key = localDateKey(entry.timestamp);
    let day = grid.get(key);
    if (!day) {
      day = { date: key, requests: 0, reportedRequests: 0, totalTokens: 0, models: [] };
      grid.set(key, day);
    }
    day.requests += 1;
    if (entry.usageStatus === "reported") day.reportedRequests += 1;
    if (typeof entry.totalTokens === "number") day.totalTokens += entry.totalTokens;
    else if (entry.usage) day.totalTokens += entry.usage.inputTokens + entry.usage.outputTokens;
    bumpDayModel(key, entry);
  }
  void since;
  const out = [...grid.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const day of out) {
    const models = dayModels.get(day.date);
    if (models) day.models = [...models.values()].sort((a, b) => b.requests - a.requests);
  }
  return out;
}

function buildModels(entries: PersistedUsageEntry[], totalRequests: number): UsageModel[] {
  const byKey = new Map<string, UsageModel>();
  for (const entry of entries) {
    const providerKey = baseProviderLabel(entry.provider);
    // resolvedModel is a routing detail (passthrough vs alias), not a row identity. Entries with
    // the same provider+model but differing resolvedModel (common when unreported rows carry no
    // resolvedModel) must collapse into one row.
    const key = `${providerKey}${entry.model}`;
    let model = byKey.get(key);
    if (!model) {
      model = {
        provider: providerKey,
        model: entry.model,
        ...(entry.resolvedModel ? { resolvedModel: entry.resolvedModel } : {}),
        requests: 0,
        reportedRequests: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        shareRatio: 0,
      };
      byKey.set(key, model);
    }
    model.requests += 1;
    if (entry.usageStatus === "reported") model.reportedRequests += 1;
    if (entry.usage) {
      model.inputTokens += entry.usage.inputTokens;
      model.outputTokens += entry.usage.outputTokens;
      if (typeof entry.totalTokens === "number") model.totalTokens += entry.totalTokens;
      else model.totalTokens += entry.usage.inputTokens + entry.usage.outputTokens;
    }
  }
  const models = [...byKey.values()];
  for (const m of models) m.shareRatio = totalRequests === 0 ? 0 : m.requests / totalRequests;
  return models.sort((a, b) => b.requests - a.requests);
}

function buildProviders(entries: PersistedUsageEntry[], totalRequests: number): UsageProvider[] {
  const byKey = new Map<string, UsageProvider>();
  for (const entry of entries) {
    const providerKey = baseProviderLabel(entry.provider);
    let provider = byKey.get(providerKey);
    if (!provider) {
      provider = {
        provider: providerKey,
        requests: 0,
        reportedRequests: 0,
        totalTokens: 0,
        shareRatio: 0,
      };
      byKey.set(providerKey, provider);
    }
    provider.requests += 1;
    if (entry.usageStatus === "reported") provider.reportedRequests += 1;
    if (entry.usage) {
      if (typeof entry.totalTokens === "number") provider.totalTokens += entry.totalTokens;
      else provider.totalTokens += entry.usage.inputTokens + entry.usage.outputTokens;
    }
  }
  const providers = [...byKey.values()];
  for (const p of providers) p.shareRatio = totalRequests === 0 ? 0 : p.requests / totalRequests;
  return providers.sort((a, b) => b.requests - a.requests);
}

export function summarizeUsage(entries: PersistedUsageEntry[], range: UsageRange, now: number): UsageSummary {
  const { since } = rangeWindow(range, now);
  const inRange = since === null ? entries : entries.filter(e => e.timestamp >= since);
  const totals = blankTotals();
  for (const entry of inRange) {
    bumpStatus(totals, entry.usageStatus);
    addTokens(totals, entry);
  }
  finalizeCoverage(totals);
  return {
    range,
    since,
    generatedAt: now,
    summary: totals,
    days: buildDayGrid(range, since, now, inRange),
    models: buildModels(inRange, totals.requests),
    providers: buildProviders(inRange, totals.requests),
  };
}
