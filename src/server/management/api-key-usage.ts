import {
  currentUsageLogRevision,
  readUsageSnapshotForManagement,
  usageLogIdentityKey,
  type PersistedUsageEntry,
} from "../../usage/log";

/**
 * Per-key usage as the API tab renders it.
 *
 * A discriminated union rather than numbers with a flag beside them: when two
 * config entries share an id there IS no per-key total, and an optional marker
 * next to `requests7d: 7` invites a consumer to render the 7 anyway.
 */
export type ApiKeyUsage =
  | { ambiguous: true }
  | { ambiguous?: false; requests7d: number; totalRequests: number; lastUsedAt?: string };

export interface ApiKeyUsageSnapshot {
  rollup: Map<string, ApiKeyUsage>;
  historyTruncated?: true;
  /**
   * Earliest row carrying a recognized `admissionKind`. A property of the DATA
   * SET, not of a key, so it is singular and lives beside the map: it is what
   * lets the GUI tell "this key was used zero times" from "nothing is
   * attributable yet". Keyed on the kind rather than on `apiKeyId`, because an
   * environment or loopback row is attributed traffic with no configured key.
   */
  attributionSince?: string;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A timestamp we can actually do date arithmetic with.
 *
 * `usage.jsonl` is hand-editable and JSON permits numbers outside the Date
 * range: `1e309` survives normalization and then throws `RangeError` from
 * `toISOString()`. Since the caller catches to protect key management, one bad
 * row would have zeroed the rollup for EVERY key — active keys reported as
 * unused is exactly the wrong answer to hand someone deciding what to delete.
 */
function usableTimestamp(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Number.isNaN(new Date(value).getTime()) ? null : value;
}

/**
 * Pure: one pass over an already-read snapshot, so it is unit-testable without
 * touching the filesystem.
 *
 * Rows are bucketed only when `admissionKind === "configured"`. Keying on
 * `apiKeyId` alone would let a hand-edited entry whose id is `loopback` absorb
 * traffic it never admitted.
 */
export function rollupApiKeyUsage(
  entries: PersistedUsageEntry[],
  configuredIds: string[],
  now: number = Date.now(),
): ApiKeyUsageSnapshot {
  const duplicated = new Set<string>();
  const seen = new Set<string>();
  for (const id of configuredIds) {
    if (seen.has(id)) duplicated.add(id);
    seen.add(id);
  }

  const totals = new Map<string, { requests7d: number; totalRequests: number; lastUsedAt?: string }>();
  let attributionSince: number | undefined;
  const cutoff = now - SEVEN_DAYS_MS;

  for (const entry of entries) {
    if (!entry.admissionKind) continue;
    const timestamp = usableTimestamp(entry.timestamp);
    if (timestamp !== null && (attributionSince === undefined || timestamp < attributionSince)) {
      attributionSince = timestamp;
    }
    if (entry.admissionKind !== "configured" || !entry.apiKeyId) continue;

    const bucket = totals.get(entry.apiKeyId) ?? { requests7d: 0, totalRequests: 0 };
    // The request happened even if its clock reading is unusable, so it still
    // counts toward the total; only the time-based fields are skipped.
    bucket.totalRequests += 1;
    if (timestamp !== null) {
      if (timestamp >= cutoff) bucket.requests7d += 1;
      const iso = new Date(timestamp).toISOString();
      if (!bucket.lastUsedAt || iso > bucket.lastUsedAt) bucket.lastUsedAt = iso;
    }
    totals.set(entry.apiKeyId, bucket);
  }

  const rollup = new Map<string, ApiKeyUsage>();
  for (const id of configuredIds) {
    if (duplicated.has(id)) {
      rollup.set(id, { ambiguous: true });
      continue;
    }
    rollup.set(id, totals.get(id) ?? { requests7d: 0, totalRequests: 0 });
  }
  return {
    rollup,
    ...(attributionSince !== undefined ? { attributionSince: new Date(attributionSince).toISOString() } : {}),
  };
}

/**
 * Rollup cache keyed by the exact usage-log revision, mirroring the /api/usage
 * summary cache. Without it, every key-list read reparses an append-only log
 * that only ever grows — and the GUI fetches this route on mount and after every
 * create/rename/delete. The compact rollup is a handful of counters per key, so
 * caching it costs nothing; a new row changes the revision and invalidates it.
 */
let rollupCache: { revisionKey: string; expiresAt: number; lastSeenSize?: number; snapshot: ApiKeyUsageSnapshot } | null = null;

/**
 * The rollup is a function of the log AND of the clock: a request ages out of
 * the seven-day window with no write to bump the file revision, so a purely
 * revision-keyed entry would report a stale `requests7d` indefinitely.
 *
 * A minute is the whole rule. Deriving the exact next-transition instant would
 * mean tracking the OLDEST counted request per key, which the compact rollup
 * deliberately does not keep — and a count that can be at most 60s stale is
 * already far tighter than the window it describes.
 */
const ROLLUP_CACHE_TTL_MS = 60_000;

/** Test seam: the cache is module state and would otherwise leak between cases. */
export function clearApiKeyUsageCacheForTests(): void {
  rollupCache = null;
}

/**
 * Reads the durable usage snapshot the way /api/usage does, then rolls it up.
 *
 * Never throws: an unreadable snapshot yields empty rollups and no
 * `attributionSince`. Key management working matters more than usage numbers
 * being present, and the GUI already treats an absent field as "no data".
 */
export function cacheApiKeyUsageFromSnapshot(
  entries: PersistedUsageEntry[],
  configuredIds: string[],
  identityKey: string,
  lastSeenSize: number,
  truncated: boolean,
  maxReadBytes: number | undefined,
  now: number = Date.now(),
): ApiKeyUsageSnapshot {
  const idsKey = JSON.stringify([configuredIds, maxReadBytes]);
  const rolled = {
    ...rollupApiKeyUsage(entries, configuredIds, now),
    ...(truncated ? { historyTruncated: true as const } : {}),
  };
  rollupCache = {
    revisionKey: `${identityKey}|${idsKey}`,
    expiresAt: now + ROLLUP_CACHE_TTL_MS,
    lastSeenSize,
    snapshot: rolled,
  };
  return rolled;
}

export async function readApiKeyUsageRollup(configuredIds: string[], maxReadBytes?: number): Promise<ApiKeyUsageSnapshot> {
  // JSON rather than a joined string: ids are only validated as non-empty
  // strings, so `["a\0b","c"]` and `["a","b\0c"]` join to the same value and one
  // config could be served the other's cached rollup.
  const idsKey = JSON.stringify([configuredIds, maxReadBytes]);
  const now = Date.now();
  try {
    const observed = currentUsageLogRevision();
    const observedKey = `${usageLogIdentityKey(observed)}|${idsKey}`;
    const observedSize = observed?.size ?? 0;
    if (rollupCache?.revisionKey === observedKey && now < rollupCache.expiresAt && observedSize >= (rollupCache.lastSeenSize ?? 0)) {
      return rollupCache.snapshot;
    }

    const snapshot = await readUsageSnapshotForManagement(maxReadBytes);
    const rolled = {
      ...rollupApiKeyUsage(snapshot.entries, configuredIds, now),
      ...(snapshot.truncatedPrefixBytes > 0 || snapshot.entriesTruncated ? { historyTruncated: true as const } : {}),
    };
    rollupCache = {
      revisionKey: `${usageLogIdentityKey(snapshot.revision)}|${idsKey}`,
      expiresAt: now + ROLLUP_CACHE_TTL_MS,
      lastSeenSize: snapshot.revision?.size ?? 0,
      snapshot: rolled,
    };
    return rolled;
  } catch {
    const rollup = new Map<string, ApiKeyUsage>();
    for (const id of configuredIds) rollup.set(id, { requests7d: 0, totalRequests: 0 });
    return { rollup };
  }
}
