/**
 * In-memory, per-provider TTL cache for live `/models` results.
 *
 * Ported in spirit from jawcode's packages/ai/src/model-manager.ts (the "always load the latest
 * model list" resolver): live fetch when the cache is stale, serve the cache while it is fresh,
 * and fall back to the last-known-good list when a live fetch fails. opencodex's proxy is a single
 * long-running process and the on-disk Codex catalog already persists the last sync across
 * restarts, so an in-memory cache is sufficient here (no SQLite layer needed).
 */
import type { CatalogModel } from "./catalog";
import type { GenerationContext } from "../lib/state-store-sweeper";
import { enforceAppOwnedMemoryBudget, type RetainedStoreSnapshot } from "../lib/app-owned-memory";
import { clearLiveCursorRosterState } from "../adapters/cursor/catalog";

/** Default freshness window. Matches Codex's own 5-min models cache so the two stay in step. */
export const DEFAULT_MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  models: CatalogModel[];
  fetchedAt: number;
  sizeBytes: number;
  /** Irreversible credential/account identity for entitlement-sensitive catalogs. */
  authorityIdentity?: string;
  /** Set by {@link expireModelCache}: the rows stay as the fallback but no longer count as fresh. */
  expired?: true;
}

export type ProviderModelDiscoveryFailureReason =
  | "http"
  | "blocked"
  | "invalid_response"
  | "network"
  | "provider";

export type ProviderModelDiscoveryStatus =
  | { status: "ok" }
  | { status: "failed"; reason: "http"; httpStatus: number }
  | {
      status: "failed";
      reason: Exclude<ProviderModelDiscoveryFailureReason, "http">;
      httpStatus?: never;
    };

export type ProviderModelDiscoveryFailure = ProviderModelDiscoveryStatus extends infer Status
  ? Status extends { status: "failed" }
    ? Omit<Status, "status">
    : never
  : never;

export type ProviderModelDiscoveryWarningCondition = "xai-legacy-privacy-mode";

/** Whether clearing cache rows also revokes in-flight discovery authority. */
export type ModelCacheClearReason = "authority" | "eviction";

const cache = new Map<string, CacheEntry>();
let globalCacheGeneration = 0;
export const providerCacheGenerations = new Map<string, number>();
let cacheBytes = 0;
let oldestCachedProvider: string | undefined;
let oldestCachedAt: number | null = null;
const modelCacheEncoder = new TextEncoder();

function recomputeOldestCachedProvider(): void {
  oldestCachedProvider = undefined;
  oldestCachedAt = null;
  for (const [provider, entry] of cache) {
    if (oldestCachedAt !== null && entry.fetchedAt >= oldestCachedAt) continue;
    oldestCachedProvider = provider;
    oldestCachedAt = entry.fetchedAt;
  }
}

function deleteCachedProvider(provider: string): number {
  const entry = cache.get(provider);
  if (!entry) return 0;
  cache.delete(provider);
  cacheBytes = Math.max(0, cacheBytes - entry.sizeBytes);
  if (oldestCachedProvider === provider) recomputeOldestCachedProvider();
  // A removal changes this provider's content as surely as a publication does.
  bumpProviderCacheRevision(provider);
  return entry.sizeBytes;
}

/** Cooldown after a failed live `/models` fetch, so a dead/unreachable provider doesn't re-pay
 * the full fetch timeout on every catalog poll (issue #54: UI stalls behind corporate proxies). */
export const MODELS_FETCH_FAILURE_COOLDOWN_MS = 30_000;

interface DiscoveryFailure {
  at: number;
  /**
   * Credential the failure was observed under, for entitlement-specific rosters. Absent means
   * the failure is credential-agnostic (a plain `/models` endpoint) and suppresses every
   * caller, which is the original #54 behaviour.
   */
  authorityIdentity?: string;
}

const failureAt = new Map<string, DiscoveryFailure>();
const discoveryStatus = new Map<string, {
  observation: ProviderModelDiscoveryStatus;
  observationOrder?: number;
  warningCondition?: ProviderModelDiscoveryWarningCondition;
}>();
let nextDiscoveryObservationOrder = 0;

/** Stamp a discovery at headers, before reading a body that may finish out of order. */
export function captureProviderDiscoveryObservation(): number {
  return ++nextDiscoveryObservationOrder;
}

export function isProviderDiscoveryObservationCurrent(provider: string, order?: number): boolean {
  return order === undefined || order > (discoveryStatus.get(provider)?.observationOrder ?? 0);
}
/**
 * How many models the last successful discovery actually returned, before any configured-alias
 * augmentation or custom-model merge. Consumers cannot recover this by subtracting known custom
 * ids: a custom id that later also appears upstream would make a real live catalog look
 * custom-only, and the provider's configured fallback would wrongly stay authoritative.
 */
const liveModelCounts = new Map<string, number>();
let lastReconciledGeneration = 0;

export function markModelsFetchFailure(
  provider: string,
  now = Date.now(),
  authorityIdentity?: string,
): void {
  failureAt.set(provider, { at: now, ...(authorityIdentity ? { authorityIdentity } : {}) });
}

/** `liveModelCount` is required so a caller that forgets to pass it fails typecheck instead of
 * silently recording zero and misclassifying the provider as having no live catalog. */
export function markProviderDiscoveryOk(provider: string, liveModelCount: number, observationOrder?: number): void {
  discoveryStatus.set(provider, { observation: { status: "ok" }, observationOrder });
  // A newer discovery can succeed after an earlier failure started a cooldown in flight.
  failureAt.delete(provider);
  liveModelCounts.set(provider, Math.max(0, Math.floor(liveModelCount)));
}

export function markProviderDiscoveryFailed(
  provider: string,
  failure: ProviderModelDiscoveryFailure,
  warningCondition?: ProviderModelDiscoveryWarningCondition,
  observationOrder?: number,
): void {
  discoveryStatus.set(provider, { observation: { status: "failed", ...failure }, warningCondition, observationOrder });
}

/**
 * Decide whether a discovery FAILURE should be logged, to avoid flooding the log with an identical
 * warning on every poll (#395: an anthropic-adapter baseUrl without `/v1/models`, e.g. Azure AI
 * Foundry, returns HTTP 404 forever; the 30s cooldown re-probes and previously re-logged each time).
 *
 * Returns true only when the failure SIGNATURE changed since the last observed status — i.e. the
 * previous state was ok/undefined, or a different reason, HTTP status, or warning condition.
 * Repeated identical failures stay observable through `getProviderDiscoveryStatus()` / the
 * providers API without log spam.
 * Call this BEFORE `markProviderDiscoveryFailed` so it can see the prior state.
 */
export function shouldLogDiscoveryFailure(
  provider: string,
  failure: ProviderModelDiscoveryFailure,
  warningCondition?: ProviderModelDiscoveryWarningCondition,
): boolean {
  const previous = discoveryStatus.get(provider);
  if (!previous || previous.observation.status !== "failed") return true;
  if (previous.warningCondition !== warningCondition) return true;
  const prev = previous.observation;
  if (prev.reason !== failure.reason) return true;
  if (prev.reason === "http" && failure.reason === "http") {
    return prev.httpStatus !== failure.httpStatus;
  }
  return false;
}

export function clearProviderDiscoveryStatus(provider: string): void {
  discoveryStatus.delete(provider);
  liveModelCounts.delete(provider);
}

export function getProviderDiscoveryStatus(provider: string): ProviderModelDiscoveryStatus | undefined {
  return discoveryStatus.get(provider)?.observation;
}

/** Undefined when discovery has never succeeded for this provider. A failed refresh keeps the
 * last successful count so a stale catalog is still recognised as live-origin. */
export function getProviderLiveModelCount(provider: string): number | undefined {
  return liveModelCounts.get(provider);
}

/**
 * Whether a failed discovery still suppresses the next one.
 *
 * `authorityIdentity` scopes the suppression to the credential that actually observed the
 * failure. A roster that upstream filters per account is evidence about that account, and
 * one account's 401 or 404 must not decide that a different account has no catalog. A
 * failure recorded without an identity stays credential-agnostic and suppresses everyone,
 * so the plain-endpoint providers keep the timeout protection #54 added.
 */
export function isModelsFetchCoolingDown(
  provider: string,
  cooldownMs = MODELS_FETCH_FAILURE_COOLDOWN_MS,
  now = Date.now(),
  authorityIdentity?: string,
): boolean {
  const failure = failureAt.get(provider);
  if (failure === undefined || now - failure.at >= cooldownMs) return false;
  if (failure.authorityIdentity === undefined || authorityIdentity === undefined) return true;
  return failure.authorityIdentity === authorityIdentity;
}

/** Fresh cached models for a provider, or null when absent/stale (caller should re-fetch). */
export function getFreshCached(provider: string, ttlMs: number, now = Date.now(), authorityIdentity?: string): CatalogModel[] | null {
  const entry = cache.get(provider);
  if (!entry) return null;
  if (entry.expired || (authorityIdentity !== undefined && entry.authorityIdentity !== authorityIdentity)) return null;
  return now - entry.fetchedAt < ttlMs ? entry.models : null;
}

/** Last-known-good models regardless of age — the fallback when a live fetch fails. */
export function getStaleCached(provider: string, authorityIdentity?: string): CatalogModel[] | null {
  const entry = cache.get(provider);
  if (!entry) return null;
  if (authorityIdentity !== undefined && entry.authorityIdentity !== authorityIdentity) return null;
  return entry.models;
}

/** Selector decoding may use unscoped rows, but scoped rows need current authority. */
export function getRoutingCached(
  provider: string, resolveAuthority: () => string | undefined,
): CatalogModel[] | null {
  const entry = cache.get(provider);
  if (!entry) return null;
  if (entry.authorityIdentity !== undefined) {
    try {
      if (resolveAuthority() !== entry.authorityIdentity) return null;
    } catch { return null; }
  }
  return entry.models;
}

/** Capture the cache generation before an asynchronous provider discovery starts. */
export function captureModelCacheGeneration(provider: string): string {
  if (!providerCacheGenerations.has(provider)) providerCacheGenerations.set(provider, 0);
  return `${globalCacheGeneration}:${providerCacheGenerations.get(provider)!}`;
}

/** Whether a discovery started under {@link captureModelCacheGeneration} may still write. */
export function isModelCacheGenerationCurrent(provider: string, generation: string): boolean {
  return generation === captureModelCacheGeneration(provider);
}

/**
 * Track cached row changes independently from authority invalidation and discovery ordering.
 * A reader holding a derived roster needs all three terms to revalidate publication.
 * Reading a revision is passive and never creates a provider entry.
 */
const providerCacheRevisions = new Map<string, number>();
let globalContentRevision = 0;

// The publication watermark survives row eviction while a delayed flight can still finish.
const publishedDiscoveryGenerations = new Map<string, number>();
let nextDiscoveryGeneration = 0;

export function captureModelDiscoveryGeneration(): number {
  return ++nextDiscoveryGeneration;
}

export function canPublishModelDiscovery(provider: string, generation: number): boolean {
  return generation >= (publishedDiscoveryGenerations.get(provider) ?? 0);
}

/** Advance the shared watermark for either outcome, independently of cached rows. */
export function claimModelDiscoveryPublication(provider: string, generation: number): boolean {
  if (!canPublishModelDiscovery(provider, generation)) return false;
  publishedDiscoveryGenerations.set(provider, generation);
  return true;
}

function bumpProviderCacheRevision(provider: string): void {
  providerCacheRevisions.set(provider, (providerCacheRevisions.get(provider) ?? 0) + 1);
}

/** A successful roster available to its caller after a newer observation wins publication. */
export function callerLocalModelDiscoveryRevision(cacheGeneration: string): string {
  return `caller-local:${cacheGeneration}`;
}

export function observeModelCacheRevision(provider: string): string {
  // The global term covers a clear that empties the map wholesale, which per-provider counters
  // cannot express: without it, wiping every entry and republishing identical-looking rows would
  // read as unchanged. It also survives pruning, so a retired provider cannot come back with a
  // counter that matches a roster built before it left. The publication watermark also
  // retires older derived rosters on a newer failure, even when the rows stay unchanged.
  return `${globalContentRevision}:${providerCacheRevisions.get(provider) ?? 0}`
    + `:${providerCacheGenerations.get(provider) ?? 0}:${publishedDiscoveryGenerations.get(provider) ?? 0}`;
}

/** Recognize ordered supersession while the provider's cache authority still holds. */
export function readableSupersededModelDiscovery(provider: string, revision: string): "caller-local" | "previously-current" | null {
  const authority = providerCacheGenerations.get(provider) ?? 0;
  if (revision === callerLocalModelDiscoveryRevision(`${globalCacheGeneration}:${authority}`)) return "caller-local";
  const [epoch, , capturedAuthority, publication] = revision.split(":");
  return epoch === String(globalContentRevision) && capturedAuthority === String(authority)
    && Number(publication) < (publishedDiscoveryGenerations.get(provider) ?? 0) ? "previously-current" : null;
}

/**
 * Store a live result if cache authority still holds and no newer discovery has published.
 */
export function setCached(
  provider: string,
  models: CatalogModel[],
  now = Date.now(),
  generation?: string,
  authorityIdentity?: string,
  discoveryGeneration?: number,
): boolean {
  if (generation !== undefined && !isModelCacheGenerationCurrent(provider, generation)) return false;
  if (discoveryGeneration !== undefined && !claimModelDiscoveryPublication(provider, discoveryGeneration)) return false;
  deleteCachedProvider(provider);
  const sizeBytes = modelCacheEncoder.encode(provider).byteLength
    + modelCacheEncoder.encode(JSON.stringify(models)).byteLength;
  cache.set(provider, { models, fetchedAt: now, sizeBytes, ...(authorityIdentity ? { authorityIdentity } : {}) });
  cacheBytes += sizeBytes;
  if (oldestCachedAt === null || now < oldestCachedAt) {
    oldestCachedProvider = provider;
    oldestCachedAt = now;
  }
  enforceAppOwnedMemoryBudget();
  // Published and accepted, so anything derived from this provider's rows is now out of date.
  bumpProviderCacheRevision(provider);
  return true;
}

/**
 * Expire freshness and require a new observation, keeping the last-known-good rows for fallback.
 * During failure backoff, leave both the cache and its failure observation intact.
 */
export function expireModelCache(provider: string, authority?: string): boolean {
  if (isModelsFetchCoolingDown(provider, undefined, undefined, authority)) return false;
  const entry = cache.get(provider);
  if (entry) entry.expired = true;
  discoveryStatus.delete(provider);
  return true;
}

/** Drop one provider's cache (or all) so the next resolve forces a live re-fetch. */
export function clearModelCache(
  provider?: string,
  reason: ModelCacheClearReason = "authority",
): void {
  clearLiveCursorRosterState(provider);
  const revokesInFlightDiscovery = reason === "authority";
  if (provider) {
    if (revokesInFlightDiscovery) {
      providerCacheGenerations.set(provider, (providerCacheGenerations.get(provider) ?? 0) + 1);
      publishedDiscoveryGenerations.delete(provider);
    }
    deleteCachedProvider(provider);
    failureAt.delete(provider);
    discoveryStatus.delete(provider);
    liveModelCounts.delete(provider);
  } else {
    if (revokesInFlightDiscovery) {
      globalCacheGeneration += 1;
      publishedDiscoveryGenerations.clear();
    }
    cache.clear();
    // A wholesale clear changes every provider's content at once, and clearing the map means no
    // per-provider counter can record it. Advancing the global term retires every derived roster
    // and lets the per-provider entries be dropped without an ABA on the way back.
    globalContentRevision += 1;
    providerCacheRevisions.clear();
    cacheBytes = 0;
    oldestCachedProvider = undefined;
    oldestCachedAt = null;
    failureAt.clear();
    discoveryStatus.clear();
    liveModelCounts.clear();
  }
}

export function reconcileModelCacheProviders(
  validProviders: ReadonlySet<string>,
  generation = lastReconciledGeneration + 1,
): number {
  if (generation <= lastReconciledGeneration) return 0;
  const removedProviders = new Set<string>();
  const trackedProviders = new Set([
    ...providerCacheGenerations.keys(),
    ...providerCacheRevisions.keys(),
    ...publishedDiscoveryGenerations.keys(),
    ...failureAt.keys(),
    ...discoveryStatus.keys(),
    ...liveModelCounts.keys(),
    ...cache.keys(),
  ]);
  let revokedRemovedProviderAuthority = false;
  for (const provider of trackedProviders) {
    if (validProviders.has(provider)) continue;
    if (!revokedRemovedProviderAuthority) {
      globalCacheGeneration += 1;
      // Advanced BEFORE any revision entry is dropped, so a provider that comes back cannot
      // present the counter a roster was built against. Without this the delete below is an ABA:
      // the entry returns at zero and an old stamp matches again.
      globalContentRevision += 1;
      revokedRemovedProviderAuthority = true;
    }
    providerCacheGenerations.set(provider, (providerCacheGenerations.get(provider) ?? 0) + 1);
    providerCacheGenerations.delete(provider);
    deleteCachedProvider(provider);
    failureAt.delete(provider);
    discoveryStatus.delete(provider);
    liveModelCounts.delete(provider);
    // AFTER the cache deletion, which bumps this provider's revision and would otherwise recreate
    // the entry we just removed. Dropped rather than left behind: a provider the configuration no
    // longer has must not keep an entry alive for the life of the process merely because nothing
    // cleared the whole cache. The global epoch advanced above, so the removal is not an ABA.
    providerCacheRevisions.delete(provider);
    publishedDiscoveryGenerations.delete(provider);
    removedProviders.add(provider);
  }
  lastReconciledGeneration = generation;
  return removedProviders.size;
}

export function reconcileModelCacheGeneration(context: GenerationContext): number {
  return reconcileModelCacheProviders(context.providerNames, context.generation);
}

export function modelCacheRetainedStoreSnapshot(): RetainedStoreSnapshot {
  return {
    count: cache.size,
    bytes: cacheBytes,
    evictableBytes: cacheBytes,
    pinnedBytes: 0,
    oldestAt: oldestCachedAt,
  };
}

export function evictOldestModelCacheForBudget(): number {
  return oldestCachedProvider === undefined ? 0 : deleteCachedProvider(oldestCachedProvider);
}
