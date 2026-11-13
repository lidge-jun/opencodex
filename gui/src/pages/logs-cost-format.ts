import type { TFn } from "../i18n/shared";

export type CostBilling =
  | { source: "provider-credits"; providerCredits: number; creditPriceUsd: number }
  | { source: "mixed" };

/** The reasons the proxy may attach to a value estimate. */
export type CostEstimateReason =
  | "usage_estimated"
  | "cache_detail_missing"
  | "expected_price_overlay"
  | "provider_cost_overlay"
  | "priority_lower_bound";

/**
 * What a billed estimate can say about itself.
 *
 * `priorityLowerBound` claims the amount is a floor under a rate the proxy could not resolve.
 * A credit charge is `credits x price`, exact for the configured price, so `>=` over it would be
 * a false claim about the amount. The proxy already withholds the marker at read time; this guard
 * covers a row seeded into the dashboard by an older build or served by an older proxy.
 *
 * A `mixed` total is a different case. `credits x price + >=token` is still `>=` the true total,
 * so an exact credit leg does not erase the floor a token leg earned. Only the credits-only basis
 * is stripped here.
 */
type BillingBasis = { billing?: CostBilling };

export function effectivePriorityLowerBound(estimate: BillingBasis & { priorityLowerBound?: boolean }): boolean {
  return estimate.priorityLowerBound === true && estimate.billing?.source !== "provider-credits";
}

/**
 * Reasons that qualify the TOKEN price rather than the charge.
 *
 * A credit charge never used the resolved token rates: the cache caveat, both price overlays and
 * the Priority floor describe a rate nobody was billed. `usage_estimated` stays, because the
 * credits were still derived from an estimated usage reading. A `mixed` total keeps its token
 * leg's caveats — including the floor, since `credits + >=token` remains a floor — and a
 * credits-only total keeps none of them.
 */
const TOKEN_PRICE_REASONS: ReadonlySet<CostEstimateReason> = new Set([
  "cache_detail_missing", "expected_price_overlay", "provider_cost_overlay", "priority_lower_bound",
]);

export function estimateReasonsForBilling(
  reasons: readonly CostEstimateReason[],
  estimate: BillingBasis,
): CostEstimateReason[] {
  if (!estimate.billing) return [...reasons];
  if (estimate.billing.source === "mixed") return [...reasons];
  return reasons.filter(reason => !TOKEN_PRICE_REASONS.has(reason));
}

type EstimatedCostResult = {
  kind: "value";
  estimate: { cost: { total: number }; priorityLowerBound?: boolean; billing?: CostBilling };
} | { kind: "unavailable" };

/**
 * Cost cells render a fixed `$0.1401` in every locale. The column header is the untranslated
 * `~$`, and the CLI usage report prints `~$12.3456`, so a locale-shaped amount under that
 * header (`약 US$0.1401`, `0,1401 $US`) read as a different unit rather than a translation.
 * `narrowSymbol` is what drops the `US` qualifier; en-US fixes the separators.
 */
const USD_FORMAT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  currencyDisplay: "narrowSymbol",
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});
const USD_FLOOR_FORMAT = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", currencyDisplay: "narrowSymbol",
  minimumFractionDigits: 4, maximumFractionDigits: 4, roundingMode: "floor",
});
const USD_FLOOR_SUPPORTED = USD_FLOOR_FORMAT.resolvedOptions().roundingMode === "floor";

/**
 * A credit count is not a token count: `formatTokens` would round 1.95 to "1.95" but a count
 * like 1,250 becomes "1.3K", and a credit charge is the number the operator reconciles against
 * a provider invoice. Keep significant digits and locale-specific grouping, including tiny values.
 */
const CREDIT_FORMATS = new Map<string, Intl.NumberFormat>();

export function formatCredits(value: number, localeCode?: string): string {
  if (!Number.isFinite(value) || value < 0) return "\u2014";
  const key = localeCode ?? "";
  let formatter = CREDIT_FORMATS.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(key || undefined, { maximumSignificantDigits: 15 });
    CREDIT_FORMATS.set(key, formatter);
  }
  return formatter.format(value);
}

/**
 * A unit price, not a charge. `formatEstimatedUsdValue` fixes four decimals, which renders a
 * legitimate sub-cent credit price as `$0.0000` — the same "zero that is not a zero" the credit
 * basis exists to remove. Significant digits keep a small price visible without inventing
 * precision the operator did not configure.
 */
const USD_PRECISE = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  currencyDisplay: "narrowSymbol",
  maximumSignificantDigits: 6,
});

export function formatUsdPrecise(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "\u2014";
  return USD_PRECISE.format(value);
}

export function formatEstimatedUsdValue(
  value: number,
  t: TFn,
  _localeTag?: string,
  priorityLowerBound = false,
): string {
  if (!Number.isFinite(value) || value < 0) return t("logs.cost.unavailable");
  let amount: string;
  if (priorityLowerBound && !USD_FLOOR_SUPPORTED) {
    // Older Intl implementations ignore roundingMode. Keep their displayed floor conservative.
    const units = Math.floor(value * 10_000);
    const rounded = Number.isSafeInteger(units) ? units / 10_000 : Math.floor(value);
    amount = USD_FORMAT.format(rounded > value ? (units - 1) / 10_000 : rounded);
  } else {
    amount = (priorityLowerBound ? USD_FLOOR_FORMAT : USD_FORMAT).format(value);
  }
  return t(priorityLowerBound ? "logs.cost.lowerBound" : "logs.cost.approximate", { amount });
}

export function formatEstimatedUsd(
  result: EstimatedCostResult | undefined,
  t: TFn,
  localeTag?: string,
): string {
  if (!result || result.kind === "unavailable") return t("logs.cost.unavailable");
  return formatEstimatedUsdValue(
    result.estimate.cost.total,
    t,
    localeTag,
    effectivePriorityLowerBound(result.estimate),
  );
}

interface CostSummaryEntry {
  usageStatus?: string;
  displayMetrics?: { cost: EstimatedCostResult };
}

export function summarizeEstimatedCosts(entries: readonly CostSummaryEntry[]): {
  estimatedCostUsd: number;
  priorityLowerBound: boolean;
  unpricedRequests: number;
  unmeteredRequests: number;
} {
  let estimatedCostUsd = 0;
  let anyPricedEstimateIsLowerBound = false;
  let unpricedRequests = 0;
  let unmeteredRequests = 0;
  for (const entry of entries) {
    if (entry.usageStatus === "unsupported") {
      unmeteredRequests += 1;
      continue;
    }
    const cost = entry.displayMetrics?.cost;
    if (cost?.kind === "value") {
      const total = cost.estimate.cost.total;
      if (Number.isFinite(total) && total >= 0) {
        estimatedCostUsd += total;
        anyPricedEstimateIsLowerBound ||= effectivePriorityLowerBound(cost.estimate);
        continue;
      }
    }
    unpricedRequests += 1;
  }
  return {
    estimatedCostUsd,
    priorityLowerBound: anyPricedEstimateIsLowerBound,
    unpricedRequests,
    unmeteredRequests,
  };
}
