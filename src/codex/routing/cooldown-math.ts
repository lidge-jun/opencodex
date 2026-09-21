import {
  CODEX_EXHAUSTED_USAGE_PERCENT,
  CODEX_UNKNOWN_USAGE_SCORE,
} from "../quota";
import { isThirtyDayOnlyCodexPlan } from "../plan";
import { isTerminalShortWindow } from "../quota-types";
import type { CodexQuotaScope } from "./health-store";
import type { TransientProbeGrant } from "./thread-affinity";

export { TERMINAL_SHORT_WINDOW_FRESHNESS_MS } from "../quota-types";

export const CODEX_DEFAULT_QUOTA_COOLDOWN_MS = 60_000;
export const CODEX_MAX_QUOTA_COOLDOWN_MS = 24 * 60 * 60_000;
/**
 * A weekly/monthly quota `resetAt` announces when the window refreshes; it is not
 * a "come back after this" directive like Retry-After. Plan quota routinely frees
 * up long before the advertised reset, so cap reset-derived cooldowns far below
 * the Retry-After ceiling (#433).
 */
export const CODEX_MAX_RESET_DERIVED_COOLDOWN_MS = 15 * 60_000;
/**
 * Ceiling on quota-refusal avoidance. Generous enough to cover a full five-hour burst window,
 * tight enough that a weekly or monthly reset four days out cannot take an account out of
 * rotation for the {@link CODEX_MAX_QUOTA_COOLDOWN_MS} day the Retry-After ceiling allows.
 */
export const CODEX_MAX_QUOTA_AVOID_MS = 6 * 60 * 60_000;
/** Minimum gap between probe leases for one cooled-down account. */
export const CODEX_QUOTA_PROBE_INTERVAL_MS = 5 * 60_000;
export const CODEX_FAILURE_WINDOW_MS = 5 * 60_000;
/** How long a transient failure keeps the account out of pool selection. */
export const CODEX_TRANSIENT_SOFT_AVOID_MS = 30_000;
export const CODEX_TRANSIENT_SOFT_AVOID_ESCALATION_MS = [
  CODEX_TRANSIENT_SOFT_AVOID_MS,
  2 * 60_000,
  10 * 60_000,
  30 * 60_000,
] as const;

export type CodexUpstreamOutcome = number | "connect_error" | "timeout" | "connect_neutral";
export type CodexUpstreamOutcomeClass = "success" | "credential"
  | "workspace" | "quota" | "transient" | "caller" | "neutral" | "unknown";
export type CodexCooldownSource = "retry-after" | "reset-derived" | "default";

export type CodexUpstreamOutcomeMeta = {
  retryAfter?: string | null;
  resetAt?: unknown | unknown[];
  now?: number;
  /** (provider, host) ledger key for account-neutral reachability failures (#914). */
  hostKey?: string;
  /**
   * Upstream denial evidence for a 403. A workspace/entitlement denial means the CREDENTIAL
   * is fine and the account simply cannot reach this workspace, so it must not be quarantined
   * for reauthentication (#1789). Absent evidence keeps the historical credential handling.
   */
  denial?: "workspace" | "entitlement";
  /** Stable transport code recorded alongside a neutral host failure. */
  lastFailureCode?: string;
  /** Native model selected for this request; used only for confirmed scoped quotas. */
  modelId?: string;
  /** When set, clears affinity for this thread immediately on transient failure. */
  threadId?: string | null;
  /**
   * Suppress Pool rotation and quota/transient affinity mutations for an account-qualified
   * request. Credential failures still sweep stale affinities because reauthentication is
   * account-wide.
   */
  fixedAccount?: boolean;
  /**
   * Probe lease held by this request, when it was admitted through an active
   * quota cooldown. Only the outcome carrying the current lease may clear the
   * cooldown (#433).
  */
  probeLeaseId?: string;
  /** Scope of `probeLeaseId` when it was granted against a model-scoped cooldown. */
  probeQuotaScope?: CodexQuotaScope;
  /**
   * The half-open TRANSIENT-HOLD probe this request was granted, when it was the one request
   * admitted to test a held account (#4701). A different lease to `probeLeaseId` above, in a
   * different domain: that one governs a quota cooldown, this one governs a 5xx hold. The two
   * are mutually exclusive by construction -- `isTransientOnlyAffinityBlock` refuses to
   * recognise a transient hold on an account that carries quota health -- so a request never
   * holds both and never pays two recovery permits for one send.
   */
  transientProbe?: TransientProbeGrant;
  /**
   * Already-chosen alternate for same-request 429 retry. When set, promotion
   * reuses this account instead of calling {@link pickAlternateCodexAccount}
   * again (which would advance a round-robin ring twice).
   */
  promoteAccountId?: string;
  /** Generation captured when this routed account was selected. */
  writerGeneration?: number;
  /**
   * Credential generation this request's bearer was read at. Distinct from
   * `writerGeneration`, which tracks the config store.
   *
   * A 401 that arrives after the credential was already replaced is evidence about a
   * token nobody is using any more, so it must not quarantine the replacement. Absent
   * means the caller cannot supply lineage and the historical unfenced handling stands.
   */
  credentialGeneration?: number;
};

export function computeCodexUsageScore(quota: {
  weeklyPercent?: number;
  monthlyPercent?: number;
  shortPercent?: number;
  shortResetAt?: number;
  shortObservedAt?: number;
} | null, plan?: unknown, now: number = Date.now()): number {
  if (!quota) return CODEX_UNKNOWN_USAGE_SCORE;
  const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
  const longWindows = isThirtyDayOnlyCodexPlan(plan)
    ? [quota.monthlyPercent]
    : [quota.weeklyPercent, quota.monthlyPercent];
  const knownLong = longWindows.filter(finite);
  // The short burst window only REFINES a known long-window position; it cannot stand in for
  // one. A snapshot carrying just `shortPercent: 0` would otherwise score a flat 0 and make an
  // account whose weekly/monthly usage is entirely unverified look like the emptiest in the
  // pool, so `pickLowestUsageAmong` would send every request to it. Unknown has to stay
  // unknown until a governing window is actually observed.
  //
  // A FULL burst window is the exception (#3029). It is not an optimistic guess about an
  // unobserved window — it is a direct observation that the account cannot serve a request
  // right now, whatever its monthly position turns out to be. Unknown-means-selectable is
  // correct for uncertainty and wrong for a measured refusal: the account stays selected,
  // `applyQuotaAutoSwitch` never fires, and the pool wedges on an exhausted credential.
  if (knownLong.length === 0) {
    return isTerminalShortWindow(quota, now) ? CODEX_EXHAUSTED_USAGE_PERCENT : CODEX_UNKNOWN_USAGE_SCORE;
  }
  const values = finite(quota.shortPercent) ? [...knownLong, quota.shortPercent] : knownLong;
  return Math.max(...values);
}

// `isTerminalShortWindow` moved to ../quota-types, the leaf the dashboard can import. Routing
// and the account-switch warning have to answer this identically for the same snapshot, and
// they did not: see the note on the shared function (#5045). Its #3029 and #3425 reasoning —
// why freshness is not optional, and why a reading with no reset and no observation stays
// unknown rather than exhausted — moved with it.

export function classifyCodexUpstreamOutcome(
  outcome: CodexUpstreamOutcome,
  denial?: "workspace" | "entitlement",
): CodexUpstreamOutcomeClass {
  if (outcome === "connect_neutral") return "neutral";
  if (outcome === "connect_error" || outcome === "timeout") return "transient";
  if (!Number.isFinite(outcome)) return "unknown";
  if (outcome >= 200 && outcome < 300) return "success";
  // Explicit 3xx policy (#914): a redirect response is relayed as-is and is
  // never account or host health evidence — it proves the host is reachable
  // and says nothing about the credential. Relayed as the neutral class so a
  // stray 3xx cannot increment an account's transient streak.
  if (outcome >= 300 && outcome < 400) return "neutral";
  // 401 is always a credential problem. A 403 is only a credential problem when nothing
  // tells us otherwise: a workspace/entitlement denial (#1789) means the credential is valid
  // and the account simply lacks access here, so quarantining it for reauth is wrong advice.
  // Absent denial evidence the historical mapping stands, so the change fails safe.
  if (outcome === 403 && denial !== undefined) return "workspace";
  if (outcome === 401 || outcome === 403) return "credential";
  // 402 Payment Required is treated as quota exhaustion for pool cooldown/failover
  // (same-request alternate retry records this outcome for the depleted account).
  if (outcome === 429 || outcome === 402) return "quota";
  if (outcome >= 400 && outcome < 500) return "caller";
  if (outcome >= 500 && outcome < 600) return "transient";
  return "unknown";
}

function clampCooldownMs(ms: number): number {
  return Math.min(Math.max(ms, 1), CODEX_MAX_QUOTA_COOLDOWN_MS);
}

export function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    if (Number.isFinite(seconds) && seconds > 0) return clampCooldownMs(Math.ceil(seconds * 1000));
  }
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) return undefined;
  const delay = timestamp - now;
  return delay > 0 ? clampCooldownMs(delay) : undefined;
}

function resetTimestampMs(value: unknown): number | undefined {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : undefined;
  if (typeof numeric !== "number" || !Number.isFinite(numeric) || numeric <= 0) return undefined;
  return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
}

export function parseResetCooldownMs(resetAt: unknown | unknown[] | undefined, now = Date.now()): number | undefined {
  const values = Array.isArray(resetAt) ? resetAt : [resetAt];
  let best: number | undefined;
  for (const value of values) {
    const timestamp = resetTimestampMs(value);
    if (timestamp === undefined) continue;
    const delay = timestamp - now;
    if (delay <= 0) continue;
    // A far-future reset must not pin the account for the full Retry-After
    // ceiling: quota usually frees up well before the advertised window (#433).
    const clamped = Math.min(clampCooldownMs(delay), CODEX_MAX_RESET_DERIVED_COOLDOWN_MS);
    if (best === undefined || clamped < best) best = clamped;
  }
  return best;
}

export function computeQuotaCooldown(meta: CodexUpstreamOutcomeMeta = {}): {
  until: number;
  source: CodexCooldownSource;
} {
  const now = meta.now ?? Date.now();
  const retryAfterMs = parseRetryAfterMs(meta.retryAfter, now);
  if (retryAfterMs !== undefined) return { until: now + retryAfterMs, source: "retry-after" };
  const resetCooldownMs = parseResetCooldownMs(meta.resetAt, now);
  if (resetCooldownMs !== undefined) return { until: now + resetCooldownMs, source: "reset-derived" };
  return { until: now + CODEX_DEFAULT_QUOTA_COOLDOWN_MS, source: "default" };
}

/**
 * When the pool should stop preferring an account after it refused on quota.
 *
 * The earliest window the refusal actually announced, bounded by {@link CODEX_MAX_QUOTA_AVOID_MS},
 * and never shorter than the cooldown the same refusal produced — a Retry-After directive that
 * outlasts every announcement still governs.
 */
export function quotaAvoidUntilFor(meta: CodexUpstreamOutcomeMeta, now: number, cooldownUntil: number): number {
  const values = Array.isArray(meta.resetAt) ? meta.resetAt : [meta.resetAt];
  let announced: number | undefined;
  for (const value of values) {
    const timestamp = resetTimestampMs(value);
    if (timestamp === undefined) continue;
    const delay = timestamp - now;
    if (delay <= 0) continue;
    const until = now + Math.min(delay, CODEX_MAX_QUOTA_AVOID_MS);
    if (announced === undefined || until < announced) announced = until;
  }
  return Math.max(cooldownUntil, announced ?? 0);
}

export function computeQuotaCooldownUntil(meta: CodexUpstreamOutcomeMeta = {}): number {
  return computeQuotaCooldown(meta).until;
}
