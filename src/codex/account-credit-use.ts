import type { OcxConfig } from "../types";
import { deleteConfigTopLevelKey } from "../config/rebase-provenance";
import { isThirtyDayOnlyCodexPlan } from "./plan";
import {
  CODEX_EXHAUSTED_USAGE_PERCENT,
  TERMINAL_SHORT_WINDOW_FRESHNESS_MS,
  isTerminalShortWindow,
  hasSpendableCodexCredits,
  resetAtToMs,
  type StoredAccountQuota,
} from "./quota-types";

/**
 * Whether an account may keep serving once one of its usage windows is full (#6334).
 *
 * Upstream does not refuse an account that holds ChatGPT credits at 100%: it serves the request
 * and draws the balance. Selection only takes an account off on quota after a refusal, so an
 * account with credits was never moved off. Spending is opt-in: only the ids in
 * `creditCodexAccountIds` may keep serving from fresh spendable credits, and every other account leaves rotation
 * at 100% and comes back after its reset. Pool accounts and the `__main__` login both carry the
 * switch; the main login is also checked where the main-account hard lock is.
 */
export function codexAccountUsesCreditsAfterLimit(
  config: Pick<OcxConfig, "creditCodexAccountIds">,
  accountId: string,
): boolean {
  return config.creditCodexAccountIds?.includes(accountId) ?? false;
}

/** Persist the switch for one account. Only the accounts allowed to spend credits are stored. */
export function setCodexAccountCreditsAfterLimit(config: OcxConfig, accountId: string, enabled: boolean): void {
  const ids = new Set(config.creditCodexAccountIds ?? []);
  if (enabled) ids.add(accountId);
  else ids.delete(accountId);
  writeCreditAccountIds(config, ids);
}

/**
 * The dashboard's global switch. On allows every account the caller passes, which is every
 * current account; off clears the list, so a later account still starts with spending off.
 */
export function setAllCodexAccountsCreditsAfterLimit(config: OcxConfig, accountIds: readonly string[], enabled: boolean): void {
  writeCreditAccountIds(config, new Set(enabled ? accountIds : []));
}

function writeCreditAccountIds(config: OcxConfig, ids: ReadonlySet<string>): void {
  if (ids.size > 0) config.creditCodexAccountIds = [...ids];
  else deleteConfigTopLevelKey(config, "creditCodexAccountIds");
}

export function forgetCodexAccountCreditUse(config: OcxConfig, accountId: string): void {
  setCodexAccountCreditsAfterLimit(config, accountId, false);
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
    // A reset-less burst reading holds until its observation goes stale: the freshness horizon
    // is the deadline a retried request still meets, so report it rather than `now` (which
    // collapsed the refusal's Retry-After to 1s against an account blocked for minutes).
    // `isTerminalShortWindow` guarantees `shortObservedAt` is finite on this branch.
    full.push(typeof quota.shortResetAt === "number" && quota.shortResetAt > 0
      ? resetAtToMs(quota.shortResetAt)
      : (quota.shortObservedAt ?? now) + TERMINAL_SHORT_WINDOW_FRESHNESS_MS);
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
  config: Pick<OcxConfig, "creditCodexAccountIds">,
  accountId: string,
  quota: StoredAccountQuota | null,
  plan: unknown,
  now: number,
): boolean {
  return !(codexAccountUsesCreditsAfterLimit(config, accountId) && hasSpendableCodexCredits(quota, now))
    && isCodexUsageLimitReached(quota, plan, now);
}
