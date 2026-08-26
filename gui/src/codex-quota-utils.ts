export interface AccountQuota {
  weeklyPercent?: number;
  fiveHourPercent?: number;
  /** Codex account API aliases for the same five-hour window. */
  shortPercent?: number;
  monthlyPercent?: number;
  weeklyResetAt?: number;
  fiveHourResetAt?: number;
  shortResetAt?: number;
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
