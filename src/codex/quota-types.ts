/** Quota wire/storage shapes. This leaf must not import credential or config owners. */
export const MAIN_ACCOUNT_HARD_LOCK_PERCENT = 99;

/**
 * How recently a 100% burst reading must have been observed to exclude an account when it
 * carries no reset timestamp (#3425). This is deliberately far tighter than the disk-hydration
 * horizon so a persisted reading cannot strand a recovered account. Routing and UI share this
 * value because both must answer whether the same short-window observation is still current.
 */
export const TERMINAL_SHORT_WINDOW_FRESHNESS_MS = 5 * 60_000;

/**
 * A window reading at or above this is a measured refusal, not a position on a scale.
 *
 * Separate from `CODEX_UNKNOWN_USAGE_SCORE` because they mean opposite things: unknown is
 * "we have not observed this account", 100 is "we observed it and it is full". It lives on
 * this leaf, next to the freshness window, because the dashboard has to answer the same
 * question and cannot import the routing or disk-cache owners to do it.
 */
export const CODEX_EXHAUSTED_USAGE_PERCENT = 100;

/**
 * Above this a value is already milliseconds; at or below it, it is Unix seconds.
 *
 * Both reach storage, so the split has to live somewhere every reader can see. It lives on this
 * leaf rather than beside the merge that uses it because the dashboard reads the same stored
 * value and cannot import the disk-cache owner.
 */
const RESET_AT_SECONDS_MAX = 10_000_000_000;

/** Normalize a stored reset instant to milliseconds. */
export function resetAtToMs(resetAt: number): number {
  return resetAt < RESET_AT_SECONDS_MAX ? resetAt * 1000 : resetAt;
}

/**
 * A short-only reading that proves the account is blocked NOW.
 *
 * Routing and the dashboard's account-switch warning must answer this identically for the same
 * snapshot, or the warning tells an operator an account is usable while the router refuses it.
 * They did not: the dashboard compared a stored reset against `Date.now()` without normalizing
 * units, so a seconds-form future reset looked expired there and live here, and it treated a
 * fresh observation as sufficient even when an ELAPSED reset was present, where routing treats
 * the reset as authoritative once it exists (#5045).
 *
 * Freshness is not optional in the reset-less branch. `getAccountQuota` performs no expiry
 * check, partial updates carry a still-open short tuple forward, and disk hydration accepts a
 * persisted reading for hours, so scoring exhausted from `shortPercent` alone would keep
 * excluding an account whose burst window has since reset.
 */
export function isTerminalShortWindow(
  quota: Pick<StoredAccountQuota, "shortPercent" | "shortResetAt" | "shortObservedAt">,
  now: number,
): boolean {
  const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
  if (!finite(quota.shortPercent) || quota.shortPercent < CODEX_EXHAUSTED_USAGE_PERCENT) return false;
  const resetAt = quota.shortResetAt;
  if (!finite(resetAt) || resetAt <= 0) {
    const observedAt = quota.shortObservedAt;
    if (!finite(observedAt)) return false;
    const age = now - observedAt;
    return age >= 0 && age <= TERMINAL_SHORT_WINDOW_FRESHNESS_MS;
  }
  return resetAtToMs(resetAt) > now;
}

export type StoredAccountQuota = {
  weeklyPercent?: number;
  monthlyPercent?: number;
  weeklyResetAt?: number;
  monthlyResetAt?: number;
  /** Sub-day burst window, independent of the weekly window; duration supplies its meaning. */
  shortPercent?: number;
  shortResetAt?: number;
  /** Local short-usage observation time; partial/credit updates do not refresh it. */
  shortObservedAt?: number;
  shortWindowSeconds?: number;
  customWindows?: Array<{ label: string; percent: number; resetAt?: number }>;
  resetCredits?: number;
  /** Monthly usage came from an explicitly monthly PRIMARY, not supplementary tertiary, window. */
  monthlyIsPrimaryWindow?: boolean;
  updatedAt: number;
};

export type WhamUsageWindow = {
  used_percent?: number;
  reset_at?: number;
  limit_window_seconds?: number;
};

export type WhamAdditionalRateLimit = {
  limit_name?: unknown;
  metered_feature?: unknown;
  rate_limit?: {
    allowed?: unknown;
    primary_window?: WhamUsageWindow | null;
    secondary_window?: WhamUsageWindow | null;
  } | null;
};

export type WhamUsageResponse = {
  email?: string | null;
  plan_type?: unknown;
  account_id?: unknown;
  user_id?: unknown;
  rate_limit_upsell?: { banner_type?: unknown } | null;
  rate_limit?: {
    allowed?: unknown;
    // WHAM sends explicit nulls for absent windows.
    primary_window?: WhamUsageWindow | null;
    secondary_window?: WhamUsageWindow | null;
    tertiary_window?: WhamUsageWindow | null;
  };
  rate_limit_reset_credits?: { available_count: number } | null;
  additional_rate_limits?: WhamAdditionalRateLimit[] | null;
};


/** Captured from the exact dispatched pool credential; never a management API field. */
export interface PoolQuotaWriter {
  accountId: string;
  credentialGeneration: number;
  historyIdentity: string;
}
