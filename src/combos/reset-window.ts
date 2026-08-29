import type { ProviderQuota } from "../providers/quota";

function collectResetCandidates(quota: ProviderQuota): number[] {
  const candidates: number[] = [];
  const push = (value: number | undefined): void => {
    if (value !== undefined && Number.isFinite(value)) candidates.push(value);
  };
  push(quota.fiveHourResetAt);
  push(quota.weeklyResetAt);
  push(quota.monthlyResetAt);
  if (quota.customWindows) {
    for (const w of quota.customWindows) {
      push(w.resetAt);
    }
  }
  return candidates;
}

/**
 * Earliest future reset timestamp from a cached provider quota snapshot,
 * or null when no fresh quota data exists or all resets have elapsed.
 */
export function earliestQuotaResetAt(
  quota: ProviderQuota | null,
  now: number,
): number | null {
  if (!quota) return null;
  const future = collectResetCandidates(quota).filter(ts => ts > now);
  if (future.length > 0) return Math.min(...future);
  return null;
}

/**
 * Milliseconds until the soonest known quota-window reset.
 * Returns Infinity when no quota data exists, quota is stale, or all known
 * reset timestamps have elapsed. An elapsed reset is stale evidence — it
 * does not prove the next request has fresh capacity.
 */
export function quotaResetRemainingMs(
  quota: ProviderQuota | null,
  now: number,
): number {
  const nearest = earliestQuotaResetAt(quota, now);
  if (nearest === null) return Number.POSITIVE_INFINITY;
  return nearest - now;
}
