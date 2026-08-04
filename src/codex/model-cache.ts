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

/** Default freshness window. Matches Codex's own 5-min models cache so the two stay in step. */
export const DEFAULT_MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  models: CatalogModel[];
  fetchedAt: number;
  sizeBytes: number;
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

const cache = new Map<string, CacheEntry>();
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
  return entry.sizeBytes;
}

/** Cooldown after a failed live `/models` fetch, so a dead/unreachable provider doesn't re-pay
 * the full fetch timeout on every catalog poll (issue #54: UI stalls behind corporate proxies). */
export const MODELS_FETCH_FAILURE_COOLDOWN_MS = 30_000;

const failureAt = new Map<string, number>();
const discoveryStatus = new Map<string, ProviderModelDiscoveryStatus>();
/**
 * How many models the last successful discovery actually returned, before any configured-alias
 * augmentation or custom-model merge. Consumers cannot recover this by subtracting known custom
 * ids: a custom id that later also appears upstream would make a real live catalog look
 * custom-only, and the provider's configured fallback would wrongly stay authoritative.
 */
const liveModelCounts = new Map<string, number>();
let lastReconciledGeneration = 0;

export function markModelsFetchFailure(provider: string, now = Date.now()): void {
  failureAt.set(provider, now);
}

/** `liveModelCount` is required so a caller that forgets to pass it fails typecheck instead of
 * silently recording zero and misclassifying the provider as having no live catalog. */
export function markProviderDiscoveryOk(provider: string, liveModelCount: number): void {
  discoveryStatus.set(provider, { status: "ok" });
  liveModelCounts.set(provider, Math.max(0, Math.floor(liveModelCount)));
}

export function markProviderDiscoveryFailed(
  provider: string,
  failure: ProviderModelDiscoveryFailure,
): void {
  discoveryStatus.set(provider, { status: "failed", ...failure });
}

/**
 * Decide whether a discovery FAILURE should be logged, to avoid flooding the log with an identical
 * warning on every poll (#395: an anthropic-adapter baseUrl without `/v1/models`, e.g. Azure AI
 * Foundry, returns HTTP 404 forever; the 30s cooldown re-probes and previously re-logged each time).
 *
 * Returns true only when the failure SIGNATURE changed since the last observed status — i.e. the
 * previous state was ok/undefined, or a different reason/httpStatus. Repeated identical failures
 * stay observable through `getProviderDiscoveryStatus()` / the providers API without log spam.
 * Call this BEFORE `markProviderDiscoveryFailed` so it can see the prior state.
 */
export function shouldLogDiscoveryFailure(
  provider: string,
  failure: ProviderModelDiscoveryFailure,
): boolean {
  const prev = discoveryStatus.get(provider);
  if (!prev || prev.status !== "failed") return true;
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
  return discoveryStatus.get(provider);
}

/** Undefined when discovery has never succeeded for this provider. A failed refresh keeps the
 * last successful count so a stale catalog is still recognised as live-origin. */
export function getProviderLiveModelCount(provider: string): number | undefined {
  return liveModelCounts.get(provider);
}

export function isModelsFetchCoolingDown(provider: string, cooldownMs = MODELS_FETCH_FAILURE_COOLDOWN_MS, now = Date.now()): boolean {
  const at = failureAt.get(provider);
  return at !== undefined && now - at < cooldownMs;
}

/** Fresh cached models for a provider, or null when absent/stale (caller should re-fetch). */
export function getFreshCached(provider: string, ttlMs: number, now = Date.now()): CatalogModel[] | null {
  const entry = cache.get(provider);
  if (!entry) return null;
  return now - entry.fetchedAt < ttlMs ? entry.models : null;
}

/** Last-known-good models regardless of age — the fallback when a live fetch fails. */
export function getStaleCached(provider: string): CatalogModel[] | null {
  return cache.get(provider)?.models ?? null;
}

export function setCached(provider: string, models: CatalogModel[], now = Date.now()): void {
  deleteCachedProvider(provider);
  const sizeBytes = modelCacheEncoder.encode(provider).byteLength
    + modelCacheEncoder.encode(JSON.stringify(models)).byteLength;
  cache.set(provider, { models, fetchedAt: now, sizeBytes });
  cacheBytes += sizeBytes;
  if (oldestCachedAt === null || now < oldestCachedAt) {
    oldestCachedProvider = provider;
    oldestCachedAt = now;
  }
  enforceAppOwnedMemoryBudget();
}

/** Drop one provider's cache (or all) so the next resolve forces a live re-fetch. */
export function clearModelCache(provider?: string): void {
  if (provider) {
    deleteCachedProvider(provider);
    failureAt.delete(provider);
    discoveryStatus.delete(provider);
    liveModelCounts.delete(provider);
  } else {
    cache.clear();
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
  for (const store of [failureAt, discoveryStatus, liveModelCounts]) {
    for (const provider of store.keys()) {
      if (validProviders.has(provider)) continue;
      store.delete(provider);
      removedProviders.add(provider);
    }
  }
  for (const provider of cache.keys()) {
    if (validProviders.has(provider)) continue;
    deleteCachedProvider(provider);
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
