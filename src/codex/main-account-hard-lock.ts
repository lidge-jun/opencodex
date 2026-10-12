import type { OcxConfig } from "../types";
import { getMainPolicyQuota } from "./quota";
import { MAIN_ACCOUNT_HARD_LOCK_PERCENT, MAIN_ACCOUNT_HARD_LOCK_SHORT_PERCENT, MAIN_ACCOUNT_HARD_LOCK_MIN_PERCENT } from "./quota-types";

export { MAIN_ACCOUNT_HARD_LOCK_PERCENT };

export interface MainAccountHardLockStatus {
  enabled: boolean;
  state: "off" | "unknown" | "ready" | "blocked";
  /** Unix milliseconds; absent when a blocking observation has no future reset. */
  resetAt?: number;
  thresholds: { short: number; long: number };
  window?: "short" | "long";
}

type PolicyConfig = Pick<OcxConfig, "codexMainAccountHardLock" | "codexMainAccountHardLockThresholds">;

export function resolveMainAccountHardLockThresholds(config: PolicyConfig | undefined): { short: number; long: number } {
  const valid = (value: unknown, fallback: number): number => typeof value === "number"
    && Number.isInteger(value) && value >= MAIN_ACCOUNT_HARD_LOCK_MIN_PERCENT && value <= 100 ? value : fallback;
  const long = valid(config?.codexMainAccountHardLockThresholds?.long, MAIN_ACCOUNT_HARD_LOCK_PERCENT);
  const short = valid(config?.codexMainAccountHardLockThresholds?.short, MAIN_ACCOUNT_HARD_LOCK_SHORT_PERCENT);
  return { short: Math.min(short, long), long };
}

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

type WindowReading = { kind: "short" | "long"; percent: number | undefined; resetAt: number | undefined };

/**
 * The windows that govern the lock. The 5h and weekly windows each govern on their own, so either
 * one at its configured threshold blocks even while the other has headroom. Monthly governs only a monthly-only account:
 * supplementary monthly data on a 5h/weekly account never becomes a lock. The list is never empty,
 * so a record with no readings at all classifies as unknown rather than vacuously ready.
 */
function governingWindows(quota: NonNullable<ReturnType<typeof getMainPolicyQuota>>): WindowReading[] {
  const hasShort = quota.shortPercent !== undefined || quota.shortResetAt !== undefined
    || quota.shortWindowSeconds !== undefined;
  const hasWeekly = quota.weeklyPercent !== undefined || quota.weeklyResetAt !== undefined;
  const windows: WindowReading[] = [];
  if (hasShort) windows.push({ kind: "short", percent: quota.shortPercent, resetAt: quota.shortResetAt });
  if (hasWeekly) windows.push({ kind: "long", percent: quota.weeklyPercent, resetAt: quota.weeklyResetAt });
  if (windows.length === 0) windows.push({ kind: "long", percent: quota.monthlyPercent, resetAt: quota.monthlyResetAt });
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
  const thresholds = resolveMainAccountHardLockThresholds(config);
  if (!isMainAccountHardLockEnabled(config)) return { enabled: false, state: "off", thresholds };
  const quota = getMainPolicyQuota();
  if (!quota) return { enabled: true, state: "unknown", thresholds };
  const windows = governingWindows(quota);
  const blocking = windows.filter(w => validPercent(w.percent) && w.percent >= thresholds[w.kind]);
  if (blocking.length > 0) {
    // The lock holds until every blocking window reads lower or is authoritatively absent, so the earliest possible unlock is
    // the latest blocking reset. One blocking window without a future reset makes it unknowable.
    // A predicted reset is not evidence of recovery; fresh lower usage or validated WHAM absence releases.
    const resets = blocking.map(w => resetTimestamp(w.resetAt));
    const resetAt = resets.every(r => r !== undefined && r > now) ? Math.max(...(resets as number[])) : undefined;
    return { enabled: true, state: "blocked", thresholds, window: blocking[0]!.kind, ...(resetAt !== undefined ? { resetAt } : {}) };
  }
  // Unknown admits, so an unreadable window never hides a blocking one and never blocks alone.
  if (windows.some(w => !validPercent(w.percent))) return { enabled: true, state: "unknown", thresholds };
  return { enabled: true, state: "ready", thresholds };
}

export function isMainAccountHardLocked(config: PolicyConfig, now = Date.now()): boolean {
  return getMainAccountHardLockStatus(config, now).state === "blocked";
}
