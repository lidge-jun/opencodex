export const ACCOUNT_PAUSE_REASONS = [
  "oauth_organization_disabled", "account_permission_denied", "subscription_inactive",
  "subscription_expired", "plan_downgraded",
] as const;
export type AccountPauseReason = typeof ACCOUNT_PAUSE_REASONS[number];
export interface AccountPauseDetails {
  reason: AccountPauseReason;
  pausedAt: number;
}
export interface AccountAutoPausePolicy {
  /** Explicit opt-in. Omitted and false both leave account eligibility unchanged. */
  enabled?: boolean;
  /** Consecutive permanent refusals; defaults to 2. */
  consecutiveFailures?: number;
}
