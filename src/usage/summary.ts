import { baseProviderLabel } from "../providers/label";
import { usageDisplayTotalTokens } from "./totals";
import type { PersistedUsageEntry, UsageStatus } from "./log";
import { estimateComboCost, estimateRequestCost } from "./cost";

export type UsageRange = "7d" | "30d" | "all";
export type UsageSurface = "all" | "codex" | "claude";

export interface UsageSummaryTotals {
  requests: number;
  attemptCount: number;
  measuredRequests: number;
  reportedRequests: number;
  unreportedRequests: number;
  unsupportedRequests: number;
  estimatedRequests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  coverageRatio: number;
  /** Display-time estimated cost in USD for the filtered window (WP6, devlog 004).
   *  Sums per-request estimateRequestCost / per-attempt combo costs; requests whose
   *  price is unmatched are excluded from the sum and counted separately. */
  estimatedCostUsd: number;
  pricedRequests: number;
  /** Requests with usage but no matched price anywhere (excluded from the sum). */
  unpricedRequests: number;
  /** Requests whose usage itself is missing/unsupported, so no cost can be computed. */
  unmeteredRequests: number;
}

export interface UsageDay {
  date: string;
  requests: number;
  measuredRequests: number;
  reportedRequests: number;
  totalTokens: number;
  models: UsageDayModel[];
}

export interface UsageDayModel {
  model: string;
  provider: string;
  requests: number;
  attemptCount: number;
  totalTokens: number;
}

export interface UsageModel {
  provider: string;
  model: string;
  resolvedModel?: string;
  requests: number;
  attemptCount: number;
  measuredRequests: number;
  reportedRequests: number;
  estimatedRequests: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  shareRatio: number;
  estimatedCostUsd?: number;
}

export interface UsageProvider {
  provider: string;
  requests: number;
  attemptCount: number;
  measuredRequests: number;
  reportedRequests: number;
  estimatedRequests: number;
  totalTokens: number;
  shareRatio: number;
  estimatedCostUsd?: number;
}

export interface UsageSummary {
  range: UsageRange;
  surface: UsageSurface;
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

export function parseUsageSurface(input: string | null | undefined): UsageSurface {
  if (input === "codex" || input === "claude") return input;
  return "all";
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
    attemptCount: 0,
    measuredRequests: 0,
    reportedRequests: 0,
    unreportedRequests: 0,
    unsupportedRequests: 0,
    estimatedRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    coverageRatio: 0,
    estimatedCostUsd: 0,
    pricedRequests: 0,
    unpricedRequests: 0,
    unmeteredRequests: 0,
  };
}

function isMeasuredStatus(status: UsageStatus): boolean {
  return status === "reported" || status === "estimated";
}

interface UsageAttribution {
  requestId: string;
  provider: string;
  model: string;
  resolvedModel?: string;
  usageStatus: UsageStatus;
  usage?: PersistedUsageEntry["usage"];
  totalTokens?: number;
}

function usageAttributions(entry: PersistedUsageEntry): UsageAttribution[] {
  if (!entry.attempts?.length) {
    return [{
      requestId: entry.requestId,
      provider: entry.provider,
      model: entry.model,
      ...(entry.resolvedModel ? { resolvedModel: entry.resolvedModel } : {}),
      usageStatus: entry.usageStatus,
      ...(entry.usage ? { usage: entry.usage } : {}),
      ...(entry.totalTokens !== undefined ? { totalTokens: entry.totalTokens } : {}),
    }];
  }
  return entry.attempts.map(attempt => ({
    requestId: entry.requestId,
    provider: attempt.provider,
    model: attempt.model,
    usageStatus: attempt.usageStatus,
    ...(attempt.usage ? { usage: attempt.usage } : {}),
    ...(attempt.totalTokens !== undefined ? { totalTokens: attempt.totalTokens } : {}),
  }));
}

function foldAttributionStatuses(statuses: readonly UsageStatus[]): UsageStatus {
  if (statuses.length > 0 && statuses.every(status => status === "unsupported")) {
    return "unsupported";
  }
  if (statuses.some(status => status === "unreported" || status === "unsupported")) {
    return "unreported";
  }
  if (statuses.some(status => status === "estimated")) return "estimated";
  return statuses.length > 0 ? "reported" : "unreported";
}

function bumpStatus(totals: UsageSummaryTotals, status: UsageStatus): void {
  totals.requests += 1;
  if (isMeasuredStatus(status)) totals.measuredRequests += 1;
  if (status === "reported") totals.reportedRequests += 1;
  else if (status === "unreported") totals.unreportedRequests += 1;
  else if (status === "unsupported") totals.unsupportedRequests += 1;
  else if (status === "estimated") totals.estimatedRequests += 1;
}

function addTokens(
  totals: UsageSummaryTotals,
  entry: Pick<PersistedUsageEntry, "usage" | "totalTokens">,
): void {
  if (!entry.usage) return;
  totals.inputTokens += entry.usage.inputTokens;
  totals.outputTokens += entry.usage.outputTokens;
  // Prefer the explicit read/write split; legacy claude-route rows stored read+write
  // combined in cachedInputTokens with only the creation split present (devlog 070),
  // so recover reads by subtracting the write share for those rows.
  const creation = entry.usage.cacheCreationInputTokens;
  const read = typeof entry.usage.cacheReadInputTokens === "number"
    ? entry.usage.cacheReadInputTokens
    : typeof entry.usage.cachedInputTokens === "number" && typeof creation === "number"
      ? Math.max(0, entry.usage.cachedInputTokens - creation)
      : entry.usage.cachedInputTokens;
  if (typeof read === "number") {
    totals.cachedInputTokens += read;
    totals.cacheReadInputTokens += read;
  }
  if (typeof creation === "number") totals.cacheCreationInputTokens += creation;
  if (typeof entry.usage.reasoningOutputTokens === "number") totals.reasoningOutputTokens += entry.usage.reasoningOutputTokens;
  totals.totalTokens += usageDisplayTotalTokens(entry.usage, entry.totalTokens) ?? 0;
}

function finalizeCoverage(totals: UsageSummaryTotals): void {
  totals.coverageRatio = totals.requests === 0 ? 0 : totals.measuredRequests / totals.requests;
}

function addEstimatedCost(
  totals: UsageSummaryTotals,
  entry: Pick<PersistedUsageEntry, "provider" | "model" | "usageStatus" | "usage" | "attempts">,
): void {
  if (entry.usageStatus === "unreported" || entry.usageStatus === "unsupported"
    || (!entry.usage && !entry.attempts?.length)) {
    totals.unmeteredRequests += 1;
    return;
  }
  const estimate = entry.attempts?.length
    ? estimateComboCost(entry.attempts)
    : estimateRequestCost({ provider: entry.provider, model: entry.model, usage: entry.usage, usageStatus: entry.usageStatus });
  if (!estimate) {
    totals.unpricedRequests += 1;
    return;
  }
  totals.pricedRequests += 1;
  totals.estimatedCostUsd += estimate.cost.total;
}

function buildDayGrid(range: UsageRange, since: number | null, now: number, entries: PersistedUsageEntry[]): UsageDay[] {
  const window = rangeWindow(range, now);
  const days = range === "all" ? dayCountForAllRange(entries, now) : window.days;
  const grid = new Map<string, UsageDay>();
  // Per-day model breakdown accumulator, keyed by day then provider/model, so the 7d bar chart can
  // render a per-model stacked bar with a hover tooltip without a second pass over the entries.
  const dayModels = new Map<string, Map<string, UsageDayModel>>();
  const dayModelRequests = new Map<string, Set<string>>();
  const bumpDayModel = (dayKey: string, attribution: UsageAttribution): void => {
    let models = dayModels.get(dayKey);
    if (!models) { models = new Map(); dayModels.set(dayKey, models); }
    const providerKey = baseProviderLabel(attribution.provider);
    const mKey = `${providerKey}/${attribution.model}`;
    let m = models.get(mKey);
    if (!m) {
      m = { model: attribution.model, provider: providerKey, requests: 0, attemptCount: 0, totalTokens: 0 };
      models.set(mKey, m);
    }
    const requestKey = `${dayKey}\0${mKey}`;
    let requests = dayModelRequests.get(requestKey);
    if (!requests) { requests = new Set(); dayModelRequests.set(requestKey, requests); }
    requests.add(attribution.requestId);
    m.requests = requests.size;
    m.attemptCount += 1;
    m.totalTokens += usageDisplayTotalTokens(attribution.usage, attribution.totalTokens) ?? 0;
  };
  for (let i = days - 1; i >= 0; i--) {
    const key = localDateKey(now - i * DAY_MS);
    grid.set(key, { date: key, requests: 0, measuredRequests: 0, reportedRequests: 0, totalTokens: 0, models: [] });
  }
  for (const entry of entries) {
    const key = localDateKey(entry.timestamp);
    let day = grid.get(key);
    if (!day) {
      day = { date: key, requests: 0, measuredRequests: 0, reportedRequests: 0, totalTokens: 0, models: [] };
      grid.set(key, day);
    }
    day.requests += 1;
    if (isMeasuredStatus(entry.usageStatus)) day.measuredRequests += 1;
    if (entry.usageStatus === "reported") day.reportedRequests += 1;
    day.totalTokens += usageDisplayTotalTokens(entry.usage, entry.totalTokens) ?? 0;
    for (const attribution of usageAttributions(entry)) bumpDayModel(key, attribution);
  }
  void since;
  const out = [...grid.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const day of out) {
    const models = dayModels.get(day.date);
    if (models) day.models = [...models.values()].sort((a, b) => b.requests - a.requests);
  }
  return out;
}

function buildModels(entries: PersistedUsageEntry[], totalTokens: number): UsageModel[] {
  const byKey = new Map<string, UsageModel>();
  const statusesByKey = new Map<string, Map<string, UsageStatus[]>>();
  for (const entry of entries) {
    for (const attribution of usageAttributions(entry)) {
      const providerKey = baseProviderLabel(attribution.provider);
      // resolvedModel is a routing detail, not a row identity.
      const key = `${providerKey}${attribution.model}`;
      let model = byKey.get(key);
      if (!model) {
        model = {
          provider: providerKey,
          model: attribution.model,
          ...(attribution.resolvedModel ? { resolvedModel: attribution.resolvedModel } : {}),
          requests: 0,
          attemptCount: 0,
          measuredRequests: 0,
          reportedRequests: 0,
          estimatedRequests: 0,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          shareRatio: 0,
        };
        byKey.set(key, model);
      }
      model.attemptCount += 1;
      let requests = statusesByKey.get(key);
      if (!requests) { requests = new Map(); statusesByKey.set(key, requests); }
      const statuses = requests.get(attribution.requestId) ?? [];
      statuses.push(attribution.usageStatus);
      requests.set(attribution.requestId, statuses);
      if (attribution.usage) {
        model.inputTokens += attribution.usage.inputTokens;
        model.outputTokens += attribution.usage.outputTokens;
        model.totalTokens += usageDisplayTotalTokens(attribution.usage, attribution.totalTokens) ?? 0;
      }
    }
  }
  for (const [key, model] of byKey) {
    const groups = statusesByKey.get(key) ?? new Map();
    model.requests = groups.size;
    for (const statuses of groups.values()) {
      const status = foldAttributionStatuses(statuses);
      if (isMeasuredStatus(status)) model.measuredRequests += 1;
      if (status === "reported") model.reportedRequests += 1;
      else if (status === "estimated") model.estimatedRequests += 1;
    }
  }
  // Accumulate per-model estimated cost
  for (const entry of entries) {
    const estimate = entry.attempts?.length
      ? estimateComboCost(entry.attempts)
      : estimateRequestCost({ provider: entry.provider, model: entry.model, usage: entry.usage, usageStatus: entry.usageStatus });
    if (!estimate) continue;

    if (entry.attempts?.length && estimate.attempts) {
      // Combo: attribute each attempt's cost to its own model
      for (const attemptEst of estimate.attempts) {
        const aProviderKey = baseProviderLabel(attemptEst.provider);
        const aKey = `${aProviderKey}${attemptEst.model}`;
        const m = byKey.get(aKey);
        if (m) m.estimatedCostUsd = (m.estimatedCostUsd ?? 0) + attemptEst.cost.total;
      }
    } else {
      // Single-target: attribute to the entry's model
      const providerKey = baseProviderLabel(entry.provider);
      const key = `${providerKey}${entry.model}`;
      const m = byKey.get(key);
      if (m) m.estimatedCostUsd = (m.estimatedCostUsd ?? 0) + estimate.cost.total;
    }
  }
  const models = [...byKey.values()];
  for (const m of models) m.shareRatio = totalTokens === 0 ? 0 : m.totalTokens / totalTokens;
  return models.sort((a, b) => b.requests - a.requests);
}

function buildProviders(entries: PersistedUsageEntry[], totalTokens: number): UsageProvider[] {
  const byKey = new Map<string, UsageProvider>();
  const statusesByKey = new Map<string, Map<string, UsageStatus[]>>();
  for (const entry of entries) {
    for (const attribution of usageAttributions(entry)) {
      const providerKey = baseProviderLabel(attribution.provider);
      let provider = byKey.get(providerKey);
      if (!provider) {
        provider = {
          provider: providerKey,
          requests: 0,
          attemptCount: 0,
          measuredRequests: 0,
          reportedRequests: 0,
          estimatedRequests: 0,
          totalTokens: 0,
          shareRatio: 0,
        };
        byKey.set(providerKey, provider);
      }
      provider.attemptCount += 1;
      let requests = statusesByKey.get(providerKey);
      if (!requests) { requests = new Map(); statusesByKey.set(providerKey, requests); }
      const statuses = requests.get(attribution.requestId) ?? [];
      statuses.push(attribution.usageStatus);
      requests.set(attribution.requestId, statuses);
      if (attribution.usage) {
        provider.totalTokens += usageDisplayTotalTokens(attribution.usage, attribution.totalTokens) ?? 0;
      }
    }
  }
  for (const [key, provider] of byKey) {
    const groups = statusesByKey.get(key) ?? new Map();
    provider.requests = groups.size;
    for (const statuses of groups.values()) {
      const status = foldAttributionStatuses(statuses);
      if (isMeasuredStatus(status)) provider.measuredRequests += 1;
      if (status === "reported") provider.reportedRequests += 1;
      else if (status === "estimated") provider.estimatedRequests += 1;
    }
  }
  for (const entry of entries) {
    const estimate = entry.attempts?.length
      ? estimateComboCost(entry.attempts)
      : estimateRequestCost({ provider: entry.provider, model: entry.model, usage: entry.usage, usageStatus: entry.usageStatus });
    if (!estimate) continue;

    if (entry.attempts?.length && estimate.attempts) {
      for (const attemptEst of estimate.attempts) {
        const aProviderKey = baseProviderLabel(attemptEst.provider);
        const p = byKey.get(aProviderKey);
        if (p) p.estimatedCostUsd = (p.estimatedCostUsd ?? 0) + attemptEst.cost.total;
      }
    } else {
      const providerKey = baseProviderLabel(entry.provider);
      const p = byKey.get(providerKey);
      if (p) p.estimatedCostUsd = (p.estimatedCostUsd ?? 0) + estimate.cost.total;
    }
  }
  const providers = [...byKey.values()];
  for (const p of providers) p.shareRatio = totalTokens === 0 ? 0 : p.totalTokens / totalTokens;
  return providers.sort((a, b) => b.requests - a.requests);
}

export function summarizeUsage(
  entries: PersistedUsageEntry[],
  range: UsageRange,
  now: number,
  surface: UsageSurface = "all",
): UsageSummary {
  const { since } = rangeWindow(range, now);
  const filteredEntries = entries.filter(entry => {
    if (since !== null && entry.timestamp < since) return false;
    if (surface === "claude") return entry.surface === "claude";
    if (surface === "codex") return entry.surface !== "claude";
    return true;
  });
  const totals = blankTotals();
  for (const entry of filteredEntries) {
    bumpStatus(totals, entry.usageStatus);
    totals.attemptCount += entry.attempts?.length ?? 1;
    addTokens(totals, entry);
    addEstimatedCost(totals, entry);
  }
  finalizeCoverage(totals);
  return {
    range,
    surface,
    since,
    generatedAt: now,
    summary: totals,
    days: buildDayGrid(range, since, now, filteredEntries),
    models: buildModels(filteredEntries, totals.totalTokens),
    providers: buildProviders(filteredEntries, totals.totalTokens),
  };
}
