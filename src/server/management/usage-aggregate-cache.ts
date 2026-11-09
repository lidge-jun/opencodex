import { enforceAppOwnedMemoryBudget } from "../../lib/app-owned-memory";
import {
  currentUsageLogRevision,
  usageLogIdentityKey,
  usageLogRevisionKey,
  type UsageLogRevision,
} from "../../usage/log";
import {
  readUsageLedgerRowsAtOffsets,
  scanUsageLedgerCooperatively,
  UsageLedgerRebuildRequiredError,
} from "../../usage/ledger-scanner";
import {
  readUsageFilterCandidates,
  readUsageFilterCandidatesPassive,
  requestUsageFilterIndexRebuild,
  resetUsageFilterIndexForTests,
  UsageFilterIndexPageError,
  type UsageFilterCandidateRead,
  type UsageFilterIndexQuery,
  type UsageFilterIndexSnapshot,
  type UsageFilterQueryStats,
} from "../../usage/filter-index";
import { isPassiveRead } from "../../lib/passive-read";
import {
  createUsageSummaryAccumulator,
  type UsageSummaryAccumulator,
  type UsageSummaryFilterInput,
} from "../../usage/summary";
import { userCostOverlayVersion } from "../../usage/user-cost-overlays";
import type { UsageTimeWindow } from "../../usage/time-range";
import { snapshotConfiguredKeyIds } from "../../usage/source-filter";
import {
  createJevStatsAccumulator,
  type JevStatsAccumulator,
} from "../../usage/jev-stats";

import {
  cacheApiKeyUsageFromRollup,
  createApiKeyUsageAccumulator,
} from "./api-key-usage";

interface RetainedUsageAggregate {
  accumulator: UsageSummaryAccumulator;
  usageIncomplete: boolean;
  usageInvalidRows: boolean;
  revision: UsageLogRevision | null;
  identityKey: string;
  revisionKey: string;
  processedThroughBytes: number;
  processedThroughDigest: string;
  overlayVersion: number;
  timeZone: string;
  retainedAt: number;
}

interface RetainedJevStatsAggregate {
  accumulator: JevStatsAccumulator;
  usageIncomplete: boolean;
  revision: UsageLogRevision | null;
  identityKey: string;
  revisionKey: string;
  processedThroughBytes: number;
  processedThroughDigest: string;
  retainedAt: number;
}

type RetainedAggregateState = RetainedUsageAggregate | RetainedJevStatsAggregate;

export interface UsageAggregateResult {
  accumulator: UsageSummaryAccumulator;
  usageIncomplete: boolean;
  usageInvalidRows: boolean;
  revision: UsageLogRevision | null;
  processedThroughBytes: number;
  overlayVersion: number;
  timeZone: string;
  update: "unchanged" | "append" | "rebuild";
  /**
   * Present on filtered results: how many ledger rows the derived candidate index read to
   * answer this filter, against the whole ledger. A full scan reports the same number twice.
   */
  filterIndex?: UsageFilterQueryStats;
}

export interface UsageAggregateOptions {
  now?: number;
  configuredApiKeyIds?: string[];
  managementUsageMaxReadBytes?: number;
}

export interface JevStatsAggregateResult {
  accumulator: JevStatsAccumulator;
  usageIncomplete: boolean;
  revision: UsageLogRevision | null;
  processedThroughBytes: number;
  update: "unchanged" | "append" | "rebuild";
}

export interface UsageAggregateRetainedStats {
  count: number;
  bytes: number;
  evictableBytes: number;
  pinnedBytes: number;
  oldestAt: number | null;
}

const MAX_REBUILD_ATTEMPTS = 2;
// A filtered read can lose a race with a concurrent index rebuild and a ledger replacement in
// the same call, so it gets one more attempt than a plain scan rebuild.
const MAX_FILTER_INDEX_ATTEMPTS = 3;
// Selected rows are folded in bounded batches, so a filter that matches most of a large ledger
// costs the same peak memory as the streaming scan it replaces.
const MAX_RETAINED_FILTERED_AGGREGATES = 4;

let retainedAggregate: RetainedUsageAggregate | null = null;
const pinnedAggregates = new Set<RetainedAggregateState>();
let baseFlight: Promise<UsageAggregateResult> | null = null;
const filteredFlights = new Map<string, Promise<UsageAggregateResult>>();
const retainedFilteredAggregates = new Map<string, RetainedFilteredAggregate>();
const MAX_CONCURRENT_FILTERED_AGGREGATES = 4;
const retainedJevStatsAggregates = new Map<string, RetainedJevStatsAggregate>();
const jevStatsFlights = new Map<string, Promise<JevStatsAggregateResult>>();
const MAX_RETAINED_JEV_STATS_AGGREGATES = 4;
const MAX_CONCURRENT_JEV_STATS_AGGREGATES = 4;

function currentTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function resultFrom(
  state: RetainedUsageAggregate,
  update: UsageAggregateResult["update"],
): UsageAggregateResult {
  return {
    accumulator: state.accumulator,
    usageIncomplete: state.usageIncomplete,
    usageInvalidRows: state.usageInvalidRows,
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
    usageIncomplete: scan.oversizedRows > 0,
    usageInvalidRows: scan.invalidRows > 0,
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
      if (userCostOverlayVersion() !== overlayVersion || currentTimeZone() !== timeZone) {
        lastError = new Error("usage aggregation inputs changed during rebuild");
        continue;
      }

      const state = makeRetainedAggregate(accumulator, scan, overlayVersion, timeZone);
      const result = publishRetainedAggregate(state);
      if (apiKeyAccumulator && options.configuredApiKeyIds) {
        cacheApiKeyUsageFromRollup(
          {
            ...apiKeyAccumulator.snapshot(),
            ...(state.usageIncomplete ? { usageIncomplete: true as const, usageIncompleteReason: "oversized_rows" as const } : {}),
          },
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
    // suffix. A callback error or mutation leaves retained state untouched.
    // Skipped oversized rows retain the normal rows with an explicit diagnostic.
    const candidate = state.accumulator.clone();
    const scan = await scanUsageLedgerCooperatively({
      startAtBytes: state.processedThroughBytes,
      expectedIdentityKey: state.identityKey,
      expectedProcessedThroughDigest: state.processedThroughDigest,
      onEntry: entry => candidate.add(entry),
    });
    if (userCostOverlayVersion() !== state.overlayVersion || currentTimeZone() !== state.timeZone) {
      if (retainedAggregate === state) retainedAggregate = null;
      rebuildAfterUnpin = true;
    } else {
      const next: RetainedUsageAggregate = {
        ...state,
        accumulator: candidate,
        // A partial unterminated row can be scanned again on the next append.
        // Preserve a boolean diagnostic rather than double-counting omissions.
        usageIncomplete: state.usageIncomplete || scan.oversizedRows > 0,
        usageInvalidRows: state.usageInvalidRows || scan.invalidRows > 0,
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

export async function getFilteredUsageAggregate(filter: UsageSummaryFilterInput, window?: UsageTimeWindow): Promise<UsageAggregateResult> {
  const fixedWindow = window ? Object.freeze({ ...window }) : undefined;
  const normalizedFilter = {
    provider: normalizeFilterValue(filter.provider),
    model: normalizeFilterValue(filter.model),
    apiKeyId: normalizeExactFilterValue(filter.apiKeyId),
    ...(filter.sourceFilter ? { sourceFilter: { client: filter.sourceFilter.client, device: { ...filter.sourceFilter.device } } } : {}),
    ...(filter.configuredApiKeyIds ? { configuredApiKeyIds: snapshotConfiguredKeyIds(filter.configuredApiKeyIds) } : {}),
  };
  const key = JSON.stringify([
    normalizedFilter.provider,
    normalizedFilter.model,
    normalizedFilter.apiKeyId,
    normalizedFilter.sourceFilter ?? null,
    normalizedFilter.configuredApiKeyIds ?? null,
    fixedWindow?.since ?? null,
    fixedWindow?.until ?? null,
  ]);
  const existing = filteredFlights.get(key);
  if (existing) return existing;
  if (filteredFlights.size >= MAX_CONCURRENT_FILTERED_AGGREGATES) {
    throw new Error("too many concurrent filtered usage aggregates");
  }

  const flight = refreshFilteredAggregate(key, normalizedFilter, fixedWindow);
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
  sourceFilter?: UsageSummaryFilterInput["sourceFilter"];
  configuredApiKeyIds?: readonly string[];
};

/**
 * A retained filtered projection plus the index generation its candidates came from.
 * `null` means it was built by the streaming fallback and cannot be extended incrementally.
 */
type RetainedFilteredAggregate = RetainedUsageAggregate & { indexGeneration: string | null };

/** The derived index and the ledger disagree about where a row starts. */
class UsageFilterIndexCorruptError extends Error {}

/** Pricing or time-zone inputs moved while a filtered projection was being built. */
class UsageAggregationInputsChangedError extends Error {}

function filterQuery(
  filter: NormalizedUsageFilter,
  window?: UsageTimeWindow,
): UsageFilterIndexQuery {
  return {
    provider: filter.provider,
    model: filter.model,
    apiKeyId: filter.apiKeyId,
    ...(filter.sourceFilter ? { sourceFilter: filter.sourceFilter } : {}),
    ...(filter.configuredApiKeyIds ? { configuredApiKeyIds: filter.configuredApiKeyIds } : {}),
    ...(window ? { window } : {}),
  };
}

function filterStats(
  read: UsageFilterCandidateRead,
  update: UsageAggregateResult["update"],
): UsageFilterQueryStats {
  return {
    totalRows: read.snapshot.indexedRows,
    candidateRows: read.candidateRows,
    scope: update,
    ingestedRows: read.snapshot.ingestedRows,
    ingestPasses: read.snapshot.ingestPasses,
  };
}

function filteredStateFrom(
  accumulator: UsageSummaryAccumulator,
  snapshot: UsageFilterIndexSnapshot,
  overlayVersion: number,
  timeZone: string,
): RetainedFilteredAggregate {
  return {
    accumulator,
    // Diagnostics describe the whole ledger, not the selected candidates: an invalid or
    // oversized row outside the filter still means the report is incomplete.
    usageIncomplete: snapshot.oversizedRows > 0,
    usageInvalidRows: snapshot.invalidRows > 0,
    revision: snapshot.revision,
    identityKey: snapshot.identityKey,
    revisionKey: usageLogRevisionKey(snapshot.revision),
    processedThroughBytes: snapshot.indexedOffset,
    processedThroughDigest: snapshot.processedThroughDigest,
    overlayVersion,
    timeZone,
    retainedAt: Date.now(),
    indexGeneration: snapshot.generation,
  };
}

/** The pre-index streaming read, used when the projection is unavailable or passive. */
function streamingStateFrom(
  accumulator: UsageSummaryAccumulator,
  scan: Awaited<ReturnType<typeof scanUsageLedgerCooperatively>>,
  overlayVersion: number,
  timeZone: string,
): RetainedFilteredAggregate {
  return {
    accumulator,
    usageIncomplete: scan.oversizedRows > 0,
    usageInvalidRows: scan.invalidRows > 0,
    revision: scan.revision,
    identityKey: usageLogIdentityKey(scan.revision),
    revisionKey: usageLogRevisionKey(scan.revision),
    processedThroughBytes: scan.processedThroughBytes,
    processedThroughDigest: scan.processedThroughDigest,
    overlayVersion,
    timeZone,
    retainedAt: Date.now(),
    indexGeneration: null,
  };
}

/**
 * Candidate selection for one filter.
 *
 * A passive management read must not create or write anything, so it only uses a projection
 * that is already current; otherwise the caller streams. Both paths return null when the
 * acceleration is unusable, never when the ledger itself failed.
 */
async function readCandidates(
  query: UsageFilterIndexQuery,
): Promise<UsageFilterCandidateRead | null> {
  return isPassiveRead()
    ? readUsageFilterCandidatesPassive(query)
    : readUsageFilterCandidates(query);
}

/**
 * Folds every candidate page into the accumulator, yielding between pages and re-reading rows
 * against the snapshot identity; closes the reader when done.
 */
async function accumulateCandidates(
  accumulator: UsageSummaryAccumulator,
  read: UsageFilterCandidateRead,
  filter: NormalizedUsageFilter,
): Promise<void> {
  try {
    let first = true;
    for (;;) {
      // Candidate selection and row decoding are synchronous bounded chunks. A timer yield
      // between them prevents a broad authenticated query from monopolizing the event loop.
      if (!first) await new Promise<void>(resolve => setTimeout(resolve, 0));
      const offsets = read.nextPage();
      if (!first && offsets.length === 0) break;
      first = false;
      const rows = await readUsageLedgerRowsAtOffsets({
        offsets,
        expectedIdentityKey: read.snapshot.identityKey,
        // The offsets belong to this index snapshot. If the ledger moved since the snapshot,
        // the reader re-validates the boundary before trusting any of them, and a rewrite of
        // the indexed tail becomes a rebuild instead of a silently different row set.
        expectedRevisionKey: usageLogRevisionKey(read.snapshot.revision),
        expectedProcessedThroughBytes: read.snapshot.indexedOffset,
        expectedProcessedThroughDigest: read.snapshot.processedThroughDigest,
        // The physical size at publish time; a torn suffix makes it larger than the boundary.
        expectedFileSize: read.snapshot.revision?.size,
      });
      if (rows.unreadableOffsets.length > 0) {
        // Serving only the rows that happened to parse would silently under-report the filter.
        throw new UsageFilterIndexCorruptError();
      }
      for (const entry of rows.entries) accumulator.add(entry);
      if (offsets.length === 0) break;
    }
  } finally {
    read.close();
  }
  // Without a source filter the reported span covers the whole ledger, including rows this
  // filter never selected. A source filter derives its span from the rows that match it, so
  // only the unfiltered-source case needs the ledger-wide span restored.
  if (!filter.sourceFilter) {
    accumulator.noteLedgerSpan(read.snapshot.minTimestamp, read.snapshot.maxTimestamp);
  }
}

async function withFilterIndexRetry<T>(run: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_FILTER_INDEX_ATTEMPTS; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (error instanceof UsageFilterIndexCorruptError) {
        requestUsageFilterIndexRebuild();
        continue;
      }
      if (error instanceof UsageLedgerRebuildRequiredError) continue;
      if (error instanceof UsageAggregationInputsChangedError) continue;
      throw error;
    }
  }
  throw lastError ?? new Error("filtered usage aggregate did not settle");
}

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
  state: RetainedFilteredAggregate,
  update: UsageAggregateResult["update"],
  read: UsageFilterCandidateRead | null,
): UsageAggregateResult {
  retainedFilteredAggregates.set(key, state);
  trimRetainedFilteredAggregates();
  enforceAppOwnedMemoryBudget();
  return read
    ? { ...resultFrom(state, update), filterIndex: filterStats(read, update) }
    : resultFrom(state, update);
}

async function rebuildFilteredAggregate(
  key: string,
  filter: NormalizedUsageFilter,
  window?: UsageTimeWindow,
  overlayVersion: number = userCostOverlayVersion(),
  timeZone: string = currentTimeZone(),
): Promise<UsageAggregateResult> {
  const read = await readCandidates(filterQuery(filter, window));
  if (!read) {
    return rebuildFilteredAggregateStreaming(key, filter, window, overlayVersion, timeZone);
  }
  const accumulator = createUsageSummaryAccumulator({
    filter,
    mode: "row-unique",
    ...(window ? { window } : {}),
  });
  await accumulateCandidates(accumulator, read, filter);
  if (userCostOverlayVersion() !== overlayVersion || currentTimeZone() !== timeZone) {
    throw new UsageAggregationInputsChangedError();
  }
  return publishFilteredAggregate(
    key,
    filteredStateFrom(accumulator, read.snapshot, overlayVersion, timeZone),
    "rebuild",
    read,
  );
}

async function rebuildFilteredAggregateStreaming(
  key: string,
  filter: NormalizedUsageFilter,
  window: UsageTimeWindow | undefined,
  overlayVersion: number,
  timeZone: string,
): Promise<UsageAggregateResult> {
  const accumulator = createUsageSummaryAccumulator({
    filter,
    mode: "row-unique",
    ...(window ? { window } : {}),
  });
  const scan = await scanUsageLedgerCooperatively({ onEntry: entry => accumulator.add(entry) });
  if (userCostOverlayVersion() !== overlayVersion || currentTimeZone() !== timeZone) {
    throw new UsageAggregationInputsChangedError();
  }
  return publishFilteredAggregate(
    key,
    streamingStateFrom(accumulator, scan, overlayVersion, timeZone),
    "rebuild",
    null,
  );
}

async function appendFilteredAggregate(
  key: string,
  state: RetainedFilteredAggregate,
  filter: NormalizedUsageFilter,
  read: UsageFilterCandidateRead,
  overlayVersion: number,
  timeZone: string,
): Promise<UsageAggregateResult> {
  pinnedAggregates.add(state);
  try {
    const candidate = state.accumulator.clone();
    await accumulateCandidates(candidate, read, filter);
    if (userCostOverlayVersion() !== overlayVersion || currentTimeZone() !== timeZone) {
      throw new UsageAggregationInputsChangedError();
    }
    return publishFilteredAggregate(
      key,
      filteredStateFrom(candidate, read.snapshot, overlayVersion, timeZone),
      "append",
      read,
    );
  } catch (error) {
    if (retainedFilteredAggregates.get(key) === state) retainedFilteredAggregates.delete(key);
    throw error;
  } finally {
    pinnedAggregates.delete(state);
    trimRetainedFilteredAggregates();
  }
}

/**
 * Serves the filtered report from the retained aggregate, appending new candidates or rebuilding
 * as needed; a candidate-page failure clears the retained state and retries the streaming scan.
 */
async function refreshFilteredAggregate(
  key: string,
  filter: NormalizedUsageFilter,
  window?: UsageTimeWindow,
): Promise<UsageAggregateResult> {
  try {
    return await withFilterIndexRetry(async () => {
      const overlayVersion = userCostOverlayVersion();
      const timeZone = currentTimeZone();
      const state = retainedFilteredAggregates.get(key);
      if (!state
        || state.overlayVersion !== overlayVersion
        || state.timeZone !== timeZone
        || state.indexGeneration === null) {
        return rebuildFilteredAggregate(key, filter, window, overlayVersion, timeZone);
      }
      const read = await readCandidates({
        ...filterQuery(filter, window),
        afterOffset: state.processedThroughBytes,
      });
      if (!read) {
        retainedFilteredAggregates.delete(key);
        return rebuildFilteredAggregate(key, filter, window, overlayVersion, timeZone);
      }
      if (state.indexGeneration !== read.snapshot.generation
        || state.identityKey !== read.snapshot.identityKey
        || state.processedThroughBytes > read.snapshot.indexedOffset) {
        // This branch never pages, so it owns closing the reader before the rebuild discards it.
        read.close();
        retainedFilteredAggregates.delete(key);
        return rebuildFilteredAggregate(key, filter, window, overlayVersion, timeZone);
      }
      if (state.processedThroughBytes === read.snapshot.indexedOffset) {
        // Even an unchanged retained projection validates the ledger against the snapshot, so a
        // rewrite in the window between the index refresh and this return is not served stale.
        try {
          await readUsageLedgerRowsAtOffsets({
            offsets: [],
            expectedIdentityKey: read.snapshot.identityKey,
            expectedRevisionKey: usageLogRevisionKey(read.snapshot.revision),
            expectedProcessedThroughBytes: read.snapshot.indexedOffset,
            expectedProcessedThroughDigest: read.snapshot.processedThroughDigest,
            expectedFileSize: read.snapshot.revision?.size,
          });
        } finally {
          // This branch never pages, so it owns closing the reader before publishing its stats.
          read.close();
        }
        state.retainedAt = Date.now();
        // Whole-ledger diagnostics can move without the boundary moving: a torn oversized or
        // malformed suffix is observed by every append scan and never advances the offset.
        state.usageIncomplete = read.snapshot.oversizedRows > 0;
        state.usageInvalidRows = read.snapshot.invalidRows > 0;
        state.revision = read.snapshot.revision;
        state.revisionKey = usageLogRevisionKey(read.snapshot.revision);
        return publishFilteredAggregate(key, state, "unchanged", read);
      }
      return appendFilteredAggregate(key, state, filter, read, overlayVersion, timeZone);
    });
  } catch (error) {
    if (error instanceof UsageFilterIndexPageError) {
      // A page failed after its reader was handed out: the index cannot serve this query,
      // so answer from the authoritative ledger scan instead of failing the request.
      retainedFilteredAggregates.delete(key);
      return withFilterIndexRetry(() =>
        rebuildFilteredAggregateStreaming(key, filter, window, userCostOverlayVersion(), currentTimeZone()),
      );
    }
    throw error;
  }
}

function jevStatsResultFrom(
  state: RetainedJevStatsAggregate,
  update: JevStatsAggregateResult["update"],
): JevStatsAggregateResult {
  return {
    accumulator: state.accumulator,
    usageIncomplete: state.usageIncomplete,
    revision: state.revision,
    processedThroughBytes: state.processedThroughBytes,
    update,
  };
}

function trimRetainedJevStatsAggregates(): void {
  while (retainedJevStatsAggregates.size > MAX_RETAINED_JEV_STATS_AGGREGATES) {
    const oldest = [...retainedJevStatsAggregates]
      .filter(([, state]) => !pinnedAggregates.has(state))
      .sort(([, left], [, right]) => left.retainedAt - right.retainedAt)[0];
    if (!oldest) return;
    retainedJevStatsAggregates.delete(oldest[0]);
  }
}

function publishJevStatsAggregate(
  key: string,
  state: RetainedJevStatsAggregate,
  update: JevStatsAggregateResult["update"],
): JevStatsAggregateResult {
  retainedJevStatsAggregates.set(key, state);
  trimRetainedJevStatsAggregates();
  enforceAppOwnedMemoryBudget();
  return jevStatsResultFrom(state, update);
}

function retainedJevStatsState(
  accumulator: JevStatsAccumulator,
  scan: Awaited<ReturnType<typeof scanUsageLedgerCooperatively>>,
  priorIncomplete = false,
): RetainedJevStatsAggregate {
  return {
    accumulator,
    usageIncomplete: priorIncomplete || scan.oversizedRows > 0,
    revision: scan.revision,
    identityKey: usageLogIdentityKey(scan.revision),
    revisionKey: usageLogRevisionKey(scan.revision),
    processedThroughBytes: scan.processedThroughBytes,
    processedThroughDigest: scan.processedThroughDigest,
    retainedAt: Date.now(),
  };
}

async function rebuildJevStatsAggregate(
  key: string,
  comboId: string | null,
  since: number | null,
): Promise<JevStatsAggregateResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_REBUILD_ATTEMPTS; attempt += 1) {
    // A rebuild-required result means the opened ledger changed underneath the
    // scan. Start from a fresh accumulator so no partially observed row can be
    // returned or retained.
    const accumulator = createJevStatsAccumulator({ comboId, since });
    try {
      const scan = await scanUsageLedgerCooperatively({ onEntry: entry => accumulator.add(entry) });
      return publishJevStatsAggregate(key, retainedJevStatsState(accumulator, scan), "rebuild");
    } catch (error) {
      lastError = error;
      if (!(error instanceof UsageLedgerRebuildRequiredError) || attempt + 1 >= MAX_REBUILD_ATTEMPTS) {
        throw error;
      }
    }
  }
  throw lastError ?? new Error("JEV stats aggregate rebuild did not settle");
}

function jevStatsRequiresRebuild(
  state: RetainedJevStatsAggregate,
  observed: UsageLogRevision | null,
): boolean {
  if (state.identityKey !== usageLogIdentityKey(observed)) return true;
  if (!state.revision || !observed) return state.revision !== observed;
  if (observed.size < state.revision.size) return true;
  return observed.size === state.revision.size && usageLogRevisionKey(observed) !== state.revisionKey;
}

async function appendJevStatsAggregate(
  key: string,
  state: RetainedJevStatsAggregate,
  comboId: string | null,
  since: number | null,
): Promise<JevStatsAggregateResult> {
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
    const next = retainedJevStatsState(candidate, scan, state.usageIncomplete);
    return publishJevStatsAggregate(key, next, "append");
  } catch (error) {
    if (retainedJevStatsAggregates.get(key) === state) retainedJevStatsAggregates.delete(key);
    if (error instanceof UsageLedgerRebuildRequiredError) rebuildAfterUnpin = true;
    else throw error;
  } finally {
    pinnedAggregates.delete(state);
    trimRetainedJevStatsAggregates();
  }
  if (rebuildAfterUnpin) return rebuildJevStatsAggregate(key, comboId, since);
  throw new Error("JEV stats aggregate append did not settle");
}

async function refreshJevStatsAggregate(
  key: string,
  comboId: string | null,
  since: number | null,
): Promise<JevStatsAggregateResult> {
  const state = retainedJevStatsAggregates.get(key);
  if (!state) return rebuildJevStatsAggregate(key, comboId, since);
  const observed = currentUsageLogRevision();
  if (jevStatsRequiresRebuild(state, observed)) {
    retainedJevStatsAggregates.delete(key);
    return rebuildJevStatsAggregate(key, comboId, since);
  }
  if (state.revisionKey === usageLogRevisionKey(observed)) {
    state.retainedAt = Date.now();
    return jevStatsResultFrom(state, "unchanged");
  }
  return appendJevStatsAggregate(key, state, comboId, since);
}

/**
 * Return one checkpointed JEV projection for a combo and fixed calendar range.
 * Concurrent readers share a flight; later polls scan only a verified append
 * suffix, and unchanged ledgers perform no file read.
 */
export async function getJevStatsAggregate(options: {
  comboId?: string | null;
  since?: number | null;
} = {}): Promise<JevStatsAggregateResult> {
  const comboId = options.comboId ?? null;
  const since = options.since ?? null;
  const key = JSON.stringify([comboId, since]);
  const existing = jevStatsFlights.get(key);
  if (existing) return existing;
  if (jevStatsFlights.size >= MAX_CONCURRENT_JEV_STATS_AGGREGATES) {
    throw new Error("too many concurrent JEV stats aggregates");
  }
  const flight = refreshJevStatsAggregate(key, comboId, since);
  jevStatsFlights.set(key, flight);
  try {
    return await flight;
  } finally {
    if (jevStatsFlights.get(key) === flight) jevStatsFlights.delete(key);
  }
}

export function usageAggregateRetainedStats(): UsageAggregateRetainedStats {
  const states = [
    ...(retainedAggregate ? [retainedAggregate] : []),
    ...retainedFilteredAggregates.values(),
    ...retainedJevStatsAggregates.values(),
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
  const candidates: Array<{
    kind: "base" | "filtered" | "jev";
    key: string | null;
    state: RetainedAggregateState;
  }> = [
    ...(retainedAggregate && !pinnedAggregates.has(retainedAggregate)
      ? [{ kind: "base" as const, key: null, state: retainedAggregate }]
      : []),
    ...[...retainedFilteredAggregates]
      .filter(([, state]) => !pinnedAggregates.has(state))
      .map(([key, state]) => ({ kind: "filtered" as const, key, state })),
    ...[...retainedJevStatsAggregates]
      .filter(([, state]) => !pinnedAggregates.has(state))
      .map(([key, state]) => ({ kind: "jev" as const, key, state })),
  ];
  const oldest = candidates.sort((left, right) => left.state.retainedAt - right.state.retainedAt)[0];
  if (!oldest) return 0;
  const released = oldest.state.accumulator.estimatedBytes;
  if (oldest.kind === "base") retainedAggregate = null;
  else if (oldest.kind === "filtered") retainedFilteredAggregates.delete(oldest.key!);
  else retainedJevStatsAggregates.delete(oldest.key!);
  return released;
}

export function resetUsageAggregateCacheForTests(): void {
  retainedAggregate = null;
  pinnedAggregates.clear();
  baseFlight = null;
  filteredFlights.clear();
  retainedFilteredAggregates.clear();
  jevStatsFlights.clear();
  retainedJevStatsAggregates.clear();
  resetUsageFilterIndexForTests();
}
