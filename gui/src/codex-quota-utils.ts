import { isTerminalShortWindow } from "../../src/codex/quota-types";

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
    // The same decision the router makes, made by the same function rather than by a second
    // copy of the rule. The copy that used to live here differed twice: it compared a stored
    // reset against `now` without normalizing seconds to milliseconds, so a seconds-form
    // future reset read as expired; and it accepted a fresh observation even when an ELAPSED
    // reset was present, where routing treats a reset as authoritative once it exists. Either
    // difference reports an account the router will refuse as usable (#5045).
    //
    // The alias collapse happens here because it is a wire concern of this DTO: the account
    // API spells the same burst window `fiveHour*` and the stored snapshot spells it `short*`.
    return isTerminalShortWindow({
      ...(finite(shortPercent) ? { shortPercent } : {}),
      ...(finite(quota.fiveHourResetAt ?? quota.shortResetAt)
        ? { shortResetAt: quota.fiveHourResetAt ?? quota.shortResetAt }
        : {}),
      ...(finite(quota.shortObservedAt) ? { shortObservedAt: quota.shortObservedAt } : {}),
    }, now)
      ? 100
      : null;
  }
  const values = finite(shortPercent) ? [...knownLong, shortPercent] : knownLong;
  return values.length ? Math.max(...values) : null;
}
