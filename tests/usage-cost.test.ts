import { describe, expect, test } from "bun:test";
import {
  calculateCost,
  estimateAttemptCost,
  estimateComboCost,
  estimateRequestCost,
  effectiveServiceTier,
  normalizeCostTokens,
  resolveMatchedPrice,
  tokensPerSecond,
} from "../src/usage/cost";
import {
  EXPECTED_PRICE_OVERLAYS,
  PRIORITY_MULTIPLIERS,
  findExpectedPriceOverlay,
  resolvePriorityMultiplier,
  type ExpectedPriceOverlay,
} from "../src/usage/expected-prices";

const RATE = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

describe("normalizeCostTokens", () => {
  test("1. OpenAI-style cached subset of input", () => {
    const tokens = normalizeCostTokens({ inputTokens: 100, outputTokens: 10, cachedInputTokens: 40 });
    expect(tokens).toEqual({ input: 60, output: 10, cacheRead: 40, cacheWrite: 0 });
  });

  test("2. Anthropic inclusive fixture — no double charge", () => {
    // adapter produced inputTokens = raw(100) + read(40) + write(20) = 160
    const usage = {
      inputTokens: 160,
      outputTokens: 10,
      cachedInputTokens: 40,
      cacheReadInputTokens: 40,
      cacheCreationInputTokens: 20,
    };
    const tokens = normalizeCostTokens(usage);
    expect(tokens).toEqual({ input: 100, output: 10, cacheRead: 40, cacheWrite: 20 });
    const cost = calculateCost(tokens!, RATE);
    expect(cost.input).toBeCloseTo(100 * 3 / 1e6, 12);
    expect(cost.total).toBeCloseTo((300 + 150 + 12 + 75) / 1e6, 12);
    // NOT the naive inclusive computation
    expect(cost.input).not.toBeCloseTo(160 * 3 / 1e6, 12);
  });

  test("3. read-only partial detail", () => {
    const tokens = normalizeCostTokens({ inputTokens: 100, outputTokens: 5, cacheReadInputTokens: 30 });
    expect(tokens).toEqual({ input: 70, output: 5, cacheRead: 30, cacheWrite: 0 });
  });

  test("4. write-only partial detail", () => {
    const tokens = normalizeCostTokens({ inputTokens: 100, outputTokens: 5, cacheCreationInputTokens: 25 });
    expect(tokens).toEqual({ input: 75, output: 5, cacheRead: 0, cacheWrite: 25 });
  });

  test("5. explicit-read contradiction R+W>I is null", () => {
    expect(normalizeCostTokens({
      inputTokens: 50,
      outputTokens: 5,
      cacheReadInputTokens: 40,
      cacheCreationInputTokens: 20,
    })).toBeNull();
  });

  test("13a. canonical-first: non-contradictory implicit cached stays canonical", () => {
    const tokens = normalizeCostTokens({
      inputTokens: 160,
      outputTokens: 10,
      cachedInputTokens: 60,
      cacheCreationInputTokens: 20,
    });
    // canonical reading R=60, W=20 -> input 80 (NOT the legacy I-R-2W=60)
    expect(tokens).toEqual({ input: 80, output: 10, cacheRead: 60, cacheWrite: 20 });
  });

  test("13b. legacy retry: implicit cached contradiction recovers read+write split", () => {
    const tokens = normalizeCostTokens({
      inputTokens: 70,
      outputTokens: 10,
      cachedInputTokens: 60,
      cacheCreationInputTokens: 20,
    });
    // canonical R=60,W=20 -> 80>70 contradiction; legacy retry R=40,W=20 -> input 10
    expect(tokens).toEqual({ input: 10, output: 10, cacheRead: 40, cacheWrite: 20 });
  });

  test("13c. both readings contradictory is null", () => {
    expect(normalizeCostTokens({
      inputTokens: 50,
      outputTokens: 10,
      cachedInputTokens: 60,
      cacheCreationInputTokens: 20,
    })).toBeNull();
  });

  test("15. non-finite values are null", () => {
    expect(normalizeCostTokens({ inputTokens: NaN, outputTokens: 1 })).toBeNull();
    expect(normalizeCostTokens({ inputTokens: Infinity, outputTokens: 1 })).toBeNull();
    expect(normalizeCostTokens({ inputTokens: -5, outputTokens: 1 })).toBeNull();
    expect(normalizeCostTokens({ inputTokens: 10, outputTokens: NaN })).toBeNull();
    expect(normalizeCostTokens({ inputTokens: 10, outputTokens: 1, cacheReadInputTokens: NaN })).toBeNull();
  });
});

describe("resolveMatchedPrice", () => {
  test("17. model-level fallback: kiro's claude opus follows the anthropic price", () => {
    const price = resolveMatchedPrice("kiro", "claude-opus-4.6");
    expect(price).not.toBeNull();
    expect(price!.source).toBe("jawcode");
    expect(price!.jawcodeProvider).toBe("anthropic");
    expect(price!.status).toBe("verified-derived");
    expect(price!.cost4).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
  });

  test("17b. model-level fallback: openai provider gets gpt prices from the openai bundle", () => {
    const price = resolveMatchedPrice("openai", "gpt-5.5");
    expect(price).not.toBeNull();
    expect(price!.jawcodeProvider).toBe("openai");
    expect(price!.cost4.input).toBe(5);
    expect(price!.cost4.output).toBe(30);
  });

  test("17c. model-level fallback: cursor's claude-fable-5 follows the anthropic price", () => {
    const price = resolveMatchedPrice("cursor", "claude-fable-5");
    expect(price).not.toBeNull();
    expect(price!.jawcodeProvider).toBe("anthropic");
    expect(price!.cost4.input).toBe(10);
  });

  test("17d. model-level fallback: all-zero everywhere stays null (grok-composer)", () => {
    expect(resolveMatchedPrice("xai", "grok-composer-2.5-fast")).toBeNull();
  });

  test("17e. exact provider bundle still beats the model-level fallback", () => {
    const price = resolveMatchedPrice("anthropic", "claude-3-haiku-20240307");
    expect(price?.status).toBe("verified");
    expect(price?.cost4.input).toBe(0.25);
  });

  test("17f. Alibaba Token Plan Qwen 3.8 uses the temporary Routeway proxy", () => {
    for (const provider of ["alibaba-token-plan", "alibaba-token-plan-intl"]) {
      const price = resolveMatchedPrice(provider, "qwen3.8-max-preview");
      expect(price).toMatchObject({
        provider,
        modelId: "qwen3.8-max-preview",
        cost4: { input: 1.5, output: 5, cacheRead: 0.15, cacheWrite: 0 },
        source: "expected",
        status: "verified-derived",
      });
      expect(price?.sourceRef).toContain("temporary reseller proxy");
    }
  });

  test("6. unmatched exact key is null", () => {
    expect(resolveMatchedPrice("no-such-provider", "no-such-model")).toBeNull();
    expect(resolveMatchedPrice("openai", "definitely-not-a-model")).toBeNull();
  });

  test("7. all-zero jawcode row with no overlay is null", () => {
    // kimi -> moonshot / kimi-k2.5 is all-zero in the snapshot (003)
    expect(resolveMatchedPrice("kimi", "kimi-k2.5", [])).toBeNull();
  });

  test("8. overlay priority: verified wins, unverified never returned", () => {
    const overlays: ExpectedPriceOverlay[] = [
      { provider: "p", modelId: "m", cost4: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 }, source: "u", verifiedAt: "2026-07-20", status: "unverified" },
      { provider: "p", modelId: "m", cost4: { input: 5, output: 6, cacheRead: 0.5, cacheWrite: 0 }, source: "v", verifiedAt: "2026-07-20", status: "verified" },
    ];
    expect(findExpectedPriceOverlay("p", "m", overlays)?.status).toBe("verified");
    const unverifiedOnly: ExpectedPriceOverlay[] = [overlays[0]!];
    expect(findExpectedPriceOverlay("p", "m", unverifiedOnly)).toBeUndefined();
    expect(resolveMatchedPrice("p", "m", unverifiedOnly)).toBeNull();
    const derivedOnly: ExpectedPriceOverlay[] = [
      { provider: "p", modelId: "m", cost4: { input: 5, output: 6, cacheRead: 0.5, cacheWrite: 0 }, source: "d", verifiedAt: "2026-07-20", status: "verified-derived" },
    ];
    expect(findExpectedPriceOverlay("p", "m", derivedOnly)?.status).toBe("verified-derived");
  });

  test("8b. jawcode nonzero beats overlay", () => {
    const overlays: ExpectedPriceOverlay[] = [
      { provider: "anthropic", modelId: "claude-3-haiku-20240307", cost4: { input: 999, output: 999, cacheRead: 9, cacheWrite: 9 }, source: "x", verifiedAt: "2026-07-20", status: "verified" },
    ];
    const price = resolveMatchedPrice("anthropic", "claude-3-haiku-20240307", overlays);
    expect(price?.source).toBe("jawcode");
    expect(price?.cost4.input).toBe(0.25);
  });

  test("9. native slash exact lookup, hyphenized fails", () => {
    const slash = resolveMatchedPrice("openrouter", "anthropic/claude-3.5-sonnet");
    expect(slash?.source).toBe("jawcode");
    expect(resolveMatchedPrice("openrouter", "anthropic-claude-3.5-sonnet")).toBeNull();
  });

  test("16. shipped overlay membership: 43 keys, including Gemini 3.6 and compatibility prices", () => {
    expect(EXPECTED_PRICE_OVERLAYS.length).toBe(45);
    expect(EXPECTED_PRICE_OVERLAYS.some(row => row.status === "unverified")).toBe(false);
    const keys = new Set(EXPECTED_PRICE_OVERLAYS.map(row => `${row.provider}/${row.modelId}`));
    for (const expected of [
      "minimax/MiniMax-M2.1-highspeed",
      "minimax-cn/MiniMax-M2.1-highspeed",
      "deepseek/deepseek-chat",
      "deepseek/deepseek-reasoner",
      "google-antigravity/gemini-3.1-pro-low",
      "google-antigravity/gemini-3.1-pro-high",
      "google-antigravity/gemini-pro-agent",
      "google-antigravity/gemini-3.6-flash",
      "google-antigravity/gemini-3.1-pro",
      "google/gemini-3.6-flash",
      "google-antigravity/gemini-3.6-flash-low",
      "google-antigravity/gemini-3.6-flash-medium",
      "google-antigravity/gemini-3.6-flash-high",
      "google-antigravity/gemini-3.5-flash-extra-low",
      "google-antigravity/gemini-3.5-flash-low",
      "google-antigravity/gemini-3.5-flash-mid",
      "google-antigravity/gemini-3.5-flash-high",
      "google-antigravity/gemini-3-flash-agent",
      "google-antigravity/gemini-3.1-pro-preview",
      "google-antigravity/claude-sonnet-4-6",
      "google-antigravity/claude-opus-4-6-thinking",
      "google-antigravity/claude-opus-4-6",
      "google-antigravity/gpt-oss-120b-medium",
      "kimi/k3",
      "kimi/k3[1m]",
      "kimi/kimi-k2.7-code",
      "kimi/kimi-k2.7-code-highspeed",
      "kimi/kimi-k2.6",
      "kimi/kimi-k2.5",
      "kimi/kimi-for-coding",
      "moonshot/kimi-k3",
      "moonshot/kimi-k2.7-code",
      "moonshot/kimi-k2.7-code-highspeed",
      "moonshot/kimi-k2.6",
      "moonshot/kimi-k2.5",
      "kimi-code/k3",
      "kimi-code/k3[1m]",
      "kimi-code/kimi-k2.7-code",
      "kimi-code/kimi-k2.7-code-highspeed",
      "kimi-code/kimi-k2.6",
      "kimi-code/kimi-k2.5",
      "kimi-code/kimi-for-coding",
      "alibaba-token-plan/qwen3.8-max-preview",
      "alibaba-token-plan-intl/qwen3.8-max-preview",
      "cursor/auto",
    ]) {
      expect(keys.has(expected)).toBe(true);
    }

    const direct = findExpectedPriceOverlay("google", "gemini-3.6-flash");
    expect(direct).toMatchObject({
      cost4: { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 },
      status: "verified",
    });
    for (const modelId of [
      "gemini-3.5-flash-extra-low",
      "gemini-3.5-flash-low",
      "gemini-3.5-flash-mid",
      "gemini-3.5-flash-high",
      "gemini-3-flash-agent",
    ]) {
      const compatibility = findExpectedPriceOverlay("google-antigravity", modelId);
      expect(compatibility).toMatchObject({
        cost4: { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 },
        status: "verified-derived",
      });
      expect(compatibility?.source).toContain("gemini-3.6-flash");
    }
  });

  test("pool-suffixed google-antigravity provider matches official Anthropic Claude Opus 4.6 overlay", () => {
    const price = resolveMatchedPrice("google-antigravity-p442fff", "claude-opus-4-6-thinking");
    expect(price).not.toBeNull();
    expect(price!.modelId).toBe("claude-opus-4-6-thinking");
    expect(price!.cost4).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
    expect(price!.source).toBe("expected");
    expect(price!.status).toBe("verified");

    const est = estimateRequestCost({
      provider: "google-antigravity-p442fff",
      model: "claude-opus-4-6-thinking",
      usageStatus: "reported",
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
    });
    expect(est?.cost.total).toBeCloseTo(5, 9);
  });

  test("pool-suffixed google-antigravity provider matches official Anthropic Claude Sonnet 4.6 overlay", () => {
    const price = resolveMatchedPrice("google-antigravity-p442fff", "claude-sonnet-4-6");
    expect(price).not.toBeNull();
    expect(price!.modelId).toBe("claude-sonnet-4-6");
    expect(price!.cost4).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
    expect(price!.source).toBe("expected");
    expect(price!.status).toBe("verified");

    const est = estimateRequestCost({
      provider: "google-antigravity-p442fff",
      model: "claude-sonnet-4-6",
      usageStatus: "reported",
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
    });
    expect(est?.cost.total).toBeCloseTo(3, 9);
  });
});

describe("combo", () => {
  const overlays: ExpectedPriceOverlay[] = [
    { provider: "pa", modelId: "ma", cost4: { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 0 }, source: "a", verifiedAt: "2026-07-20", status: "verified" },
    { provider: "pb", modelId: "mb", cost4: { input: 2, output: 20, cacheRead: 0.2, cacheWrite: 0 }, source: "b", verifiedAt: "2026-07-20", status: "verified-derived" },
  ];

  test("10. per-attempt rates summed; derived propagates estimated", () => {
    const combo = estimateComboCost([
      { ordinal: 1, provider: "pa", model: "ma", usageStatus: "reported", usage: { inputTokens: 1_000_000, outputTokens: 100_000 } },
      { ordinal: 2, provider: "pb", model: "mb", usageStatus: "reported", usage: { inputTokens: 500_000, outputTokens: 50_000 } },
    ], overlays);
    expect(combo).not.toBeNull();
    // pa: 1*1 + 10*0.1 = 2.0 ; pb: 2*0.5 + 20*0.05 = 2.0
    expect(combo!.cost.total).toBeCloseTo(4.0, 9);
    expect(combo!.estimated).toBe(true); // pb is verified-derived
    expect(combo!.attempts).toHaveLength(2);
  });

  test("11. fail-closed: any unpriced attempt nulls the whole combo", () => {
    const combo = estimateComboCost([
      { ordinal: 1, provider: "pa", model: "ma", usageStatus: "reported", usage: { inputTokens: 100, outputTokens: 10 } },
      { ordinal: 2, provider: "nope", model: "nope", usageStatus: "reported", usage: { inputTokens: 100, outputTokens: 10 } },
    ], overlays);
    expect(combo).toBeNull();
  });

  test("14. usage-less attempt and empty combo are null", () => {
    expect(estimateAttemptCost({ ordinal: 1, provider: "pa", model: "ma", usageStatus: "unreported" }, overlays)).toBeNull();
    expect(estimateComboCost([], overlays)).toBeNull();
    expect(estimateComboCost([
      { ordinal: 1, provider: "pa", model: "ma", usageStatus: "unreported" },
    ], overlays)).toBeNull();
  });
});

describe("estimateRequestCost", () => {
  test("estimated usage propagates", () => {
    const overlays: ExpectedPriceOverlay[] = [
      { provider: "p", modelId: "m", cost4: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, source: "s", verifiedAt: "2026-07-20", status: "verified" },
    ];
    const est = estimateRequestCost({ provider: "p", model: "m", usageStatus: "estimated", usage: { inputTokens: 10, outputTokens: 5, estimated: true } }, overlays);
    expect(est?.estimated).toBe(true);
    expect(estimateRequestCost({ provider: "p", model: "m", usageStatus: "unreported" }, overlays)).toBeNull();
  });
});

describe("tokensPerSecond", () => {
  test("12. edges", () => {
    expect(tokensPerSecond(100, 2000)).toBe(50);
    expect(tokensPerSecond(0, 2000)).toBeNull();
    expect(tokensPerSecond(100, 0)).toBeNull();
    expect(tokensPerSecond(-1, 2000)).toBeNull();
    expect(tokensPerSecond(NaN, 2000)).toBeNull();
    expect(tokensPerSecond(100, Infinity)).toBeNull();
  });
});

describe("priority (Fast) service tier multiplier", () => {
  const overlays: ExpectedPriceOverlay[] = [
    { provider: "openai", modelId: "gpt-5.6-sol", cost4: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 }, source: "test", verifiedAt: "2026-07-24", status: "verified" },
    { provider: "openai", modelId: "gpt-5.5", cost4: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 }, source: "test", verifiedAt: "2026-07-24", status: "verified" },
    { provider: "openai", modelId: "gpt-5.3-codex-spark", cost4: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 }, source: "test", verifiedAt: "2026-07-24", status: "verified" },
  ];
  const usage = { inputTokens: 1_000_000, outputTokens: 100_000 };

  test("P1. priority tier applies 2x multiplier for gpt-5.6-sol", () => {
    const base = estimateRequestCost({ provider: "openai", model: "gpt-5.6-sol", usageStatus: "reported", usage }, overlays);
    const fast = estimateRequestCost({ provider: "openai", model: "gpt-5.6-sol", usageStatus: "reported", usage, serviceTier: "priority" }, overlays);
    expect(base).not.toBeNull();
    expect(fast).not.toBeNull();
    // base: 5*1 + 30*0.1 = 8.0
    expect(base!.cost.total).toBeCloseTo(8.0, 9);
    // fast: 2x => 16.0
    expect(fast!.cost.total).toBeCloseTo(16.0, 9);
    expect(fast!.priorityMultiplier).toBe(2);
    expect(base!.priorityMultiplier).toBeUndefined();
  });

  test("P2. priority tier applies 2.5x multiplier for gpt-5.5", () => {
    const base = estimateRequestCost({ provider: "openai", model: "gpt-5.5", usageStatus: "reported", usage }, overlays);
    const fast = estimateRequestCost({ provider: "openai", model: "gpt-5.5", usageStatus: "reported", usage, serviceTier: "priority" }, overlays);
    expect(base!.cost.total).toBeCloseTo(8.0, 9);
    // 2.5x => 20.0
    expect(fast!.cost.total).toBeCloseTo(20.0, 9);
    expect(fast!.priorityMultiplier).toBe(2.5);
  });

  test("P3. no service tier => base price unchanged (regression)", () => {
    const est = estimateRequestCost({ provider: "openai", model: "gpt-5.6-sol", usageStatus: "reported", usage }, overlays);
    expect(est!.cost.total).toBeCloseTo(8.0, 9);
    expect(est!.priorityMultiplier).toBeUndefined();
  });

  test("P4. unknown model + priority => multiplier 1 (fallback)", () => {
    const est = estimateRequestCost({ provider: "openai", model: "gpt-5.3-codex-spark", usageStatus: "reported", usage, serviceTier: "priority" }, overlays);
    expect(est).not.toBeNull();
    // base: 1.75*1 + 14*0.1 = 3.15; no multiplier listed => stays 3.15
    expect(est!.cost.total).toBeCloseTo(3.15, 9);
    expect(est!.priorityMultiplier).toBeUndefined();
  });

  test("P5. non-OpenAI provider + priority => no multiplier (provider gate)", () => {
    const customOverlays: ExpectedPriceOverlay[] = [
      { provider: "openrouter", modelId: "gpt-5.6-sol", cost4: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 }, source: "test", verifiedAt: "2026-07-24", status: "verified" },
    ];
    const est = estimateRequestCost({ provider: "openrouter", model: "gpt-5.6-sol", usageStatus: "reported", usage, serviceTier: "priority" }, customOverlays);
    expect(est).not.toBeNull();
    // provider gate: openrouter is not openai => no multiplier
    expect(est!.cost.total).toBeCloseTo(8.0, 9);
    expect(est!.priorityMultiplier).toBeUndefined();
  });

  test("P6. combo with priority tier applies multiplier per attempt", () => {
    const combo = estimateComboCost([
      { ordinal: 1, provider: "openai", model: "gpt-5.6-sol", usageStatus: "reported", usage },
    ], overlays, "priority");
    expect(combo).not.toBeNull();
    expect(combo!.cost.total).toBeCloseTo(16.0, 9);
    expect(combo!.priorityMultiplier).toBe(2);
  });

  test("P7. effectiveServiceTier priority: response > requested > configured", () => {
    expect(effectiveServiceTier({ responseServiceTier: "priority", requestedServiceTier: undefined, configuredServiceTier: undefined })).toBe("priority");
    expect(effectiveServiceTier({ responseServiceTier: undefined, requestedServiceTier: "priority", configuredServiceTier: undefined })).toBe("priority");
    expect(effectiveServiceTier({ responseServiceTier: undefined, requestedServiceTier: undefined, configuredServiceTier: "priority" })).toBe("priority");
    expect(effectiveServiceTier({})).toBeUndefined();
    // response wins over requested
    expect(effectiveServiceTier({ responseServiceTier: "priority", requestedServiceTier: "default" })).toBe("priority");
  });

  test("P8. resolvePriorityMultiplier returns correct values", () => {
    expect(resolvePriorityMultiplier("gpt-5.6-sol")).toBe(2);
    expect(resolvePriorityMultiplier("gpt-5.6-terra")).toBe(2);
    expect(resolvePriorityMultiplier("gpt-5.6-luna")).toBe(2);
    expect(resolvePriorityMultiplier("gpt-5.5")).toBe(2.5);
    expect(resolvePriorityMultiplier("gpt-5.4")).toBe(2);
    expect(resolvePriorityMultiplier("gpt-5.3-codex-spark")).toBe(1);
    expect(resolvePriorityMultiplier("unknown-model")).toBe(1);
  });

  test("P9. PRIORITY_MULTIPLIERS table has expected entries", () => {
    expect(Object.keys(PRIORITY_MULTIPLIERS)).toHaveLength(5);
    expect(PRIORITY_MULTIPLIERS["gpt-5.6-sol"]).toBe(2);
    expect(PRIORITY_MULTIPLIERS["gpt-5.5"]).toBe(2.5);
  });

  test("P10. attempt cost with priority tier", () => {
    const base = estimateAttemptCost({ ordinal: 1, provider: "openai", model: "gpt-5.6-sol", usageStatus: "reported", usage }, overlays);
    const fast = estimateAttemptCost({ ordinal: 1, provider: "openai", model: "gpt-5.6-sol", usageStatus: "reported", usage }, overlays, "priority");
    expect(base!.cost.total).toBeCloseTo(8.0, 9);
    expect(fast!.cost.total).toBeCloseTo(16.0, 9);
    expect(fast!.priorityMultiplier).toBe(2);
  });
});
