import type { TFn } from "../i18n/shared";

export type CostBilling =
  | { source: "provider-credits"; providerCredits: number; creditPriceUsd: number }
  | { source: "mixed" };

type EstimatedCostResult = {
  kind: "value";
  estimate: { cost: { total: number }; priorityLowerBound?: boolean };
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

/**
 * A credit count is not a token count: `formatTokens` would round 1.95 to "1.95" but a count
 * like 1,250 becomes "1.3K", and a credit charge is the number the operator reconciles against
 * a provider invoice. Keep the digits, group them for the locale, and cap fractions rather
 * than dropping them.
 */
const CREDIT_FORMATS = new Map<string, Intl.NumberFormat>();

export function formatCredits(value: number, localeCode?: string): string {
  if (!Number.isFinite(value) || value < 0) return "\u2014";
  const key = localeCode ?? "";
  let formatter = CREDIT_FORMATS.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(key || undefined, { maximumFractionDigits: 6 });
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
  const amount = USD_FORMAT.format(value);
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
    result.estimate.priorityLowerBound,
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
  let everyPricedEstimateIsLowerBound = true;
  let pricedEstimates = 0;
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
        pricedEstimates += 1;
        everyPricedEstimateIsLowerBound &&= cost.estimate.priorityLowerBound === true;
        continue;
      }
    }
    unpricedRequests += 1;
  }
  return {
    estimatedCostUsd,
    priorityLowerBound: pricedEstimates > 0 && everyPricedEstimateIsLowerBound,
    unpricedRequests,
    unmeteredRequests,
  };
}
