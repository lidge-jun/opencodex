/**
 * Per-conversation calibration of the Kiro input estimate.
 *
 * The estimator in `lib/token-estimate` is a fixed heuristic: constants derived from recorded
 * traffic, applied to every account and every conversation identically. It is close on average
 * and necessarily wrong in the particular, because how densely a prompt tokenizes depends on
 * what is in it — a Korean design discussion and a repository of minified JSON do not share a
 * ratio, and no constant can serve both.
 *
 * Kiro, however, tells us the answer. Mid-stream it reports `contextUsagePercentage`, which
 * against a known window is an authoritative token count for the exact payload just sent. Today
 * that number is used once, as a floor under the current turn's total, and then discarded. The
 * conversation's own measured tokens-per-character is therefore recomputed from scratch, and
 * mispredicted the same way, on every single turn.
 *
 * This module keeps it. After a TERMINAL attempt that produced both an estimate and a reported
 * percentage, the realised ratio `charged / estimated` is folded into a per-conversation
 * correction and applied to the next turn of that conversation, so a long conversation converges
 * on the rate it actually exhibits rather than the rate the average conversation exhibits.
 *
 * "Terminal" matters: the adapter's bounded completion retry streams a second time for the same
 * user turn against a rebuilt payload, so the caller commits an observation only once that turn
 * is genuinely over.
 *
 * Four properties keep this from being able to make the gauge worse:
 *
 * - **Bounded.** The factor is clamped, so a single anomalous reading cannot distort the
 *   estimate by an unbounded amount, and a malformed or hostile percentage cannot either.
 * - **Smoothed.** Each observation moves the factor part of the way rather than replacing it, so
 *   one cache-affected or truncated turn cannot swing the gauge.
 * - **Bounded in memory.** Conversation-scoped with an eviction cap and no persistence. This is
 *   a hint that improves with use, not state anything depends on.
 * - **Subordinate to the truth.** The existing upstream floor is untouched. Calibration only
 *   sharpens the estimate BEFORE upstream reports; it can never lower a value upstream has
 *   already justified.
 *
 * Deliberately not in `lib/token-estimate`: that module is pure, shared by every provider, and
 * must stay so. This is Kiro-specific state and lives with the Kiro adapter.
 */

/**
 * Clamp for the correction factor.
 *
 * Wide enough to absorb the genuine spread between conversation kinds, narrow enough that a
 * wrong reading cannot produce a nonsensical gauge. A factor below 1 shrinks the estimate, so
 * the lower bound is the more dangerous side and is kept nearer 1.
 */
const MIN_FACTOR = 0.7;
const MAX_FACTOR = 3;

/**
 * Weight given to a new observation. 0.35 reaches most of the way to a persistent new rate
 * within a few turns while still requiring more than one reading to move far.
 */
const SMOOTHING = 0.35;

/**
 * Maximum conversations tracked. Entries are small, but the map must not grow with uptime.
 *
 * Eviction is least-recently-USED, not oldest-inserted: `touch` re-inserts on every estimate and
 * every observation, so an active long conversation survives an arbitrary number of short ones
 * started after it. Insertion order would have evicted exactly the conversation most worth
 * keeping.
 */
const MAX_TRACKED_CONVERSATIONS = 256;

/**
 * A ratio this far from 1 is not a mis-calibrated estimate, it is a different measurement:
 * a compaction, a cache boundary, or a percentage reported against a window we did not expect.
 * Learning from it would teach the wrong lesson, so it is ignored entirely.
 */
const MAX_PLAUSIBLE_OBSERVATION = 6;

/**
 * One conversation's calibration state.
 *
 * `factor` is the learned correction. `rawEstimate` is the uncorrected estimate most recently
 * applied: the stream records what upstream charged, but by then the value it holds has already
 * been corrected, and learning from that would make the factor measure its own residual error
 * instead of the heuristic's — each round would close only the part it had not yet fixed and the
 * factor would converge short of the true ratio.
 *
 * Both live in ONE entry so they cannot desynchronise. Held as two maps, a conversation could be
 * refreshed in one and evicted from the other, and the pair could retain twice the documented
 * bound in distinct ids.
 */
interface Calibration {
  factor?: number;
  rawEstimate?: number;
}

/** Insertion-ordered, so the first key is the least recently touched entry. */
const calibrations = new Map<string, Calibration>();

/** Re-insert to move an entry to the most-recently-used end, then evict from the old end. */
function touch(conversationId: string, update: (current: Calibration) => Calibration): void {
  const current = calibrations.get(conversationId) ?? {};
  calibrations.delete(conversationId);
  calibrations.set(conversationId, update(current));
  while (calibrations.size > MAX_TRACKED_CONVERSATIONS) {
    const oldest = calibrations.keys().next();
    if (oldest.done) break;
    calibrations.delete(oldest.value);
  }
}

function clamp(value: number): number {
  return Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, value));
}

/**
 * Record what a conversation was actually charged against what we estimated.
 *
 * `estimated` must be the RAW estimate — what the fixed heuristic produced before any correction
 * was applied — and `charged` the token count implied by the upstream percentage. Passing the
 * already-corrected value instead would make the factor measure its own residual error rather
 * than the heuristic's, so each round would learn only the part it had not yet fixed and the
 * factor would settle short of the true ratio, permanently under-correcting.
 *
 * Non-finite, non-positive, or implausible inputs are ignored rather than clamped, because a bad
 * reading carries no information worth smoothing in.
 */
export function recordKiroCalibration(
  conversationId: string | undefined,
  estimated: number,
  charged: number,
): void {
  if (!conversationId) return;
  if (!Number.isFinite(estimated) || !Number.isFinite(charged)) return;
  if (estimated <= 0 || charged <= 0) return;
  const entry = calibrations.get(conversationId);
  // Prefer the raw estimate recorded at build time; fall back to the caller's value when this
  // conversation was never seen by `calibrateKiroEstimate` (a first turn, or a rebuilt retry).
  const baseline = entry?.rawEstimate ?? estimated;
  if (!Number.isFinite(baseline) || baseline <= 0) return;
  const observed = charged / baseline;
  if (!Number.isFinite(observed) || observed <= 0 || observed > MAX_PLAUSIBLE_OBSERVATION) return;

  // Smooth from 1 (the "no correction" prior) on the FIRST observation too. Jumping straight to
  // `clamp(observed)` would let a single cache-affected or truncated turn set the factor outright,
  // which is exactly the swing the smoothing exists to prevent.
  const previous = entry?.factor ?? 1;
  const next = clamp(previous + (observed - previous) * SMOOTHING);

  // The observation for this turn is consumed: dropping the raw estimate keeps a later record for
  // the same conversation from being scored a second time against a stale baseline, which would
  // re-learn the same correction from a payload that has since grown.
  touch(conversationId, () => ({ factor: next }));
}

/**
 * Apply a conversation's learned correction to an estimate. Unknown conversations are returned
 * unchanged, so the first turn behaves exactly as it did before calibration existed.
 */
export function calibrateKiroEstimate(conversationId: string | undefined, estimate: number): number {
  if (!conversationId || !Number.isFinite(estimate) || estimate <= 0) return estimate;
  touch(conversationId, current => ({ ...current, rawEstimate: estimate }));
  const factor = calibrations.get(conversationId)?.factor;
  return factor === undefined ? estimate : Math.ceil(estimate * factor);
}

/**
 * Carry a conversation's state to the id upstream actually returned.
 *
 * The estimate is stored under the id the request was BUILT with, but Kiro can answer with a
 * different conversation id, and the stream then records under that one. Without this the record
 * would miss its own raw estimate and silently fall back to the corrected value — the exact
 * feedback bug the raw estimate exists to avoid.
 */
export function rekeyKiroCalibration(fromConversationId: string | undefined, toConversationId: string | undefined): void {
  if (!fromConversationId || !toConversationId || fromConversationId === toConversationId) return;
  const entry = calibrations.get(fromConversationId);
  if (!entry) return;
  calibrations.delete(fromConversationId);
  touch(toConversationId, current => ({ ...current, ...entry }));
}

/** Test seam: drop all learned state. */
export function resetKiroCalibration(): void {
  calibrations.clear();
}
