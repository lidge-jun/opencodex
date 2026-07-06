export type StoredAccountQuota = {
  weeklyPercent?: number;
  fiveHourPercent?: number;
  monthlyPercent?: number;
  weeklyResetAt?: number;
  fiveHourResetAt?: number;
  monthlyResetAt?: number;
  resetCredits?: number;
  updatedAt: number;
};

export type WhamUsageResponse = {
  email?: string | null;
  plan_type?: string | null;
  rate_limit?: {
    primary_window?: { used_percent?: number; reset_at?: number };
    secondary_window?: { used_percent?: number; reset_at?: number };
    tertiary_window?: { used_percent?: number; reset_at?: number };
  };
  rate_limit_reset_credits?: {
    available_count: number;
  } | null;
};

const accountQuota = new Map<string, StoredAccountQuota>();

export const CODEX_UNKNOWN_USAGE_SCORE = 100;

export function normalizeUsagePercent(value: unknown): number | undefined {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : undefined;
  if (typeof numeric !== "number" || !Number.isFinite(numeric)) return undefined;
  return Math.max(0, Math.min(100, numeric));
}

function normalizeResetAt(value: unknown): number | undefined {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : undefined;
  if (typeof numeric !== "number" || !Number.isFinite(numeric) || numeric < 0) return undefined;
  return numeric;
}

function hasKnownQuotaValue(quota: Omit<StoredAccountQuota, "updatedAt">): boolean {
  return [quota.weeklyPercent, quota.fiveHourPercent, quota.monthlyPercent]
    .some(value => typeof value === "number" && Number.isFinite(value));
}

export function updateAccountQuota(
  accountId: string,
  weekly: unknown,
  fiveHour: unknown,
  weeklyResetAt?: unknown,
  fiveHourResetAt?: unknown,
  monthly?: unknown,
  monthlyResetAt?: unknown,
  resetCredits?: number,
): void {
  const existing = accountQuota.get(accountId);
  const nextWeekly = normalizeUsagePercent(weekly);
  const nextFiveHour = normalizeUsagePercent(fiveHour);
  const nextMonthly = normalizeUsagePercent(monthly);
  if (nextWeekly === undefined && nextFiveHour === undefined && nextMonthly === undefined && resetCredits === undefined) return;

  const quota: StoredAccountQuota = {
    ...(existing?.weeklyPercent !== undefined ? { weeklyPercent: existing.weeklyPercent } : {}),
    ...(existing?.fiveHourPercent !== undefined ? { fiveHourPercent: existing.fiveHourPercent } : {}),
    ...(existing?.monthlyPercent !== undefined ? { monthlyPercent: existing.monthlyPercent } : {}),
    ...(existing?.weeklyResetAt !== undefined ? { weeklyResetAt: existing.weeklyResetAt } : {}),
    ...(existing?.fiveHourResetAt !== undefined ? { fiveHourResetAt: existing.fiveHourResetAt } : {}),
    ...(existing?.monthlyResetAt !== undefined ? { monthlyResetAt: existing.monthlyResetAt } : {}),
    ...(existing?.resetCredits !== undefined ? { resetCredits: existing.resetCredits } : {}),
    updatedAt: Date.now(),
  };

  const nextWeeklyResetAt = normalizeResetAt(weeklyResetAt);
  const nextFiveHourResetAt = normalizeResetAt(fiveHourResetAt);
  const nextMonthlyResetAt = normalizeResetAt(monthlyResetAt);
  if (nextWeekly !== undefined) {
    quota.weeklyPercent = nextWeekly;
    if (nextWeeklyResetAt !== undefined) quota.weeklyResetAt = nextWeeklyResetAt;
  }
  if (nextFiveHour !== undefined) {
    quota.fiveHourPercent = nextFiveHour;
    if (nextFiveHourResetAt !== undefined) quota.fiveHourResetAt = nextFiveHourResetAt;
  }
  if (nextMonthly !== undefined) {
    quota.monthlyPercent = nextMonthly;
    if (nextMonthlyResetAt !== undefined) quota.monthlyResetAt = nextMonthlyResetAt;
  }
  if (resetCredits !== undefined) quota.resetCredits = resetCredits;

  accountQuota.set(accountId, quota);
}

export function getAccountQuota(accountId: string): StoredAccountQuota | null {
  return accountQuota.get(accountId) ?? null;
}

export function listAccountQuotas(): IterableIterator<[string, StoredAccountQuota]> {
  return accountQuota.entries();
}

export function clearAccountQuota(accountId?: string): void {
  if (accountId) accountQuota.delete(accountId);
  else accountQuota.clear();
}

export function parseUsageQuota(data: WhamUsageResponse): Omit<StoredAccountQuota, "updatedAt"> | null {
  const resetCredits = typeof data.rate_limit_reset_credits?.available_count === "number"
    ? data.rate_limit_reset_credits.available_count
    : undefined;

  if (!data.rate_limit) {
    return resetCredits !== undefined ? { resetCredits } : null;
  }

  const quota: Omit<StoredAccountQuota, "updatedAt"> = {};
  const thirtyDayOnly = data.plan_type?.trim().toLowerCase() === "go" || data.plan_type?.trim().toLowerCase() === "free";
  const weeklyPercent = normalizeUsagePercent(data.rate_limit.secondary_window?.used_percent);
  const fiveHourPercent = normalizeUsagePercent(data.rate_limit.primary_window?.used_percent);
  const monthlyPercent = normalizeUsagePercent(data.rate_limit.tertiary_window?.used_percent);
  const weeklyResetAt = normalizeResetAt(data.rate_limit.secondary_window?.reset_at);
  const fiveHourResetAt = normalizeResetAt(data.rate_limit.primary_window?.reset_at);
  const monthlyResetAt = normalizeResetAt(data.rate_limit.tertiary_window?.reset_at);
  if (thirtyDayOnly) {
    const goMonthlyPercent = monthlyPercent ?? fiveHourPercent;
    const goMonthlyResetAt = monthlyResetAt ?? fiveHourResetAt;
    if (goMonthlyPercent !== undefined) {
      quota.monthlyPercent = goMonthlyPercent;
      if (goMonthlyResetAt !== undefined) quota.monthlyResetAt = goMonthlyResetAt;
    }
  } else if (weeklyPercent !== undefined) {
    quota.weeklyPercent = weeklyPercent;
    if (weeklyResetAt !== undefined) quota.weeklyResetAt = weeklyResetAt;
  }
  if (!thirtyDayOnly && fiveHourPercent !== undefined) {
    quota.fiveHourPercent = fiveHourPercent;
    if (fiveHourResetAt !== undefined) quota.fiveHourResetAt = fiveHourResetAt;
  }
  if (!thirtyDayOnly && monthlyPercent !== undefined) {
    quota.monthlyPercent = monthlyPercent;
    if (monthlyResetAt !== undefined) quota.monthlyResetAt = monthlyResetAt;
  }
  if (resetCredits !== undefined) quota.resetCredits = resetCredits;

  return hasKnownQuotaValue(quota) || resetCredits !== undefined ? quota : null;
}
