/** GPT-6.1 Terra API facts verified 2026-10-27; vendor windows retain their Sol snapshot. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { getModelMetadata } from "../../src/generated/model-metadata";
import { estimateAttemptCost, estimateRequestCost } from "../../src/usage/cost";
import {
  CONTEXT_TIERS, EXPECTED_PRICE_OVERLAYS, findContextTier, findExpectedPriceOverlay,
  findPriorityPricingRule, resolvePriorityMultiplier,
} from "../../src/usage/expected-prices";
import { repoPath } from "../helpers/repo-root";

const MODEL = "gpt-6.1-terra";
const PRICE = { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 };
const LONG_PRICE = { input: 2, output: 7.5, cacheRead: 0.1, cacheWrite: 2.5 };
const SOURCE = "https://developers.openai.com/api/docs/models/gpt-6.1-terra";
const metadataRows = [
  ["openai", MODEL, 1_050_000],
  ["openai-codex", MODEL, 500_000],
  ["github-copilot", MODEL, 373_000],
  ["amazon-bedrock", `openai.${MODEL}`, 373_000],
  ["openrouter", `openai/${MODEL}`, 1_050_000],
  ["vercel-ai-gateway", `openai/${MODEL}`, 373_000],
] as const;

describe("GPT-6.1 Terra pricing", () => {
  test.each(["openai-apikey", "openai"])("%s has a dated API-reference overlay", provider => {
    const row = findExpectedPriceOverlay(provider, MODEL);
    expect(row).toMatchObject({ cost4: PRICE, verifiedAt: "2026-10-27",
      status: provider === "openai-apikey" ? "verified" : "verified-derived" });
    expect(row?.source).toContain(SOURCE);
    expect(EXPECTED_PRICE_OVERLAYS.filter(item => item.provider === provider && item.modelId === MODEL)).toHaveLength(1);
    expect(findExpectedPriceOverlay(provider, "gpt-6.1-sol")?.cost4)
      .toEqual({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
  });

  test.each(["devin", "devin-cli"])("%s retains a derived enterprise reference", provider => {
    expect(findExpectedPriceOverlay(provider, "gpt-6-1-terra"))
      .toMatchObject({ cost4: PRICE, status: "verified-derived", verifiedAt: "2026-10-27" });
    expect(findExpectedPriceOverlay(provider, "gpt-6-1-sol")?.cost4)
      .toEqual({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
    if (provider === "devin") expect(findExpectedPriceOverlay(provider, "gpt-5-6-terra")?.cost4)
      .toEqual({ input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 });
  });

  test.each(["openai", "openai-apikey"])("%s reprices all buckets strictly above 272K raw input", provider => {
    const tier = findContextTier(provider, MODEL);
    expect(tier).toMatchObject({ thresholdInputTokens: 272_000, inclusive: false,
      multiplier: { input: 2, output: 1.5, cacheRead: 2, cacheWrite: 2 }, confirmedPriorityRelation: "stack" });
    expect(tier?.source).toBe(SOURCE);
    expect(tier?.verifiedAt).toBe("2026-10-27");
    for (const inputTokens of [271_999, 272_000, 272_001]) {
      const usage = { inputTokens, outputTokens: 1000, cachedInputTokens: 200_000, cacheCreationInputTokens: 20_000 };
      const input = { provider, model: MODEL, usage, usageStatus: "reported" as const };
      const rates = inputTokens > 272_000 ? LONG_PRICE : PRICE;
      for (const estimate of [estimateRequestCost(input), estimateAttemptCost({ ...input, ordinal: 1 })]) {
        expect(estimate).not.toBeNull();
        expect(estimate!.contextTier).toBe(inputTokens > 272_000 ? "long" : undefined);
        expect(estimate!.cost.input).toBeCloseTo((inputTokens - 220_000) * rates.input / 1e6, 12);
        expect(estimate!.cost.output).toBeCloseTo(1000 * rates.output / 1e6, 12);
        expect(estimate!.cost.cacheRead).toBeCloseTo(200_000 * rates.cacheRead / 1e6, 12);
        expect(estimate!.cost.cacheWrite).toBeCloseTo(20_000 * rates.cacheWrite / 1e6, 12);
        expect(estimate!.price.status).toBe(provider === "openai" ? "verified-derived" : "verified");
      }
    }
  });

  test.each(["openai", "openai-apikey"])("%s prices confirmed Fast at 2x, stacked on the 272K tier", provider => {
    expect(findPriorityPricingRule(provider, MODEL)).toMatchObject({ multiplier: 2, verifiedAt: "2026-10-27" });
    expect(resolvePriorityMultiplier(MODEL)).toBe(2);
    for (const inputTokens of [271_999, 272_000, 272_001]) {
      const usage = { inputTokens, outputTokens: 1000, cachedInputTokens: 200_000, cacheCreationInputTokens: 20_000 };
      const input = { provider, model: MODEL, usage, usageStatus: "reported" as const };
      const rates = inputTokens > 272_000 ? LONG_PRICE : PRICE;
      const fast = { responseServiceTier: "priority" };
      for (const estimate of [estimateRequestCost({ ...input, serviceTier: fast }),
        estimateAttemptCost({ ...input, ordinal: 1 }, EXPECTED_PRICE_OVERLAYS, fast)]) {
        expect(estimate!.cost.input).toBeCloseTo(2 * (inputTokens - 220_000) * rates.input / 1e6, 12);
        expect(estimate!.cost.output).toBeCloseTo(2 * 1000 * rates.output / 1e6, 12);
        expect(estimate!.cost.cacheRead).toBeCloseTo(2 * 200_000 * rates.cacheRead / 1e6, 12);
        expect(estimate!.cost.cacheWrite).toBeCloseTo(2 * 20_000 * rates.cacheWrite / 1e6, 12);
      }
    }
  });

  test("tier membership is exact and does not create reseller bands", () => {
    expect(CONTEXT_TIERS.filter(row => row.modelId === MODEL).map(row => row.provider).sort())
      .toEqual(["openai", "openai-apikey"]);
    // Routed resellers never inherit OpenAI's Fast premium for the same slug.
    for (const provider of ["openrouter", "devin", "cursor"]) {
      expect(findPriorityPricingRule(provider, MODEL)).toBeUndefined();
    }
    expect(findContextTier("openrouter", `openai/${MODEL}`)).toBeUndefined();
    expect(findExpectedPriceOverlay("cursor", MODEL)).toBeUndefined();
    expect(findExpectedPriceOverlay("openai", `${MODEL}-pro`)).toBeUndefined();
  });
});

describe("GPT-6.1 Terra generated metadata", () => {
  // The generator excludes Copilot and Vercel bundles for Sol too; keep its allowlist unchanged.
  test.each(metadataRows.filter(([provider]) => !["github-copilot", "vercel-ai-gateway"].includes(provider)))("%s/%s has the Terra list price and the documented provider window", (provider, id, contextWindow) => {
    expect(getModelMetadata(provider, id)).toMatchObject({ id, contextWindow,
      maxTokens: 128_000, input: ["text", "image"], reasoning: true, cost: PRICE });
    expect(getModelMetadata(provider, id.replace("6.1-terra", "5.6-terra"))).toBeDefined();
  });

  test("source rows preserve Sol transport and capabilities while adding Terra alongside old models", () => {
    const source = JSON.parse(readFileSync(repoPath("scripts/model-metadata.source.json"), "utf8"));
    for (const [provider, id, contextWindow] of metadataRows) {
      const sol = source[provider][id.replace("6.1-terra", "6.1-sol")];
      const terra = source[provider][id];
      expect(terra).toMatchObject({ ...sol, id, name: "GPT-6.1 Terra", cost: PRICE, contextWindow,
        thinking: { ...sol.thinking, minLevel: provider === "openai" ? "none" : sol.thinking.minLevel } });
    }
    // These bundles lack a Sol row or differ from its OpenAI list-price tuple.
    for (const [provider, id] of [
      ["cloudflare-ai-gateway", `openai/${MODEL}`], ["kilo", `openai/${MODEL}`],
      ["opencode-zen", MODEL], ["zenmux", `openai/${MODEL}`],
    ]) expect(source[provider][id]).toBeUndefined();
  });
});
