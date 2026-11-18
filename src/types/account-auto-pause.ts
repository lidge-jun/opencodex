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
  /**
   * Explicit opt-in to pause on any permanent account refusal. With no policy at all, only a Cloud
   * Code Assist provider pauses, on the first Terms of Service account ban. `false` opts out of both.
   */
  enabled?: boolean;
  /** Consecutive permanent refusals; defaults to 2. */
  consecutiveFailures?: number;
}
