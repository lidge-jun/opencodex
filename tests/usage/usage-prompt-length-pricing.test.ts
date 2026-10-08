import { describe, expect, test } from "bun:test";
import type { AttemptTierOutcome, OcxUsage } from "../../src/types";
import type { PromptLengthPricing } from "../../src/types/provider";
import { estimateAttemptCost, estimateComboCost, estimateRequestCost, type ServiceTierInput } from "../../src/usage/cost";
import { CONTEXT_TIERS, type Cost4, type ExpectedPriceOverlay } from "../../src/usage/expected-prices";

const BASE: Cost4 = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 };
const ABOVE: Cost4 = { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 };
const custom = (thresholdTokens = 100_000, comparison: "gt" | "gte" = "gt"): PromptLengthPricing => ({
  mode: "custom", thresholdTokens, comparison, rates: ABOVE,
});
function rows(policy?: PromptLengthPricing, provider = "anthropic", modelId = "claude-haiku-5-5", cost4 = BASE): ExpectedPriceOverlay[] {
  return [{ provider, modelId, cost4, promptLengthPricing: policy, source: "user test", verifiedAt: "user-configured", status: "verified" }];
}
function estimate(usage: OcxUsage, policy?: PromptLengthPricing, provider = "anthropic", model = "claude-haiku-5-5", serviceTier?: ServiceTierInput) {
  return estimateRequestCost({ provider, model, usage, usageStatus: "reported", serviceTier }, undefined, rows(policy, provider, model));
}
function expectCharges(result: ReturnType<typeof estimate>, usage: OcxUsage, rates: Cost4, multiplier = 1) {
  expect(result).not.toBeNull();
  const read = usage.cacheReadInputTokens ?? usage.cachedInputTokens ?? 0;
  const write = usage.cacheCreationInputTokens ?? 0;
  const expected = {
    input: (usage.inputTokens! - read - write) * rates.input * multiplier / 1e6,
    output: usage.outputTokens! * rates.output * multiplier / 1e6,
    cacheRead: read * rates.cacheRead * multiplier / 1e6,
    cacheWrite: write * rates.cacheWrite * multiplier / 1e6,
  };
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    expect(result!.cost[key]).toBeCloseTo(expected[key], 12);
  }
  expect(result!.cost.total).toBeCloseTo(Object.values(expected).reduce((a, b) => a + b, 0), 12);
}

describe("user prompt-length pricing", () => {
  for (const threshold of [100_000, 272_000]) {
    for (const comparison of ["gt", "gte"] as const) {
      for (const offset of [-1, 0, 1]) {
        test(`${comparison} ${threshold}: prompt at boundary ${offset >= 0 ? "+" : ""}${offset}`, () => {
          const usage = { inputTokens: threshold + offset, outputTokens: 500 };
          const crossed = offset > 0 || (comparison === "gte" && offset === 0);
          const result = estimate(usage, custom(threshold, comparison));
          expectCharges(result, usage, crossed ? ABOVE : BASE);
          expect(result?.customThresholdApplied).toBe(crossed ? true : undefined);
          expect(result?.contextTier).toBeUndefined();
        });
      }
    }
  }

  test("cached reads and writes count toward the threshold once; all four rates change", () => {
    const usage = { inputTokens: 100_001, outputTokens: 10_000, cacheReadInputTokens: 90_000, cacheCreationInputTokens: 10_000 };
    expectCharges(estimate(usage, custom()), usage, ABOVE);
    const below = { ...usage, inputTokens: 100_000 };
    expectCharges(estimate(below, custom()), below, BASE);
    const fullyCached = { inputTokens: 280_000, outputTokens: 1, cachedInputTokens: 280_000 };
    expectCharges(estimate(fullyCached, custom(272_000)), fullyCached, ABOVE);
  });

  test("output tokens never push a short prompt over its threshold", () => {
    const usage = { inputTokens: 1, outputTokens: 1_000_000 };
    expectCharges(estimate(usage, custom()), usage, BASE);
  });

  test("flat and custom replace the automatic rule below and above the custom boundary", () => {
    const provider = "openai-apikey", model = "gpt-6-astra";
    for (const count of [280_000, 400_001]) {
      const usage = { inputTokens: count, outputTokens: 1_000 };
      expectCharges(estimate(usage, { mode: "flat" }, provider, model), usage, BASE);
      const result = estimate(usage, custom(400_000), provider, model);
      expectCharges(result, usage, count > 400_000 ? ABOVE : BASE);
      expect(result?.contextTier).toBeUndefined();
    }
    const usage = { inputTokens: 100_001, outputTokens: 1_000 };
    expectCharges(estimate(usage, custom(), provider, model), usage, ABOVE);
  });

  test("legacy and explicit automatic overrides retain catalog multipliers", () => {
    const usage = { inputTokens: 280_000, outputTokens: 100, cacheReadInputTokens: 200_000, cacheCreationInputTokens: 10_000 };
    const expected = { input: BASE.input * 2, output: BASE.output * 1.5, cacheRead: BASE.cacheRead * 2, cacheWrite: BASE.cacheWrite * 2 };
    for (const policy of [undefined, { mode: "automatic" } as const]) {
      const result = estimate(usage, policy, "openai-apikey", "gpt-6-astra");
      expectCharges(result, usage, expected);
      expect(result?.contextTier).toBe("long");
      expect(result?.customThresholdApplied).toBeUndefined();
    }
  });

  test("zero base and zero alternative tuples remain authoritative", () => {
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const input = { provider: "custom", model: "private-model", usageStatus: "reported" as const, usage: { inputTokens: 100_001, outputTokens: 100 } };
    expectCharges(estimateRequestCost(input, undefined, rows(custom(), input.provider, input.model, zero)), input.usage, ABOVE);
    const freePolicy: PromptLengthPricing = { ...custom(), mode: "custom", thresholdTokens: 100_000, comparison: "gt", rates: zero };
    expectCharges(estimateRequestCost(input, undefined, rows(freePolicy, input.provider, input.model)), input.usage, zero);
  });

  test("OpenAI priority applies once after custom or flat selection, automatic still stacks", () => {
    const usage = { inputTokens: 280_000, outputTokens: 100, cacheReadInputTokens: 200_000 };
    for (const tier of ["priority", { requestedServiceTier: "priority" }, { configuredServiceTier: "priority" }, { responseServiceTier: "priority" }]) {
      expectCharges(estimate(usage, custom(), "openai-apikey", "gpt-6-astra", tier), usage, ABOVE, 2);
      expectCharges(estimate(usage, { mode: "flat" }, "openai-apikey", "gpt-6-astra", tier), usage, BASE, 2);
      const auto = estimate(usage, undefined, "openai-apikey", "gpt-6-astra", tier);
      expect(auto?.cost.input).toBeCloseTo(80_000 * BASE.input * 2 * 2 / 1e6, 12);
    }
  });

  test("Anthropic and xAI confirmation and downgrade rules remain independent", () => {
    const usage = { inputTokens: 280_000, outputTokens: 100 };
    for (const [provider, model] of [["anthropic", "claude-opus-5-5"], ["xai", "grok-4.7"]]) {
      for (const tier of ["priority", { requestedServiceTier: "priority" }, { configuredServiceTier: "priority" }, { requestedServiceTier: "priority", responseServiceTier: "standard" }]) {
        expectCharges(estimate(usage, custom(), provider, model, tier), usage, ABOVE);
      }
      const result = estimate(usage, custom(), provider, model, { responseServiceTier: "priority" });
      expectCharges(result, usage, ABOVE, provider === "xai" ? 1 : 2);
      expect(result?.priorityLowerBound).toBe(provider === "xai" ? true : undefined);
    }
    const legacyXai = estimate(usage, undefined, "xai", "grok-4.7", { responseServiceTier: "priority" });
    expect(legacyXai?.priorityLowerBound).toBe(true);
    expect(legacyXai?.priorityMultiplier).toBeUndefined();
  });

  test("custom policy inherits a catalog exclusive Priority relation only when confirmed", () => {
    const rule = CONTEXT_TIERS.find(row => row.provider === "openai-apikey" && row.modelId === "gpt-6-astra")!;
    const before = rule.confirmedPriorityRelation;
    try {
      rule.confirmedPriorityRelation = "exclusive";
      const usage = { inputTokens: 280_000, outputTokens: 100 };
      const tier = { responseServiceTier: "priority" };
      expectCharges(estimate(usage, undefined, rule.provider, rule.modelId, tier), usage, BASE, 2);
      const result = estimate(usage, custom(), rule.provider, rule.modelId, tier);
      expectCharges(result, usage, BASE, 2);
      expect(result?.customThresholdApplied).toBeUndefined();
      expect(result?.priorityLowerBound).toBeUndefined();
      expectCharges(estimate(usage, custom(), rule.provider, rule.modelId, { requestedServiceTier: "priority" }), usage, ABOVE, 2);
      expectCharges(estimate(usage, { mode: "flat" }, rule.provider, rule.modelId, tier), usage, BASE, 2);
    } finally { rule.confirmedPriorityRelation = before; }
  });

  test("xAI custom confirmed Priority uses the custom rates as a lower bound", () => {
    const usage = { inputTokens: 300_000, outputTokens: 1_000 };
    const base = { input: 3, output: 15, cacheRead: 0.5, cacheWrite: 0 };
    const rates = { input: 6, output: 30, cacheRead: 1, cacheWrite: 0 };
    const policy: PromptLengthPricing = { mode: "custom", thresholdTokens: 200_000, comparison: "gte", rates };
    const overlays = rows(policy, "xai", "grok-4.7", base);
    const serviceTier = { requestedServiceTier: "priority", responseServiceTier: "priority" };
    const request = { provider: "xai", model: "grok-4.7", usage, usageStatus: "reported" as const };
    for (const result of [estimateRequestCost({ ...request, serviceTier }, undefined, overlays),
      estimateAttemptCost({ ...request, ordinal: 1 }, undefined, serviceTier, overlays)]) {
      expectCharges(result, usage, rates);
      expect(result?.cost.total).toBeCloseTo(1.83, 12);
      expect(result?.priorityLowerBound).toBe(true);
      expect(result?.priorityMultiplier).toBeUndefined();
      expect(result?.customThresholdApplied).toBe(true);
      expect(result?.contextTier).toBeUndefined();
    }
    expectCharges(estimate(usage, { mode: "flat" }, "xai", "grok-4.7", serviceTier), usage, BASE, 2);
  });

  test("custom Priority stacks once with a catalog stack relation or no context rule", () => {
    const usage = { inputTokens: 300_000, outputTokens: 1_000 };
    for (const [provider, model] of [["openai-apikey", "gpt-6-astra"], ["anthropic", "claude-opus-5-5"]]) {
      const result = estimate(usage, custom(), provider, model, { responseServiceTier: "priority" });
      expectCharges(result, usage, ABOVE, 2);
      expect(result?.priorityMultiplier).toBe(2);
      expect(result?.priorityLowerBound).toBeUndefined();
      expect(result?.customThresholdApplied).toBe(true);
    }
  });

  test("Cursor explicit Fast IDs retain user prices; variant outcomes apply one premium", () => {
    const usage = { inputTokens: 100_001, outputTokens: 100 };
    expectCharges(estimate(usage, custom(), "cursor", "claude-opus-5-5-high-fast", { requestedServiceTier: "priority" }), usage, ABOVE);
    expectCharges(estimate(usage, custom(), "cursor", "claude-opus-5-5", { requestedServiceTier: "priority" }), usage, ABOVE, 2);
  });

  test("OpenRouter unknown Priority prices keep their lower-bound provenance", () => {
    const outcome: AttemptTierOutcome = { canonical: "priority", wireKind: "service-tier", wireValue: "priority", fastOutcome: "applied", confirmation: "assumed" };
    const usage = { inputTokens: 100_001, outputTokens: 100 };
    const result = estimateAttemptCost({ ordinal: 1, provider: "openrouter", model: "anthropic/test", usageStatus: "reported", usage, tierOutcome: outcome }, undefined, undefined, rows(custom(), "openrouter", "anthropic/test"));
    expectCharges(result, usage, ABOVE);
    expect(result?.priorityLowerBound).toBe(true);
  });

  test("each Combo attempt evaluates its own prompt; sums do not select a shared band", () => {
    const common = { provider: "anthropic", model: "claude-haiku-5-5", usageStatus: "reported" as const };
    const attempts = [
      { ...common, ordinal: 1, usage: { inputTokens: 90_000, outputTokens: 100 } },
      { ...common, ordinal: 2, usage: { inputTokens: 100_001, outputTokens: 100 } },
    ];
    const result = estimateComboCost(attempts, undefined, undefined, rows(custom()));
    expectCharges(result?.attempts?.[0] ?? null, attempts[0]!.usage, BASE);
    expectCharges(result?.attempts?.[1] ?? null, attempts[1]!.usage, ABOVE);
    expect(result?.cost.total).toBeCloseTo(0.00905 + 0.0502505, 12);
    expect(result?.customThresholdApplied).toBe(true);
    expect(result?.contextTier).toBeUndefined();
    expect(estimateComboCost([...attempts, { ...common, ordinal: 3 }], undefined, undefined, rows(custom()))).toBeNull();
  });

  test("invalid token evidence remains unavailable instead of falling through to a custom price", () => {
    for (const usage of [{ outputTokens: 100 }, { inputTokens: -1, outputTokens: 100 }, { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 2 }]) {
      expect(estimate(usage, custom())).toBeNull();
    }
  });
});
