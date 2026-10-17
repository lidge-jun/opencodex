import { isThirtyDayOnlyCodexPlan } from "./plan";
import type { StoredAccountQuota } from "./quota-types";

type Window = "weeklyPercent" | "monthlyPercent" | "shortPercent";
// Request policy needs observations, not a recent cache write. Keep this evidence
// process-local: hydrated display bars do not prove a fresh observation in this process.
const observed = new WeakMap<StoredAccountQuota, Partial<Record<Window, number>>>();
const windows: Window[] = ["weeklyPercent", "monthlyPercent", "shortPercent"];
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function stampCodexQuotaUsageObservation(
  next: StoredAccountQuota,
  incoming: Pick<StoredAccountQuota, Window>,
  existing?: StoredAccountQuota,
): StoredAccountQuota {
  const previous = existing && observed.get(existing);
  const timestamps: Partial<Record<Window, number>> = {};
  for (const window of windows) {
    if (!finite(next[window])) continue;
    if (finite(incoming[window])) timestamps[window] = next.updatedAt;
    else if (previous?.[window] !== undefined) timestamps[window] = previous[window];
  }
  observed.set(next, timestamps);
  return next;
}

/** Per-window measurement clock; carried or hydrated values cannot acquire a new observation. */
export function codexQuotaUsageObservedAt(quota: StoredAccountQuota, window: Window): number | undefined {
  return observed.get(quota)?.[window];
}

export function codexQuotaHasFreshUsage(quota: StoredAccountQuota, plan: unknown, now: number, maxAgeMs: number): boolean {
  const long: Window[] = isThirtyDayOnlyCodexPlan(plan) ? ["monthlyPercent"] : ["weeklyPercent", "monthlyPercent"];
  const relevant = long.filter(window => finite(quota[window]));
  if (relevant.length === 0) return false;
  if (finite(quota.shortPercent)) relevant.push("shortPercent");
  const timestamps = observed.get(quota);
  return relevant.every(window => finite(timestamps?.[window]) && now - timestamps![window]! < maxAgeMs);
}
