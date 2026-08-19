import { describe, expect, test } from "bun:test";
import { DICTS } from "../src/i18n/catalogs";
import { interpolate, type TFn } from "../src/i18n/shared";
import {
  formatEstimatedUsd,
  formatEstimatedUsdValue,
  summarizeEstimatedCosts,
} from "../src/pages/logs-cost-format";

function translator(locale: keyof typeof DICTS): TFn {
  return (key, vars) => interpolate(DICTS[locale][key], vars);
}

const en = translator("en");
const de = translator("de");

describe("Logs priority lower-bound formatting", () => {
  test("prefixes confirmed unpriced priority estimates with the lower-bound marker", () => {
    expect(formatEstimatedUsdValue(1.6, en, "en-US", true)).toBe("≥$1.6000");
  });

  test("keeps ordinary standard-price estimates unchanged", () => {
    expect(formatEstimatedUsdValue(1.6, en, "en-US", false)).toBe("~$1.6000");
  });

  test("uses locale-aware USD placement and separators", () => {
    expect(formatEstimatedUsdValue(1.6, de, "de-DE", false)).toBe("ca. 1,6000\u00a0$");
  });
});

describe("Logs table cost formatting", () => {
  test("uses the shared value formatter for lower bounds, ordinary estimates, and unavailable costs", () => {
    expect(formatEstimatedUsd({
      kind: "value",
      estimate: { cost: { total: 1.6 }, priorityLowerBound: true },
    }, en, "en-US")).toBe("≥$1.6000");
    expect(formatEstimatedUsd({
      kind: "value",
      estimate: { cost: { total: 1.6 } },
    }, en, "en-US")).toBe("~$1.6000");
    expect(formatEstimatedUsd({ kind: "unavailable" }, en, "en-US")).toBe("—");
    expect(formatEstimatedUsdValue(Number.NaN, en, "en-US")).toBe("—");
  });
});

describe("Logs conversation cost aggregation", () => {
  test("does not mark a mixed ordinary and lower-bound total as a lower bound", () => {
    const summary = summarizeEstimatedCosts([
      {
        usageStatus: "reported",
        displayMetrics: {
          cost: {
            kind: "value",
            estimate: { cost: { total: 1.6 }, priorityLowerBound: true },
          },
        },
      },
      {
        usageStatus: "reported",
        displayMetrics: {
          cost: {
            kind: "value",
            estimate: { cost: { total: 0.4 } },
          },
        },
      },
    ]);

    expect(summary.estimatedCostUsd).toBe(2);
    expect(summary.priorityLowerBound).toBe(false);
  });

  test("marks a total as a lower bound only when every priced estimate is one", () => {
    const summary = summarizeEstimatedCosts([
      {
        usageStatus: "reported",
        displayMetrics: {
          cost: {
            kind: "value",
            estimate: { cost: { total: 1.6 }, priorityLowerBound: true },
          },
        },
      },
      {
        usageStatus: "reported",
        displayMetrics: {
          cost: {
            kind: "value",
            estimate: { cost: { total: 0.4 }, priorityLowerBound: true },
          },
        },
      },
    ]);

    expect(summary.estimatedCostUsd).toBe(2);
    expect(summary.priorityLowerBound).toBe(true);
  });

  test("does not mark an unpriced-only total as a lower bound", () => {
    const summary = summarizeEstimatedCosts([
      {
        usageStatus: "reported",
        displayMetrics: { cost: { kind: "unavailable" } },
      },
    ]);

    expect(summary.estimatedCostUsd).toBe(0);
    expect(summary.priorityLowerBound).toBe(false);
    expect(summary.unpricedRequests).toBe(1);
  });
});
