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

// Process-local authority: display readings must not acquire key-selection authority.
const displayOnlyQuotas = new WeakSet<ProviderQuota>();
export function markDisplayOnlyQuota(quota: ProviderQuota): ProviderQuota {
  displayOnlyQuotas.add(quota);
  return quota;
}
export function isDisplayOnlyQuota(quota: ProviderQuota): boolean {
  return displayOnlyQuotas.has(quota);
}

/** Management-only eligibility evidence; private credential binding never leaves the server. */
export type ProviderRoutingQuota =
  | { state: "unknown" }
  | { state: "available" | "exhausted"; updatedAt: number; validUntil: number };

export interface ProviderQuotaWindow {
  label: string;
  /** Presentation text only; identity and routing use label and structured fields. */
  displayLabel?: string;
  percent: number;
  resetAt?: number;
  /**
   * Model this window is attributed to: the exact CCA wire model of a fallback measurement, or
   * the canonical model of a quota-summary bucket dedicated to one model (Antigravity's Gemini 4
   * Argon pool). Display evidence only, never eligibility: routing, exhaustion, reset ordering
   * and reset notifications ignore every window that carries it.
   */
  modelId?: string;
  /**
   * Set only when the PRODUCER proved this window covers one model family, structurally rather
   * than by reading its label: an Anthropic `seven_day_<family>` body key, or a limit with
   * `kind: "weekly_scoped"` and a recognized `scope.model.display_name`.
   *
   * Absent means provider-wide, which gates every model. That is the fail-closed direction and
   * the behaviour every other producer keeps. Routing must key on THIS, never on the label text:
   * `quota/antigravity.ts` passes an upstream `group.displayName` straight through, so a
   * provider-wide group named "Opus" there would otherwise be mistaken for a per-model window.
   */
  scope?: "model";
  /**
   * Share of the provider-wide weekly limit a model-scoped window may consume, in percent:
   * Anthropic's `weekly_scoped_shares[].allowance_percent_of_weekly` (Fable is "up to 50% of
   * your weekly limit"). `percent` stays relative to this allowance. Read from upstream, never
   * inferred from a plan; ranking restates family usage on the weekly scale with it.
   */
  weeklyAllowancePercent?: number;
  /** Passive family readings have their own freshness clock, independent of active probes. */
  passiveObservedAt?: number;
  /** Upstream refusal evidence, distinct from a measured utilization counter. */
  rejected?: true;
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
  /** Display-only budget windows for which the upstream did not provide a usable entitlement. */
  unknownBudgetWindows?: { label: string; resetAt?: number }[];
  /** Display-only subscription credits; not a routing or exhaustion window. */
  workbuddyCredits?: import("./workbuddy-credit-balance").WorkBuddyCreditBalance;
  fiveHourPercent?: number;
  fiveHourResetAt?: number;
  weeklyPercent?: number;
  weeklyResetAt?: number;
  monthlyPercent?: number;
  monthlyResetAt?: number;
  /** Observed Kiro plan credits, independent of token and currency estimates. */
  kiroCreditsUsed?: number;
  kiroCreditsLimit?: number;
  customWindows?: ProviderQuotaWindow[];
  /**
   * Display-only measurements the producer withheld from routing: Anthropic model-scoped rows
   * that upstream reports with `is_active: false`. Routing, exhaustion, cooldown recovery and
   * reset ordering read only `customWindows`; nothing but quota display reads this field.
   */
  displayWindows?: ProviderQuotaWindow[];
  creditsUsd?: ProviderQuotaCreditsUsd;
  updatedAt: number;
}

export type AccountQuotaMode = "probe" | "passive" | "unsupported";

/** Additive management-row fields; cheap lists emit only quotaMode. */
export interface AccountQuotaFields {
  quotaMode?: AccountQuotaMode;
  quota?: ProviderQuota | null;
  quotaUnavailable?: boolean;
  quotaFailure?: QuotaFailureCode;
  /** Why the current balance is unknown (#8397); a last-good value may still ride along with read_failed. */
  quotaUnknownReason?: QuotaUnknownReason;
  /** When the balance was last read (epoch ms), success or failure; absent when never read. */
  quotaReadAt?: number;
}

/**
 * Closed reasons a balance is unknown. A row with a reason must never be rendered as zero.
 * no_balance_source: no reader exists for this destination. passive_not_observed: a passive
 * provider has not observed usage yet. read_failed: a reader exists and its last read failed.
 * not_read: a reader exists but no read was made (paused key, or the key changed mid-read).
 * not_reported: the read succeeded and the provider authoritatively reported no balance to meter
 * (for example zero total credits, or a plan with no model window).
 */
export const QUOTA_UNKNOWN_REASONS = ["no_balance_source", "passive_not_observed", "read_failed", "not_read", "not_reported"] as const;
export type QuotaUnknownReason = typeof QUOTA_UNKNOWN_REASONS[number];
export function parseQuotaUnknownReason(value: unknown): QuotaUnknownReason | undefined {
  return QUOTA_UNKNOWN_REASONS.find(reason => reason === value);
}


/** Closed account-probe diagnoses; never upstream text, URLs, credentials or routing policy. */
export const QUOTA_FAILURE_CODES = [
  "account_unavailable", "access_denied", "rate_limited", "upstream_error", "redirect_blocked",
  "destination_blocked", "dns_failed", "timeout", "transport_error", "response_unusable",
] as const;
export type QuotaFailureCode = typeof QUOTA_FAILURE_CODES[number];
export function parseQuotaFailureCode(value: unknown): QuotaFailureCode | undefined {
  return QUOTA_FAILURE_CODES.find(code => code === value);
}

/** A model family's share of the weekly limit is meaningful only as a finite percent in (0, 100]. */
export function isWeeklyAllowancePercent(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100;
}
