import { enforceAppOwnedMemoryBudget } from "../../lib/app-owned-memory";
import {
  currentUsageLogRevision,
  usageLogIdentityKey,
  usageLogRevisionKey,
  type UsageLogRevision,
} from "../../usage/log";
import {
  scanUsageLedgerCooperatively,
  UsageLedgerRebuildRequiredError,
} from "../../usage/ledger-scanner";
import {
  createUsageSummaryAccumulator,
  type UsageSummaryAccumulator,
} from "../../usage/summary";
import { userCostOverlayVersion } from "../../usage/user-cost-overlays";

import {
  cacheApiKeyUsageFromRollup,
  createApiKeyUsageAccumulator,
} from "./api-key-usage";

interface RetainedUsageAggregate {
  accumulator: UsageSummaryAccumulator;
  revision: UsageLogRevision | null;
  identityKey: string;
  revisionKey: string;
  processedThroughBytes: number;
  processedThroughDigest: string;
  overlayVersion: number;
  timeZone: string;
  retainedAt: number;
}

export interface UsageAggregateResult {
  accumulator: UsageSummaryAccumulator;
  revision: UsageLogRevision | null;
  processedThroughBytes: number;
  overlayVersion: number;
  timeZone: string;
  update: "unchanged" | "append" | "rebuild";
}

export interface UsageAggregateOptions {
  now?: number;
  configuredApiKeyIds?: string[];
  managementUsageMaxReadBytes?: number;
}

export interface UsageAggregateRetainedStats {
  count: number;
  bytes: number;
  evictableBytes: number;
  pinnedBytes: number;
  oldestAt: number | null;
}

const MAX_REBUILD_ATTEMPTS = 2;
const MAX_RETAINED_FILTERED_AGGREGATES = 4;

let retainedAggregate: RetainedUsageAggregate | null = null;
const pinnedAggregates = new Set<RetainedUsageAggregate>();
let baseFlight: Promise<UsageAggregateResult> | null = null;
const filteredFlights = new Map<string, Promise<UsageAggregateResult>>();
const retainedFilteredAggregates = new Map<string, RetainedUsageAggregate>();

function currentTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function resultFrom(
  state: RetainedUsageAggregate,
  update: UsageAggregateResult["update"],
): UsageAggregateResult {
  return {
    accumulator: state.accumulator,
    revision: state.revision,
    processedThroughBytes: state.processedThroughBytes,
    overlayVersion: state.overlayVersion,
    timeZone: state.timeZone,
    update,
  };
}

function publishRetainedAggregate(state: RetainedUsageAggregate): UsageAggregateResult {
  retainedAggregate = state;
  // The budget may evict the state immediately. The request that built it still
  // owns the returned accumulator and can finish this response safely.
  enforceAppOwnedMemoryBudget();
  return resultFrom(state, "rebuild");
}

function makeRetainedAggregate(
  accumulator: UsageSummaryAccumulator,
  scan: Awaited<ReturnType<typeof scanUsageLedgerCooperatively>>,
  overlayVersion: number,
  timeZone: string,
): RetainedUsageAggregate {
  return {
    accumulator,
    revision: scan.revision,
    identityKey: usageLogIdentityKey(scan.revision),
    revisionKey: usageLogRevisionKey(scan.revision),
    processedThroughBytes: scan.processedThroughBytes,
    processedThroughDigest: scan.processedThroughDigest,
    overlayVersion,
    timeZone,
    retainedAt: Date.now(),
  };
}

async function rebuildAggregate(options: UsageAggregateOptions): Promise<UsageAggregateResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_REBUILD_ATTEMPTS; attempt += 1) {
    const overlayVersion = userCostOverlayVersion();
    const timeZone = currentTimeZone();
    const accumulator = createUsageSummaryAccumulator({ mode: "row-unique" });
    const apiKeyAccumulator = options.configuredApiKeyIds
      ? createApiKeyUsageAccumulator(options.configuredApiKeyIds, options.now)
      : null;
    try {
      const scan = await scanUsageLedgerCooperatively({
        onEntry(entry) {
          accumulator.add(entry);
          apiKeyAccumulator?.add(entry);
        },
      });
      if (scan.oversizedRows > 0) {
        throw new Error("usage ledger contains an oversized row");
      }
      if (userCostOverlayVersion() !== overlayVersion || currentTimeZone() !== timeZone) {
        lastError = new Error("usage aggregation inputs changed during rebuild");
        continue;
      }

      const state = makeRetainedAggregate(accumulator, scan, overlayVersion, timeZone);
      const result = publishRetainedAggregate(state);
      if (apiKeyAccumulator && options.configuredApiKeyIds) {
        cacheApiKeyUsageFromRollup(
          apiKeyAccumulator.snapshot(),
          options.configuredApiKeyIds,
          state.identityKey,
          state.revision?.size ?? 0,
          options.managementUsageMaxReadBytes,
          options.now,
        );
      }
      return result;
    } catch (error) {
      lastError = error;
      if (!(error instanceof UsageLedgerRebuildRequiredError) || attempt + 1 >= MAX_REBUILD_ATTEMPTS) {
        throw error;
      }
    }
  }
  throw lastError ?? new Error("usage aggregate rebuild did not settle");
}

function requiresRebuild(
  state: RetainedUsageAggregate,
  observed: UsageLogRevision | null,
  overlayVersion: number,
  timeZone: string,
): boolean {
  if (state.overlayVersion !== overlayVersion || state.timeZone !== timeZone) return true;
  if (state.identityKey !== usageLogIdentityKey(observed)) return true;
  if (!state.revision || !observed) return state.revision !== observed;
  if (observed.size < state.revision.size) return true;
  // At the same size, metadata movement cannot be an append. Rebuild so a
  // detectable same-inode replacement/edit never extends stale counters.
  return observed.size === state.revision.size && usageLogRevisionKey(observed) !== state.revisionKey;
}

async function appendAggregate(
  state: RetainedUsageAggregate,
  options: UsageAggregateOptions,
): Promise<UsageAggregateResult> {
  pinnedAggregates.add(state);
  let rebuildAfterUnpin = false;
  try {
    // Clone first and publish only after the scanner verifies the captured
    // suffix. A callback error, mutation, or oversized row leaves retained
    // state byte-for-byte untouched.
    const candidate = state.accumulator.clone();
    const scan = await scanUsageLedgerCooperatively({
      startAtBytes: state.processedThroughBytes,
      expectedIdentityKey: state.identityKey,
      expectedProcessedThroughDigest: state.processedThroughDigest,
      onEntry: entry => candidate.add(entry),
    });
    if (scan.oversizedRows > 0) {
      if (retainedAggregate === state) retainedAggregate = null;
      throw new Error("usage ledger contains an oversized row");
    }
    if (userCostOverlayVersion() !== state.overlayVersion || currentTimeZone() !== state.timeZone) {
      if (retainedAggregate === state) retainedAggregate = null;
      rebuildAfterUnpin = true;
    } else {
      const next: RetainedUsageAggregate = {
        ...state,
        accumulator: candidate,
        revision: scan.revision,
        identityKey: usageLogIdentityKey(scan.revision),
        revisionKey: usageLogRevisionKey(scan.revision),
        processedThroughBytes: scan.processedThroughBytes,
        processedThroughDigest: scan.processedThroughDigest,
        retainedAt: Date.now(),
      };
      retainedAggregate = next;
      enforceAppOwnedMemoryBudget();
      return resultFrom(next, "append");
    }
  } catch (error) {
    if (retainedAggregate === state) retainedAggregate = null;
    if (error instanceof UsageLedgerRebuildRequiredError) rebuildAfterUnpin = true;
    else throw error;
  } finally {
    pinnedAggregates.delete(state);
  }
  if (rebuildAfterUnpin) return rebuildAggregate(options);
  throw new Error("usage aggregate append did not settle");
}

async function refreshAggregate(options: UsageAggregateOptions): Promise<UsageAggregateResult> {
  const state = retainedAggregate;
  if (!state) return rebuildAggregate(options);

  const observed = currentUsageLogRevision();
  const overlayVersion = userCostOverlayVersion();
  const timeZone = currentTimeZone();
  if (requiresRebuild(state, observed, overlayVersion, timeZone)) {
    retainedAggregate = null;
    return rebuildAggregate(options);
  }
  if (usageLogRevisionKey(observed) === state.revisionKey) return resultFrom(state, "unchanged");
  return appendAggregate(state, options);
}

export async function getUsageAggregate(
  options: UsageAggregateOptions = {},
): Promise<UsageAggregateResult> {
  if (baseFlight) return baseFlight;
  const flight = refreshAggregate(options);
  baseFlight = flight;
  try {
    return await flight;
  } finally {
    if (baseFlight === flight) baseFlight = null;
  }
}

function normalizeFilterValue(value: string | null | undefined): string | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized || null;
}

function normalizeExactFilterValue(value: string | null | undefined): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

export async function getFilteredUsageAggregate(filter: {
  provider?: string | null;
  model?: string | null;
  apiKeyId?: string | null;
}): Promise<UsageAggregateResult> {
  const normalizedFilter = {
    provider: normalizeFilterValue(filter.provider),
    model: normalizeFilterValue(filter.model),
    apiKeyId: normalizeExactFilterValue(filter.apiKeyId),
  };
  const key = JSON.stringify([
    normalizedFilter.provider,
    normalizedFilter.model,
    normalizedFilter.apiKeyId,
  ]);
  const existing = filteredFlights.get(key);
  if (existing) return existing;

  const flight = refreshFilteredAggregate(key, normalizedFilter);
  filteredFlights.set(key, flight);
  try {
    return await flight;
  } finally {
    if (filteredFlights.get(key) === flight) filteredFlights.delete(key);
  }
}

type NormalizedUsageFilter = {
  provider: string | null;
  model: string | null;
  apiKeyId: string | null;
};

function trimRetainedFilteredAggregates(): void {
  while (retainedFilteredAggregates.size > MAX_RETAINED_FILTERED_AGGREGATES) {
    const oldest = [...retainedFilteredAggregates]
      .filter(([, state]) => !pinnedAggregates.has(state))
      .sort(([, left], [, right]) => left.retainedAt - right.retainedAt)[0];
    if (!oldest) return;
    retainedFilteredAggregates.delete(oldest[0]);
  }
}

function publishFilteredAggregate(
  key: string,
  state: RetainedUsageAggregate,
  update: UsageAggregateResult["update"],
): UsageAggregateResult {
  retainedFilteredAggregates.set(key, state);
  trimRetainedFilteredAggregates();
  enforceAppOwnedMemoryBudget();
  return resultFrom(state, update);
}

async function rebuildFilteredAggregate(
  key: string,
  filter: NormalizedUsageFilter,
): Promise<UsageAggregateResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_REBUILD_ATTEMPTS; attempt += 1) {
    const overlayVersion = userCostOverlayVersion();
    const timeZone = currentTimeZone();
    const accumulator = createUsageSummaryAccumulator({ filter, mode: "row-unique" });
    try {
      const scan = await scanUsageLedgerCooperatively({ onEntry: entry => accumulator.add(entry) });
      if (scan.oversizedRows > 0) throw new Error("usage ledger contains an oversized row");
      if (userCostOverlayVersion() !== overlayVersion || currentTimeZone() !== timeZone) {
        lastError = new Error("usage aggregation inputs changed during filtered scan");
        continue;
      }
      const state = makeRetainedAggregate(accumulator, scan, overlayVersion, timeZone);
      return publishFilteredAggregate(key, state, "rebuild");
    } catch (error) {
      lastError = error;
      if (!(error instanceof UsageLedgerRebuildRequiredError) || attempt + 1 >= MAX_REBUILD_ATTEMPTS) {
        throw error;
      }
    }
  }
  throw lastError ?? new Error("filtered usage scan did not settle");
}

async function appendFilteredAggregate(
  key: string,
  state: RetainedUsageAggregate,
  filter: NormalizedUsageFilter,
): Promise<UsageAggregateResult> {
  pinnedAggregates.add(state);
  let rebuildAfterUnpin = false;
  try {
    const candidate = state.accumulator.clone();
    const scan = await scanUsageLedgerCooperatively({
      startAtBytes: state.processedThroughBytes,
      expectedIdentityKey: state.identityKey,
      expectedProcessedThroughDigest: state.processedThroughDigest,
      onEntry: entry => candidate.add(entry),
    });
    if (scan.oversizedRows > 0) {
      if (retainedFilteredAggregates.get(key) === state) retainedFilteredAggregates.delete(key);
      throw new Error("usage ledger contains an oversized row");
    }
    if (userCostOverlayVersion() !== state.overlayVersion || currentTimeZone() !== state.timeZone) {
      if (retainedFilteredAggregates.get(key) === state) retainedFilteredAggregates.delete(key);
      rebuildAfterUnpin = true;
    } else {
      const next: RetainedUsageAggregate = {
        ...state,
        accumulator: candidate,
        revision: scan.revision,
        identityKey: usageLogIdentityKey(scan.revision),
        revisionKey: usageLogRevisionKey(scan.revision),
        processedThroughBytes: scan.processedThroughBytes,
        processedThroughDigest: scan.processedThroughDigest,
        retainedAt: Date.now(),
      };
      return publishFilteredAggregate(key, next, "append");
    }
  } catch (error) {
    if (retainedFilteredAggregates.get(key) === state) retainedFilteredAggregates.delete(key);
    if (error instanceof UsageLedgerRebuildRequiredError) rebuildAfterUnpin = true;
    else throw error;
  } finally {
    pinnedAggregates.delete(state);
    trimRetainedFilteredAggregates();
  }
  if (rebuildAfterUnpin) return rebuildFilteredAggregate(key, filter);
  throw new Error("filtered usage append did not settle");
}

async function refreshFilteredAggregate(
  key: string,
  filter: NormalizedUsageFilter,
): Promise<UsageAggregateResult> {
  const state = retainedFilteredAggregates.get(key);
  if (!state) return rebuildFilteredAggregate(key, filter);
  const observed = currentUsageLogRevision();
  const overlayVersion = userCostOverlayVersion();
  const timeZone = currentTimeZone();
  if (requiresRebuild(state, observed, overlayVersion, timeZone)) {
    retainedFilteredAggregates.delete(key);
    return rebuildFilteredAggregate(key, filter);
  }
  if (state.revisionKey === usageLogRevisionKey(observed)) {
    state.retainedAt = Date.now();
    return resultFrom(state, "unchanged");
  }
  return appendFilteredAggregate(key, state, filter);
}

export function usageAggregateRetainedStats(): UsageAggregateRetainedStats {
  const states = [
    ...(retainedAggregate ? [retainedAggregate] : []),
    ...retainedFilteredAggregates.values(),
  ];
  if (states.length === 0) {
    return { count: 0, bytes: 0, evictableBytes: 0, pinnedBytes: 0, oldestAt: null };
  }
  let bytes = 0;
  let evictableBytes = 0;
  let pinnedBytes = 0;
  let oldestAt: number | null = null;
  for (const state of states) {
    const stateBytes = state.accumulator.estimatedBytes;
    bytes += stateBytes;
    if (pinnedAggregates.has(state)) pinnedBytes += stateBytes;
    else {
      evictableBytes += stateBytes;
      oldestAt = oldestAt === null ? state.retainedAt : Math.min(oldestAt, state.retainedAt);
    }
  }
  return {
    count: states.length,
    bytes,
    evictableBytes,
    pinnedBytes,
    oldestAt,
  };
}

export function discardRetainedUsageAggregate(): number {
  const candidates: Array<{ key: string | null; state: RetainedUsageAggregate }> = [
    ...(retainedAggregate && !pinnedAggregates.has(retainedAggregate)
      ? [{ key: null, state: retainedAggregate }]
      : []),
    ...[...retainedFilteredAggregates]
      .filter(([, state]) => !pinnedAggregates.has(state))
      .map(([key, state]) => ({ key, state })),
  ];
  const oldest = candidates.sort((left, right) => left.state.retainedAt - right.state.retainedAt)[0];
  if (!oldest) return 0;
  const released = oldest.state.accumulator.estimatedBytes;
  if (oldest.key === null) retainedAggregate = null;
  else retainedFilteredAggregates.delete(oldest.key);
  return released;
}

export function resetUsageAggregateCacheForTests(): void {
  retainedAggregate = null;
  pinnedAggregates.clear();
  baseFlight = null;
  filteredFlights.clear();
  retainedFilteredAggregates.clear();
}
