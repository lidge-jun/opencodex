import { baseProviderLabel } from "../providers/label";
import { canonicalAntigravityUsageModel } from "../providers/antigravity-models";
import { usageDisplayTotalTokens } from "./totals";
import { isCodexUsageAccountLogLabel, type PersistedUsageEntry, type UsageStatus } from "./log";
import { estimateAttemptCost, estimateComboCost, estimateRequestCost, serviceTierContext } from "./cost";

export type UsageRange = "7d" | "30d" | "all";
export type UsageSurface = "all" | "codex" | "claude" | "grok";

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

function antigravityUsageModel(provider: string, model: string): string {
  if (baseProviderLabel(provider) !== "google-antigravity") return model;
  return canonicalAntigravityUsageModel(model);
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
  entry: Pick<PersistedUsageEntry, "provider" | "model" | "usageStatus" | "usage" | "attempts" | "responseServiceTier" | "requestedServiceTier" | "configuredServiceTier">,
): void {
  if (entry.usageStatus === "unreported" || entry.usageStatus === "unsupported"
    || (!entry.usage && !entry.attempts?.length)) {
    totals.unmeteredRequests += 1;
    return;
  }
  const tier = serviceTierContext(entry);
  const estimate = entry.attempts?.length
    ? estimateComboCost(entry.attempts, undefined, tier)
    : estimateRequestCost({ provider: entry.provider, model: entry.model, usage: entry.usage, usageStatus: entry.usageStatus, serviceTier: tier });
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
    const mKey = usageModelKey(providerKey, attribution.model);
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
  const startOfToday = startOfLocalDay(now);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(startOfToday);
    d.setDate(d.getDate() - i);
    const key = localDateKey(d.getTime());
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
    if (models) {
      const sorted = [...models.values()].sort((a, b) => b.requests - a.requests);
      day.models = retainedBreakdownRows(sorted, overflow => {
        const requests = new Set<string>();
        let attemptCount = 0;
        let totalTokens = 0;
        for (const model of overflow) {
          attemptCount += model.attemptCount;
          totalTokens += model.totalTokens;
          const requestKey = `${day.date}\0${usageModelKey(model.provider, model.model)}`;
          for (const requestId of dayModelRequests.get(requestKey) ?? []) requests.add(requestId);
        }
        return { model: "other", provider: "other", requests: requests.size, attemptCount, totalTokens };
      });
    }
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
    const tier = serviceTierContext(entry);
    const estimate = entry.attempts?.length
      ? estimateComboCost(entry.attempts, undefined, tier)
      : estimateRequestCost({ provider: entry.provider, model: entry.model, usage: entry.usage, usageStatus: entry.usageStatus, serviceTier: tier });
    if (!estimate) continue;

    if (entry.attempts?.length && estimate.attempts) {
      // Combo: attribute each attempt's cost to its own model
      for (const attemptEst of estimate.attempts) {
        const aProviderKey = baseProviderLabel(attemptEst.provider);
        const aKey = usageModelKey(aProviderKey, antigravityUsageModel(attemptEst.provider, attemptEst.model));
        const m = byKey.get(aKey);
        if (m) m.estimatedCostUsd = (m.estimatedCostUsd ?? 0) + attemptEst.cost.total;
      }
    } else {
      // Single-target: attribute to the entry's model
      const providerKey = baseProviderLabel(entry.provider);
      const key = usageModelKey(providerKey, antigravityUsageModel(entry.provider, entry.model));
      const m = byKey.get(key);
      if (m) m.estimatedCostUsd = (m.estimatedCostUsd ?? 0) + estimate.cost.total;
    }
  }
  const models = [...byKey.values()];
  for (const m of models) m.shareRatio = totalTokens === 0 ? 0 : m.totalTokens / totalTokens;
  const sorted = models.sort((a, b) => b.requests - a.requests);
  return retainedBreakdownRows(sorted, overflow => {
    const statusesByRequest = new Map<string, UsageStatus[]>();
    const other: UsageModel = {
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
      shareRatio: 0,
    };
    for (const model of overflow) {
      other.attemptCount += model.attemptCount;
      other.totalTokens += model.totalTokens;
      other.inputTokens += model.inputTokens;
      other.outputTokens += model.outputTokens;
      if (model.estimatedCostUsd !== undefined) {
        other.estimatedCostUsd = (other.estimatedCostUsd ?? 0) + model.estimatedCostUsd;
      }
      const key = usageModelKey(model.provider, model.model);
      for (const [requestId, statuses] of statusesByKey.get(key) ?? []) {
        const combined = statusesByRequest.get(requestId) ?? [];
        combined.push(...statuses);
        statusesByRequest.set(requestId, combined);
      }
    }
    other.requests = statusesByRequest.size;
    for (const statuses of statusesByRequest.values()) {
      const status = foldAttributionStatuses(statuses);
      if (isMeasuredStatus(status)) other.measuredRequests += 1;
      if (status === "reported") other.reportedRequests += 1;
      else if (status === "estimated") other.estimatedRequests += 1;
    }
    other.shareRatio = totalTokens === 0 ? 0 : other.totalTokens / totalTokens;
    return other;
  });
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
    const tier = serviceTierContext(entry);
    const estimate = entry.attempts?.length
      ? estimateComboCost(entry.attempts, undefined, tier)
      : estimateRequestCost({ provider: entry.provider, model: entry.model, usage: entry.usage, usageStatus: entry.usageStatus, serviceTier: tier });
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

const LEGACY_AMBIGUOUS_ACCOUNT_LABEL = "legacy-ambiguous";

function legacyCodexAccountLabel(provider: string): string | null {
  if (baseProviderLabel(provider) !== "openai") return null;
  const suffix = provider.match(/-(main|p[a-f0-9]{6})$/)?.[1];
  return suffix ?? LEGACY_AMBIGUOUS_ACCOUNT_LABEL;
}

function accountLabelForAttribution(provider: string, explicit: unknown): string | null {
  if (isCodexUsageAccountLogLabel(explicit)) return explicit;
  return legacyCodexAccountLabel(provider);
}

function buildAccounts(entries: PersistedUsageEntry[]): UsageAccount[] {
  const byLabel = new Map<string, UsageAccount>();
  const requestIds = new Map<string, Set<string>>();

  const add = (input: {
    requestId: string;
    provider: string;
    accountLogLabel?: string;
    usageStatus: UsageStatus;
    usage?: PersistedUsageEntry["usage"];
    totalTokens?: number;
    estimate: ReturnType<typeof estimateRequestCost>;
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
    const creation = input.usage!.cacheCreationInputTokens;
    const read = typeof input.usage!.cacheReadInputTokens === "number"
      ? input.usage!.cacheReadInputTokens
      : typeof input.usage!.cachedInputTokens === "number" && typeof creation === "number"
        ? Math.max(0, input.usage!.cachedInputTokens - creation)
        : input.usage!.cachedInputTokens;
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
    const tier = serviceTierContext(entry);
    if (entry.attempts?.length) {
      for (const attempt of entry.attempts) {
        add({
          requestId: entry.requestId,
          provider: attempt.provider,
          ...(attempt.accountLogLabel ? { accountLogLabel: attempt.accountLogLabel } : {}),
          usageStatus: attempt.usageStatus,
          ...(attempt.usage ? { usage: attempt.usage } : {}),
          ...(attempt.totalTokens !== undefined ? { totalTokens: attempt.totalTokens } : {}),
          estimate: estimateAttemptCost(attempt, undefined, tier),
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
      estimate: estimateRequestCost({
        provider: entry.provider,
        model: entry.model,
        usage: entry.usage,
        usageStatus: entry.usageStatus,
        serviceTier: tier,
      }),
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
    accounts: buildAccounts(filteredEntries),
  };
}
