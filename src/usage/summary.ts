import { baseProviderLabel } from "../providers/label";
import { canonicalAntigravityUsageModel } from "../providers/antigravity-models";
import { usageDisplayTotalTokens } from "./totals";
import { isCodexUsageAccountLogLabel, type PersistedUsageEntry, type UsageStatus } from "./log";
import { type AttemptCostEstimate, type CostEstimate, estimateAttemptCost, estimateRequestCost, serviceTierContext, type ServiceTierContext } from "./cost";

/**
 * Canonical range members. The warm-up loop in the management usage route
 * iterates this constant rather than its own literal: the two used to be
 * written separately, and a subset literal type-checks perfectly happily, so a
 * range added to the union but forgotten in the loop was never warmed and
 * never invalidated alongside its siblings.
 */
export const USAGE_RANGES = ["today", "7d", "30d", "all"] as const;
export type UsageRange = typeof USAGE_RANGES[number];
export const USAGE_SURFACES = ["all", "codex", "claude", "grok"] as const;
export type UsageSurface = typeof USAGE_SURFACES[number];

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
  /** Display-time estimated cost for this local day, summed from its model rows. */
  estimatedCostUsd: number;
  models: UsageDayModel[];
}

export interface UsageDayModel {
  model: string;
  provider: string;
  requests: number;
  attemptCount: number;
  totalTokens: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheHitRate?: number | null;
  estimatedCostUsd?: number;
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
  cachedInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheHitRate?: number | null;
  priceCoverageRatio?: number;
  pricedRequests?: number;
  unpricedRequests?: number;
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
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheHitRate?: number | null;
  priceCoverageRatio?: number;
  pricedRequests?: number;
  unpricedRequests?: number;
  shareRatio: number;
  estimatedCostUsd?: number;
}

export interface UsageAccount {
  accountLogLabel: string;
  ambiguous: boolean;
  requests: number;
  attemptCount: number;
  measuredAttempts: number;
  reportedAttempts: number;
  estimatedAttempts: number;
  unmeteredAttempts: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  usageCoverageRatio: number;
  estimatedCostUsd?: number;
  pricedAttempts: number;
  unpricedAttempts: number;
  priceCoverageRatio: number;
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
  accounts: UsageAccount[];
}

/**
 * Echo of an applied provider/model projection.
 *
 * Present only on a filtered response so a consumer can distinguish "no rows
 * matched" from "no traffic in this window", and can tell that the totals it
 * is reading are a projection rather than the whole window.
 */
export interface UsageFilterEcho {
  provider: string | null;
  model: string | null;
  matched: boolean;
  /**
   * True when a retained row came from a combo attribution. Cost partitions
   * cleanly across attempts, but a combo request is counted once per
   * participating model, so a filtered REQUEST count can exceed the number of
   * distinct requests. Cost is unaffected.
   */
  comboOverlap: boolean;
}

export interface EntryCostInfo {
  tier: ServiceTierContext;
  estimate: CostEstimate | null;
  attemptEstimates?: (AttemptCostEstimate | null)[];
  costTotal: number;
  isPriced: boolean;
}

export function cacheTokensFromUsage(usage?: PersistedUsageEntry["usage"]): {
  read: number | undefined;
  creation: number | undefined;
  hasCacheTelemetry: boolean;
} {
  if (!usage) return { read: undefined, creation: undefined, hasCacheTelemetry: false };
  const creation = usage.cacheCreationInputTokens;
  const read = typeof usage.cacheReadInputTokens === "number"
    ? usage.cacheReadInputTokens
    : typeof usage.cachedInputTokens === "number" && typeof creation === "number"
      ? Math.max(0, usage.cachedInputTokens - creation)
      : usage.cachedInputTokens;
  const hasCacheTelemetry = typeof usage.cachedInputTokens === "number"
    || typeof usage.cacheReadInputTokens === "number"
    || typeof usage.cacheCreationInputTokens === "number";
  return { read, creation, hasCacheTelemetry };
}

export function calculateCacheHitRate(
  cacheObserved: boolean,
  inputTokens: number,
  cacheReadTokens: number,
): number | null {
  if (!cacheObserved || inputTokens <= 0) return null;
  return Math.max(0, Math.min(1, cacheReadTokens / inputTokens));
}

export function computeEntryCost(entry: PersistedUsageEntry): EntryCostInfo {
  const tier = serviceTierContext(entry);
  if (entry.attempts?.length) {
    const attemptEstimates = entry.attempts.map(attempt =>
      estimateAttemptCost(attempt, undefined, tier)
    );
    let costTotal = 0;
    let isPriced = false;
    for (const est of attemptEstimates) {
      if (est) {
        costTotal += est.cost.total;
        isPriced = true;
      }
    }
    return { tier, estimate: null, attemptEstimates, costTotal, isPriced };
  }
  const estimate = estimateRequestCost({
    provider: entry.provider,
    model: entry.model,
    usage: entry.usage,
    usageStatus: entry.usageStatus,
    serviceTier: tier,
  });
  return {
    tier,
    estimate,
    costTotal: estimate ? estimate.cost.total : 0,
    isPriced: estimate !== null,
  };
}

const DAY_MS = 86_400_000;
export const MAX_USAGE_MODEL_BREAKDOWN_ROWS = 256;

function retainedBreakdownRows<T>(
  rows: T[],
  aggregateOverflow: (overflow: T[]) => T,
): T[] {
  if (rows.length <= MAX_USAGE_MODEL_BREAKDOWN_ROWS) return rows;
  const keep = rows.slice(0, MAX_USAGE_MODEL_BREAKDOWN_ROWS - 1);
  keep.push(aggregateOverflow(rows.slice(MAX_USAGE_MODEL_BREAKDOWN_ROWS - 1)));
  return keep;
}

export function parseRange(input: string | null | undefined): UsageRange {
  // `1d` normalises here rather than becoming a second union member: a second
  // member would need its own cache slot, its own grid arm and its own test
  // matrix for no user-visible gain.
  if (input === "today" || input === "1d") return "today";
  if (input === "7d" || input === "30d" || input === "all") return input;
  return "30d";
}

export function parseUsageSurface(input: string | null | undefined): UsageSurface {
  if (input === "codex" || input === "claude" || input === "grok") return input;
  return "all";
}

function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function rangeWindow(range: UsageRange, now: number): { since: number | null; days: number } {
  // Handled before the others because the fallthrough below is the `all`
  // window: a range that reaches it is silently reported as all-time history,
  // which for a cost surface is a plausible-looking wrong answer rather than a
  // visible failure.
  if (range === "today") return { since: startOfLocalDay(now), days: 1 };
  if (range === "7d") {
    const start = new Date(startOfLocalDay(now));
    start.setDate(start.getDate() - 6);
    return { since: start.getTime(), days: 7 };
  }
  if (range === "30d") {
    const start = new Date(startOfLocalDay(now));
    start.setDate(start.getDate() - 29);
    return { since: start.getTime(), days: 30 };
  }
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


/**
 * Usage row identity for model breakdowns.
 * Google Antigravity collapses wire/compat/suffix ids to picker/call base models so
 * historical effort-variant logs merge with current base-model invocations.
 */
function usageModelIdentity(
  provider: string,
  model: string,
  resolvedModel?: string,
): { model: string; resolvedModel?: string } {
  if (baseProviderLabel(provider) !== "google-antigravity") {
    return resolvedModel ? { model, resolvedModel } : { model };
  }
  const fromModel = canonicalAntigravityUsageModel(model);
  const fromResolved = resolvedModel
    ? canonicalAntigravityUsageModel(resolvedModel)
    : undefined;
  // Prefer an explicit base mapping from model; if model is unknown but resolved maps
  // to a known base, use that (covers base call + upstream wire resolvedModel pairs).
  const canonical = fromModel !== model
    ? fromModel
    : (fromResolved && fromResolved !== resolvedModel ? fromResolved : fromModel);
  return { model: canonical };
}

function usageModelKey(providerKey: string, model: string): string {
  return `${providerKey}/${model}`;
}

function usageAttributions(entry: PersistedUsageEntry): UsageAttribution[] {
  if (!entry.attempts?.length) {
    return [{
      requestId: entry.requestId,
      provider: entry.provider,
      ...usageModelIdentity(entry.provider, entry.model, entry.resolvedModel),
      usageStatus: entry.usageStatus,
      ...(entry.usage ? { usage: entry.usage } : {}),
      ...(entry.totalTokens !== undefined ? { totalTokens: entry.totalTokens } : {}),
    }];
  }
  return entry.attempts.map(attempt => ({
    requestId: entry.requestId,
    provider: attempt.provider,
    ...usageModelIdentity(attempt.provider, attempt.model),
    usageStatus: attempt.usageStatus,
    ...(attempt.usage ? { usage: attempt.usage } : {}),
    ...(attempt.totalTokens !== undefined ? { totalTokens: attempt.totalTokens } : {}),
  }));
}

function projectedComboUsage(
  attempts: readonly NonNullable<PersistedUsageEntry["attempts"]>[number][],
): { usage?: PersistedUsageEntry["usage"]; totalTokens?: number } {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let cacheReadInputTokens = 0;
  let cacheCreationInputTokens = 0;
  let reasoningOutputTokens = 0;
  let hasUsage = false;
  let hasCacheTelemetry = false;
  let hasReasoningTelemetry = false;
  let totalTokens = 0;
  let hasTotalTokens = false;
  let estimated = false;

  for (const attempt of attempts) {
    if (attempt.usage) {
      hasUsage = true;
      inputTokens += attempt.usage.inputTokens;
      outputTokens += attempt.usage.outputTokens;
      const cache = cacheTokensFromUsage(attempt.usage);
      if (cache.hasCacheTelemetry) hasCacheTelemetry = true;
      if (typeof cache.read === "number") {
        cachedInputTokens += cache.read;
        cacheReadInputTokens += cache.read;
      }
      if (typeof cache.creation === "number") cacheCreationInputTokens += cache.creation;
      if (typeof attempt.usage.reasoningOutputTokens === "number") {
        hasReasoningTelemetry = true;
        reasoningOutputTokens += attempt.usage.reasoningOutputTokens;
      }
      if (attempt.usage.estimated === true) estimated = true;
    }
    const attemptTotal = usageDisplayTotalTokens(attempt.usage, attempt.totalTokens);
    if (attemptTotal !== undefined) {
      hasTotalTokens = true;
      totalTokens += attemptTotal;
    }
  }

  if (!hasUsage && !hasTotalTokens) return {};
  const usage = hasUsage
    ? {
      inputTokens,
      outputTokens,
      ...(hasCacheTelemetry ? { cachedInputTokens, cacheReadInputTokens, cacheCreationInputTokens } : {}),
      ...(hasReasoningTelemetry ? { reasoningOutputTokens } : {}),
      ...(estimated ? { estimated: true } : {}),
    }
    : undefined;
  return {
    ...(usage ? { usage } : {}),
    ...(hasTotalTokens ? { totalTokens } : {}),
  };
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
  const { read, creation } = cacheTokensFromUsage(entry.usage);
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
  entry: Pick<PersistedUsageEntry, "usageStatus" | "usage" | "attempts">,
  costInfo: EntryCostInfo,
): void {
  if (entry.usageStatus === "unreported" || entry.usageStatus === "unsupported"
    || (!entry.usage && !entry.attempts?.length)) {
    totals.unmeteredRequests += 1;
    return;
  }
  if (!costInfo.isPriced) {
    totals.unpricedRequests += 1;
    return;
  }
  totals.pricedRequests += 1;
  totals.estimatedCostUsd += costInfo.costTotal;
}

function buildDayGrid(range: UsageRange, since: number | null, now: number, entries: PersistedUsageEntry[], costMap: Map<PersistedUsageEntry, EntryCostInfo>): UsageDay[] {
  const window = rangeWindow(range, now);
  const days = range === "all" ? dayCountForAllRange(entries, now) : window.days;
  const grid = new Map<string, UsageDay>();
  // Per-day model breakdown accumulator, keyed by day then provider/model, so the 7d bar chart can
  // render a per-model stacked bar with a hover tooltip without a second pass over the entries.
  interface DayModelAccumulator extends UsageDayModel {
    cacheObserved?: boolean;
  }
  const dayModels = new Map<string, Map<string, DayModelAccumulator>>();
  const dayModelRequests = new Map<string, Set<string>>();
  const bumpDayModel = (dayKey: string, attribution: UsageAttribution): void => {
    let models = dayModels.get(dayKey);
    if (!models) { models = new Map(); dayModels.set(dayKey, models); }
    const providerKey = baseProviderLabel(attribution.provider);
    const mKey = usageModelKey(providerKey, attribution.model);
    let m = models.get(mKey);
    if (!m) {
      m = {
        model: attribution.model,
        provider: providerKey,
        requests: 0,
        attemptCount: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheHitRate: null,
      };
      models.set(mKey, m);
    }
    const requestKey = `${dayKey}\0${mKey}`;
    let requests = dayModelRequests.get(requestKey);
    if (!requests) { requests = new Set(); dayModelRequests.set(requestKey, requests); }
    requests.add(attribution.requestId);
    m.requests = requests.size;
    m.attemptCount += 1;
    if (attribution.usage) {
      m.inputTokens = (m.inputTokens ?? 0) + attribution.usage.inputTokens;
      m.outputTokens = (m.outputTokens ?? 0) + attribution.usage.outputTokens;
      const { read, creation, hasCacheTelemetry } = cacheTokensFromUsage(attribution.usage);
      if (hasCacheTelemetry) m.cacheObserved = true;
      if (typeof read === "number") m.cacheReadInputTokens = (m.cacheReadInputTokens ?? 0) + read;
      if (typeof creation === "number") m.cacheCreationInputTokens = (m.cacheCreationInputTokens ?? 0) + creation;
    }
    m.totalTokens += usageDisplayTotalTokens(attribution.usage, attribution.totalTokens) ?? 0;
  };
  const startOfToday = startOfLocalDay(now);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(startOfToday);
    d.setDate(d.getDate() - i);
    const key = localDateKey(d.getTime());
    grid.set(key, { date: key, requests: 0, measuredRequests: 0, reportedRequests: 0, totalTokens: 0, estimatedCostUsd: 0, models: [] });
  }
  for (const entry of entries) {
    const key = localDateKey(entry.timestamp);
    let day = grid.get(key);
    if (!day) {
      day = { date: key, requests: 0, measuredRequests: 0, reportedRequests: 0, totalTokens: 0, estimatedCostUsd: 0, models: [] };
      grid.set(key, day);
    }
    day.requests += 1;
    if (isMeasuredStatus(entry.usageStatus)) day.measuredRequests += 1;
    if (entry.usageStatus === "reported") day.reportedRequests += 1;
    day.totalTokens += usageDisplayTotalTokens(entry.usage, entry.totalTokens) ?? 0;
    for (const attribution of usageAttributions(entry)) bumpDayModel(key, attribution);
    const costInfo = costMap.get(entry);
    if (costInfo?.isPriced) {
      if (entry.attempts?.length && costInfo.attemptEstimates) {
        for (let i = 0; i < entry.attempts.length; i++) {
          const attempt = entry.attempts[i];
          const attemptEst = costInfo.attemptEstimates[i];
          if (attemptEst) {
            const aProviderKey = baseProviderLabel(attempt.provider);
            const aIdentity = usageModelIdentity(attempt.provider, attempt.model);
            const aKey = usageModelKey(aProviderKey, aIdentity.model);
            const m = dayModels.get(key)?.get(aKey);
            if (m) m.estimatedCostUsd = (m.estimatedCostUsd ?? 0) + attemptEst.cost.total;
          }
        }
      } else if (costInfo.estimate) {
        const providerKey = baseProviderLabel(entry.provider);
        const identity = usageModelIdentity(entry.provider, entry.model, entry.resolvedModel);
        const mKey = usageModelKey(providerKey, identity.model);
        const m = dayModels.get(key)?.get(mKey);
        if (m) m.estimatedCostUsd = (m.estimatedCostUsd ?? 0) + costInfo.estimate.cost.total;
      }
      day.estimatedCostUsd += costInfo.costTotal;
    }
  }
  void since;
  const out = [...grid.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const day of out) {
    const models = dayModels.get(day.date);
    if (models) {
      for (const m of models.values()) {
        m.cacheHitRate = calculateCacheHitRate(!!m.cacheObserved, m.inputTokens ?? 0, m.cacheReadInputTokens ?? 0);
      }
      const sorted = [...models.values()].sort((a, b) => b.requests - a.requests);
      const retained = retainedBreakdownRows(sorted, overflow => {
        const requests = new Set<string>();
        let attemptCount = 0;
        let totalTokens = 0;
        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadInputTokens = 0;
        let cacheCreationInputTokens = 0;
        let cacheObserved = false;
        let estimatedCostUsd: number | undefined;
        for (const model of overflow) {
          attemptCount += model.attemptCount;
          totalTokens += model.totalTokens;
          inputTokens += model.inputTokens ?? 0;
          outputTokens += model.outputTokens ?? 0;
          cacheReadInputTokens += model.cacheReadInputTokens ?? 0;
          cacheCreationInputTokens += model.cacheCreationInputTokens ?? 0;
          if (model.cacheObserved) cacheObserved = true;
          if (model.estimatedCostUsd !== undefined) {
            estimatedCostUsd = (estimatedCostUsd ?? 0) + model.estimatedCostUsd;
          }
          const requestKey = `${day.date}\0${usageModelKey(model.provider, model.model)}`;
          for (const requestId of dayModelRequests.get(requestKey) ?? []) requests.add(requestId);
        }
        const cacheHitRate = calculateCacheHitRate(cacheObserved, inputTokens, cacheReadInputTokens);
        return {
          model: "other",
          provider: "other",
          requests: requests.size,
          attemptCount,
          totalTokens,
          inputTokens,
          outputTokens,
          cacheReadInputTokens,
          cacheCreationInputTokens,
          cacheHitRate,
          ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
        };
      });
      for (const model of retained) delete model.cacheObserved;
      day.models = retained;
    }
  }
  return out;
}

function buildModels(entries: PersistedUsageEntry[], totalTokens: number, costMap: Map<PersistedUsageEntry, EntryCostInfo>): UsageModel[] {
  interface ModelAccumulator extends UsageModel {
    cacheObserved?: boolean;
  }
  const byKey = new Map<string, ModelAccumulator>();
  const statusesByKey = new Map<string, Map<string, UsageStatus[]>>();
  for (const entry of entries) {
    for (const attribution of usageAttributions(entry)) {
      const providerKey = baseProviderLabel(attribution.provider);
      // resolvedModel is a routing detail, not a row identity.
      const key = usageModelKey(providerKey, attribution.model);
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
          cachedInputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          pricedRequests: 0,
          unpricedRequests: 0,
          priceCoverageRatio: 0,
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
        const { read, creation, hasCacheTelemetry } = cacheTokensFromUsage(attribution.usage);
        if (hasCacheTelemetry) model.cacheObserved = true;
        if (typeof read === "number") {
          model.cachedInputTokens = (model.cachedInputTokens ?? 0) + read;
          model.cacheReadInputTokens = (model.cacheReadInputTokens ?? 0) + read;
        }
        if (typeof creation === "number") {
          model.cacheCreationInputTokens = (model.cacheCreationInputTokens ?? 0) + creation;
        }
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
  // Accumulate per-model estimated cost & price coverage by request ID
  const pricedRequestsByModel = new Map<string, Set<string>>();
  const unpricedRequestsByModel = new Map<string, Set<string>>();
  for (const entry of entries) {
    const costInfo = costMap.get(entry);
    if (entry.attempts?.length) {
      const attemptEstimates = costInfo?.attemptEstimates;
      for (let i = 0; i < entry.attempts.length; i++) {
        const attempt = entry.attempts[i];
        const attemptEst = attemptEstimates?.[i];
        const aProviderKey = baseProviderLabel(attempt.provider);
        const aIdentity = usageModelIdentity(attempt.provider, attempt.model);
        const aKey = usageModelKey(aProviderKey, aIdentity.model);
        if (attemptEst) {
          const m = byKey.get(aKey);
          if (m) {
            m.estimatedCostUsd = (m.estimatedCostUsd ?? 0) + attemptEst.cost.total;
          }
          let s = pricedRequestsByModel.get(aKey);
          if (!s) { s = new Set(); pricedRequestsByModel.set(aKey, s); }
          s.add(entry.requestId);
        } else {
          let s = unpricedRequestsByModel.get(aKey);
          if (!s) { s = new Set(); unpricedRequestsByModel.set(aKey, s); }
          s.add(entry.requestId);
        }
      }
    } else {
      const providerKey = baseProviderLabel(entry.provider);
      const identity = usageModelIdentity(entry.provider, entry.model, entry.resolvedModel);
      const key = usageModelKey(providerKey, identity.model);
      const estimate = costInfo?.estimate;
      if (estimate) {
        const m = byKey.get(key);
        if (m) {
          m.estimatedCostUsd = (m.estimatedCostUsd ?? 0) + estimate.cost.total;
        }
        let s = pricedRequestsByModel.get(key);
        if (!s) { s = new Set(); pricedRequestsByModel.set(key, s); }
        s.add(entry.requestId);
      } else {
        let s = unpricedRequestsByModel.get(key);
        if (!s) { s = new Set(); unpricedRequestsByModel.set(key, s); }
        s.add(entry.requestId);
      }
    }
  }
  const models = [...byKey.values()];
  for (const [key, m] of byKey) {
    m.pricedRequests = pricedRequestsByModel.get(key)?.size ?? 0;
    m.unpricedRequests = unpricedRequestsByModel.get(key)?.size ?? 0;
    m.shareRatio = totalTokens === 0 ? 0 : m.totalTokens / totalTokens;
    m.cacheHitRate = calculateCacheHitRate(!!m.cacheObserved, m.inputTokens, m.cacheReadInputTokens ?? 0);
    m.priceCoverageRatio = m.requests > 0 ? m.pricedRequests / m.requests : 0;
  }
  const sorted = models.sort((a, b) => b.requests - a.requests);
  const retained = retainedBreakdownRows(sorted, overflow => {
    const statusesByRequest = new Map<string, UsageStatus[]>();
    const overflowPricedRequests = new Set<string>();
    const overflowUnpricedRequests = new Set<string>();
    let cacheObserved = false;
    const other: ModelAccumulator = {
      provider: "other",
      model: "other",
      requests: 0,
      attemptCount: 0,
      measuredRequests: 0,
      reportedRequests: 0,
      estimatedRequests: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      pricedRequests: 0,
      unpricedRequests: 0,
      priceCoverageRatio: 0,
      shareRatio: 0,
    };
    for (const model of overflow) {
      other.attemptCount += model.attemptCount;
      other.totalTokens += model.totalTokens;
      other.inputTokens += model.inputTokens;
      other.outputTokens += model.outputTokens;
      if (model.cacheObserved) cacheObserved = true;
      other.cachedInputTokens = (other.cachedInputTokens ?? 0) + (model.cachedInputTokens ?? 0);
      other.cacheReadInputTokens = (other.cacheReadInputTokens ?? 0) + (model.cacheReadInputTokens ?? 0);
      other.cacheCreationInputTokens = (other.cacheCreationInputTokens ?? 0) + (model.cacheCreationInputTokens ?? 0);
      if (model.estimatedCostUsd !== undefined) {
        other.estimatedCostUsd = (other.estimatedCostUsd ?? 0) + model.estimatedCostUsd;
      }
      const key = usageModelKey(model.provider, model.model);
      for (const [requestId, statuses] of statusesByKey.get(key) ?? []) {
        const combined = statusesByRequest.get(requestId) ?? [];
        combined.push(...statuses);
        statusesByRequest.set(requestId, combined);
      }
      for (const reqId of pricedRequestsByModel.get(key) ?? []) overflowPricedRequests.add(reqId);
      for (const reqId of unpricedRequestsByModel.get(key) ?? []) overflowUnpricedRequests.add(reqId);
    }
    other.requests = statusesByRequest.size;
    other.pricedRequests = overflowPricedRequests.size;
    other.unpricedRequests = overflowUnpricedRequests.size;
    for (const statuses of statusesByRequest.values()) {
      const status = foldAttributionStatuses(statuses);
      if (isMeasuredStatus(status)) other.measuredRequests += 1;
      if (status === "reported") other.reportedRequests += 1;
      else if (status === "estimated") other.estimatedRequests += 1;
    }
    other.shareRatio = totalTokens === 0 ? 0 : other.totalTokens / totalTokens;
    other.cacheHitRate = calculateCacheHitRate(cacheObserved, other.inputTokens, other.cacheReadInputTokens ?? 0);
    other.priceCoverageRatio = other.requests > 0 ? other.pricedRequests / other.requests : 0;
    return other;
  });
  for (const model of retained) delete model.cacheObserved;
  return retained;
}

function buildProviders(entries: PersistedUsageEntry[], totalTokens: number, costMap: Map<PersistedUsageEntry, EntryCostInfo>): UsageProvider[] {
  interface ProviderAccumulator extends UsageProvider {
    cacheObserved?: boolean;
  }
  const byKey = new Map<string, ProviderAccumulator>();
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
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          pricedRequests: 0,
          unpricedRequests: 0,
          priceCoverageRatio: 0,
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
        provider.inputTokens = (provider.inputTokens ?? 0) + attribution.usage.inputTokens;
        provider.outputTokens = (provider.outputTokens ?? 0) + attribution.usage.outputTokens;
        const { read, creation, hasCacheTelemetry } = cacheTokensFromUsage(attribution.usage);
        if (hasCacheTelemetry) provider.cacheObserved = true;
        if (typeof read === "number") {
          provider.cachedInputTokens = (provider.cachedInputTokens ?? 0) + read;
          provider.cacheReadInputTokens = (provider.cacheReadInputTokens ?? 0) + read;
        }
        if (typeof creation === "number") {
          provider.cacheCreationInputTokens = (provider.cacheCreationInputTokens ?? 0) + creation;
        }
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
  const pricedRequestsByProvider = new Map<string, Set<string>>();
  const unpricedRequestsByProvider = new Map<string, Set<string>>();
  for (const entry of entries) {
    const costInfo = costMap.get(entry);
    if (entry.attempts?.length) {
      const attemptEstimates = costInfo?.attemptEstimates;
      for (let i = 0; i < entry.attempts.length; i++) {
        const attempt = entry.attempts[i];
        const attemptEst = attemptEstimates?.[i];
        const aProviderKey = baseProviderLabel(attempt.provider);
        if (attemptEst) {
          const p = byKey.get(aProviderKey);
          if (p) {
            p.estimatedCostUsd = (p.estimatedCostUsd ?? 0) + attemptEst.cost.total;
          }
          let s = pricedRequestsByProvider.get(aProviderKey);
          if (!s) { s = new Set(); pricedRequestsByProvider.set(aProviderKey, s); }
          s.add(entry.requestId);
        } else {
          let s = unpricedRequestsByProvider.get(aProviderKey);
          if (!s) { s = new Set(); unpricedRequestsByProvider.set(aProviderKey, s); }
          s.add(entry.requestId);
        }
      }
    } else {
      const providerKey = baseProviderLabel(entry.provider);
      const estimate = costInfo?.estimate;
      if (estimate) {
        const p = byKey.get(providerKey);
        if (p) {
          p.estimatedCostUsd = (p.estimatedCostUsd ?? 0) + estimate.cost.total;
        }
        let s = pricedRequestsByProvider.get(providerKey);
        if (!s) { s = new Set(); pricedRequestsByProvider.set(providerKey, s); }
        s.add(entry.requestId);
      } else {
        let s = unpricedRequestsByProvider.get(providerKey);
        if (!s) { s = new Set(); unpricedRequestsByProvider.set(providerKey, s); }
        s.add(entry.requestId);
      }
    }
  }
  const providers = [...byKey.values()];
  for (const [key, p] of byKey) {
    p.pricedRequests = pricedRequestsByProvider.get(key)?.size ?? 0;
    p.unpricedRequests = unpricedRequestsByProvider.get(key)?.size ?? 0;
    p.shareRatio = totalTokens === 0 ? 0 : p.totalTokens / totalTokens;
    p.cacheHitRate = calculateCacheHitRate(!!p.cacheObserved, p.inputTokens ?? 0, p.cacheReadInputTokens ?? 0);
    p.priceCoverageRatio = p.requests > 0 ? p.pricedRequests / p.requests : 0;
  }
  const sorted = providers.sort((a, b) => b.requests - a.requests);
  for (const provider of sorted) delete provider.cacheObserved;
  return sorted;
}

const LEGACY_AMBIGUOUS_ACCOUNT_LABEL = "legacy-ambiguous";

function legacyCodexAccountLabel(provider: string): string | null {
  if (baseProviderLabel(provider) !== "openai") return null;
  const suffix = provider.match(/-(main|p[a-f0-9]{6})$/)?.[1];
  return suffix ?? LEGACY_AMBIGUOUS_ACCOUNT_LABEL;
}

/**
 * An explicitly stamped label of EITHER family is authoritative for any provider (#2699).
 *
 * No `o`-label branch is needed here: `isCodexUsageAccountLogLabel` now accepts both families,
 * and adding a second predicate call would be a no-op guarded by a comment claiming otherwise.
 *
 * The legacy fallback stays openai-only on purpose. It infers an account from the PROVIDER
 * string, and inferring for a non-Codex row would merge unrelated accounts under one label --
 * so an unlabeled xai row is dropped from the account table rather than guessed at.
 */
function accountLabelForAttribution(provider: string, explicit: unknown): string | null {
  if (isCodexUsageAccountLogLabel(explicit)) return explicit;
  return legacyCodexAccountLabel(provider);
}

function buildAccounts(entries: PersistedUsageEntry[], costMap: Map<PersistedUsageEntry, EntryCostInfo>): UsageAccount[] {
  const byLabel = new Map<string, UsageAccount>();
  const requestIds = new Map<string, Set<string>>();

  const add = (input: {
    requestId: string;
    provider: string;
    accountLogLabel?: string;
    usageStatus: UsageStatus;
    usage?: PersistedUsageEntry["usage"];
    totalTokens?: number;
    estimate: AttemptCostEstimate | CostEstimate | null;
  }): void => {
    const label = accountLabelForAttribution(input.provider, input.accountLogLabel);
    if (!label) return;
    let row = byLabel.get(label);
    if (!row) {
      row = {
        accountLogLabel: label,
        ambiguous: label === LEGACY_AMBIGUOUS_ACCOUNT_LABEL,
        requests: 0,
        attemptCount: 0,
        measuredAttempts: 0,
        reportedAttempts: 0,
        estimatedAttempts: 0,
        unmeteredAttempts: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
        usageCoverageRatio: 0,
        pricedAttempts: 0,
        unpricedAttempts: 0,
        priceCoverageRatio: 0,
      };
      byLabel.set(label, row);
      requestIds.set(label, new Set());
    }
    requestIds.get(label)!.add(input.requestId);
    row.requests = requestIds.get(label)!.size;
    row.attemptCount += 1;
    const measured = input.usage !== undefined && isMeasuredStatus(input.usageStatus);
    if (!measured) {
      row.unmeteredAttempts += 1;
      return;
    }

    row.measuredAttempts += 1;
    if (input.usageStatus === "reported") row.reportedAttempts += 1;
    else if (input.usageStatus === "estimated") row.estimatedAttempts += 1;
    row.inputTokens += input.usage!.inputTokens;
    row.outputTokens += input.usage!.outputTokens;
    const { read, creation } = cacheTokensFromUsage(input.usage);
    if (typeof read === "number") row.cacheReadInputTokens += read;
    if (typeof creation === "number") row.cacheCreationInputTokens += creation;
    if (typeof input.usage!.reasoningOutputTokens === "number") {
      row.reasoningOutputTokens += input.usage!.reasoningOutputTokens;
    }
    row.totalTokens += usageDisplayTotalTokens(input.usage, input.totalTokens) ?? 0;
    if (input.estimate) {
      row.pricedAttempts += 1;
      row.estimatedCostUsd = (row.estimatedCostUsd ?? 0) + input.estimate.cost.total;
    } else {
      row.unpricedAttempts += 1;
    }
  };

  for (const entry of entries) {
    const costInfo = costMap.get(entry);
    if (entry.attempts?.length) {
      for (let i = 0; i < entry.attempts.length; i++) {
        const attempt = entry.attempts[i];
        const attemptEst = costInfo?.attemptEstimates?.[i] ?? null;
        add({
          requestId: entry.requestId,
          provider: attempt.provider,
          ...(attempt.accountLogLabel ? { accountLogLabel: attempt.accountLogLabel } : {}),
          usageStatus: attempt.usageStatus,
          ...(attempt.usage ? { usage: attempt.usage } : {}),
          ...(attempt.totalTokens !== undefined ? { totalTokens: attempt.totalTokens } : {}),
          estimate: attemptEst,
        });
      }
      continue;
    }
    add({
      requestId: entry.requestId,
      provider: entry.provider,
      ...(entry.accountLogLabel ? { accountLogLabel: entry.accountLogLabel } : {}),
      usageStatus: entry.usageStatus,
      ...(entry.usage ? { usage: entry.usage } : {}),
      ...(entry.totalTokens !== undefined ? { totalTokens: entry.totalTokens } : {}),
      estimate: costInfo?.estimate ?? null,
    });
  }

  for (const row of byLabel.values()) {
    row.usageCoverageRatio = row.attemptCount === 0 ? 0 : row.measuredAttempts / row.attemptCount;
    row.priceCoverageRatio = row.measuredAttempts === 0 ? 0 : row.pricedAttempts / row.measuredAttempts;
  }
  return [...byLabel.values()].sort((a, b) => b.totalTokens - a.totalTokens);
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
    if (surface === "claude") return entry.surface === "claude" || entry.surface === "claude-desktop";
    if (surface === "grok") return entry.surface === "grok";
    // Codex = the historical unlabelled bucket. Before the grok tag existed every
    // non-Claude turn landed here, and `surface !== "claude"` also swallowed
    // claude-desktop — disjoint predicates fix both.
    if (surface === "codex") return entry.surface === undefined;
    return true;
  });
  const costMap = new Map<PersistedUsageEntry, EntryCostInfo>();
  for (const entry of filteredEntries) {
    costMap.set(entry, computeEntryCost(entry));
  }
  const totals = blankTotals();
  for (const entry of filteredEntries) {
    bumpStatus(totals, entry.usageStatus);
    totals.attemptCount += entry.attempts?.length ?? 1;
    addTokens(totals, entry);
    addEstimatedCost(totals, entry, costMap.get(entry)!);
  }
  finalizeCoverage(totals);
  return {
    range,
    surface,
    since,
    generatedAt: now,
    summary: totals,
    days: buildDayGrid(range, since, now, filteredEntries, costMap),
    models: buildModels(filteredEntries, totals.totalTokens, costMap),
    providers: buildProviders(filteredEntries, totals.totalTokens, costMap),
    accounts: buildAccounts(filteredEntries, costMap),
  };
}

function normalizeFilterValue(input: string | null | undefined): string | null {
  const trimmed = typeof input === "string" ? input.trim() : "";
  return trimmed === "" ? null : trimmed.toLowerCase();
}

/**
 * Narrow an already-summarised window to one provider and/or model.
 *
 * Deliberately a projection over a finished summary rather than a parameter to
 * {@link summarizeUsage}. The management route caches summaries under
 * `range:surface` and warms that key space as a cross-product; a filtered
 * summary that reached either would be served to the next UNFILTERED caller,
 * the dashboard included. Keeping the filter outside the producer makes that
 * mistake unrepresentable rather than merely discouraged.
 *
 * Totals are recomputed from the retained rows. For combo traffic a request is
 * counted once per participating model, so a filtered request count can exceed
 * the number of distinct requests; `comboOverlap` reports when that is
 * possible. Cost is unaffected — combo cost is attributed per attempt, so it
 * partitions across models rather than repeating.
 *
 * `accounts` is emptied whenever a filter is active: account rows are not
 * provider-partitioned in a way this projection could honestly re-derive, and
 * unfiltered account totals sitting beside filtered model totals would invite
 * exactly the wrong reading.
 */
export function projectUsageSummary<T extends UsageSummary>(
  summary: T,
  filter: { provider?: string | null; model?: string | null },
  entries?: PersistedUsageEntry[],
): T & { filter?: UsageFilterEcho } {
  const provider = normalizeFilterValue(filter.provider);
  const model = normalizeFilterValue(filter.model);
  if (provider === null && model === null) return summary;

  const matches = (rowProvider: string, rowModel: string): boolean => {
    if (provider !== null && baseProviderLabel(rowProvider).toLowerCase() !== provider) return false;
    if (model !== null && rowModel.toLowerCase() !== model) return false;
    return true;
  };

  const source = entries ?? [];
  let comboOverlap = false;
  const filtered: PersistedUsageEntry[] = [];
  for (const entry of source) {
    if (!entry.attempts?.length) {
      const identity = usageModelIdentity(entry.provider, entry.model, entry.resolvedModel);
      if (matches(entry.provider, identity.model)) filtered.push(entry);
      continue;
    }
    const attempts = entry.attempts.filter(a => {
      const identity = usageModelIdentity(a.provider, a.model);
      return matches(a.provider, identity.model);
    });
    if (attempts.length === 0) continue;
    if (entry.attempts.length > 1) comboOverlap = true;
    const { usage: _parentUsage, totalTokens: _parentTotalTokens, ...withoutParentUsage } = entry;
    filtered.push({ ...withoutParentUsage, attempts, ...projectedComboUsage(attempts) });
  }

  const projected = summarizeUsage(filtered, summary.range, summary.generatedAt, summary.surface);
  const matched = projected.summary.requests > 0;
  const models = projected.models.filter(row => matches(row.provider, row.model));
  const retainedProviders = new Set(models.map(row => row.provider));
  return {
    ...summary,
    summary: projected.summary,
    days: projected.days.map(day => ({ ...day, models: day.models.filter(row => matches(row.provider, row.model)) })),
    models,
    providers: projected.providers.filter(row => retainedProviders.has(row.provider)),
    accounts: [],
    filter: { provider, model, matched, comboOverlap },
  };
}
