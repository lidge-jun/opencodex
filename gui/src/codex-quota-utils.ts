import { CODEX_EXHAUSTED_USAGE_PERCENT, TERMINAL_SHORT_WINDOW_FRESHNESS_MS } from "../../src/codex/quota-types";

export interface AccountQuota {
  weeklyPercent?: number;
  fiveHourPercent?: number;
  /** Codex account API aliases for the same five-hour window. */
  shortPercent?: number;
  monthlyPercent?: number;
  weeklyResetAt?: number;
  fiveHourResetAt?: number;
  shortResetAt?: number;
  /** Local observation time for the short-window percentage. */
  shortObservedAt?: number;
  shortWindowSeconds?: number;
  monthlyResetAt?: number;
  customWindows?: { label: string; percent: number; resetAt?: number }[];
  creditsUsd?: {
    used: number;
    limit: number;
    remaining: number;
    percent: number;
    expiresAt?: number;
    unlimited?: boolean;
  };
  resetCredits?: number;
  updatedAt: number;
}

export function quotaAutoRefreshAvailability(quota: AccountQuota | null) {
  return {
    fiveHourAvailable: quota?.shortWindowSeconds === 5 * 60 * 60
      && typeof quota.shortResetAt === "number",
    weeklyAvailable: typeof quota?.weeklyResetAt === "number",
  };
}

export function isThirtyDayOnlyPlan(plan: string | null | undefined): boolean {
  const normalized = plan?.trim().toLowerCase();
  return normalized === "go" || normalized === "free";
}

export function normalizeQuotaForPlan(quota: AccountQuota | null, plan: string | null | undefined): AccountQuota | null {
  if (!quota) return null;
  const normalized = quota.shortPercent === undefined && quota.shortResetAt === undefined
    ? quota
    : {
        ...quota,
        fiveHourPercent: quota.fiveHourPercent ?? quota.shortPercent,
        fiveHourResetAt: quota.fiveHourResetAt ?? quota.shortResetAt,
      };
  if (!isThirtyDayOnlyPlan(plan)) return normalized;
  return {
    ...(normalized.monthlyPercent !== undefined ? { monthlyPercent: normalized.monthlyPercent } : {}),
    ...(normalized.monthlyResetAt !== undefined ? { monthlyResetAt: normalized.monthlyResetAt } : {}),
    ...(normalized.creditsUsd !== undefined ? { creditsUsd: normalized.creditsUsd } : {}),
    ...(normalized.resetCredits !== undefined ? { resetCredits: normalized.resetCredits } : {}),
    updatedAt: normalized.updatedAt,
  };
}

/**
 * Compute the governing Codex usage score matching the server's auto-switch threshold evaluation.
 *
 * Evaluates governing quota windows based on the account's plan:
 * - For 30-day only plans (e.g. Free/Go), only the monthly window governs.
 * - For standard plans, weekly and monthly windows govern.
 * - A known five-hour / short window refines a known governing long-window score.
 * - If no long window has been observed, an active terminal short burst (at 100%) acts as exhausted (100).
 * - Unknown or unprimed quota returns `null` so callers do not spuriously trigger threshold actions.
 */
export function computeCodexUsageScore(
  quota: AccountQuota | null | undefined,
  plan?: string | null,
  now: number = Date.now(),
): number | null {
  if (!quota) return null;
  const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
  const shortPercent = finite(quota.fiveHourPercent)
    ? quota.fiveHourPercent
    : (finite(quota.shortPercent) ? quota.shortPercent : undefined);
  const longWindows = isThirtyDayOnlyPlan(plan)
    ? [quota.monthlyPercent]
    : [quota.weeklyPercent, quota.monthlyPercent];
  const knownLong = longWindows.filter(finite);
  if (knownLong.length === 0) {
    const shortReset = quota.fiveHourResetAt ?? quota.shortResetAt;
    const shortObservationAge = typeof quota.shortObservedAt === "number"
      ? now - quota.shortObservedAt
      : undefined;
    const isExhausted = finite(shortPercent) && shortPercent >= CODEX_EXHAUSTED_USAGE_PERCENT && (
      (typeof shortReset === "number" && shortReset > now) ||
      (typeof shortObservationAge === "number"
        && shortObservationAge >= 0
        && shortObservationAge <= TERMINAL_SHORT_WINDOW_FRESHNESS_MS)
    );
    return isExhausted ? 100 : null;
  }
  const values = finite(shortPercent) ? [...knownLong, shortPercent] : knownLong;
  return values.length ? Math.max(...values) : null;
}
