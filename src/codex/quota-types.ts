/** Quota wire/storage shapes. This leaf must not import credential or config owners. */
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
