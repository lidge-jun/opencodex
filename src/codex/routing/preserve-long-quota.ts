import { resetAtToMs, type StoredAccountQuota } from "../quota-types";

// Partial responses must not extend short-only evidence indefinitely.
const SHORT_ONLY_EVIDENCE_TTL_MS = 6 * 60 * 60_000;

function futureReset(reset: number | undefined, now: number): number {
  if (typeof reset !== "number" || !Number.isFinite(reset) || reset <= 0) return Infinity;
  const millis = resetAtToMs(reset);
  return millis > now ? millis : Infinity;
}

function longestWindow(quota: StoredAccountQuota | null, now: number): { tier: number; reset: number } {
  if (!quota) return { tier: 3, reset: Infinity };
  if (quota.monthlyPercent !== undefined || quota.monthlyResetAt !== undefined) {
    return { tier: 2, reset: futureReset(quota.monthlyResetAt, now) };
  }
  if (quota.weeklyPercent !== undefined || quota.weeklyResetAt !== undefined) {
    return { tier: 1, reset: futureReset(quota.weeklyResetAt, now) };
  }
  const observed = quota.shortOnlyObservedAt;
  if (!quota.customWindows?.length && typeof observed === "number" && Number.isFinite(observed)
    && observed <= now && now - observed <= SHORT_ONLY_EVIDENCE_TTL_MS
    && (quota.shortPercent !== undefined || quota.shortWindowSeconds !== undefined)) {
    return { tier: 0, reset: futureReset(quota.shortResetAt, now) };
  }
  return { tier: 3, reset: Infinity };
}

/** Only a proven short-only account can use short usage as its governing threshold. */
export function preserveLongQuotaShortUsage(quota: StoredAccountQuota | null, now: number): number | undefined {
  if (longestWindow(quota, now).tier !== 0 || !quota || typeof quota.shortPercent !== "number"
    || !Number.isFinite(quota.shortPercent) || quota.shortPercent < 0 || quota.shortPercent > 100
    || !Number.isFinite(futureReset(quota.shortResetAt, now))) return undefined;
  return quota.shortPercent;
}

/** Return a stable shortlist; leave the final usage tie-break to the shared picker. */
export function preserveLongQuotaCandidates(
  ids: readonly string[], quotaFor: (id: string) => StoredAccountQuota | null, now: number,
): string[] {
  const ranked = ids.map(id => ({ id, ...longestWindow(quotaFor(id), now) }));
  const tier = Math.min(...ranked.map(row => row.tier));
  const sameTier = ranked.filter(row => row.tier === tier);
  const reset = Math.min(...sameTier.map(row => row.reset));
  let candidates = sameTier.filter(row => row.reset === reset).map(row => row.id);
  // Comparing short resets only when both exist is nontransitive across three accounts.
  const shorts = candidates.map(id => futureReset(quotaFor(id)?.shortResetAt, now));
  if (shorts.every(Number.isFinite)) {
    const shortReset = Math.min(...shorts);
    candidates = candidates.filter((_, index) => shorts[index] === shortReset);
  }
  return candidates;
}
