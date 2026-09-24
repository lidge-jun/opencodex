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

/** Observed admission policy, not a reservation of the account's remaining quota. */
export function getMainAccountHardLockStatus(
  config: PolicyConfig,
  now = Date.now(),
): MainAccountHardLockStatus {
  if (!isMainAccountHardLockEnabled(config)) return { enabled: false, state: "off" };
  const quota = getMainPolicyQuota();
  if (!quota) return { enabled: true, state: "unknown" };
  // Account window priority is deliberate: a 5h account uses that window, even if
  // its weekly bar is higher. An unknown/expired selected window does not change the choice.
  const hasShort = quota.shortPercent !== undefined || quota.shortResetAt !== undefined
    || quota.shortWindowSeconds !== undefined;
  const hasWeekly = quota.weeklyPercent !== undefined || quota.weeklyResetAt !== undefined;
  const [percent, rawReset] = hasShort
    ? [quota.shortPercent, quota.shortResetAt]
    : hasWeekly ? [quota.weeklyPercent, quota.weeklyResetAt] : [quota.monthlyPercent, quota.monthlyResetAt];
  const resetAt = resetTimestamp(rawReset);
  // The routing score's unknown sentinel is 101. It is never a raw quota observation.
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) {
    return { enabled: true, state: "unknown" };
  }
  if (percent < MAIN_ACCOUNT_HARD_LOCK_PERCENT) return { enabled: true, state: "ready" };
  return {
    enabled: true,
    state: "blocked",
    // A predicted reset is not evidence of recovery. Only a fresh lower reading releases.
    ...(resetAt !== undefined && resetAt > now ? { resetAt } : {}),
  };
}

export function isMainAccountHardLocked(config: PolicyConfig, now = Date.now()): boolean {
  return getMainAccountHardLockStatus(config, now).state === "blocked";
}
