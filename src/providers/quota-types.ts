/**
 * Provider quota shapes, split out of `quota.ts` so a provider-specific quota module can
 * describe its result without importing the aggregator that will consume it.
 *
 * `quota.ts` imports the Kiro usage module for its fetcher; if that module reached back
 * into `quota.ts` for these types the two would depend on each other. Types have no
 * runtime edge, but a cycle that exists only in the type graph is still a cycle, and it
 * blocks any later attempt to load one side without the other.
 */

export const PROVIDER_QUOTA_MAX_AGE_MS = 30 * 60_000;

/** Management-only eligibility evidence; private credential binding never leaves the server. */
export type ProviderRoutingQuota =
  | { state: "unknown" }
  | { state: "available" | "exhausted"; updatedAt: number; validUntil: number };

export interface ProviderQuotaWindow {
  label: string;
  percent: number;
  resetAt?: number;
}

export interface ProviderQuotaCreditsUsd {
  used: number;
  limit: number;
  remaining: number;
  percent: number;
  expiresAt?: number;
  unlimited?: boolean;
}

export interface ProviderQuota {
  fiveHourPercent?: number;
  fiveHourResetAt?: number;
  weeklyPercent?: number;
  weeklyResetAt?: number;
  monthlyPercent?: number;
  monthlyResetAt?: number;
  customWindows?: ProviderQuotaWindow[];
  creditsUsd?: ProviderQuotaCreditsUsd;
  updatedAt: number;
}

export type AccountQuotaMode = "probe" | "passive" | "unsupported";

/** Additive management-row fields; cheap lists emit only quotaMode. */
export interface AccountQuotaFields {
  quotaMode?: AccountQuotaMode;
  quota?: ProviderQuota | null;
  quotaUnavailable?: boolean;
}
