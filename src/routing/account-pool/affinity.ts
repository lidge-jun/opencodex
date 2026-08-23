import { createHash } from "node:crypto";
import { retainedUtf8Bytes } from "../../lib/admission";

export const AFFINITY_IDLE_TTL_MS = 24 * 60 * 60_000;
export const MAX_AFFINITY_ENTRIES = 2_000;
export const MAX_AFFINITY_COMPONENT_BYTES = 512;

interface AffinityEntry {
  accountId: string;
  lastUsedAt: number;
}

const affinityByPool = new Map<string, Map<string, AffinityEntry>>();

export function normalizeAffinityComponent(value: string | null | undefined): string {
  const normalized = value?.trim() ?? "";
  return normalized && retainedUtf8Bytes(normalized) <= MAX_AFFINITY_COMPONENT_BYTES ? normalized : "";
}

/**
 * Build a sticky session key from request headers.
 * Prefer true session/thread ids; ignore Desktop shared cache-cohort prompt_cache_key.
 */
export function buildSessionKeyFromParts(input: {
  sessionIdHeader?: string | null;
  threadIdHeader?: string | null;
  clientThreadId?: string | null;
  promptCacheKey?: string | null;
  promptCacheKeyIsSharedCohort?: boolean;
}): string | null {
  const preferred = (
    input.clientThreadId
    ?? input.sessionIdHeader
    ?? input.threadIdHeader
    ?? ""
  ).trim();
  if (preferred) {
    return preferred.length <= 128 ? preferred : createHash("sha256").update(preferred).digest("hex");
  }
  if (input.promptCacheKeyIsSharedCohort) return null;
  const cacheKey = input.promptCacheKey?.trim() ?? "";
  if (!cacheKey) return null;
  return cacheKey.length <= 128 ? cacheKey : createHash("sha256").update(cacheKey).digest("hex");
}

function getPoolMap(poolKey: string): Map<string, AffinityEntry> {
  let map = affinityByPool.get(poolKey);
  if (!map) {
    map = new Map();
    affinityByPool.set(poolKey, map);
  }
  return map;
}

function pruneExpiredAffinity(poolKey: string, now: number): void {
  const map = affinityByPool.get(poolKey);
  if (!map) return;
  for (const [key, entry] of map) {
    if (now - entry.lastUsedAt > AFFINITY_IDLE_TTL_MS) map.delete(key);
  }
  if (map.size <= MAX_AFFINITY_ENTRIES) return;
  const sorted = [...map.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
  const drop = map.size - MAX_AFFINITY_ENTRIES;
  for (let i = 0; i < drop; i++) map.delete(sorted[i]![0]);
}

export function getSessionAffinity(
  poolKey: string,
  sessionKey: string | null | undefined,
  now: number,
): AffinityEntry | null {
  pruneExpiredAffinity(poolKey, now);
  const key = normalizeAffinityComponent(sessionKey);
  if (!key) return null;
  const entry = getPoolMap(poolKey).get(key);
  if (!entry) return null;
  if (now - entry.lastUsedAt > AFFINITY_IDLE_TTL_MS) {
    getPoolMap(poolKey).delete(key);
    return null;
  }
  return entry;
}

export function bindSessionAffinity(
  poolKey: string,
  sessionKey: string | null | undefined,
  accountId: string,
  now: number,
): void {
  const key = normalizeAffinityComponent(sessionKey);
  if (!key || !normalizeAffinityComponent(accountId)) return;
  getPoolMap(poolKey).set(key, { accountId, lastUsedAt: now });
  pruneExpiredAffinity(poolKey, now);
}

export function touchSessionAffinity(
  poolKey: string,
  sessionKey: string | null | undefined,
  now: number,
): void {
  const key = normalizeAffinityComponent(sessionKey);
  if (!key) return;
  const entry = getPoolMap(poolKey).get(key);
  if (entry) entry.lastUsedAt = now;
}

export function clearSessionAffinityForAccount(poolKey: string, accountId: string): void {
  const map = affinityByPool.get(poolKey);
  if (!map) return;
  for (const [key, entry] of map) {
    if (entry.accountId === accountId) map.delete(key);
  }
}

export function clearAffinityState(poolKey?: string): void {
  if (poolKey === undefined) {
    affinityByPool.clear();
    return;
  }
  affinityByPool.delete(poolKey);
}

export function affinitySizeForTests(poolKey: string): number {
  return affinityByPool.get(poolKey)?.size ?? 0;
}
