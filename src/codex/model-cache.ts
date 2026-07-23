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

const cache = new Map<string, CacheEntry>();

/** Cooldown after a failed live `/models` fetch, so a dead/unreachable provider doesn't re-pay
 * the full fetch timeout on every catalog poll (issue #54: UI stalls behind corporate proxies). */
export const MODELS_FETCH_FAILURE_COOLDOWN_MS = 30_000;

const failureAt = new Map<string, number>();

/**
 * Last live-discovery outcome per provider. Survives cooldown so the Models page can badge
 * HTTP 401 / network failures without re-fetching (issue #329). Cleared with the cache when
 * credentials or provider config change.
 */
export type ProviderDiscoveryKind =
  | "ok"
  | "empty"
  | "http"
  | "network"
  | "policy"
  | "malformed"
  | "skipped";

export type ProviderDiscoveryFallback = "stale" | "configured" | "none";

export interface ProviderDiscoveryStatus {
  ok: boolean;
  kind: ProviderDiscoveryKind;
  at: number;
  httpStatus?: number;
  fallback?: ProviderDiscoveryFallback;
  /** Short, secret-free diagnostic (error name or policy reason). */
  detail?: string;
}

const discoveryStatus = new Map<string, ProviderDiscoveryStatus>();

export function markModelsFetchFailure(provider: string, now = Date.now()): void {
  failureAt.set(provider, now);
}

export function clearModelsFetchFailure(provider: string): void {
  failureAt.delete(provider);
}

export function isModelsFetchCoolingDown(provider: string, cooldownMs = MODELS_FETCH_FAILURE_COOLDOWN_MS, now = Date.now()): boolean {
  const at = failureAt.get(provider);
  return at !== undefined && now - at < cooldownMs;
}

export function setModelsDiscoveryStatus(
  provider: string,
  status: Omit<ProviderDiscoveryStatus, "at"> & { at?: number },
): void {
  const next: ProviderDiscoveryStatus = {
    ok: status.ok,
    kind: status.kind,
    at: status.at ?? Date.now(),
  };
  if (typeof status.httpStatus === "number") next.httpStatus = status.httpStatus;
  if (status.fallback) next.fallback = status.fallback;
  if (status.detail) next.detail = status.detail.slice(0, 160);
  discoveryStatus.set(provider, next);
}

export function getModelsDiscoveryStatus(provider: string): ProviderDiscoveryStatus | undefined {
  return discoveryStatus.get(provider);
}

/** Public DTO for management API / GUI (stable field names). */
export function publicModelsDiscoveryStatus(provider: string): ProviderDiscoveryStatus | null {
  return getModelsDiscoveryStatus(provider) ?? null;
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
  clearModelsFetchFailure(provider);
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
