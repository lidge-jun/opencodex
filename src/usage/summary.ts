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
/** Maximum number of calendar buckets returned by the all-history chart. */
export const MAX_USAGE_DAY_BUCKETS = 366;

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
 * Echo of an applied API-key/provider/model projection.
 *
 * Present only on a filtered response so a consumer can distinguish "no rows
 * matched" from "no traffic in this window", and can tell that the totals it
 * is reading are a projection rather than the whole window.
 */
export interface UsageFilterEcho {
  provider: string | null;
  model: string | null;
  apiKeyId: string | null;
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
  const y = String(d.getFullYear()).padStart(4, "0");
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dayCountForAllRange(oldest: number | null, now: number): number {
  if (oldest === null) return 1;
  const days = Math.ceil((now - oldest) / DAY_MS) + 1;
  return Math.min(MAX_USAGE_DAY_BUCKETS, Math.max(1, days));
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
  accountLogLabel?: string;
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
  return `${providerKey}\0${model}`;
}

function usageAttributions(entry: PersistedUsageEntry): UsageAttribution[] {
  if (!entry.attempts?.length) {
    return [{
      requestId: entry.requestId,
      provider: entry.provider,
      ...usageModelIdentity(entry.provider, entry.model, entry.resolvedModel),
      ...(entry.accountLogLabel ? { accountLogLabel: entry.accountLogLabel } : {}),
      usageStatus: entry.usageStatus,
      ...(entry.usage ? { usage: entry.usage } : {}),
      ...(entry.totalTokens !== undefined ? { totalTokens: entry.totalTokens } : {}),
    }];
  }
  return entry.attempts.map(attempt => ({
    requestId: entry.requestId,
    provider: attempt.provider,
    ...usageModelIdentity(attempt.provider, attempt.model),
    ...(attempt.accountLogLabel ? { accountLogLabel: attempt.accountLogLabel } : {}),
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

const REQUEST_REPORTED = 1 << 0;
const REQUEST_ESTIMATED = 1 << 1;
const REQUEST_UNREPORTED = 1 << 2;
const REQUEST_UNSUPPORTED = 1 << 3;
const REQUEST_PRICED = 1 << 4;
const REQUEST_UNPRICED = 1 << 5;
const REQUEST_STATUS_MASK = REQUEST_REPORTED | REQUEST_ESTIMATED | REQUEST_UNREPORTED | REQUEST_UNSUPPORTED;

type UsagePartitionSurface = Exclude<UsageSurface, "all"> | "other";
export type UsageAccumulatorMode = "exact" | "row-unique";

interface UsageRequestCounts {
  requests: number;
  measuredRequests: number;
  reportedRequests: number;
  estimatedRequests: number;
  pricedRequests: number;
  unpricedRequests: number;
}

interface UsageModelOverlap {
  models: ReadonlyArray<readonly [modelKey: string, requestFacts: number]>;
  count: number;
}

interface UsageModelAccumulator {
  provider: string;
  model: string;
  resolvedModel?: string;
  firstSeen: number;
  attemptCount: number;
  dayTotalTokens: number;
  summaryTotalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  cacheObserved: boolean;
  estimatedCostUsd?: number;
  requestCounts: UsageRequestCounts;
  requestFacts?: Map<number, number>;
}

interface UsageAccountAccumulator {
  accountLogLabel: string;
  ambiguous: boolean;
  firstSeen: number;
  requests: number;
  requestIds?: Set<number>;
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
  estimatedCostUsd?: number;
  pricedAttempts: number;
  unpricedAttempts: number;
}

interface UsagePartition {
  date: string;
  dayStart: number;
  surface: UsagePartitionSurface;
  oldestTimestamp: number | null;
  totals: UsageSummaryTotals;
  models: Map<string, UsageModelAccumulator>;
  providers?: Map<string, UsageModelAccumulator>;
  accounts: Map<string, UsageAccountAccumulator>;
  modelOverlaps: Map<string, UsageModelOverlap>;
}

interface UsageDayAccumulator {
  totals: UsageSummaryTotals;
  models: Map<string, UsageModelAccumulator>;
  modelOverlaps: UsageModelOverlap[];
}

interface NormalizedUsageFilter {
  provider: string | null;
  model: string | null;
  apiKeyId: string | null;
}

export interface UsageSummaryAccumulator {
  add(entry: PersistedUsageEntry): void;
  /** Return a mutation-independent snapshot that may continue accepting rows. */
  clone(): UsageSummaryAccumulator;
  summarize(
    range: UsageRange,
    now: number,
    surface?: UsageSurface,
  ): UsageSummary & { filter?: UsageFilterEcho };
  readonly snapshotWindow: { start: number | null; end: number | null };
  /** Conservative O(1) retained-state estimate; excludes scan and summarize temporaries. */
  readonly estimatedBytes: number;
}

function requestStatusFact(status: UsageStatus): number {
  if (status === "reported") return REQUEST_REPORTED;
  if (status === "estimated") return REQUEST_ESTIMATED;
  if (status === "unsupported") return REQUEST_UNSUPPORTED;
  return REQUEST_UNREPORTED;
}

function statusFromRequestFacts(facts: number): UsageStatus {
  const statuses = facts & REQUEST_STATUS_MASK;
  if (statuses === REQUEST_UNSUPPORTED) return "unsupported";
  if ((statuses & (REQUEST_UNREPORTED | REQUEST_UNSUPPORTED)) !== 0) return "unreported";
  if ((statuses & REQUEST_ESTIMATED) !== 0) return "estimated";
  return (statuses & REQUEST_REPORTED) !== 0 ? "reported" : "unreported";
}

function blankRequestCounts(): UsageRequestCounts {
  return {
    requests: 0,
    measuredRequests: 0,
    reportedRequests: 0,
    estimatedRequests: 0,
    pricedRequests: 0,
    unpricedRequests: 0,
  };
}

function bumpRequestCounts(counts: UsageRequestCounts, facts: number, amount = 1): void {
  counts.requests += amount;
  const status = statusFromRequestFacts(facts);
  if (isMeasuredStatus(status)) counts.measuredRequests += amount;
  if (status === "reported") counts.reportedRequests += amount;
  else if (status === "estimated") counts.estimatedRequests += amount;
  if ((facts & REQUEST_PRICED) !== 0) counts.pricedRequests += amount;
  if ((facts & REQUEST_UNPRICED) !== 0) counts.unpricedRequests += amount;
}

function mergeRequestCounts(target: UsageRequestCounts, source: UsageRequestCounts): void {
  target.requests += source.requests;
  target.measuredRequests += source.measuredRequests;
  target.reportedRequests += source.reportedRequests;
  target.estimatedRequests += source.estimatedRequests;
  target.pricedRequests += source.pricedRequests;
  target.unpricedRequests += source.unpricedRequests;
}

function mergeRequestFacts(target: Map<number, number>, source: Map<number, number>): void {
  for (const [requestId, facts] of source) {
    target.set(requestId, (target.get(requestId) ?? 0) | facts);
  }
}

function requestCountsFor(model: UsageModelAccumulator): UsageRequestCounts {
  if (!model.requestFacts) return model.requestCounts;
  const counts = blankRequestCounts();
  for (const facts of model.requestFacts.values()) bumpRequestCounts(counts, facts);
  return counts;
}

function mergeTotals(target: UsageSummaryTotals, source: UsageSummaryTotals): void {
  target.requests += source.requests;
  target.attemptCount += source.attemptCount;
  target.measuredRequests += source.measuredRequests;
  target.reportedRequests += source.reportedRequests;
  target.unreportedRequests += source.unreportedRequests;
  target.unsupportedRequests += source.unsupportedRequests;
  target.estimatedRequests += source.estimatedRequests;
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cachedInputTokens += source.cachedInputTokens;
  target.cacheReadInputTokens += source.cacheReadInputTokens;
  target.cacheCreationInputTokens += source.cacheCreationInputTokens;
  target.reasoningOutputTokens += source.reasoningOutputTokens;
  target.totalTokens += source.totalTokens;
  target.estimatedCostUsd += source.estimatedCostUsd;
  target.pricedRequests += source.pricedRequests;
  target.unpricedRequests += source.unpricedRequests;
  target.unmeteredRequests += source.unmeteredRequests;
}

function blankModelAccumulator(
  provider: string,
  model: string,
  resolvedModel: string | undefined,
  firstSeen: number,
  mode: UsageAccumulatorMode,
): UsageModelAccumulator {
  return {
    provider,
    model,
    ...(resolvedModel ? { resolvedModel } : {}),
    firstSeen,
    attemptCount: 0,
    dayTotalTokens: 0,
    summaryTotalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheObserved: false,
    requestCounts: blankRequestCounts(),
    ...(mode === "exact" ? { requestFacts: new Map() } : {}),
  };
}

function cloneModelAccumulator(source: UsageModelAccumulator): UsageModelAccumulator {
  return {
    ...source,
    requestCounts: { ...source.requestCounts },
    ...(source.requestFacts ? { requestFacts: new Map(source.requestFacts) } : {}),
  };
}

function mergeModelAccumulator(target: UsageModelAccumulator, source: UsageModelAccumulator): void {
  if (source.firstSeen < target.firstSeen) {
    target.firstSeen = source.firstSeen;
    target.resolvedModel = source.resolvedModel;
  }
  target.attemptCount += source.attemptCount;
  target.dayTotalTokens += source.dayTotalTokens;
  target.summaryTotalTokens += source.summaryTotalTokens;
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheReadInputTokens += source.cacheReadInputTokens;
  target.cacheCreationInputTokens += source.cacheCreationInputTokens;
  target.cacheObserved ||= source.cacheObserved;
  if (source.estimatedCostUsd !== undefined) {
    target.estimatedCostUsd = (target.estimatedCostUsd ?? 0) + source.estimatedCostUsd;
  }
  if (target.requestFacts && source.requestFacts) mergeRequestFacts(target.requestFacts, source.requestFacts);
  else mergeRequestCounts(target.requestCounts, source.requestCounts);
}

function mergeModelMaps(
  target: Map<string, UsageModelAccumulator>,
  source: Map<string, UsageModelAccumulator>,
): void {
  for (const [key, model] of source) {
    const current = target.get(key);
    if (current) mergeModelAccumulator(current, model);
    else target.set(key, cloneModelAccumulator(model));
  }
}

function cloneAccountAccumulator(source: UsageAccountAccumulator): UsageAccountAccumulator {
  return {
    ...source,
    ...(source.requestIds ? { requestIds: new Set(source.requestIds) } : {}),
  };
}

function mergeAccountAccumulator(target: UsageAccountAccumulator, source: UsageAccountAccumulator): void {
  target.firstSeen = Math.min(target.firstSeen, source.firstSeen);
  if (target.requestIds && source.requestIds) {
    for (const requestId of source.requestIds) target.requestIds.add(requestId);
  } else {
    target.requests += source.requests;
  }
  target.attemptCount += source.attemptCount;
  target.measuredAttempts += source.measuredAttempts;
  target.reportedAttempts += source.reportedAttempts;
  target.estimatedAttempts += source.estimatedAttempts;
  target.unmeteredAttempts += source.unmeteredAttempts;
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheReadInputTokens += source.cacheReadInputTokens;
  target.cacheCreationInputTokens += source.cacheCreationInputTokens;
  target.reasoningOutputTokens += source.reasoningOutputTokens;
  target.totalTokens += source.totalTokens;
  if (source.estimatedCostUsd !== undefined) {
    target.estimatedCostUsd = (target.estimatedCostUsd ?? 0) + source.estimatedCostUsd;
  }
  target.pricedAttempts += source.pricedAttempts;
  target.unpricedAttempts += source.unpricedAttempts;
}

function usagePartitionSurface(entry: PersistedUsageEntry): UsagePartitionSurface {
  if (entry.surface === undefined) return "codex";
  if (entry.surface === "claude" || entry.surface === "claude-desktop") return "claude";
  if (entry.surface === "grok") return "grok";
  return "other";
}

function usageSurfaceMatches(partition: UsagePartitionSurface, surface: UsageSurface): boolean {
  return surface === "all" || partition === surface;
}

const LEGACY_AMBIGUOUS_ACCOUNT_LABEL = "legacy-ambiguous";

function legacyCodexAccountLabel(provider: string): string | null {
  if (baseProviderLabel(provider) !== "openai") return null;
  const suffix = provider.match(/-(main|p[a-f0-9]{6})$/)?.[1];
  return suffix ?? LEGACY_AMBIGUOUS_ACCOUNT_LABEL;
}

/**
 * An explicitly stamped label of EITHER family is authoritative for any provider (#2699).
 * The legacy fallback stays openai-only so unrelated unlabeled providers are not guessed.
 */
function accountLabelForAttribution(provider: string, explicit: unknown): string | null {
  if (isCodexUsageAccountLogLabel(explicit)) return explicit;
  return legacyCodexAccountLabel(provider);
}

function filterMatchesAttribution(
  filter: NormalizedUsageFilter,
  provider: string,
  model: string,
): boolean {
  if (filter.provider !== null && baseProviderLabel(provider).toLowerCase() !== filter.provider) return false;
  if (filter.model !== null && model.toLowerCase() !== filter.model) return false;
  return true;
}

function projectedEntryForFilter(
  entry: PersistedUsageEntry,
  filter: NormalizedUsageFilter,
): { entry: PersistedUsageEntry; comboOverlap: boolean } | null {
  if (filter.apiKeyId !== null && entry.apiKeyId !== filter.apiKeyId) return null;
  if (!entry.attempts?.length) {
    const identity = usageModelIdentity(entry.provider, entry.model, entry.resolvedModel);
    return filterMatchesAttribution(filter, entry.provider, identity.model)
      ? { entry, comboOverlap: false }
      : null;
  }
  const attempts = entry.attempts.filter(attempt => {
    const identity = usageModelIdentity(attempt.provider, attempt.model);
    return filterMatchesAttribution(filter, attempt.provider, identity.model);
  });
  if (attempts.length === 0) return null;
  const { usage: _parentUsage, totalTokens: _parentTotalTokens, ...withoutParentUsage } = entry;
  return {
    entry: { ...withoutParentUsage, attempts, ...projectedComboUsage(attempts) },
    comboOverlap: entry.attempts.length > 1,
  };
}

function overflowModelAccumulator(
  models: UsageModelAccumulator[],
  overlaps: readonly UsageModelOverlap[],
): UsageModelAccumulator {
  const mode: UsageAccumulatorMode = models[0]?.requestFacts ? "exact" : "row-unique";
  const other = blankModelAccumulator("other", "other", undefined, models[0]?.firstSeen ?? 0, mode);
  for (const model of models) mergeModelAccumulator(other, model);
  if (mode === "row-unique" && overlaps.length > 0) {
    const overflowKeys = new Set(models.map(model => usageModelKey(model.provider, model.model)));
    for (const overlap of overlaps) {
      const retained = overlap.models.filter(([modelKey]) => overflowKeys.has(modelKey));
      if (retained.length < 2) continue;
      let combinedFacts = 0;
      for (const [, facts] of retained) {
        bumpRequestCounts(other.requestCounts, facts, -overlap.count);
        combinedFacts |= facts;
      }
      bumpRequestCounts(other.requestCounts, combinedFacts, overlap.count);
    }
  }
  other.provider = "other";
  other.model = "other";
  delete other.resolvedModel;
  return other;
}

function retainedModelAccumulators(
  models: UsageModelAccumulator[],
  overlaps: readonly UsageModelOverlap[],
): UsageModelAccumulator[] {
  if (models.length <= MAX_USAGE_MODEL_BREAKDOWN_ROWS) return models;
  return [
    ...models.slice(0, MAX_USAGE_MODEL_BREAKDOWN_ROWS - 1),
    overflowModelAccumulator(models.slice(MAX_USAGE_MODEL_BREAKDOWN_ROWS - 1), overlaps),
  ];
}

function buildDayModels(
  models: Map<string, UsageModelAccumulator>,
  overlaps: readonly UsageModelOverlap[],
): UsageDayModel[] {
  const sorted = [...models.values()].sort((a, b) =>
    requestCountsFor(b).requests - requestCountsFor(a).requests || a.firstSeen - b.firstSeen
  );
  return retainedModelAccumulators(sorted, overlaps).map(model => ({
    model: model.model,
    provider: model.provider,
    requests: requestCountsFor(model).requests,
    attemptCount: model.attemptCount,
    totalTokens: model.dayTotalTokens,
    inputTokens: model.inputTokens,
    outputTokens: model.outputTokens,
    cacheReadInputTokens: model.cacheReadInputTokens,
    cacheCreationInputTokens: model.cacheCreationInputTokens,
    cacheHitRate: calculateCacheHitRate(model.cacheObserved, model.inputTokens, model.cacheReadInputTokens),
    ...(model.estimatedCostUsd !== undefined ? { estimatedCostUsd: model.estimatedCostUsd } : {}),
  }));
}

function buildUsageModels(
  models: Map<string, UsageModelAccumulator>,
  totalTokens: number,
  overlaps: readonly UsageModelOverlap[],
): UsageModel[] {
  const sorted = [...models.values()].sort((a, b) =>
    requestCountsFor(b).requests - requestCountsFor(a).requests || a.firstSeen - b.firstSeen
  );
  return retainedModelAccumulators(sorted, overlaps).map(model => {
    const counts = requestCountsFor(model);
    const requests = counts.requests;
    return {
      provider: model.provider,
      model: model.model,
      ...(model.resolvedModel ? { resolvedModel: model.resolvedModel } : {}),
      requests,
      attemptCount: model.attemptCount,
      measuredRequests: counts.measuredRequests,
      reportedRequests: counts.reportedRequests,
      estimatedRequests: counts.estimatedRequests,
      totalTokens: model.summaryTotalTokens,
      inputTokens: model.inputTokens,
      outputTokens: model.outputTokens,
      cachedInputTokens: model.cacheReadInputTokens,
      cacheReadInputTokens: model.cacheReadInputTokens,
      cacheCreationInputTokens: model.cacheCreationInputTokens,
      cacheHitRate: calculateCacheHitRate(model.cacheObserved, model.inputTokens, model.cacheReadInputTokens),
      priceCoverageRatio: requests > 0 ? counts.pricedRequests / requests : 0,
      pricedRequests: counts.pricedRequests,
      unpricedRequests: counts.unpricedRequests,
      shareRatio: totalTokens === 0 ? 0 : model.summaryTotalTokens / totalTokens,
      ...(model.estimatedCostUsd !== undefined ? { estimatedCostUsd: model.estimatedCostUsd } : {}),
    };
  });
}

function buildUsageProviders(
  models: Map<string, UsageModelAccumulator>,
  totalTokens: number,
): UsageProvider[] {
  const providers = new Map<string, UsageModelAccumulator>();
  for (const model of models.values()) {
    const current = providers.get(model.provider);
    if (current) mergeModelAccumulator(current, model);
    else providers.set(model.provider, cloneModelAccumulator(model));
  }
  return [...providers.values()]
    .sort((a, b) => requestCountsFor(b).requests - requestCountsFor(a).requests || a.firstSeen - b.firstSeen)
    .map(provider => {
      const counts = requestCountsFor(provider);
      const requests = counts.requests;
      return {
        provider: provider.provider,
        requests,
        attemptCount: provider.attemptCount,
        measuredRequests: counts.measuredRequests,
        reportedRequests: counts.reportedRequests,
        estimatedRequests: counts.estimatedRequests,
        totalTokens: provider.summaryTotalTokens,
        inputTokens: provider.inputTokens,
        outputTokens: provider.outputTokens,
        cachedInputTokens: provider.cacheReadInputTokens,
        cacheReadInputTokens: provider.cacheReadInputTokens,
        cacheCreationInputTokens: provider.cacheCreationInputTokens,
        cacheHitRate: calculateCacheHitRate(provider.cacheObserved, provider.inputTokens, provider.cacheReadInputTokens),
        priceCoverageRatio: requests > 0 ? counts.pricedRequests / requests : 0,
        pricedRequests: counts.pricedRequests,
        unpricedRequests: counts.unpricedRequests,
        shareRatio: totalTokens === 0 ? 0 : provider.summaryTotalTokens / totalTokens,
        ...(provider.estimatedCostUsd !== undefined ? { estimatedCostUsd: provider.estimatedCostUsd } : {}),
      };
    });
}

function buildUsageAccounts(accounts: Map<string, UsageAccountAccumulator>): UsageAccount[] {
  return [...accounts.values()]
    .sort((a, b) => b.totalTokens - a.totalTokens || a.firstSeen - b.firstSeen)
    .map(account => ({
      accountLogLabel: account.accountLogLabel,
      ambiguous: account.ambiguous,
      requests: account.requestIds?.size ?? account.requests,
      attemptCount: account.attemptCount,
      measuredAttempts: account.measuredAttempts,
      reportedAttempts: account.reportedAttempts,
      estimatedAttempts: account.estimatedAttempts,
      unmeteredAttempts: account.unmeteredAttempts,
      inputTokens: account.inputTokens,
      outputTokens: account.outputTokens,
      cacheReadInputTokens: account.cacheReadInputTokens,
      cacheCreationInputTokens: account.cacheCreationInputTokens,
      reasoningOutputTokens: account.reasoningOutputTokens,
      totalTokens: account.totalTokens,
      usageCoverageRatio: account.attemptCount === 0 ? 0 : account.measuredAttempts / account.attemptCount,
      ...(account.estimatedCostUsd !== undefined ? { estimatedCostUsd: account.estimatedCostUsd } : {}),
      pricedAttempts: account.pricedAttempts,
      unpricedAttempts: account.unpricedAttempts,
      priceCoverageRatio: account.measuredAttempts === 0 ? 0 : account.pricedAttempts / account.measuredAttempts,
    }));
}

// Retained-size estimates intentionally favor over-counting. They are updated only when
// retained structures grow, so memory-budget checks stay O(1) even on very large ledgers.
const ESTIMATED_ACCUMULATOR_BASE_BYTES = 2_048;
const ESTIMATED_PARTITION_BYTES = 1_024;
const ESTIMATED_BREAKDOWN_BYTES = 1_024;
const ESTIMATED_EXACT_REQUEST_ID_BYTES = 1_024;
const ESTIMATED_REQUEST_FACT_BYTES = 512;
const ESTIMATED_ACCOUNT_REQUEST_BYTES = 256;
const ESTIMATED_OVERLAP_BYTES = 128;
const ESTIMATED_OVERLAP_MODEL_BYTES = 256;

class StreamingUsageSummaryAccumulator implements UsageSummaryAccumulator {
  private readonly partitions = new Map<string, UsagePartition>();
  private readonly requestIds: Map<string, number> | null;
  private readonly filter: NormalizedUsageFilter | null;
  private readonly mode: UsageAccumulatorMode;
  private nextRequestId = 0;
  private nextOrdinal = 0;
  private snapshotStart: number | null = null;
  private snapshotEnd: number | null = null;
  private comboOverlap = false;
  private estimatedRetainedBytes = ESTIMATED_ACCUMULATOR_BASE_BYTES;

  constructor(options?: {
    filter?: { provider?: string | null; model?: string | null; apiKeyId?: string | null };
    mode?: UsageAccumulatorMode;
  }) {
    const provider = normalizeFilterValue(options?.filter?.provider);
    const model = normalizeFilterValue(options?.filter?.model);
    const apiKeyId = normalizeExactFilterValue(options?.filter?.apiKeyId);
    this.filter = provider === null && model === null && apiKeyId === null
      ? null
      : { provider, model, apiKeyId };
    this.mode = options?.mode ?? "exact";
    this.requestIds = this.mode === "exact" ? new Map() : null;
  }

  get snapshotWindow(): { start: number | null; end: number | null } {
    return { start: this.snapshotStart, end: this.snapshotEnd };
  }

  get estimatedBytes(): number {
    return this.estimatedRetainedBytes;
  }

  clone(): UsageSummaryAccumulator {
    const cloned = new StreamingUsageSummaryAccumulator({
      ...(this.filter ? { filter: this.filter } : {}),
      mode: this.mode,
    });
    cloned.nextRequestId = this.nextRequestId;
    cloned.nextOrdinal = this.nextOrdinal;
    cloned.snapshotStart = this.snapshotStart;
    cloned.snapshotEnd = this.snapshotEnd;
    cloned.comboOverlap = this.comboOverlap;
    cloned.estimatedRetainedBytes = this.estimatedRetainedBytes;
    if (this.requestIds && cloned.requestIds) {
      for (const [requestId, key] of this.requestIds) cloned.requestIds.set(requestId, key);
    }
    for (const [key, partition] of this.partitions) {
      const models = new Map<string, UsageModelAccumulator>();
      for (const [modelKey, model] of partition.models) {
        models.set(modelKey, cloneModelAccumulator(model));
      }
      const providers = partition.providers
        ? new Map([...partition.providers].map(([providerKey, provider]) => [providerKey, cloneModelAccumulator(provider)]))
        : undefined;
      const accounts = new Map<string, UsageAccountAccumulator>();
      for (const [label, account] of partition.accounts) {
        accounts.set(label, cloneAccountAccumulator(account));
      }
      cloned.partitions.set(key, {
        ...partition,
        totals: { ...partition.totals },
        models,
        ...(providers ? { providers } : {}),
        accounts,
        modelOverlaps: new Map(
          [...partition.modelOverlaps].map(([signature, overlap]) => [signature, { ...overlap }]),
        ),
      });
    }
    return cloned;
  }

  private requestKey(requestId: string): number {
    if (!this.requestIds) throw new Error("row-unique accumulators do not retain request ids");
    const existing = this.requestIds.get(requestId);
    if (existing !== undefined) return existing;
    const key = this.nextRequestId++;
    this.requestIds.set(requestId, key);
    this.estimatedRetainedBytes += ESTIMATED_EXACT_REQUEST_ID_BYTES + requestId.length * 2;
    return key;
  }

  private partitionFor(entry: PersistedUsageEntry): UsagePartition {
    const date = localDateKey(entry.timestamp);
    const dayStart = startOfLocalDay(entry.timestamp);
    const surface = usagePartitionSurface(entry);
    const key = `${date}\0${surface}`;
    let partition = this.partitions.get(key);
    if (!partition) {
      partition = {
        date,
        dayStart,
        surface,
        oldestTimestamp: null,
        totals: blankTotals(),
        models: new Map(),
        ...(this.mode === "row-unique" ? { providers: new Map() } : {}),
        accounts: new Map(),
        modelOverlaps: new Map(),
      };
      this.partitions.set(key, partition);
      this.estimatedRetainedBytes += ESTIMATED_PARTITION_BYTES;
    }
    if (Number.isFinite(entry.timestamp)) {
      partition.oldestTimestamp = partition.oldestTimestamp === null
        ? entry.timestamp
        : Math.min(partition.oldestTimestamp, entry.timestamp);
    }
    return partition;
  }

  private addAttributionMetrics(
    breakdown: UsageModelAccumulator,
    attribution: UsageAttribution,
    estimate: AttemptCostEstimate | CostEstimate | null,
  ): void {
    breakdown.attemptCount += 1;
    if (attribution.usage) {
      breakdown.inputTokens += attribution.usage.inputTokens;
      breakdown.outputTokens += attribution.usage.outputTokens;
      const { read, creation, hasCacheTelemetry } = cacheTokensFromUsage(attribution.usage);
      breakdown.cacheObserved ||= hasCacheTelemetry;
      if (typeof read === "number") breakdown.cacheReadInputTokens += read;
      if (typeof creation === "number") breakdown.cacheCreationInputTokens += creation;
      breakdown.summaryTotalTokens += usageDisplayTotalTokens(attribution.usage, attribution.totalTokens) ?? 0;
    }
    breakdown.dayTotalTokens += usageDisplayTotalTokens(attribution.usage, attribution.totalTokens) ?? 0;
    if (estimate) breakdown.estimatedCostUsd = (breakdown.estimatedCostUsd ?? 0) + estimate.cost.total;
  }

  private addModelAttribution(
    partition: UsagePartition,
    attribution: UsageAttribution,
    estimate: AttemptCostEstimate | CostEstimate | null,
    ordinal: number,
  ): string {
    const provider = baseProviderLabel(attribution.provider);
    const key = usageModelKey(provider, attribution.model);
    let model = partition.models.get(key);
    if (!model) {
      model = blankModelAccumulator(provider, attribution.model, attribution.resolvedModel, ordinal, this.mode);
      partition.models.set(key, model);
      this.estimatedRetainedBytes += ESTIMATED_BREAKDOWN_BYTES + key.length * 2;
    }
    this.addAttributionMetrics(model, attribution, estimate);
    return key;
  }

  private addProviderAttribution(
    partition: UsagePartition,
    attribution: UsageAttribution,
    estimate: AttemptCostEstimate | CostEstimate | null,
    ordinal: number,
  ): string {
    const providerKey = baseProviderLabel(attribution.provider);
    const providers = partition.providers;
    if (!providers) return providerKey;
    let provider = providers.get(providerKey);
    if (!provider) {
      provider = blankModelAccumulator(providerKey, "", undefined, ordinal, "row-unique");
      providers.set(providerKey, provider);
      this.estimatedRetainedBytes += ESTIMATED_BREAKDOWN_BYTES + providerKey.length * 2;
    }
    this.addAttributionMetrics(provider, attribution, estimate);
    return providerKey;
  }

  private addBreakdownRequest(
    breakdown: UsageModelAccumulator,
    facts: number,
    requestKey: number | null,
  ): void {
    if (breakdown.requestFacts) {
      if (requestKey === null) throw new Error("exact accumulators require request identity");
      const previous = breakdown.requestFacts.get(requestKey);
      breakdown.requestFacts.set(requestKey, (previous ?? 0) | facts);
      if (previous === undefined) this.estimatedRetainedBytes += ESTIMATED_REQUEST_FACT_BYTES;
      return;
    }
    bumpRequestCounts(breakdown.requestCounts, facts);
  }

  private addAccountRequest(account: UsageAccountAccumulator, requestKey: number | null): void {
    if (account.requestIds) {
      if (requestKey === null) throw new Error("exact accumulators require request identity");
      const previousSize = account.requestIds.size;
      account.requestIds.add(requestKey);
      if (account.requestIds.size !== previousSize) {
        this.estimatedRetainedBytes += ESTIMATED_ACCOUNT_REQUEST_BYTES;
      }
      return;
    }
    account.requests += 1;
  }

  private addAccountAttribution(
    partition: UsagePartition,
    attribution: UsageAttribution,
    estimate: AttemptCostEstimate | CostEstimate | null,
    ordinal: number,
  ): string | null {
    const label = accountLabelForAttribution(attribution.provider, attribution.accountLogLabel);
    if (!label) return null;
    let account = partition.accounts.get(label);
    if (!account) {
      account = {
        accountLogLabel: label,
        ambiguous: label === LEGACY_AMBIGUOUS_ACCOUNT_LABEL,
        firstSeen: ordinal,
        requests: 0,
        ...(this.mode === "exact" ? { requestIds: new Set() } : {}),
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
        pricedAttempts: 0,
        unpricedAttempts: 0,
      };
      partition.accounts.set(label, account);
      this.estimatedRetainedBytes += ESTIMATED_BREAKDOWN_BYTES + label.length * 2;
    }
    account.attemptCount += 1;
    if (!attribution.usage || !isMeasuredStatus(attribution.usageStatus)) {
      account.unmeteredAttempts += 1;
      return label;
    }
    account.measuredAttempts += 1;
    if (attribution.usageStatus === "reported") account.reportedAttempts += 1;
    else if (attribution.usageStatus === "estimated") account.estimatedAttempts += 1;
    account.inputTokens += attribution.usage.inputTokens;
    account.outputTokens += attribution.usage.outputTokens;
    const { read, creation } = cacheTokensFromUsage(attribution.usage);
    if (typeof read === "number") account.cacheReadInputTokens += read;
    if (typeof creation === "number") account.cacheCreationInputTokens += creation;
    if (typeof attribution.usage.reasoningOutputTokens === "number") {
      account.reasoningOutputTokens += attribution.usage.reasoningOutputTokens;
    }
    account.totalTokens += usageDisplayTotalTokens(attribution.usage, attribution.totalTokens) ?? 0;
    if (estimate) {
      account.pricedAttempts += 1;
      account.estimatedCostUsd = (account.estimatedCostUsd ?? 0) + estimate.cost.total;
    } else {
      account.unpricedAttempts += 1;
    }
    return label;
  }

  add(sourceEntry: PersistedUsageEntry): void {
    if (Number.isFinite(sourceEntry.timestamp)) {
      this.snapshotStart = this.snapshotStart === null
        ? sourceEntry.timestamp
        : Math.min(this.snapshotStart, sourceEntry.timestamp);
      this.snapshotEnd = this.snapshotEnd === null
        ? sourceEntry.timestamp
        : Math.max(this.snapshotEnd, sourceEntry.timestamp);
    }
    const projected = this.filter ? projectedEntryForFilter(sourceEntry, this.filter) : { entry: sourceEntry, comboOverlap: false };
    if (!projected) return;
    this.comboOverlap ||= projected.comboOverlap;
    const entry = projected.entry;
    const partition = this.partitionFor(entry);
    const costInfo = computeEntryCost(entry);
    bumpStatus(partition.totals, entry.usageStatus);
    partition.totals.attemptCount += entry.attempts?.length ?? 1;
    addTokens(partition.totals, entry);
    addEstimatedCost(partition.totals, entry, costInfo);

    const requestKey = this.mode === "exact" ? this.requestKey(entry.requestId) : null;
    const attributions = usageAttributions(entry);
    const modelFacts = new Map<string, number>();
    const providerFacts = new Map<string, number>();
    const accountLabels = new Set<string>();
    for (let index = 0; index < attributions.length; index++) {
      const attribution = attributions[index]!;
      const estimate = entry.attempts?.length
        ? costInfo.attemptEstimates?.[index] ?? null
        : costInfo.estimate;
      const ordinal = this.nextOrdinal++;
      const facts = requestStatusFact(attribution.usageStatus)
        | (estimate ? REQUEST_PRICED : REQUEST_UNPRICED);
      const modelKey = this.addModelAttribution(partition, attribution, estimate, ordinal);
      modelFacts.set(modelKey, (modelFacts.get(modelKey) ?? 0) | facts);
      if (this.mode === "row-unique") {
        const providerKey = this.addProviderAttribution(partition, attribution, estimate, ordinal);
        providerFacts.set(providerKey, (providerFacts.get(providerKey) ?? 0) | facts);
      }
      const accountLabel = this.addAccountAttribution(partition, attribution, estimate, ordinal);
      if (accountLabel) accountLabels.add(accountLabel);
    }
    for (const [modelKey, facts] of modelFacts) {
      this.addBreakdownRequest(partition.models.get(modelKey)!, facts, requestKey);
    }
    if (partition.providers) {
      for (const [providerKey, facts] of providerFacts) {
        this.addBreakdownRequest(partition.providers.get(providerKey)!, facts, null);
      }
    }
    for (const label of accountLabels) {
      this.addAccountRequest(partition.accounts.get(label)!, requestKey);
    }
    if (this.mode === "row-unique" && modelFacts.size > 1) {
      const models = [...modelFacts].sort(([a], [b]) => a.localeCompare(b));
      const signature = JSON.stringify(models);
      const overlap = partition.modelOverlaps.get(signature);
      if (overlap) {
        overlap.count += 1;
      } else {
        partition.modelOverlaps.set(signature, { models, count: 1 });
        this.estimatedRetainedBytes += ESTIMATED_OVERLAP_BYTES
          + models.length * ESTIMATED_OVERLAP_MODEL_BYTES
          + signature.length * 2;
      }
    }
  }

  summarize(
    range: UsageRange,
    now: number,
    surface: UsageSurface = "all",
  ): UsageSummary & { filter?: UsageFilterEcho } {
    const { since, days: fixedDays } = rangeWindow(range, now);
    const totals = blankTotals();
    const models = new Map<string, UsageModelAccumulator>();
    const providers = new Map<string, UsageModelAccumulator>();
    const accounts = new Map<string, UsageAccountAccumulator>();
    const dayAccumulators = new Map<string, UsageDayAccumulator>();
    const modelOverlaps: UsageModelOverlap[] = [];
    let oldestTimestamp: number | null = null;

    for (const partition of this.partitions.values()) {
      if (!usageSurfaceMatches(partition.surface, surface)) continue;
      if (since !== null && partition.dayStart < since) continue;
      mergeTotals(totals, partition.totals);
      mergeModelMaps(models, partition.models);
      if (partition.providers) mergeModelMaps(providers, partition.providers);
      modelOverlaps.push(...partition.modelOverlaps.values());
      for (const [label, account] of partition.accounts) {
        const current = accounts.get(label);
        if (current) mergeAccountAccumulator(current, account);
        else accounts.set(label, cloneAccountAccumulator(account));
      }
      if (partition.oldestTimestamp !== null) {
        oldestTimestamp = oldestTimestamp === null
          ? partition.oldestTimestamp
          : Math.min(oldestTimestamp, partition.oldestTimestamp);
      }
      let day = dayAccumulators.get(partition.date);
      if (!day) {
        day = { totals: blankTotals(), models: new Map(), modelOverlaps: [] };
        dayAccumulators.set(partition.date, day);
      }
      mergeTotals(day.totals, partition.totals);
      mergeModelMaps(day.models, partition.models);
      day.modelOverlaps.push(...partition.modelOverlaps.values());
    }
    finalizeCoverage(totals);

    const dayCount = range === "all" ? dayCountForAllRange(oldestTimestamp, now) : fixedDays;
    const startOfToday = startOfLocalDay(now);
    const firstVisibleDay = new Date(startOfToday);
    firstVisibleDay.setDate(firstVisibleDay.getDate() - dayCount + 1);
    const firstVisibleDate = localDateKey(firstVisibleDay.getTime());
    const lastVisibleDate = localDateKey(startOfToday);
    for (let offset = dayCount - 1; offset >= 0; offset--) {
      const date = new Date(startOfToday);
      date.setDate(date.getDate() - offset);
      const key = localDateKey(date.getTime());
      if (!dayAccumulators.has(key)) {
        dayAccumulators.set(key, { totals: blankTotals(), models: new Map(), modelOverlaps: [] });
      }
    }
    const days = [...dayAccumulators]
      // All-history totals, models, providers, and accounts still cover every
      // retained row. Only the chart buckets are bounded so one malformed or
      // ancient timestamp cannot synthesize an enormous JSON response.
      .filter(([date]) => range !== "all"
        || (date >= firstVisibleDate && date <= lastVisibleDate))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, day]): UsageDay => ({
        date,
        requests: day.totals.requests,
        measuredRequests: day.totals.measuredRequests,
        reportedRequests: day.totals.reportedRequests,
        totalTokens: day.totals.totalTokens,
        estimatedCostUsd: day.totals.estimatedCostUsd,
        models: buildDayModels(day.models, day.modelOverlaps),
      }));

    const summary: UsageSummary = {
      range,
      surface,
      since,
      generatedAt: now,
      summary: totals,
      days,
      models: buildUsageModels(models, totals.totalTokens, modelOverlaps),
      providers: buildUsageProviders(this.mode === "row-unique" ? providers : models, totals.totalTokens),
      accounts: buildUsageAccounts(accounts),
    };
    if (!this.filter) return summary;
    const matches = (provider: string, model: string): boolean =>
      filterMatchesAttribution(this.filter!, provider, model);
    const retainedModels = summary.models.filter(row => matches(row.provider, row.model));
    const retainedProviders = new Set(retainedModels.map(row => row.provider));
    return {
      ...summary,
      days: summary.days.map(day => ({
        ...day,
        models: day.models.filter(row => matches(row.provider, row.model)),
      })),
      models: retainedModels,
      providers: summary.providers.filter(row => retainedProviders.has(row.provider)),
      accounts: this.filter.provider === null && this.filter.model === null
        ? summary.accounts
        : [],
      filter: {
        provider: this.filter.provider,
        model: this.filter.model,
        apiKeyId: this.filter.apiKeyId,
        matched: summary.summary.requests > 0,
        comboOverlap: this.comboOverlap,
      },
    };
  }
}

export function createUsageSummaryAccumulator(options?: {
  filter?: { provider?: string | null; model?: string | null; apiKeyId?: string | null };
  mode?: UsageAccumulatorMode;
}): UsageSummaryAccumulator {
  return new StreamingUsageSummaryAccumulator(options);
}

export function summarizeUsage(
  entries: PersistedUsageEntry[],
  range: UsageRange,
  now: number,
  surface: UsageSurface = "all",
): UsageSummary {
  const accumulator = createUsageSummaryAccumulator();
  for (const entry of entries) accumulator.add(entry);
  return accumulator.summarize(range, now, surface);
}

function normalizeFilterValue(input: string | null | undefined): string | null {
  const trimmed = typeof input === "string" ? input.trim() : "";
  return trimmed === "" ? null : trimmed.toLowerCase();
}

function normalizeExactFilterValue(input: string | null | undefined): string | null {
  const trimmed = typeof input === "string" ? input.trim() : "";
  return trimmed === "" ? null : trimmed;
}

/**
 * Narrow an already-summarised window to one provider and/or model.
 *
 * The compatibility wrapper feeds source rows through a filter-bound streaming
 * accumulator. The management route can use the same accumulator directly and
 * still keep filtered results outside its unfiltered `range:surface` cache.
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
  filter: { provider?: string | null; model?: string | null; apiKeyId?: string | null },
  entries?: PersistedUsageEntry[],
): T & { filter?: UsageFilterEcho } {
  const provider = normalizeFilterValue(filter.provider);
  const model = normalizeFilterValue(filter.model);
  const apiKeyId = normalizeExactFilterValue(filter.apiKeyId);
  if (provider === null && model === null && apiKeyId === null) return summary;
  const accumulator = createUsageSummaryAccumulator({ filter: { provider, model, apiKeyId } });
  for (const entry of entries ?? []) accumulator.add(entry);
  const projected = accumulator.summarize(summary.range, summary.generatedAt, summary.surface);
  return {
    ...summary,
    summary: projected.summary,
    days: projected.days,
    models: projected.models,
    providers: projected.providers,
    accounts: projected.accounts,
    filter: projected.filter,
  };
}
