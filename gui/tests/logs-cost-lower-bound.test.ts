import { describe, expect, test } from "bun:test";
import { DICTS } from "../src/i18n/catalogs";
import { interpolate, type Locale, type TFn } from "../src/i18n/shared";
import {
  effectivePriorityLowerBound,
  estimateReasonsForBilling,
  formatEstimatedUsd,
  formatEstimatedUsdValue,
  formatCredits,
  summarizeEstimatedCosts,
} from "../src/pages/logs-cost-format";

function translator(locale: Locale): TFn {
  return (key, vars) => interpolate(DICTS[locale][key], vars);
}

test("ordinary dashboard costs render as a bare dollar amount; the ~ lives in the column header", () => {
  expect(formatEstimatedUsdValue(0.77, translator("en"), "en-US", false)).toBe("$0.7700");
});

test("priority long-context lower bounds render with a greater-than-or-equal marker", () => {
  expect(formatEstimatedUsdValue(0.77, translator("en"), "en-US", true)).toBe("≥$0.7700");
});

test("small floors never round above their value", () => {
  expect(formatEstimatedUsdValue(0.00006, translator("en"), "en-US", true)).toBe("≥$0.0000");
  expect(formatEstimatedUsdValue(0.0001, translator("de"), "de-DE", true)).toBe("≥$0.0001");
  expect(formatEstimatedUsdValue(0.00009999, translator("en"), "en-US", true)).toBe("≥$0.0000");
  expect(formatEstimatedUsdValue(0.00019999, translator("en"), "en-US", true)).toBe("≥$0.0001");
  expect(formatEstimatedUsdValue(0, translator("en"), "en-US", true)).toBe("≥$0.0000");
  expect(formatEstimatedUsdValue(-1, translator("en"), "en-US", true)).toBe("—");
});

test("tiny credits stay nonzero", () => {
  expect(formatCredits(1e-7, "en-US")).toBe("0.0000001");
  expect(formatCredits(1e-7, "de-DE")).toBe("0,0000001");
  expect(formatCredits(0, "en-US")).toBe("0");
  expect(formatCredits(-1, "en-US")).toBe("—");
});

test("the dollar shape is fixed under a non-English locale; only the unavailable label is translated", () => {
  expect(formatEstimatedUsdValue(0.77, translator("de"), "de-DE", false)).toBe("$0.7700");
  expect(formatEstimatedUsd({ kind: "unavailable" }, translator("de"), "de-DE")).toBe("nicht verfügbar");
});

describe("conversation cost lower-bound aggregation", () => {
  const priced = (total: number, lowerBound: boolean) => ({
    usageStatus: "reported",
    displayMetrics: {
      cost: {
        kind: "value" as const,
        estimate: { cost: { total }, priorityLowerBound: lowerBound },
      },
    },
  });

  test("marks a total when any included priced estimate is a lower bound", () => {
    expect(summarizeEstimatedCosts([priced(0.77, true), priced(1.23, true)])).toMatchObject({
      estimatedCostUsd: 2,
      priorityLowerBound: true,
    });
    expect(summarizeEstimatedCosts([priced(0.77, true), priced(1.23, false)])).toMatchObject({
      estimatedCostUsd: 2,
      priorityLowerBound: true,
    });
  });

  test("preserves unpriced and unsupported exclusions without minting a lower bound", () => {
    expect(summarizeEstimatedCosts([
      { usageStatus: "reported", displayMetrics: { cost: { kind: "unavailable" } } },
      { usageStatus: "unsupported" },
    ])).toEqual({
      estimatedCostUsd: 0,
      priorityLowerBound: false,
      unpricedRequests: 1,
      unmeteredRequests: 1,
    });
  });
});

describe("a billing basis governs what the estimate may claim", () => {
  const credits = { source: "provider-credits" as const, providerCredits: 2, creditPriceUsd: 0.04 };

  test("a credit-only estimate cannot render as a lower bound, even from a stale row", () => {
    expect(effectivePriorityLowerBound({ priorityLowerBound: true })).toBe(true);
    expect(effectivePriorityLowerBound({ priorityLowerBound: true, billing: credits })).toBe(false);
    expect(effectivePriorityLowerBound({ priorityLowerBound: false, billing: credits })).toBe(false);
    expect(formatEstimatedUsd(
      { kind: "value", estimate: { cost: { total: 0.08 }, priorityLowerBound: true, billing: credits } },
      translator("en"),
      "en-US",
    )).toBe("$0.0800");
  });

  test("a mixed estimate keeps the floor its token leg earned", () => {
    // `credits x price + >=token` is still `>=` the true total, so the exact credit leg must not
    // erase a floor that a token-priced leg produced. Only a credits-ONLY total is exact.
    expect(effectivePriorityLowerBound({ priorityLowerBound: true, billing: { source: "mixed" } })).toBe(true);
    expect(effectivePriorityLowerBound({ priorityLowerBound: false, billing: { source: "mixed" } })).toBe(false);
    expect(formatEstimatedUsd(
      { kind: "value", estimate: { cost: { total: 1.29 }, priorityLowerBound: true, billing: { source: "mixed" } } },
      translator("en"),
      "en-US",
    )).toBe("≥$1.2900");
  });

  test("token-only reasons drop for a credit charge, survive for a mixed total, and keep the usage caveat", () => {
    const reasons = ["usage_estimated", "cache_detail_missing", "expected_price_overlay", "provider_cost_overlay", "priority_lower_bound"] as const;
    expect(estimateReasonsForBilling(reasons, { billing: credits })).toEqual(["usage_estimated"]);
    // A mixed total keeps its token leg's caveats, floor included: that leg really was a floor.
    expect(estimateReasonsForBilling(reasons, { billing: { source: "mixed" } })).toEqual([...reasons]);
    // No basis is a token price: every reason the proxy sent describes it.
    expect(estimateReasonsForBilling(reasons, {})).toEqual([...reasons]);
  });

  test("a credit row in a conversation total is not aggregated as a lower bound", () => {
    expect(summarizeEstimatedCosts([
      { usageStatus: "reported", displayMetrics: { cost: { kind: "value", estimate: { cost: { total: 0.08 }, priorityLowerBound: true, billing: credits } } } },
    ])).toMatchObject({ estimatedCostUsd: 0.08, priorityLowerBound: false });
  });
});
