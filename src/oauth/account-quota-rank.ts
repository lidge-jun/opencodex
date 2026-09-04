/**
 * Order failover candidates by what we know about their remaining allowance.
 *
 * Rotation without this walks the roster blind: the account right after the one that just
 * 429'd may itself be spent, so the request burns a second rotation from a budget of three
 * to learn what a cached quota row already knew.
 *
 * Deliberately NOT a scoring function. Percentages from different providers measure
 * different things, and a weight would invite tuning a number nobody can validate. Three
 * categories answer the only question rotation asks — "which of these is most likely to
 * serve the retry" — and within the healthy group a simple headroom sort is enough.
 */
import { getCachedProviderAccountQuota, hasPassiveAccountQuota } from "../providers/quota";
import { getKiroAccountExhaustion } from "../providers/kiro-usage";

/** Lower sorts earlier. Unknown sits between measured-healthy and measured-empty. */
const RANK_HEALTHY = 0;
const RANK_UNKNOWN = 1;
const RANK_EXHAUSTED = 2;

interface Ranked {
  id: string;
  bucket: number;
  /** Remaining percentage points, descending within the healthy bucket. */
  headroom: number;
  /** Preserves the caller's ring order for ties. */
  index: number;
}

/**
 * How old a PASSIVELY observed quota may be and still steer routing.
 *
 * A probed row is fresh by construction: it exists only because a probe wrote it, and
 * `fetchAccountQuota` re-probes once `ACCOUNT_QUOTA_TTL_MS` has passed. So no caller has
 * ever needed an explicit age check, and `getCachedProviderAccountQuota` does not apply
 * one.
 *
 * A passive row breaks that invariant — nothing re-probes it, so it can be hours or days
 * old. Routing on such a reading is worse than routing on none: the unranked ring at
 * least rotates, while a stale ranking sends every first attempt to an account that may
 * have been spent since. The bound is longer than the probe TTL (an hour-old reading of
 * a five-hour window is still informative) and far shorter than the six-hour disk
 * horizon, which exists to preserve a value for DISPLAY — where the age is shown to the
 * user and no automatic decision rides on it.
 */
const PASSIVE_HEADROOM_MAX_AGE_MS = 60 * 60_000;

/**
 * Remaining headroom across every window the provider reports.
 *
 * The minimum wins: an account at 5% of its five-hour window is unusable right now even if
 * its monthly allowance is barely touched.
 */
function headroomOf(provider: string, accountId: string): number | null {
  const quota = getCachedProviderAccountQuota(provider, accountId);
  if (!quota) return null;
  // Null, not a low rank: this must reproduce "no evidence" so a stale roster degrades to
  // the unranked ring rather than to a differently wrong answer.
  if (hasPassiveAccountQuota(provider) && Date.now() - quota.updatedAt > PASSIVE_HEADROOM_MAX_AGE_MS) return null;
  const percents = [
    quota.fiveHourPercent,
    quota.weeklyPercent,
    quota.monthlyPercent,
    ...(quota.customWindows ?? []).map(window => window.percent),
  ].filter((value): value is number => typeof value === "number");
  if (percents.length === 0) return null;
  return 100 - Math.max(...percents);
}

/**
 * Order candidates best-first.
 *
 * Returns the input untouched when no candidate has quota evidence, which keeps every
 * provider without per-account quota on exactly the behaviour it has today.
 */
export function rankAccountsByHeadroom(provider: string, ring: readonly string[]): string[] {
  if (ring.length < 2) return [...ring];

  let sawEvidence = false;
  // Same rule as hasHeadroomEvidence: a passive provider's partial roster must not rank
  // at all. The failover path calls this directly (selectFailoverAccount), so the guard
  // cannot live only in the pre-dispatch predicate.
  if (hasPassiveAccountQuota(provider) && !ring.every(id => headroomOf(provider, id) !== null)) {
    return [...ring];
  }
  const ranked: Ranked[] = ring.map((id, index) => {
    // A provider-declared exhaustion verdict outranks the percentage: an account may sit at
    // 100% and still be servable when overage is enabled, and the verdict knows that.
    const exhaustion = provider === "kiro" ? getKiroAccountExhaustion(`${provider}\u0000${id}`) : null;
    const headroom = headroomOf(provider, id);
    if (exhaustion !== null || headroom !== null) sawEvidence = true;

    if (exhaustion?.exhausted === true) return { id, bucket: RANK_EXHAUSTED, headroom: 0, index };
    if (headroom === null) return { id, bucket: RANK_UNKNOWN, headroom: 0, index };
    return { id, bucket: RANK_HEALTHY, headroom, index };
  });

  if (!sawEvidence) return [...ring];

  return ranked
    .sort((a, b) => (a.bucket - b.bucket) || (b.headroom - a.headroom) || (a.index - b.index))
    .map(entry => entry.id);
}

/**
 * Do we hold any measurement at all for these accounts?
 *
 * Ranking a single candidate is trivially the identity, which makes it useless as an
 * evidence test: a caller that has already filtered its list down to one account would be
 * told "ranked" when nothing was measured. Pre-dispatch selection asks this first so it
 * can decline to act on a roster it knows nothing about.
 */
export function hasHeadroomEvidence(provider: string, ids: readonly string[]): boolean {
  // A PASSIVE provider needs evidence for EVERY candidate, not any one of them.
  //
  // A probe fills the whole roster in one pass (fetchProviderAccountQuotas), so "any"
  // and "every" coincide there. An observation arrives one account at a time, so the
  // normal passive state is "one measured, N unknown" -- and RANK_UNKNOWN (1) sorts
  // AFTER RANK_HEALTHY (0), including behind a measured row sitting at 100% with zero
  // headroom. Accepting partial evidence would therefore redirect the first attempt
  // AWAY from an unmeasured account and TOWARD the one account known to be spent, which
  // is the exact inversion of what ranking is for.
  if (hasPassiveAccountQuota(provider)) {
    return ids.length > 0 && ids.every(id => headroomOf(provider, id) !== null);
  }
  return ids.some(id =>
    headroomOf(provider, id) !== null
    || (provider === "kiro" && getKiroAccountExhaustion(`${provider}\u0000${id}`) !== null));
}
/**
 * How long to cool an account that just 429'd, when we know its allowance is spent.
 *
 * A monthly-exhausted account retried every minute is pure waste, but an upstream reset
 * date is not something to trust unbounded — the clamp keeps a bogus far-future value from
 * parking an account for weeks, and a near-instant one from being pointless.
 */
const MIN_EXHAUSTED_COOLDOWN_MS = 5 * 60_000;
const MAX_EXHAUSTED_COOLDOWN_MS = 24 * 60 * 60_000;

export function exhaustedCooldownMs(provider: string, accountId: string, now = Date.now()): number | null {
  if (provider !== "kiro") return null;
  const exhaustion = getKiroAccountExhaustion(`${provider}\u0000${accountId}`, now);
  if (!exhaustion?.exhausted) return null;
  const untilReset = exhaustion.nextResetAt === undefined ? MIN_EXHAUSTED_COOLDOWN_MS : exhaustion.nextResetAt - now;
  return Math.min(Math.max(untilReset, MIN_EXHAUSTED_COOLDOWN_MS), MAX_EXHAUSTED_COOLDOWN_MS);
}
