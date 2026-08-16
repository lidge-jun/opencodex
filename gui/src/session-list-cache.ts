/**
 * SessionStorage helpers for non-secret GUI list/summary shapes (SWR seeds).
 * Never store API keys, tokens, or credentials here — XSS can read sessionStorage.
 */

/** Envelope marker: distinguishes a timestamped entry from a legacy raw value. */
const CACHED_AT_KEY = "__ocxCachedAt";

export type SessionListEntry<T> = {
  data: T;
  /** null when the cache predates timestamping — treated as unknown age (stale). */
  cachedAt: number | null;
};

export function readSessionListCache<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    // Transparent to callers that do not care about age.
    if (isEntryEnvelope(parsed)) return parsed.data as T;
    return parsed as T;
  } catch {
    return null;
  }
}

function isEntryEnvelope(value: unknown): value is { [CACHED_AT_KEY]: number; data: unknown } {
  return typeof value === "object"
    && value !== null
    && typeof (value as Record<string, unknown>)[CACHED_AT_KEY] === "number"
    && "data" in value;
}

/**
 * Read a seed with its age. A legacy (untimestamped) value reads as `cachedAt: null`,
 * which every caller treats as stale — so an existing cache self-heals on first use
 * instead of pinning old data.
 */
export function readSessionListCacheEntry<T>(key: string): SessionListEntry<T> | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (isEntryEnvelope(parsed)) {
      return { data: parsed.data as T, cachedAt: parsed[CACHED_AT_KEY] };
    }
    return { data: parsed as T, cachedAt: null };
  } catch {
    return null;
  }
}

/** Write a seed with its write time so a revisit can decide whether to revalidate. */
export function writeSessionListCacheEntry<T>(key: string, data: T): void {
  try {
    sessionStorage.setItem(key, JSON.stringify({ [CACHED_AT_KEY]: Date.now(), data }));
  } catch {
    /* private mode / quota */
  }
}

export function writeSessionListCache(key: string, value: unknown): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota */
  }
}

export function clearSessionListCache(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
