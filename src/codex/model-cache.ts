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

/** Default freshness window. Matches Codex's own 5-min models cache so the two stay in step. */
export const DEFAULT_MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  models: CatalogModel[];
  fetchedAt: number;
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

/** Cooldown after a failed live `/models` fetch, so a dead/unreachable provider doesn't re-pay
 * the full fetch timeout on every catalog poll (issue #54: UI stalls behind corporate proxies). */
export const MODELS_FETCH_FAILURE_COOLDOWN_MS = 30_000;

const failureAt = new Map<string, number>();
const discoveryStatus = new Map<string, ProviderModelDiscoveryStatus>();

export function markModelsFetchFailure(provider: string, now = Date.now()): void {
  failureAt.set(provider, now);
}

export function markProviderDiscoveryOk(provider: string): void {
  discoveryStatus.set(provider, { status: "ok" });
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
}

export function getProviderDiscoveryStatus(provider: string): ProviderModelDiscoveryStatus | undefined {
  return discoveryStatus.get(provider);
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
  cache.set(provider, { models, fetchedAt: now });
}

/** Drop one provider's cache (or all) so the next resolve forces a live re-fetch. */
export function clearModelCache(provider?: string): void {
  if (provider) {
    cache.delete(provider);
    failureAt.delete(provider);
    discoveryStatus.delete(provider);
  } else {
    cache.clear();
    failureAt.clear();
    discoveryStatus.clear();
  }
}
