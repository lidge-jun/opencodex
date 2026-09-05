/** Quota wire/storage shapes. This leaf must not import credential or config owners. */
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
