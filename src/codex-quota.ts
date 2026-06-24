export type StoredAccountQuota = {
  weeklyPercent: number;
  fiveHourPercent: number;
  monthlyPercent?: number;
  weeklyResetAt?: number;
  fiveHourResetAt?: number;
  monthlyResetAt?: number;
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
};

const accountQuota = new Map<string, StoredAccountQuota>();

export function updateAccountQuota(
  accountId: string,
  weekly: number,
  fiveHour: number,
  weeklyResetAt?: number,
  fiveHourResetAt?: number,
  monthly?: number,
  monthlyResetAt?: number,
): void {
  const existing = accountQuota.get(accountId);
  accountQuota.set(accountId, {
    weeklyPercent: weekly,
    fiveHourPercent: fiveHour,
    monthlyPercent: monthly ?? existing?.monthlyPercent,
    weeklyResetAt: weeklyResetAt ?? existing?.weeklyResetAt,
    fiveHourResetAt: fiveHourResetAt ?? existing?.fiveHourResetAt,
    monthlyResetAt: monthlyResetAt ?? existing?.monthlyResetAt,
    updatedAt: Date.now(),
  });
}

export function getAccountQuota(accountId: string): StoredAccountQuota | null {
  return accountQuota.get(accountId) ?? null;
}

export function listAccountQuotas(): IterableIterator<[string, StoredAccountQuota]> {
  return accountQuota.entries();
}

export function clearAccountQuota(): void {
  accountQuota.clear();
}

export function parseUsageQuota(data: WhamUsageResponse): Omit<StoredAccountQuota, "updatedAt"> | null {
  if (!data.rate_limit) return null;
  return {
    weeklyPercent: data.rate_limit.secondary_window?.used_percent ?? 0,
    fiveHourPercent: data.rate_limit.primary_window?.used_percent ?? 0,
    monthlyPercent: data.rate_limit.tertiary_window?.used_percent,
    weeklyResetAt: data.rate_limit.secondary_window?.reset_at,
    fiveHourResetAt: data.rate_limit.primary_window?.reset_at,
    monthlyResetAt: data.rate_limit.tertiary_window?.reset_at,
  };
}
