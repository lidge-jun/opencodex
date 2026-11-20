/** The shared weekly and five-hour readings used for reset-near-weighted placement. */
export interface ResetNearQuota {
  weeklyPercent?: number;
  weeklyResetAt?: number;
  weeklyObservedAt?: number;
  fiveHourPercent?: number;
  fiveHourResetAt?: number;
  fiveHourObservedAt?: number;
}

// Use the last day of the weekly cycle to favor quota that would otherwise go unused.
const WEEKLY_RESET_WINDOW_MS = 24 * 60 * 60_000;
// Keep burst capacity available for sessions already assigned to the account.
const FIVE_HOUR_USAGE_LIMIT_PERCENT = 60;
// Avoid steering new sessions into an account with almost no weekly capacity left.
const MIN_WEEKLY_REMAINING_PERCENT = 2;
// Refresh both usage readings within a quarter-hour before giving the account extra traffic.
const MAX_QUOTA_AGE_MS = 15 * 60_000;

function asMs(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value < 100_000_000_000 ? value * 1000 : value;
}

function isFresh(at: number | undefined, now: number): boolean {
  const ms = asMs(at);
  return ms !== null && ms <= now && now - ms <= MAX_QUOTA_AGE_MS;
}

function below(value: number | undefined, limit: number): boolean {
  return typeof value === "number" && value >= 0 && value < limit;
}

/** Call with the pool's eligible IDs, in rotation order. Undefined means equal weights. */
export function resetNearWeightOf(
  accountIds: readonly string[],
  quotaOf: (accountId: string) => ResetNearQuota | null,
  now: number,
): ((accountId: string) => number) | undefined {
  if (accountIds.length < 2) return undefined;
  let target: string | undefined;
  let earliest = Infinity;
  for (const id of accountIds) {
    const quota = quotaOf(id);
    if (!quota || !isFresh(quota.weeklyObservedAt, now) || !isFresh(quota.fiveHourObservedAt, now)
      || !below(quota.fiveHourPercent, FIVE_HOUR_USAGE_LIMIT_PERCENT)
      || !below(quota.weeklyPercent, 100 - MIN_WEEKLY_REMAINING_PERCENT)) continue;
    const reset = asMs(quota.weeklyResetAt);
    if (reset === null || reset <= now || reset - now > WEEKLY_RESET_WINDOW_MS) continue;
    const shortReset = asMs(quota.fiveHourResetAt);
    if (quota.fiveHourResetAt !== undefined && (shortReset === null || shortReset <= now)) continue;
    if (target === undefined || reset < earliest || (reset === earliest && id.localeCompare(target) < 0)) {
      target = id;
      earliest = reset;
    }
  }
  return target === undefined ? undefined : id => id === target ? accountIds.length - 1 : 1;
}
