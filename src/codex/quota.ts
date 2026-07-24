export type StoredAccountQuota = {
  weeklyPercent?: number;
  monthlyPercent?: number;
  weeklyResetAt?: number;
  monthlyResetAt?: number;
  resetCredits?: number;
  updatedAt: number;
};

export type WhamUsageResponse = {
  email?: string | null;
  plan_type?: string | null;
  rate_limit?: {
    // Live WHAM payloads send explicit nulls for absent windows (issue #315 repro).
    primary_window?: WhamUsageWindow | null;
    secondary_window?: WhamUsageWindow | null;
    tertiary_window?: WhamUsageWindow | null;
  };
  rate_limit_reset_credits?: {
    available_count: number;
  } | null;
};

type WhamUsageWindow = {
  used_percent?: number;
  reset_at?: number;
  limit_window_seconds?: number;
};

const MONTHLY_WINDOW_MIN_SECONDS = 28 * 24 * 60 * 60;
const MONTHLY_WINDOW_MIN_MINUTES = MONTHLY_WINDOW_MIN_SECONDS / 60;

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
  return [quota.weeklyPercent, quota.monthlyPercent]
    .some(value => typeof value === "number" && Number.isFinite(value));
}

function isExplicitMonthlyWindow(window: WhamUsageWindow | null | undefined): boolean {
  const seconds = window?.limit_window_seconds;
  return typeof seconds === "number"
    && Number.isFinite(seconds)
    && seconds >= MONTHLY_WINDOW_MIN_SECONDS;
}

function isExplicitMonthlyWindowMinutes(windowMinutes: unknown): boolean {
  const minutes = typeof windowMinutes === "number"
    ? windowMinutes
    : typeof windowMinutes === "string" && windowMinutes.trim() !== ""
      ? Number(windowMinutes)
      : undefined;
  return typeof minutes === "number"
    && Number.isFinite(minutes)
    && minutes >= MONTHLY_WINDOW_MIN_MINUTES;
}


function snapshotHasWeekly(quota: Omit<StoredAccountQuota, "updatedAt">): boolean {
  return quota.weeklyPercent !== undefined || quota.weeklyResetAt !== undefined;
}

function snapshotHasMonthly(quota: Omit<StoredAccountQuota, "updatedAt">): boolean {
  return quota.monthlyPercent !== undefined || quota.monthlyResetAt !== undefined;
}

function snapshotHasUsage(quota: Omit<StoredAccountQuota, "updatedAt">): boolean {
  return snapshotHasWeekly(quota) || snapshotHasMonthly(quota);
}
export function setAccountQuotaFromParsed(
  accountId: string,
  quota: Omit<StoredAccountQuota, "updatedAt"> | null,
): void {
  if (!quota) return;
  const existing = accountQuota.get(accountId);
  const next: StoredAccountQuota = { updatedAt: Date.now() };
  const creditsOnly = quota.resetCredits !== undefined && !snapshotHasUsage(quota);

  if (creditsOnly) {
    if (existing?.weeklyPercent !== undefined) next.weeklyPercent = existing.weeklyPercent;
    if (existing?.weeklyResetAt !== undefined) next.weeklyResetAt = existing.weeklyResetAt;
    if (existing?.monthlyPercent !== undefined) next.monthlyPercent = existing.monthlyPercent;
    if (existing?.monthlyResetAt !== undefined) next.monthlyResetAt = existing.monthlyResetAt;
    next.resetCredits = quota.resetCredits;
    accountQuota.set(accountId, next);
    return;
  }

  if (snapshotHasWeekly(quota)) {
    if (quota.weeklyPercent !== undefined) next.weeklyPercent = quota.weeklyPercent;
    if (quota.weeklyResetAt !== undefined) next.weeklyResetAt = quota.weeklyResetAt;
  } else if (snapshotHasMonthly(quota) && !snapshotHasWeekly(quota)) {
    // Monthly-only snapshots intentionally clear stale weekly values (issue #382).
  } else if (existing?.weeklyPercent !== undefined) {
    next.weeklyPercent = existing.weeklyPercent;
    if (existing.weeklyResetAt !== undefined) next.weeklyResetAt = existing.weeklyResetAt;
  }

  if (snapshotHasMonthly(quota)) {
    if (quota.monthlyPercent !== undefined) next.monthlyPercent = quota.monthlyPercent;
    if (quota.monthlyResetAt !== undefined) next.monthlyResetAt = quota.monthlyResetAt;
  } else if (snapshotHasWeekly(quota) && existing?.monthlyPercent !== undefined) {
    next.monthlyPercent = existing.monthlyPercent;
    if (existing.monthlyResetAt !== undefined) next.monthlyResetAt = existing.monthlyResetAt;
  }

  if (quota.resetCredits !== undefined) next.resetCredits = quota.resetCredits;
  else if (existing?.resetCredits !== undefined) next.resetCredits = existing.resetCredits;

  accountQuota.set(accountId, next);
}

export function parseUpstreamQuotaHeaders(headers: Headers): Omit<StoredAccountQuota, "updatedAt"> | null {
  const primaryRaw = headers.get("x-codex-primary-used-percent");
  const secondaryRaw = headers.get("x-codex-secondary-used-percent");
  const tertiaryRaw = headers.get("x-codex-tertiary-used-percent");
  const primaryResetRaw = headers.get("x-codex-primary-reset-at");
  const secondaryResetRaw = headers.get("x-codex-secondary-reset-at");
  const tertiaryResetRaw = headers.get("x-codex-tertiary-reset-at");
  const primaryWindowMinutes = headers.get("x-codex-primary-window-minutes");
  const secondaryWindowMinutes = headers.get("x-codex-secondary-window-minutes");

  const quota: Omit<StoredAccountQuota, "updatedAt"> = {};
  const primaryPercent = normalizeUsagePercent(primaryRaw);
  const secondaryPercent = normalizeUsagePercent(secondaryRaw);
  const tertiaryPercent = normalizeUsagePercent(tertiaryRaw);
  const primaryResetAt = normalizeResetAt(primaryResetRaw);
  const secondaryResetAt = normalizeResetAt(secondaryResetRaw);
  const tertiaryResetAt = normalizeResetAt(tertiaryResetRaw);
  const primaryIsMonthly = primaryRaw !== null && isExplicitMonthlyWindowMinutes(primaryWindowMinutes);

  if (primaryIsMonthly) {
    if (primaryPercent !== undefined) {
      quota.monthlyPercent = primaryPercent;
      if (primaryResetAt !== undefined) quota.monthlyResetAt = primaryResetAt;
    }
    if (secondaryPercent !== undefined) {
      quota.weeklyPercent = secondaryPercent;
      if (secondaryResetAt !== undefined) quota.weeklyResetAt = secondaryResetAt;
    }
  } else {
    const weeklyPercent = primaryPercent ?? secondaryPercent;
    const weeklyResetAt = primaryPercent !== undefined
      ? primaryResetAt
      : secondaryResetAt;
    if (weeklyPercent !== undefined) {
      quota.weeklyPercent = weeklyPercent;
      if (weeklyResetAt !== undefined) quota.weeklyResetAt = weeklyResetAt;
    }
  }

  if (tertiaryPercent !== undefined && quota.monthlyPercent === undefined) {
    quota.monthlyPercent = tertiaryPercent;
    if (tertiaryResetAt !== undefined) quota.monthlyResetAt = tertiaryResetAt;
  }

  return hasKnownQuotaValue(quota) ? quota : null;
}

export function applyAccountQuotaFromUpstreamHeaders(accountId: string, headers: Headers): void {
  const quota = parseUpstreamQuotaHeaders(headers);
  if (!quota) return;
  setAccountQuotaFromParsed(accountId, quota);
}

export function updateAccountQuota(
  accountId: string,
  weekly: unknown,
  weeklyResetAt?: unknown,
  monthly?: unknown,
  monthlyResetAt?: unknown,
  resetCredits?: number,
): void {
  const existing = accountQuota.get(accountId);
  const nextWeekly = normalizeUsagePercent(weekly);
  const nextMonthly = normalizeUsagePercent(monthly);
  if (nextWeekly === undefined && nextMonthly === undefined && resetCredits === undefined) return;

  const quota: StoredAccountQuota = {
    ...(existing?.weeklyPercent !== undefined ? { weeklyPercent: existing.weeklyPercent } : {}),
    ...(existing?.monthlyPercent !== undefined ? { monthlyPercent: existing.monthlyPercent } : {}),
    ...(existing?.weeklyResetAt !== undefined ? { weeklyResetAt: existing.weeklyResetAt } : {}),
    ...(existing?.monthlyResetAt !== undefined ? { monthlyResetAt: existing.monthlyResetAt } : {}),
    ...(existing?.resetCredits !== undefined ? { resetCredits: existing.resetCredits } : {}),
    updatedAt: Date.now(),
  };

  const nextWeeklyResetAt = normalizeResetAt(weeklyResetAt);
  const nextMonthlyResetAt = normalizeResetAt(monthlyResetAt);
  if (nextWeekly !== undefined) {
    quota.weeklyPercent = nextWeekly;
    if (nextWeeklyResetAt !== undefined) quota.weeklyResetAt = nextWeeklyResetAt;
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
  const primaryWindow = data.rate_limit.primary_window;
  const secondaryWindow = data.rate_limit.secondary_window;
  const tertiaryWindow = data.rate_limit.tertiary_window;
  const primaryPercent = normalizeUsagePercent(primaryWindow?.used_percent);
  const secondaryPercent = normalizeUsagePercent(secondaryWindow?.used_percent);
  const tertiaryPercent = normalizeUsagePercent(tertiaryWindow?.used_percent);
  const primaryResetAt = normalizeResetAt(primaryWindow?.reset_at);
  const secondaryResetAt = normalizeResetAt(secondaryWindow?.reset_at);
  const tertiaryResetAt = normalizeResetAt(tertiaryWindow?.reset_at);
  const primaryIsMonthly = isExplicitMonthlyWindow(primaryWindow);

  // [Decision Log]
  // - 목적과 의도: distinguish weekly and roughly monthly WHAM primary windows without plan-name guesses.
  // - 기존 구현 및 제약 조건: primary meant weekly, and older responses omit limit_window_seconds.
  // - 검토한 주요 대안: exact-duration matching, plan-specific mapping, and a duration lower bound.
  // - 선택한 방식: only an explicit primary duration of at least 28 days changes it to monthly.
  // - 다른 대안 대신 이 방식을 선택한 이유: it accepts calendar-month variance and preserves legacy payloads.
  // - 장점, 단점 및 영향: Team monthly quotas classify correctly; unknown durations remain weekly by design.
  const weeklyPercent = primaryIsMonthly ? secondaryPercent : primaryPercent ?? secondaryPercent;
  const weeklyResetAt = primaryIsMonthly
    ? secondaryResetAt
    : primaryPercent !== undefined ? primaryResetAt : secondaryResetAt;
  const monthlyPercent = primaryIsMonthly ? primaryPercent ?? tertiaryPercent : tertiaryPercent;
  const monthlyResetAt = primaryIsMonthly && primaryPercent !== undefined ? primaryResetAt : tertiaryResetAt;
  if (thirtyDayOnly) {
    if (monthlyPercent !== undefined) {
      quota.monthlyPercent = monthlyPercent;
      if (monthlyResetAt !== undefined) quota.monthlyResetAt = monthlyResetAt;
    }
  } else if (weeklyPercent !== undefined) {
    quota.weeklyPercent = weeklyPercent;
    if (weeklyResetAt !== undefined) quota.weeklyResetAt = weeklyResetAt;
  }
  if (!thirtyDayOnly && monthlyPercent !== undefined) {
    quota.monthlyPercent = monthlyPercent;
    if (monthlyResetAt !== undefined) quota.monthlyResetAt = monthlyResetAt;
  }
  if (resetCredits !== undefined) quota.resetCredits = resetCredits;

  return hasKnownQuotaValue(quota) || resetCredits !== undefined ? quota : null;
}
