import { describe, expect, test } from "bun:test";
import { createAdapterTierMetadata } from "../../src/providers/fastwire";
import type { AttemptTierOutcome } from "../../src/types";
import { estimateAttemptCost, resolveMatchedPrice } from "../../src/usage/cost";
import { findPriorityPricingRule } from "../../src/usage/expected-prices";

const usage = {
  inputTokens: 100_000,
  outputTokens: 10_000,
  cacheReadInputTokens: 20_000,
  cacheCreationInputTokens: 10_000,
};

const opusPrices = [
  { model: "claude-opus-5-5", standard: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }, fastTotal: 1.068 },
  { model: "claude-opus-5", standard: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, fastTotal: 1.345 },
  { model: "claude-opus-4-8", standard: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, fastTotal: 1.345 },
] as const;

function tierOutcome(responseSpeed?: string): AttemptTierOutcome {
  const tracker = createAdapterTierMetadata(
    {
      capability: true,
      eligibility: "eligible",
      fastWire: {
        kind: "anthropic-speed",
        canonicalToWire: { priority: "fast" },
        foreignCallerTiers: "drop",
        betas: ["fast-mode-2026-02-01"],
      },
      demandDecision: "force-fast",
    },
    { kind: "set", value: "priority" },
    "anthropic-speed",
    "fast",
  )!;
  if (responseSpeed !== undefined) tracker.observeResponseServiceTier(responseSpeed);
  return tracker.outcome;
}

function estimate(provider: string, model: string, outcome: AttemptTierOutcome) {
  return estimateAttemptCost({
    ordinal: 1,
    provider,
    model,
    usageStatus: "reported",
    usage,
    tierOutcome: outcome,
  });
}

describe("Anthropic fast pricing", () => {
  test("all six first-party pairs resolve the published standard tuple and require a confirmed fast echo", () => {
    for (const provider of ["anthropic", "anthropic-apikey"]) {
      for (const { model, standard } of opusPrices) {
        expect(resolveMatchedPrice(provider, model)?.cost4).toEqual(standard);
        expect(findPriorityPricingRule(provider, model)).toMatchObject({
          provider,
          modelId: model,
          multiplier: 2,
          requiresResponseConfirmation: true,
          source: "https://platform.claude.com/docs/en/about-claude/pricing",
          verifiedAt: "2026-09-23",
        });
      }
    }
  });

  test("confirmed fast doubles input, output, cache read, and 5-minute cache write on both providers and a pooled OAuth label", () => {
    const confirmed = tierOutcome("fast");
    expect(confirmed).toMatchObject({
      canonical: "priority",
      wireKind: "anthropic-speed",
      fastOutcome: "applied",
      confirmation: "confirmed",
      responseServiceTier: "fast",
    });

    for (const provider of ["anthropic", "anthropic-pabcdef", "anthropic-apikey"]) {
      for (const { model, standard, fastTotal } of opusPrices) {
        const result = estimate(provider, model, confirmed);
        expect(result).not.toBeNull();
        expect(result!.price.cost4).toEqual(standard);
        expect(result!.priorityMultiplier).toBe(2);
        expect(result!.cost.input).toBeCloseTo(70_000 * standard.input * 2 / 1_000_000, 10);
        expect(result!.cost.output).toBeCloseTo(10_000 * standard.output * 2 / 1_000_000, 10);
        expect(result!.cost.cacheRead).toBeCloseTo(20_000 * standard.cacheRead * 2 / 1_000_000, 10);
        expect(result!.cost.cacheWrite).toBeCloseTo(10_000 * standard.cacheWrite * 2 / 1_000_000, 10);
        expect(result!.cost.total).toBeCloseTo(fastTotal, 10);
      }
    }
  });

  test("assumed fast and a standard response echo retain standard pricing", () => {
    const assumed = tierOutcome();
    const downgraded = tierOutcome("standard");
    expect(assumed).toMatchObject({ canonical: "priority", wireKind: "anthropic-speed", confirmation: "assumed" });
    expect(downgraded).toMatchObject({
      wireKind: "anthropic-speed",
      fastOutcome: "downgraded",
      fastDowngradeReason: "response-declined",
      confirmation: "downgraded",
      responseServiceTier: "standard",
    });

    for (const provider of ["anthropic", "anthropic-pabcdef", "anthropic-apikey"]) {
      for (const { model, fastTotal } of opusPrices) {
        for (const outcome of [assumed, downgraded]) {
          const result = estimate(provider, model, outcome);
          expect(result?.priorityMultiplier).toBeUndefined();
          expect(result?.cost.total).toBeCloseTo(fastTotal / 2, 10);
        }
      }
    }
  });

  test("unlisted Sonnet and a priced OpenRouter reseller slug never inherit Anthropic fast rules", () => {
    const confirmed = tierOutcome("fast");
    const sonnet = estimate("anthropic", "claude-sonnet-5", confirmed);
    expect(sonnet?.price.cost4).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 });
    expect(sonnet?.cost.total).toBeCloseTo(0.269, 10);
    expect(sonnet?.priorityMultiplier).toBeUndefined();
    expect(findPriorityPricingRule("anthropic", "claude-sonnet-5")).toBeUndefined();

    const resellerModel = "anthropic/claude-opus-5.5";
    const reseller = estimate("openrouter", resellerModel, confirmed);
    expect(reseller?.price.cost4).toEqual(opusPrices[0]!.standard);
    expect(reseller?.cost.total).toBeCloseTo(opusPrices[0]!.fastTotal / 2, 10);
    expect(reseller?.priorityMultiplier).toBeUndefined();
    expect(findPriorityPricingRule("openrouter", resellerModel)).toBeUndefined();
  });
});
