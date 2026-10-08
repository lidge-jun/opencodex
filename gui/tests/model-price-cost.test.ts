import { describe, expect, test } from "bun:test";
import {
  EMPTY_CUSTOM, EMPTY_RATES, INVALID, buildDraftCost, loadDraft, parseModelCost, receiptMatches,
  type CustomDraft, type ModelCost, type RateDraft,
} from "../src/components/model-price-cost";

const base: RateDraft = { input: "1.25", output: "9.5", cacheRead: "", cacheWrite: "" };
const custom: CustomDraft = { input: "2.5", output: "19", cacheRead: "", cacheWrite: "", threshold: "200000", comparison: "gte" };
const rates = { input: 1.25, output: 9.5, cacheRead: 0, cacheWrite: 0 };
const saved: ModelCost = { ...rates, promptLengthPricing: { mode: "custom", thresholdTokens: 200000, comparison: "gte", rates: { input: 2.5, output: 19, cacheRead: 0, cacheWrite: 0 } } };

describe("model price cost contract", () => {
  test("normalizes an explicit automatic mode to absent", () => {
    expect(parseModelCost({ ...rates, promptLengthPricing: { mode: "automatic" } })).toEqual(rates);
    expect(parseModelCost({ ...rates, promptLengthPricing: { mode: "flat" } })).toEqual({ ...rates, promptLengthPricing: { mode: "flat" } });
    expect(parseModelCost({ ...rates, promptLengthPricing: { mode: "automatic", ignored: true } })).toBe(INVALID);
  });

  test("builds automatic without a key and defaults blank cache rates to zero", () => {
    expect(buildDraftCost(base, "automatic", EMPTY_CUSTOM)).toEqual({ cost: rates });
    expect(buildDraftCost(base, "flat", EMPTY_CUSTOM)).toEqual({ cost: { ...rates, promptLengthPricing: { mode: "flat" } } });
    expect(buildDraftCost(base, "custom", custom)).toEqual({ cost: saved });
  });

  test("loads saved custom values and validates positive safe-integer thresholds", () => {
    expect(loadDraft(saved)).toEqual({ rates: { input: "1.25", output: "9.5", cacheRead: "0", cacheWrite: "0" }, mode: "custom", custom: { ...custom, cacheRead: "0", cacheWrite: "0" } });
    for (const threshold of ["", "0", "1.5", "1e3", "007", "9007199254740993"]) {
      expect(buildDraftCost(base, "custom", { ...custom, threshold })).toEqual({ field: "threshold" });
    }
  });

  test("receipt comparison accepts absent and automatic as equal but checks custom data exactly", () => {
    expect(receiptMatches(rates, { ...rates, promptLengthPricing: { mode: "automatic" } })).toBe(true);
    expect(receiptMatches({ ...saved, promptLengthPricing: { ...saved.promptLengthPricing!, comparison: "gt" } }, saved)).toBe(false);
    expect(receiptMatches(null, null)).toBe(true);
    expect(receiptMatches(rates, null)).toBe(false);
  });
});
