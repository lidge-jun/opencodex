import { expect, test } from "bun:test";
import { estimateRequestCost, resolveMatchedPrice } from "../../src/usage/cost";

test("Antigravity Gemini 4 prices exact effort IDs using reported input, output and cache hits", () => {
  const usage = { inputTokens: 10_000, outputTokens: 1_000, cachedInputTokens: 4_000, reasoningOutputTokens: 800 };
  for (const [base, expected] of [
    ["gemini-4-neon", { input: 0.018, output: 0.015, cacheRead: 0.0006, total: 0.0336 }],
    ["gemini-4-hydrogen", { input: 0.009, output: 0.0075, cacheRead: 0.0003, total: 0.0168 }],
  ] as const) {
    for (const suffix of ["", "-low", "-medium", "-high", "-xhigh"]) {
      const estimate = estimateRequestCost({
        provider: "google-antigravity", model: base + suffix, usage, usageStatus: "reported",
      });
      expect(estimate?.price).toMatchObject({ modelId: base + suffix, source: "expected", status: "verified-derived" });
      expect(estimate?.estimated).toBe(true);
      expect(estimate?.tokens).toEqual({ input: 6_000, output: 1_000, cacheRead: 4_000, cacheWrite: 0 });
      expect(estimate?.cost.cacheWrite).toBe(0);
      for (const component of ["input", "output", "cacheRead", "total"] as const) {
        expect(estimate!.cost[component]).toBeCloseTo(expected[component], 12);
      }
    }
    const direct = resolveMatchedPrice("google", base);
    expect(direct?.status).toBe("verified");
  }
  expect(resolveMatchedPrice("google-antigravity", "gemini-discovery-fixture")).toBeNull();
});
