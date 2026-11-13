/**
 * Credit-billed pricing bounds and the billing basis a cost estimate reports.
 *
 * A provider that bills credits (Kiro) reports a measured credit count, and the operator may
 * configure a USD price per credit. Both numbers arrive independently, so bounding them one at a
 * time is not enough: `1e308 x 1e308` is still `Infinity`, and `JSON.stringify` turns that into
 * `null`. This module owns the pair of bounds that keeps `credits x price` representable, and the
 * discriminated billing basis that lets a consumer tell a credit charge from a token allocation
 * instead of reading four zero component costs as a measured split.
 *
 * The bounds are deliberately absurd relative to real usage — the most expensive published plans
 * are cents per credit, and a single response reports at most a few thousand credits — so no
 * plausible row is refused, while an unbounded or corrupted value fails closed instead of
 * serializing as `null`.
 */

/** Upper bound for a configured USD price of one credit. */
export const MAX_CREDIT_PRICE_USD = 1_000_000;

/** Upper bound for the credits a single attempt may report. */
export const MAX_PROVIDER_CREDITS = 1_000_000_000;

/** Preserve invalid or incomplete credit evidence when usage snapshots are combined. */
export function sumCreditReadings(values: readonly (number | undefined)[]): number | undefined {
  const readings = values.filter((value): value is number => value !== undefined);
  if (readings.length === 0) return undefined;
  if (readings.length !== values.length || readings.some(value => !Number.isFinite(value) || value < 0)) return -1;
  return readings.reduce((sum, value) => sum + value, 0);
}

/**
 * A price that can be multiplied by any admissible credit count without overflowing.
 * The product stays well inside the safe-integer range, so a sum over attempts stays exact
 * enough for display and cannot reach `Infinity`.
 */
export function isValidCreditPriceBound(value: unknown): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= 0
    && value <= MAX_CREDIT_PRICE_USD;
}

/** A credit count small enough that `count x price` is representable for any admissible price. */
export function isRepresentableCreditCount(value: unknown): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= 0
    && value <= MAX_PROVIDER_CREDITS;
}

/**
 * Upper bound for one token bucket of a priced request.
 *
 * `MAX_CREDIT_PRICE_USD` bounds the price, and this bounds the count, for the same reason the
 * credit pair exists: a token estimate is `rate x tokens / 1e6`, and a corrupt row can carry
 * `tokens = 1e308`. The rate is itself bounded (`MAX_COST4_RATE`), but that bound multiplied by an
 * unbounded token count is still `Infinity`, which `JSON.stringify` turns into `null`. 1e12 tokens
 * is roughly half a million full 2M-token contexts in a single request, so no real row is refused.
 */
export const MAX_COST_TOKENS = 1_000_000_000_000;

/** Every normalized token bucket small enough for `rate x tokens / 1e6` to stay finite. */
export function costTokensWithinBound(tokens: {
  input: number; output: number; cacheRead: number; cacheWrite: number;
}): boolean {
  return tokens.input <= MAX_COST_TOKENS
    && tokens.output <= MAX_COST_TOKENS
    && tokens.cacheRead <= MAX_COST_TOKENS
    && tokens.cacheWrite <= MAX_COST_TOKENS;
}

/**
 * How a cost estimate was billed.
 *
 * `provider-credits` means the total is `providerCredits x creditPriceUsd`; the token component
 * fields carry no allocation and must not be displayed as charges. `mixed` means the total is the
 * sum of attempt costs that were not all billed the same way (or not all at the same credit
 * price), so the aggregate has no single split — only the per-attempt estimates do.
 */
export type CreditBilling =
  | { source: "provider-credits"; providerCredits: number; creditPriceUsd: number }
  | { source: "mixed" };
