import type { OcxConfig } from "../types";
import { deleteConfigTopLevelKey } from "../config/rebase-provenance";
import { isThirtyDayOnlyCodexPlan } from "./plan";
import {
  CODEX_EXHAUSTED_USAGE_PERCENT,
  isTerminalShortWindow,
  resetAtToMs,
  type StoredAccountQuota,
} from "./quota-types";

/**
 * Whether an account may keep serving once one of its usage windows is full (#6334).
 *
 * Upstream does not refuse an account that holds ChatGPT credits at 100%: it serves the request
 * and draws the balance. Selection only takes an account off on quota after a refusal, so an
 * account with credits was never moved off. On is the default and is stored as absence, so a pool
 * that never touched the switch routes exactly as before. Pool accounts and the `__main__` login
 * both carry the switch; the main login is also checked where the main-account hard lock is.
 */
export function codexAccountUsesCreditsAfterLimit(
  config: Pick<OcxConfig, "noCreditCodexAccountIds">,
  accountId: string,
): boolean {
  return !(config.noCreditCodexAccountIds?.includes(accountId) ?? false);
}

/** Persist the switch for one account. Only the accounts that turned it off are stored. */
export function setCodexAccountCreditsAfterLimit(config: OcxConfig, accountId: string, enabled: boolean): void {
  const ids = new Set(config.noCreditCodexAccountIds ?? []);
  if (enabled) ids.delete(accountId);
  else ids.add(accountId);

  if (ids.size > 0) config.noCreditCodexAccountIds = [...ids];
  else deleteConfigTopLevelKey(config, "noCreditCodexAccountIds");
}

export function forgetCodexAccountCreditUse(config: OcxConfig, accountId: string): void {
  setCodexAccountCreditsAfterLimit(config, accountId, true);
}

/**
 * A usage window that is full right now.
 *
 * Stricter than the selection score about time, on purpose. The score keeps a 100% reading until
 * a new observation replaces it, which is safe there because an account at 100% still receives
 * traffic and that traffic brings the next observation. An account held by this switch receives
 * none, so the reading itself has to say when it ends: a long window counts only while its reset
 * is still ahead, and one without a reset is not trusted. The burst window uses the rule routing
 * and the dashboard already share.
 */
export function isCodexUsageLimitReached(quota: StoredAccountQuota | null, plan: unknown, now: number): boolean {
  return codexUsageLimitResetAt(quota, plan, now) !== undefined;
}

/**
 * When the full window ends, in milliseconds, or undefined when no window is full. With several
 * full windows the latest reset is the earliest moment the account is usable again.
 */
export function codexUsageLimitResetAt(quota: StoredAccountQuota | null, plan: unknown, now: number): number | undefined {
  if (!quota) return undefined;
  const full: number[] = [];
  if (isTerminalShortWindow(quota, now)) {
    // A reset-less burst reading counts while it is fresh, so there is no instant to report.
    full.push(typeof quota.shortResetAt === "number" && quota.shortResetAt > 0 ? resetAtToMs(quota.shortResetAt) : now);
  }
  const longWindows: Array<[number | undefined, number | undefined]> = isThirtyDayOnlyCodexPlan(plan)
    ? [[quota.monthlyPercent, quota.monthlyResetAt]]
    : [[quota.weeklyPercent, quota.weeklyResetAt], [quota.monthlyPercent, quota.monthlyResetAt]];
  for (const [percent, resetAt] of longWindows) {
    if (typeof percent !== "number" || percent < CODEX_EXHAUSTED_USAGE_PERCENT) continue;
    if (typeof resetAt !== "number" || !Number.isFinite(resetAt) || resetAt <= 0) continue;
    const resetMs = resetAtToMs(resetAt);
    if (resetMs > now) full.push(resetMs);
  }
  return full.length > 0 ? Math.max(...full) : undefined;
}

/** Whether automatic selection must skip this account so that it keeps its credits. */
export function isCodexAccountHeldForCredits(
  config: Pick<OcxConfig, "noCreditCodexAccountIds">,
  accountId: string,
  quota: StoredAccountQuota | null,
  plan: unknown,
  now: number,
): boolean {
  return !codexAccountUsesCreditsAfterLimit(config, accountId) && isCodexUsageLimitReached(quota, plan, now);
}
