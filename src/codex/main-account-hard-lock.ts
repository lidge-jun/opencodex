import type { OcxConfig } from "../types";
import { getMainPolicyQuota } from "./quota";
import { MAIN_ACCOUNT_HARD_LOCK_PERCENT } from "./quota-types";

export { MAIN_ACCOUNT_HARD_LOCK_PERCENT };

export interface MainAccountHardLockStatus {
  enabled: boolean;
  state: "off" | "unknown" | "ready" | "blocked";
  /** Unix milliseconds; absent when a blocking observation has no future reset. */
  resetAt?: number;
}

type PolicyConfig = Pick<OcxConfig, "codexMainAccountHardLock">;

/**
 * Whether the main-account hard lock applies to this config (#5694).
 *
 * Absent key or `true` means on; only the persisted `false` opt-out turns it off. The
 * `undefined` branch is the trap this resolver cannot close on its own: no config object is
 * "the caller supplied no policy", not "the operator opted out", so a call site holding an
 * optional config must test for one before asking. Sites that hold a config always (a loaded
 * config, a resolved policy) call this directly.
 */
export function isMainAccountHardLockEnabled(config: PolicyConfig | undefined): boolean {
  return config?.codexMainAccountHardLock !== false;
}

function resetTimestamp(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return value < 10_000_000_000 ? value * 1000 : value;
}

type WindowReading = { percent: number | undefined; resetAt: number | undefined };

/**
 * The windows that govern the lock. The 5h and weekly windows each govern on their own, so either
 * one at 98% blocks even while the other has headroom. Monthly governs only a monthly-only account:
 * supplementary monthly data on a 5h/weekly account never becomes a lock. The list is never empty,
 * so a record with no readings at all classifies as unknown rather than vacuously ready.
 */
function governingWindows(quota: NonNullable<ReturnType<typeof getMainPolicyQuota>>): WindowReading[] {
  const hasShort = quota.shortPercent !== undefined || quota.shortResetAt !== undefined
    || quota.shortWindowSeconds !== undefined;
  const hasWeekly = quota.weeklyPercent !== undefined || quota.weeklyResetAt !== undefined;
  const windows: WindowReading[] = [];
  if (hasShort) windows.push({ percent: quota.shortPercent, resetAt: quota.shortResetAt });
  if (hasWeekly) windows.push({ percent: quota.weeklyPercent, resetAt: quota.weeklyResetAt });
  if (windows.length === 0) windows.push({ percent: quota.monthlyPercent, resetAt: quota.monthlyResetAt });
  return windows;
}

function validPercent(percent: number | undefined): percent is number {
  // The routing score's unknown sentinel is 101. It is never a raw quota observation.
  return typeof percent === "number" && Number.isFinite(percent) && percent >= 0 && percent <= 100;
}

/** Observed admission policy, not a reservation of the account's remaining quota. */
export function getMainAccountHardLockStatus(
  config: PolicyConfig,
  now = Date.now(),
): MainAccountHardLockStatus {
  if (!isMainAccountHardLockEnabled(config)) return { enabled: false, state: "off" };
  const quota = getMainPolicyQuota();
  if (!quota) return { enabled: true, state: "unknown" };
  const windows = governingWindows(quota);
  const blocking = windows.filter(w => validPercent(w.percent) && w.percent >= MAIN_ACCOUNT_HARD_LOCK_PERCENT);
  if (blocking.length > 0) {
    // The lock holds until every blocking window reads lower, so the earliest possible unlock is
    // the latest blocking reset. One blocking window without a future reset makes it unknowable.
    // A predicted reset is not evidence of recovery either way: only a fresh lower reading releases.
    const resets = blocking.map(w => resetTimestamp(w.resetAt));
    const resetAt = resets.every(r => r !== undefined && r > now) ? Math.max(...(resets as number[])) : undefined;
    return { enabled: true, state: "blocked", ...(resetAt !== undefined ? { resetAt } : {}) };
  }
  // Unknown admits, so an unreadable window never hides a blocking one and never blocks alone.
  if (windows.some(w => !validPercent(w.percent))) return { enabled: true, state: "unknown" };
  return { enabled: true, state: "ready" };
}

export function isMainAccountHardLocked(config: PolicyConfig, now = Date.now()): boolean {
  return getMainAccountHardLockStatus(config, now).state === "blocked";
}
