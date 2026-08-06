/**
 * Observational ledger for pre-connection upstream reachability failures,
 * keyed by (provider, host). Records ONLY — no circuit breaker, no admission
 * change (issue #914 scope). Rotation decisions stay with account health;
 * this ledger exists so a host-wide outage is visible as host-wide.
 *
 * Retention: bounded at 128 entries; on overflow the stalest entries by
 * last-touch are pruned before insert, and failure timestamps older than the
 * window are reconciled away on the next record — repeated provider/base-URL
 * churn cannot grow the map for the process lifetime.
 */

export const UPSTREAM_HOST_HEALTH_MAX_ENTRIES = 128;
export const UPSTREAM_HOST_FAILURE_WINDOW_MS = 10 * 60_000;

export type UpstreamHostHealthEntry = {
  consecutiveFailures: number;
  lastFailureAt: number;
  lastFailureCode?: string;
  /** Recency marker for stalest-first pruning (not health semantics). */
  lastTouch: number;
};

const hostHealth = new Map<string, UpstreamHostHealthEntry>();

export function upstreamHostHealthKey(provider: string, host: string): string {
  return `${provider}|${host.toLowerCase()}`;
}

function pruneForInsert(): void {
  if (hostHealth.size < UPSTREAM_HOST_HEALTH_MAX_ENTRIES) return;
  const entries = [...hostHealth.entries()].sort((a, b) => a[1].lastTouch - b[1].lastTouch);
  for (const [key] of entries) {
    if (hostHealth.size < UPSTREAM_HOST_HEALTH_MAX_ENTRIES) return;
    hostHealth.delete(key);
  }
}

export function recordUpstreamHostFailure(
  key: string,
  opts: { code?: string; now?: number } = {},
): void {
  const now = opts.now ?? Date.now();
  const prior = hostHealth.get(key);
  // Prune only for a genuinely new key: updating an existing entry must never
  // evict an unrelated one.
  if (prior === undefined) pruneForInsert();
  const stale = prior !== undefined && now - prior.lastFailureAt > UPSTREAM_HOST_FAILURE_WINDOW_MS;
  const code = typeof opts.code === "string" && opts.code !== "" ? opts.code : prior?.lastFailureCode;
  hostHealth.set(key, {
    consecutiveFailures: stale || prior === undefined ? 1 : prior.consecutiveFailures + 1,
    lastFailureAt: now,
    lastTouch: now,
    ...(code !== undefined ? { lastFailureCode: code } : {}),
  });
}

/** Any real HTTP response from the host clears its reachability streak. */
export function resetUpstreamHostHealth(key: string): void {
  hostHealth.delete(key);
}

export function getUpstreamHostHealth(key: string): UpstreamHostHealthEntry | null {
  return hostHealth.get(key) ?? null;
}

/** Test hook: clear the whole ledger. */
export function clearUpstreamHostHealth(): void {
  hostHealth.clear();
}
