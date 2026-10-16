import { computeCodexUsageScore } from "./cooldown-math";
import { CODEX_UNKNOWN_USAGE_SCORE, resetAtToMs } from "../quota";
import { isThirtyDayOnlyCodexPlan } from "../plan";
import { codexQuotaUsageObservedAt } from "../quota-observation-freshness";
import type { StoredAccountQuota } from "../quota-types";

const HOUR_MS = 60 * 60_000;
const RESET_OBSERVATION_FRESHNESS_MS = 5 * 60_000;
/** Near resets only break near-ties: the bounded lift can decide close remaining-share scores. */
const RESET_TIE_BREAK_MAX = 0.1;

/** Bounded tie-break: missing, elapsed or stale deadlines add nothing and never imply replenished quota. */
function resetTieBreak(resetAt: number | undefined, now: number, short: boolean, fresh: boolean): number {
  if (!fresh || resetAt === undefined || !Number.isFinite(resetAt)) return 0;
  const remaining = resetAtToMs(resetAt) - now;
  if (remaining <= 0) return 0;
  return remaining <= (short ? HOUR_MS / 2 : 6 * HOUR_MS) ? RESET_TIE_BREAK_MAX
    : remaining <= (short ? HOUR_MS : 24 * HOUR_MS) ? RESET_TIE_BREAK_MAX / 2 : 0;
}

/** Remaining share dominates; a near reset only adds a small lift to its own window. Unknown gets a small probe share. */
export function codexQuotaSchedulingWeight(
  quota: StoredAccountQuota | null, plan: unknown, threshold: number, now: number, allowCredits = false,
): number {
  const usage = computeCodexUsageScore(quota, plan, now, allowCredits);
  if (usage !== CODEX_UNKNOWN_USAGE_SCORE && (usage >= 100 || (threshold > 0 && usage >= threshold))) return 0;
  if (!quota || usage === CODEX_UNKNOWN_USAGE_SCORE) return 1;
  const fresh = (window: "weekly" | "monthly" | "short") => {
    const observedAt = codexQuotaUsageObservedAt(quota, `${window}Percent`);
    return observedAt !== undefined && Number.isFinite(observedAt)
      && observedAt <= now && now - observedAt <= RESET_OBSERVATION_FRESHNESS_MS;
  };
  const longWindows = isThirtyDayOnlyCodexPlan(plan)
    ? ["monthly"] as const : ["weekly", "monthly"] as const;
  const longWeights = longWindows.flatMap(window => {
    const percent = quota[`${window}Percent`];
    return typeof percent === "number" && Number.isFinite(percent)
      ? [Math.max(1, 100 - percent) * (1 + resetTieBreak(quota[`${window}ResetAt`], now, false, fresh(window)))] : [];
  });
  // A short reset can only lift its own window. An unreset tight weekly/monthly window still caps the weight.
  if (typeof quota.shortPercent === "number" && Number.isFinite(quota.shortPercent)) {
    longWeights.push(Math.max(1, 100 - quota.shortPercent) * (1 + resetTieBreak(quota.shortResetAt, now, true, fresh("short") && (quota.shortObservedAt === undefined || (Number.isFinite(quota.shortObservedAt) && quota.shortObservedAt <= now && now - quota.shortObservedAt <= RESET_OBSERVATION_FRESHNESS_MS)))));
  }
  return Math.min(...longWeights);
}

/** True when no usable quota evidence exists; such accounts keep a proportional probe share instead of joining the dominant tier. */
export function codexQuotaUnknownForScheduling(
  quota: StoredAccountQuota | null, plan: unknown, now: number, allowCredits = false,
): boolean {
  return !quota || computeCodexUsageScore(quota, plan, now, allowCredits) === CODEX_UNKNOWN_USAGE_SCORE;
}

/**
 * Kernel weights for the dominant tier: when every candidate's quota is known, the largest
 * remaining share gets weight 1 and the rest 0, so smooth weighted rotation settles on it every
 * round while zero-weight accounts stay eligible for seeds and failure fallback. A pool with any
 * unknown-quota account keeps the proportional weights so that account still receives its probe
 * share and can become known.
 */
export function dominantTierKernelWeights(
  weights: ReadonlyMap<string, number>, unknown: (id: string) => boolean,
): ReadonlyMap<string, number> {
  let max = 0;
  for (const [id, weight] of weights) {
    if (weight <= 0) continue;
    if (unknown(id)) return weights;
    if (weight > max) max = weight;
  }
  if (max <= 0) return weights;
  return new Map([...weights].map(([id, weight]) => [id, weight === max ? 1 : 0]));
}
