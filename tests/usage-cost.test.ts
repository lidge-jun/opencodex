import { afterEach, describe, expect, test } from "bun:test";
import { createAdapterTierMetadata } from "../src/providers/fastwire";
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
  PRIORITY_PRICING_RULES,
  CONTEXT_TIERS,
  findExpectedPriceOverlay,
  findPriorityPricingRule,
  resolvePriorityMultiplier,
  type ExpectedPriceOverlay,
} from "../src/usage/expected-prices";
import {
  activeUserCostOverlays,
  refreshUserCostOverlays,
  userCostOverlayVersion,
} from "../src/usage/user-cost-overlays";
import type { OcxConfig } from "../src/types";

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
  test("gpt-5.6 family four-tuples match the post-cut official rates (#907)", () => {
    const expectations: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
      "gpt-5.6-sol": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
      "gpt-5.6-terra": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
      "gpt-5.6-luna": { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
    };
    for (const [model, tuple] of Object.entries(expectations)) {
      const price = resolveMatchedPrice("openai", model);
      expect(price, model).not.toBeNull();
      expect(price!.cost4.input, `${model} input`).toBeCloseTo(tuple.input, 9);
      expect(price!.cost4.output, `${model} output`).toBeCloseTo(tuple.output, 9);
      expect(price!.cost4.cacheRead, `${model} cacheRead`).toBeCloseTo(tuple.cacheRead, 9);
      expect(price!.cost4.cacheWrite, `${model} cacheWrite`).toBeCloseTo(tuple.cacheWrite, 9);
    }
  });

  // WP7: claude-opus-5 is exposed by three providers but was missing from the jawcode
  // bundle, so it resolved to null and Logs rendered an em dash instead of a cost.
  // The model-level vendor fallback only searches jawcode metadata, never overlays,
  // so each exposing provider needed its own row.
  //
  // Upstream has since published an `anthropic/claude-opus-5` row at the SAME numbers the
  // maintainer derived (5 / 25 / 0.5 / 6.25), so that provider is now sourced from jawcode
  // and reads `verified` instead of `verified-derived`. cursor and kiro have no jawcode row
  // of their own and still come from the overlay, which is why the overlay must stay.
  // The price is identical either way — only the provenance moved, and it moved forward.
  test("claude-opus-5 resolves to the Opus 4.6 price on every exposing provider", () => {
    const COST4 = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };

    const anthropic = resolveMatchedPrice("anthropic", "claude-opus-5");
    expect(anthropic).toMatchObject({
      provider: "anthropic",
      modelId: "claude-opus-5",
      cost4: COST4,
      source: "jawcode",
      status: "verified",
    });

    for (const provider of ["cursor", "kiro"]) {
      const price = resolveMatchedPrice(provider, "claude-opus-5");
      expect(price).not.toBeNull();
      expect(price).toMatchObject({
        provider,
        modelId: "claude-opus-5",
        cost4: COST4,
        source: "expected",
        status: "verified-derived",
      });
      // Provenance must stay honest: derived from the maintainer's confirmation,
      // not from a published Opus 5 price page.
      expect(price?.sourceRef).toContain("user-confirmed");
    }
  });

  test("17. model-level fallback: kiro's claude opus follows the anthropic price", () => {
    const price = resolveMatchedPrice("kiro", "claude-opus-4.6");
    expect(price).not.toBeNull();
    expect(price!.source).toBe("jawcode");
    expect(price!.jawcodeProvider).toBe("anthropic");
    expect(price!.status).toBe("verified-derived");
    expect(price!.cost4).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
  });

  // Claude Fable 5.1 (2026-09-02): 10 / 50 / 12.50 cache write, and a cache-hit rate of
  // 0.025x base input (0.25) rather than the 0.1x every other family uses. There is no
  // jawcode row yet, so both Anthropic surfaces resolve from the shipped overlay; an
  // account-pool log label must collapse onto the same price.
  test("claude-fable-5-1 resolves to the official Fable 5.1 price on both Anthropic surfaces", () => {
    const COST4 = { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 };
    for (const provider of ["anthropic", "anthropic-apikey"]) {
      const price = resolveMatchedPrice(provider, "claude-fable-5-1");
      expect(price, provider).toMatchObject({
        provider,
        modelId: "claude-fable-5-1",
        cost4: COST4,
        source: "expected",
        status: "verified",
      });
      expect(price?.sourceRef).toContain("platform.claude.com");
      expect(price?.sourceRef).toContain("0.025x");
    }
    expect(resolveMatchedPrice("anthropic-pb51d9b", "claude-fable-5-1")?.cost4).toEqual(COST4);
    // Cursor accepts all three spellings but pricing stores one canonical overlay row.
    for (const spelling of ["claude-fable-5-1", "claude-fable-5.1", "claude-5.1-fable"]) {
      expect(resolveMatchedPrice("cursor", spelling), spelling).toMatchObject({ cost4: COST4, source: "expected", status: "verified-derived" });
      expect(findExpectedPriceOverlay("cursor", spelling)?.modelId, spelling).toBe("claude-fable-5-1");
    }
    // The cheaper cache-hit rate must not leak onto Fable 5, which stays at 0.1x.
    expect(resolveMatchedPrice("anthropic", "claude-fable-5")?.cost4.cacheRead).toBe(1);
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

  // 260804: Qwen published a per-token rate for the stable qwen3.8-max, which is exactly
  // the exit condition the old Routeway reseller overlay named, so the proxy rate is gone.
  test("17f. Alibaba Token Plan Qwen 3.8 uses the vendor-published rate", () => {
    for (const provider of ["alibaba-token-plan", "alibaba-token-plan-intl"]) {
      const price = resolveMatchedPrice(provider, "qwen3.8-max");
      expect(price).toMatchObject({
        provider,
        modelId: "qwen3.8-max",
        cost4: { input: 2, output: 6, cacheRead: 0, cacheWrite: 0 },
        source: "expected",
        status: "verified",
      });
      // The source string must keep carrying what the vendor figure does NOT cover:
      // there is no Model Studio billing row yet, and no published cache rate. Dropping
      // either caveat would present an announcement price as billing-table verified.
      expect(price?.sourceRef).toContain("qwen.ai/blog");
      expect(price?.sourceRef).toContain("cache rates unpublished");
      expect(price?.sourceRef).not.toContain("routeway");
    }
  });

  test("17g. the retired qwen3.8-max-preview id no longer resolves", () => {
    // Alibaba retires the preview endpoint; capability metadata follows the stable id.
    for (const provider of ["alibaba-token-plan", "alibaba-token-plan-intl"]) {
      expect(resolveMatchedPrice(provider, "qwen3.8-max-preview")).toBeNull();
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

  test("16. shipped overlay membership: 68 keys, including canonical Fable 5.1, Opus 5 and compatibility prices", () => {
    expect(EXPECTED_PRICE_OVERLAYS.length).toBe(68);
    expect(EXPECTED_PRICE_OVERLAYS.some(row => row.status === "unverified")).toBe(false);
    const keys = new Set(EXPECTED_PRICE_OVERLAYS.map(row => `${row.provider}/${row.modelId}`));
    for (const expected of [
      "anthropic/claude-fable-5-1",
      "anthropic-apikey/claude-fable-5-1",
      "cursor/claude-fable-5-1",
      "anthropic/claude-opus-5",
      "cursor/claude-opus-5",
      "kiro/claude-opus-5",
      "openai/gpt-daybreak-blue-latest",
      "openai-apikey/daybreak-red-latest",
      "openai-apikey/daybreak-blue-latest",
      "minimax/MiniMax-M2.1-highspeed",
      "minimax-cn/MiniMax-M2.1-highspeed",
      "deepseek/deepseek-chat",
      "deepseek/deepseek-reasoner",
      "google-antigravity/gemini-3.8-flash",
      "google-antigravity/gemini-3.8-flash-low",
      "google-antigravity/gemini-3.8-flash-medium",
      // meta-model has no jawcode alias, so these exact overlays are the only price
      // source for the direct Meta provider.
      "meta-model/muse-spark-1.3",
      "meta-model/muse-spark-1.3-contributor",
      // meta-muse reaches the same endpoint with the CLI credential; overlays resolve by
      // exact provider id, so it needs its own rows or its cost column stays empty.
      "meta-muse/muse-spark-1.3",
      "meta-muse/muse-spark-1.3-contributor",
      "google-antigravity/gemini-3.8-flash-high",
      "google/gemini-3.8-flash",
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
      "alibaba-token-plan/qwen3.8-max",
      "alibaba-token-plan-intl/qwen3.8-max",
      "cursor/auto",
    ]) {
      expect(keys.has(expected)).toBe(true);
    }
    for (const impossible of [
      "openai/daybreak-blue-latest",
      "openai/daybreak-red-latest",
      "openai-apikey/gpt-daybreak-blue-latest",
      "cursor/claude-fable-5.1",
      "cursor/claude-5.1-fable",
    ]) {
      expect(keys.has(impossible)).toBe(false);
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
  // Below OpenAI's 272k long-context boundary on purpose: these cases isolate the Fast
  // multiplier, and a 1M-token prompt would silently also trip the context tier (#908).
  const usage = { inputTokens: 200_000, outputTokens: 20_000 };

  test("P1. priority tier applies 2x multiplier for gpt-5.6-sol", () => {
    const base = estimateRequestCost({ provider: "openai", model: "gpt-5.6-sol", usageStatus: "reported", usage }, overlays);
    const fast = estimateRequestCost({ provider: "openai", model: "gpt-5.6-sol", usageStatus: "reported", usage, serviceTier: "priority" }, overlays);
    expect(base).not.toBeNull();
    expect(fast).not.toBeNull();
    // base: 5*0.2 + 30*0.02 = 1.6
    expect(base!.cost.total).toBeCloseTo(1.6, 9);
    // fast: 2x => 3.2
    expect(fast!.cost.total).toBeCloseTo(3.2, 9);
    expect(fast!.priorityMultiplier).toBe(2);
    expect(base!.priorityMultiplier).toBeUndefined();
  });

  test("P1b. Fast mode applies the current 2x price for gpt-5.6-luna (#907)", () => {
    const base = estimateRequestCost({ provider: "openai", model: "gpt-5.6-luna", usageStatus: "reported", usage });
    const fast = estimateRequestCost({ provider: "openai", model: "gpt-5.6-luna", usageStatus: "reported", usage, serviceTier: "priority" });
    expect(base).not.toBeNull();
    expect(fast).not.toBeNull();
    // Post-cut standard: 200K×$0.20/M + 20K×$1.20/M = $0.064. Fast (2x): $0.128.
    expect(base!.cost.total).toBeCloseTo(0.064, 9);
    expect(fast!.cost.total).toBeCloseTo(0.128, 9);
    expect(fast!.priorityMultiplier).toBe(2);
  });

  test("P1c. Fast mode applies the current 2x price for gpt-5.6-terra (#907)", () => {
    const base = estimateRequestCost({ provider: "openai", model: "gpt-5.6-terra", usageStatus: "reported", usage });
    const fast = estimateRequestCost({ provider: "openai", model: "gpt-5.6-terra", usageStatus: "reported", usage, serviceTier: "priority" });
    expect(base).not.toBeNull();
    expect(fast).not.toBeNull();
    // Post-cut standard: 200K×$2/M + 20K×$12/M = $0.64. Fast (2x): $1.28.
    expect(base!.cost.total).toBeCloseTo(0.64, 9);
    expect(fast!.cost.total).toBeCloseTo(1.28, 9);
    expect(fast!.priorityMultiplier).toBe(2);
  });

  test("P2. priority tier applies 2.5x multiplier for gpt-5.5", () => {
    const base = estimateRequestCost({ provider: "openai", model: "gpt-5.5", usageStatus: "reported", usage }, overlays);
    const fast = estimateRequestCost({ provider: "openai", model: "gpt-5.5", usageStatus: "reported", usage, serviceTier: "priority" }, overlays);
    expect(base!.cost.total).toBeCloseTo(1.6, 9);
    // 2.5x => 4.0
    expect(fast!.cost.total).toBeCloseTo(4.0, 9);
    expect(fast!.priorityMultiplier).toBe(2.5);
  });

  test("P3. no service tier => base price unchanged (regression)", () => {
    const est = estimateRequestCost({ provider: "openai", model: "gpt-5.6-sol", usageStatus: "reported", usage }, overlays);
    expect(est!.cost.total).toBeCloseTo(1.6, 9);
    expect(est!.priorityMultiplier).toBeUndefined();
  });

  test("P4. unknown model + priority => multiplier 1 (fallback)", () => {
    const est = estimateRequestCost({ provider: "openai", model: "gpt-5.3-codex-spark", usageStatus: "reported", usage, serviceTier: "priority" }, overlays);
    expect(est).not.toBeNull();
    // base: 1.75*0.2 + 14*0.02 = 0.63; no multiplier listed => stays 0.63
    expect(est!.cost.total).toBeCloseTo(0.63, 9);
    expect(est!.priorityMultiplier).toBeUndefined();
  });

  test("P5. non-OpenAI provider + priority => no multiplier (provider gate)", () => {
    const customOverlays: ExpectedPriceOverlay[] = [
      { provider: "openrouter", modelId: "gpt-5.6-sol", cost4: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 }, source: "test", verifiedAt: "2026-07-24", status: "verified" },
    ];
    const est = estimateRequestCost({ provider: "openrouter", model: "gpt-5.6-sol", usageStatus: "reported", usage, serviceTier: "priority" }, customOverlays);
    expect(est).not.toBeNull();
    // provider gate: openrouter is not openai => no multiplier
    expect(est!.cost.total).toBeCloseTo(1.6, 9);
    expect(est!.priorityMultiplier).toBeUndefined();
  });

  test("P6. combo with priority tier applies multiplier per attempt", () => {
    const combo = estimateComboCost([
      { ordinal: 1, provider: "openai", model: "gpt-5.6-sol", usageStatus: "reported", usage },
    ], overlays, "priority");
    expect(combo).not.toBeNull();
    expect(combo!.cost.total).toBeCloseTo(3.2, 9);
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
    expect(resolvePriorityMultiplier("gpt-daybreak-blue-latest")).toBe(2);
    expect(resolvePriorityMultiplier("daybreak-blue-latest")).toBe(2);
    expect(resolvePriorityMultiplier("gpt-5.6-terra")).toBe(2);
    expect(resolvePriorityMultiplier("gpt-5.6-luna")).toBe(2);
    expect(resolvePriorityMultiplier("gpt-5.5")).toBe(2.5);
    expect(resolvePriorityMultiplier("gpt-5.4-mini")).toBe(2);
    expect(resolvePriorityMultiplier("gpt-5.4")).toBe(2);
    expect(resolvePriorityMultiplier("gpt-5.3-codex-spark")).toBe(1);
    expect(resolvePriorityMultiplier("unknown-model")).toBe(1);
  });

  test("P9. PRIORITY_MULTIPLIERS table has expected entries", () => {
    expect(Object.keys(PRIORITY_MULTIPLIERS)).toHaveLength(8);
    expect(PRIORITY_MULTIPLIERS["gpt-5.6-sol"]).toBe(2);
    expect(PRIORITY_MULTIPLIERS["gpt-daybreak-blue-latest"]).toBe(2);
    expect(PRIORITY_MULTIPLIERS["daybreak-blue-latest"]).toBe(2);
    expect(PRIORITY_MULTIPLIERS["gpt-5.6-terra"]).toBe(2);
    expect(PRIORITY_MULTIPLIERS["gpt-5.6-luna"]).toBe(2);
    expect(PRIORITY_MULTIPLIERS["gpt-5.5"]).toBe(2.5);
    expect(PRIORITY_MULTIPLIERS["gpt-5.4-mini"]).toBe(2);
  });

  test("P9b. Daybreak priority rules stay inside their routable provider namespace", () => {
    expect(findPriorityPricingRule("openai", "gpt-daybreak-blue-latest")?.multiplier).toBe(2);
    expect(findPriorityPricingRule("openai-apikey", "daybreak-blue-latest")?.multiplier).toBe(2);
    expect(findPriorityPricingRule("openai-apikey", "gpt-daybreak-blue-latest")).toBeUndefined();
    expect(findPriorityPricingRule("openai", "daybreak-blue-latest")).toBeUndefined();
  });

  test("P10. attempt cost with priority tier", () => {
    const base = estimateAttemptCost({ ordinal: 1, provider: "openai", model: "gpt-5.6-sol", usageStatus: "reported", usage }, overlays);
    const fast = estimateAttemptCost({ ordinal: 1, provider: "openai", model: "gpt-5.6-sol", usageStatus: "reported", usage }, overlays, "priority");
    expect(base!.cost.total).toBeCloseTo(1.6, 9);
    expect(fast!.cost.total).toBeCloseTo(3.2, 9);
    expect(fast!.priorityMultiplier).toBe(2);
  });
});

describe("xAI Priority Processing pricing", () => {
  const usage = {
    inputTokens: 100_000,
    outputTokens: 10_000,
    cacheReadInputTokens: 20_000,
  };

  function outcome(responseServiceTier?: string) {
    const tracker = createAdapterTierMetadata(
      {
        capability: true,
        eligibility: "eligible",
        fastWire: {
          kind: "service-tier",
          canonicalToWire: { priority: "priority" },
          foreignCallerTiers: "verbatim",
        },
        demandDecision: "force-fast",
      },
      { kind: "set", value: "priority" },
      "service-tier",
      "priority",
    )!;
    if (responseServiceTier !== undefined) tracker.observeResponseServiceTier(responseServiceTier);
    return tracker.outcome;
  }

  function estimate(tierOutcome: ReturnType<typeof outcome>, requestUsage = usage) {
    return estimateAttemptCost({
      ordinal: 1,
      provider: "xai",
      model: "grok-4.6",
      usageStatus: "reported",
      usage: requestUsage,
      tierOutcome,
    })!;
  }

  test("xAI rules declare exact 2x premiums with official provenance", () => {
    const xaiRules = PRIORITY_PRICING_RULES.filter(rule => rule.provider === "xai");
    expect(xaiRules.map(rule => rule.modelId)).toEqual(["grok-4.5", "grok-4.6"]);
    expect(xaiRules.every(rule => rule.multiplier === 2)).toBe(true);
    expect(xaiRules.every(rule => rule.requiresResponseConfirmation === true)).toBe(true);
    expect(xaiRules.every(rule => rule.source === "https://docs.x.ai/developers/advanced-api-usage/priority-processing")).toBe(true);
    expect(findPriorityPricingRule("xai", "grok-4.6")?.multiplier).toBe(2);
    expect(findPriorityPricingRule("openrouter", "grok-4.6")).toBeUndefined();
    expect(resolveMatchedPrice("openrouter", "grok-4.6")?.cost4).toEqual({
      input: 2,
      output: 6,
      cacheRead: 0.3,
      cacheWrite: 0,
    });
    expect(resolveMatchedPrice("cursor", "grok-4.6")?.cost4).toEqual({
      input: 2,
      output: 6,
      cacheRead: 0.3,
      cacheWrite: 0,
    });
  });

  test("grok-4.6 standard and confirmed priority prices include the official cache rate", () => {
    expect(resolveMatchedPrice("xai", "grok-4.6")?.cost4).toEqual({
      input: 2,
      output: 6,
      cacheRead: 0.5,
      cacheWrite: 0,
    });
    const confirmedOutcome = outcome("priority");
    const confirmed = estimate(confirmedOutcome);
    expect(confirmedOutcome).toMatchObject({
      canonical: "priority",
      fastOutcome: "applied",
      confirmation: "confirmed",
    });
    expect(confirmed.cost.total).toBeCloseTo(0.46, 9);
    expect(confirmed.cost.cacheRead).toBeCloseTo(0.02, 9);
    expect(confirmed.priorityMultiplier).toBe(2);
  });

  test("an assumed priority outcome stays at the standard price", () => {
    const assumedOutcome = outcome();
    const assumed = estimate(assumedOutcome);
    expect(assumedOutcome).toMatchObject({
      canonical: "priority",
      fastOutcome: "applied",
      confirmation: "assumed",
    });
    expect(assumed.cost.total).toBeCloseTo(0.23, 9);
    expect(assumed.priorityMultiplier).toBeUndefined();
  });

  test("missing provenance and a requested tier do not prove the xAI premium", () => {
    for (const serviceTier of [
      "priority",
      { requestedServiceTier: "priority" },
      { configuredServiceTier: "priority" },
    ] as const) {
      const unconfirmed = estimateRequestCost({
        provider: "xai",
        model: "grok-4.6",
        usageStatus: "reported",
        usage,
        serviceTier,
      })!;
      expect(unconfirmed.cost.total).toBeCloseTo(0.23, 9);
      expect(unconfirmed.priorityMultiplier).toBeUndefined();
    }
  });

  test("an echoed default records a downgrade and bills the standard price", () => {
    const downgradedOutcome = outcome("default");
    const downgraded = estimate(downgradedOutcome);
    expect(downgradedOutcome).toMatchObject({
      fastOutcome: "downgraded",
      fastDowngradeReason: "response-declined",
      confirmation: "downgraded",
      responseServiceTier: "default",
    });
    expect(downgradedOutcome).not.toHaveProperty("canonical");
    expect(downgraded.cost.total).toBeCloseTo(0.23, 9);
    expect(downgraded.priorityMultiplier).toBeUndefined();
  });

  test("confirmed priority at 200k uses the long-context price as a marked lower bound", () => {
    const long = estimate(outcome("priority"), {
      inputTokens: 200_000,
      outputTokens: 10_000,
      cacheReadInputTokens: 50_000,
    });
    expect(long.contextTier).toBe("long");
    expect(long.priorityMultiplier).toBeUndefined();
    expect(long.priorityLowerBound).toBe(true);
    expect(long.cost).toMatchObject({
      input: 0.6,
      cacheRead: 0.05,
      output: 0.12,
    });
    expect(long.cost.total).toBeCloseTo(0.77, 9);
  });

  test("a combo is a lower bound only when every priced attempt is a lower bound", () => {
    const confirmed = outcome("priority");
    const lowerBoundAttempt = {
      ordinal: 1,
      provider: "xai",
      model: "grok-4.6",
      usageStatus: "reported" as const,
      usage: { inputTokens: 200_000, outputTokens: 10_000 },
      tierOutcome: confirmed,
    };
    const ordinaryAttempt = {
      ordinal: 2,
      provider: "xai",
      model: "grok-4.6",
      usageStatus: "reported" as const,
      usage,
    };

    expect(estimateComboCost([lowerBoundAttempt, { ...lowerBoundAttempt, ordinal: 2 }])?.priorityLowerBound).toBe(true);
    expect(estimateComboCost([lowerBoundAttempt, ordinaryAttempt])?.priorityLowerBound).toBeUndefined();
  });
});

describe("long-context pricing tiers (#908)", () => {
  const SOL: ExpectedPriceOverlay[] = [
    { provider: "openai", modelId: "gpt-5.6-sol", cost4: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 }, source: "test", verifiedAt: "2026-08-03", status: "verified" },
    { provider: "openai", modelId: "gpt-5.3-codex-spark", cost4: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 }, source: "test", verifiedAt: "2026-08-03", status: "verified" },
  ];
  const sol = (usage: Record<string, number>, serviceTier?: Parameters<typeof estimateRequestCost>[0]["serviceTier"]) =>
    estimateRequestCost({ provider: "openai", model: "gpt-5.6-sol", usageStatus: "reported", usage, serviceTier }, SOL);

  test("L1. OpenAI boundary is exclusive: 272,000 is standard, 272,001 is long", () => {
    const at = sol({ inputTokens: 272_000, outputTokens: 10_000 });
    const over = sol({ inputTokens: 272_001, outputTokens: 10_000 });
    expect(at!.contextTier).toBeUndefined();
    expect(over!.contextTier).toBe("long");
    // 2x input, 1.5x output — not a uniform doubling. Compare at equal token
    // counts so the one-token difference across the boundary does not skew it.
    const overSameTokens = sol({ inputTokens: 272_001, outputTokens: 10_000 })!;
    expect(overSameTokens.cost.output).toBeCloseTo(at!.cost.output * 1.5, 9);
    expect(overSameTokens.cost.input / (272_001 / 1e6)).toBeCloseTo(10, 9);
    expect(at!.cost.input / (272_000 / 1e6)).toBeCloseTo(5, 9);
  });

  test("L2. worked example: 300k in + 20k out is $2.10 standard, $3.90 long", () => {
    // The tier is what makes this $3.90; without it the estimator reports $2.10.
    const est = sol({ inputTokens: 300_000, outputTokens: 20_000 });
    expect(est!.contextTier).toBe("long");
    expect(est!.cost.total).toBeCloseTo(3.9, 9);
    const short = 300_000 / 1e6 * 5 + 20_000 / 1e6 * 30;
    expect(short).toBeCloseTo(2.1, 9);
  });

  test("L2b. Daybreak aliases: Blue carries the sol tier, Red carries none", () => {
    // An alias is priced as its current snapshot, so the shipped rows are the real check.
    const red = resolveMatchedPrice("openai-apikey", "daybreak-red-latest");
    const blue = resolveMatchedPrice("openai-apikey", "daybreak-blue-latest");
    const gptBlueOpenAi = resolveMatchedPrice("openai", "gpt-daybreak-blue-latest");
    expect(red?.cost4).toEqual({ input: 12.5, output: 75, cacheRead: 1.25, cacheWrite: 15.625 });
    expect(blue?.cost4).toEqual({ input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 });
    expect(gptBlueOpenAi?.cost4).toEqual({ input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 });
    // verified-derived, never verified: the pricing page has no daybreak-* rows, only the
    // snapshots'. This status is also what keeps `estimated` on downstream, and an alias is
    // more drift-prone than a normal row because OpenAI can repoint it.
    expect(red?.status).toBe("verified-derived");
    expect(blue?.status).toBe("verified-derived");
    expect(gptBlueOpenAi?.status).toBe("verified-derived");
    expect(resolveMatchedPrice("openai-apikey", "gpt-daybreak-blue-latest")).toBeNull();
    expect(resolveMatchedPrice("openai", "daybreak-blue-latest")).toBeNull();
    expect(resolveMatchedPrice("openai", "daybreak-red-latest")).toBeNull();

    const alias = (model: string, usage: Record<string, number>, provider = "openai-apikey") =>
      estimateRequestCost({ provider, model, usageStatus: "reported", usage });
    // Blue aliases gpt-5.6-sol, which publishes a long-context row: same exclusive boundary.
    expect(alias("daybreak-blue-latest", { inputTokens: 272_000, outputTokens: 10_000 })!.contextTier).toBeUndefined();
    expect(alias("daybreak-blue-latest", { inputTokens: 272_001, outputTokens: 10_000 })!.contextTier).toBe("long");
    expect(alias("gpt-daybreak-blue-latest", { inputTokens: 272_000, outputTokens: 10_000 }, "openai")!.contextTier).toBeUndefined();
    expect(alias("gpt-daybreak-blue-latest", { inputTokens: 272_001, outputTokens: 10_000 }, "openai")!.contextTier).toBe("long");
    // Red aliases gpt-5.6-cyber, whose four long-context cells are all "-" — no tier at all,
    // so a large prompt must stay on the standard rate rather than inheriting the family rule.
    const redOver = alias("daybreak-red-latest", { inputTokens: 272_001, outputTokens: 10_000 })!;
    expect(redOver.contextTier).toBeUndefined();
    expect(redOver.cost.input / (272_001 / 1e6)).toBeCloseTo(12.5, 9);

    // Each spelling stays in the provider namespace where that selector is routable.
    expect(CONTEXT_TIERS.filter(t => t.modelId === "daybreak-blue-latest").map(t => t.provider)).toEqual(["openai-apikey"]);
    expect(CONTEXT_TIERS.filter(t => t.modelId === "gpt-daybreak-blue-latest").map(t => t.provider)).toEqual(["openai"]);
    expect(CONTEXT_TIERS.some(t => t.modelId === "daybreak-red-latest")).toBe(false);
  });

  test("L3. threshold reads RAW input, not cache-normalized billable input", () => {
    // 280k prompt with a 200k cache read: 80k billable input, but the vendor
    // threshold is measured on the whole prompt. Deciding after normalization
    // would under-bill exactly the cache-heavy long requests.
    const est = sol({ inputTokens: 280_000, outputTokens: 1_000, cachedInputTokens: 200_000 });
    expect(est!.tokens.input).toBe(80_000);
    expect(est!.contextTier).toBe("long");
    expect(est!.cost.cacheRead).toBeCloseTo(200_000 / 1e6 * 0.5 * 2, 9);
  });

  test("L4. xAI boundary is inclusive: 199,999 standard, 200,000 long", () => {
    const overlays: ExpectedPriceOverlay[] = [
      { provider: "xai", modelId: "grok-4.5", cost4: { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0 }, source: "test", verifiedAt: "2026-08-03", status: "verified" },
    ];
    const at = (n: number) => estimateRequestCost({ provider: "xai", model: "grok-4.5", usageStatus: "reported", usage: { inputTokens: n, outputTokens: 1_000 } }, overlays);
    expect(at(199_999)!.contextTier).toBeUndefined();
    expect(at(200_000)!.contextTier).toBe("long");
  });

  test("L5. MiniMax casing is exact: MiniMax-M3 tiers, minimax-m3 does not", () => {
    const overlays: ExpectedPriceOverlay[] = [
      { provider: "minimax", modelId: "MiniMax-M3", cost4: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 }, source: "test", verifiedAt: "2026-08-03", status: "verified" },
      { provider: "minimax", modelId: "minimax-m3", cost4: { input: 0.6, output: 2.4, cacheRead: 0.12, cacheWrite: 0 }, source: "test", verifiedAt: "2026-08-03", status: "verified" },
    ];
    const at = (model: string, n: number) => estimateRequestCost({ provider: "minimax", model, usageStatus: "reported", usage: { inputTokens: n, outputTokens: 1_000 } }, overlays);
    expect(at("MiniMax-M3", 512_000)!.contextTier).toBeUndefined();
    expect(at("MiniMax-M3", 512_001)!.contextTier).toBe("long");
    // The bundle carries both ids at different rates; case-folding would pick the wrong row.
    expect(at("minimax-m3", 512_001)!.contextTier).toBeUndefined();
  });

  test("L6. routed resellers price independently: cursor/openrouter never tier", () => {
    const overlays: ExpectedPriceOverlay[] = [
      { provider: "cursor", modelId: "gpt-5.6-sol", cost4: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 }, source: "test", verifiedAt: "2026-08-03", status: "verified" },
      { provider: "openrouter", modelId: "gpt-5.6-sol", cost4: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 }, source: "test", verifiedAt: "2026-08-03", status: "verified" },
    ];
    for (const provider of ["cursor", "openrouter"]) {
      const est = estimateRequestCost({ provider, model: "gpt-5.6-sol", usageStatus: "reported", usage: { inputTokens: 1_000_000, outputTokens: 10_000 } }, overlays);
      expect(est!.contextTier).toBeUndefined();
    }
  });

  test("L7. a model with no published tier is unaffected at any size", () => {
    const est = estimateRequestCost({ provider: "openai", model: "gpt-5.3-codex-spark", usageStatus: "reported", usage: { inputTokens: 5_000_000, outputTokens: 10_000 } }, SOL);
    expect(est!.contextTier).toBeUndefined();
    expect(est!.cost.total).toBeCloseTo(5_000_000 / 1e6 * 1.75 + 10_000 / 1e6 * 14, 9);
  });

  test("L8. Fast and long context are mutually exclusive, by PROVENANCE", () => {
    const usage = { inputTokens: 300_000, outputTokens: 20_000 };
    // Response-confirmed Fast: OpenAI does not serve long context in Fast mode,
    // so the request really was Fast and the context tier must not apply.
    const confirmed = sol(usage, { responseServiceTier: "priority" });
    expect(confirmed!.contextTier).toBeUndefined();
    expect(confirmed!.priorityMultiplier).toBe(2);
    expect(confirmed!.cost.total).toBeCloseTo(4.2, 9);

    // Requested/configured only, with no response confirmation: a >272k request
    // cannot have been served as Fast, so it was downgraded and bills long.
    // Suppressing the tier here would under-bill exactly the downgraded request.
    for (const tier of [{ requestedServiceTier: "priority" }, { configuredServiceTier: "priority" }]) {
      const downgraded = sol(usage, tier);
      expect(downgraded!.contextTier).toBe("long");
      expect(downgraded!.cost.total).toBeCloseTo(3.9, 9);
    }
  });

  test("L9. combo carries the tier when any attempt is long", () => {
    const combo = estimateComboCost([
      { ordinal: 1, provider: "openai", model: "gpt-5.6-sol", usageStatus: "reported", usage: { inputTokens: 300_000, outputTokens: 10_000 } },
      { ordinal: 2, provider: "openai", model: "gpt-5.6-sol", usageStatus: "reported", usage: { inputTokens: 1_000, outputTokens: 10_000 } },
    ], SOL);
    expect(combo!.attempts![0]!.contextTier).toBe("long");
    expect(combo!.attempts![1]!.contextTier).toBeUndefined();
    expect(combo!.contextTier).toBe("long");
  });

  test("L10. -pro virtual aliases are priceable AND tier (regression: returned null)", () => {
    for (const model of ["gpt-5.6-sol-pro", "gpt-5.6-terra-pro", "gpt-5.6-luna-pro"]) {
      // Shipped overlays on purpose: these ids had no base price at all, so the
      // estimator returned null and the dashboard showed no cost for them.
      const priced = estimateRequestCost({ provider: "openai-apikey", model, usageStatus: "reported", usage: { inputTokens: 1_000, outputTokens: 1_000 } });
      expect(priced).not.toBeNull();
      const long = estimateRequestCost({ provider: "openai-apikey", model, usageStatus: "reported", usage: { inputTokens: 272_001, outputTokens: 1_000 } });
      expect(long!.contextTier).toBe("long");
    }
  });

  test("L11. every tier rule records a source and a verification date", () => {
    expect(CONTEXT_TIERS.length).toBeGreaterThan(0);
    for (const tier of CONTEXT_TIERS) {
      expect(tier.source).toMatch(/^https:\/\//);
      expect(tier.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(tier.thresholdInputTokens).toBeGreaterThan(0);
    }
  });
});

describe("provider cost overlay (user-configured)", () => {
  const USER_PRICE = { input: 0.5, output: 2, cacheRead: 0.1, cacheWrite: 0.25 };
  const USER_ROWS: ExpectedPriceOverlay[] = [{
    provider: "deepseek",
    modelId: "deepseek-chat",
    cost4: USER_PRICE,
    source: "config:providers.deepseek.modelCosts[deepseek-chat]",
    verifiedAt: "user-configured",
    status: "verified",
  }];

  afterEach(() => {
    // The registry is module-level; reset it even when a test fails early so
    // rows cannot leak into other files in a shared-process run.
    refreshUserCostOverlays({ providers: {} } as unknown as OcxConfig);
  });

  test("user overlay beats the jawcode price and reads verified (not estimated)", () => {
    const price = resolveMatchedPrice("deepseek", "deepseek-chat", undefined, USER_ROWS);
    expect(price).toMatchObject({
      provider: "deepseek",
      modelId: "deepseek-chat",
      cost4: USER_PRICE,
      source: "user",
      status: "verified",
    });
    expect(price?.sourceRef).toBe("config:providers.deepseek.modelCosts[deepseek-chat]");
    expect(price?.verifiedAt).toBe("user-configured");
    const estimate = estimateRequestCost({
      provider: "deepseek",
      model: "deepseek-chat",
      usage: { inputTokens: 1_000_000, outputTokens: 500_000 },
      usageStatus: "reported",
    }, undefined, USER_ROWS);
    expect(estimate?.cost.total).toBeCloseTo(0.5 + 1.0, 9);
    expect(estimate?.estimated).toBe(false);
    expect(estimate?.price?.source).toBe("user");
  });

  test("custom provider names resolve only via the user overlay", () => {
    // Fabricated model id: absent from the jawcode catalog, so only the user
    // overlay can price it (deepseek-v4-flash itself would resolve through the
    // model-level vendor fallback).
    expect(resolveMatchedPrice("blsc", "blsc-test-model")).toBeNull();
    const rows: ExpectedPriceOverlay[] = [{
      provider: "blsc",
      modelId: "blsc-test-model",
      cost4: USER_PRICE,
      source: "config:providers.blsc.modelCosts[blsc-test-model]",
      verifiedAt: "user-configured",
      status: "verified",
    }];
    const price = resolveMatchedPrice("blsc", "blsc-test-model", undefined, rows);
    expect(price).toMatchObject({ provider: "blsc", modelId: "blsc-test-model", source: "user" });
  });

  test("user overlay matches an exact provider name ending with an account-label suffix", () => {
    refreshUserCostOverlays({
      providers: {
        "blsc-pabcdef": {
          modelCosts: { "custom-model": USER_PRICE },
        },
      },
    } as unknown as OcxConfig);
    // "pabcdef" matches the Codex account-log-label pattern, so the base label
    // collapses to "blsc"; the exact provider name must still win for its own
    // configured overlay.
    const price = resolveMatchedPrice("blsc-pabcdef", "custom-model");
    expect(price).toMatchObject({
      provider: "blsc-pabcdef",
      modelId: "custom-model",
      cost4: USER_PRICE,
      source: "user",
      status: "verified",
    });
    expect(price?.sourceRef).toBe("config:providers.blsc-pabcdef.modelCosts[custom-model]");
  });

  test("a configured provider with a label-shaped suffix never inherits the base provider's user overlay", () => {
    refreshUserCostOverlays({
      providers: {
        acme: { modelCosts: { "acme-custom-model": USER_PRICE } },
        "acme-pabcdef": { adapter: "openai-chat", baseUrl: "https://example.invalid" },
      },
    } as unknown as OcxConfig);
    // The literal provider exists in config.providers, so its pricing namespace
    // stays isolated even though the name matches the account-label pattern:
    // it must NOT price through acme's user overlay.
    expect(resolveMatchedPrice("acme-pabcdef", "acme-custom-model")).toBeNull();
    // The base provider itself still resolves through its own overlay.
    expect(resolveMatchedPrice("acme", "acme-custom-model")).toMatchObject({
      provider: "acme",
      modelId: "acme-custom-model",
      cost4: USER_PRICE,
      source: "user",
      status: "verified",
    });
  });

  test("an all-zero overlay on a suffix-shaped configured provider falls through to compiled pricing, not the base provider's overlay", () => {
    refreshUserCostOverlays({
      providers: {
        acme: { modelCosts: { "claude-opus-4-6": USER_PRICE } },
        "acme-pabcdef": {
          modelCosts: { "claude-opus-4-6": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
        },
      },
    } as unknown as OcxConfig);
    const price = resolveMatchedPrice("acme-pabcdef", "claude-opus-4-6");
    // The all-zero row falls through to compiled/catalog pricing — the
    // documented fallback order — and never to acme's user-configured price.
    expect(price).not.toBeNull();
    expect(price?.provider).toBe("acme-pabcdef");
    expect(price?.source).toBe("jawcode");
    expect(price?.cost4).not.toEqual(USER_PRICE);
    // A real positive catalog price, without pinning the vendor's current
    // rate (the catalog lives outside this PR and may change independently).
    expect(price?.cost4?.input).toBeGreaterThan(0);
    expect(price?.cost4?.output).toBeGreaterThan(0);
  });

  test("a generated account label (not a configured provider) still collapses to the base provider's overlay", () => {
    refreshUserCostOverlays({
      providers: {
        acme: { modelCosts: { "acme-custom-model": USER_PRICE } },
      },
    } as unknown as OcxConfig);
    // acme-pabcdef is NOT in config.providers here — it is a generated log
    // label for an acme account, so collapsing to acme's overlay is intended.
    const price = resolveMatchedPrice("acme-pabcdef", "acme-custom-model");
    expect(price).toMatchObject({
      provider: "acme",
      modelId: "acme-custom-model",
      cost4: USER_PRICE,
      source: "user",
      status: "verified",
    });
  });

  test("configuring a provider invalidates its collapsed memo entry immediately", () => {
    refreshUserCostOverlays({
      providers: {
        acme: { modelCosts: { "acme-custom-model": USER_PRICE } },
      },
    } as unknown as OcxConfig);
    // Not configured yet → generated label → collapses to acme (memoized).
    expect(resolveMatchedPrice("acme-pabcdef", "acme-custom-model")?.source).toBe("user");
    // The provider is now configured (without an overlay): namespace isolation
    // must apply immediately — the resolver memo cannot keep serving the stale
    // collapsed entry, even though no overlay row changed.
    refreshUserCostOverlays({
      providers: {
        acme: { modelCosts: { "acme-custom-model": USER_PRICE } },
        "acme-pabcdef": { adapter: "openai-chat", baseUrl: "https://example.invalid" },
      },
    } as unknown as OcxConfig);
    expect(resolveMatchedPrice("acme-pabcdef", "acme-custom-model")).toBeNull();
  });

  test("all-zero user overlay falls through to the expected overlay price", () => {
    const zero: ExpectedPriceOverlay[] = [{
      provider: "deepseek",
      modelId: "deepseek-chat",
      cost4: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      source: "config:providers.deepseek.modelCosts[deepseek-chat]",
      verifiedAt: "user-configured",
      status: "verified",
    }];
    const price = resolveMatchedPrice("deepseek", "deepseek-chat", undefined, zero);
    expect(price?.source).toBe("expected");
    // A real positive expected-overlay price, without pinning the current
    // rate (the overlay table may change independently of this feature).
    expect(price?.cost4.input).toBeGreaterThan(0);
  });

  test("combo fails closed when a user-priced attempt shares a combo with an unpriced one", () => {
    const attempts = [
      { ordinal: 1, provider: "deepseek", model: "deepseek-chat", usageStatus: "reported" as const, usage: { inputTokens: 100, outputTokens: 10 } },
      { ordinal: 2, provider: "blsc", model: "unknown-model", usageStatus: "reported" as const, usage: { inputTokens: 100, outputTokens: 10 } },
    ];
    expect(estimateComboCost(attempts, undefined, undefined, USER_ROWS)).toBeNull();
    const priced = [attempts[0]];
    const combo = estimateComboCost(priced, undefined, undefined, USER_ROWS);
    expect(combo?.attempts[0].price.source).toBe("user");
    expect(combo?.attempts[0].cost.total).toBeCloseTo((0.5 * 100 + 2 * 10) / 1e6, 12);
  });

  test("registry refresh replaces rows, bumps the version, and invalidates the memo", () => {
    const before = activeUserCostOverlays();
    const versionBefore = userCostOverlayVersion();
    refreshUserCostOverlays({
      providers: {
        blsc: {
          adapter: "openai-chat",
          baseUrl: "https://example.invalid",
          modelCosts: {
            "deepseek-v4-flash": USER_PRICE,
            "overlay-test-model": USER_PRICE,
          },
        },
      },
    } as unknown as OcxConfig);
    expect(activeUserCostOverlays()).not.toBe(before);
    expect(userCostOverlayVersion()).toBe(versionBefore + 1);
    // Default lookup path (registry-backed, memoized) picks the configured price up.
    const first = resolveMatchedPrice("blsc", "deepseek-v4-flash");
    expect(first).toMatchObject({ source: "user", cost4: USER_PRICE });
    expect(resolveMatchedPrice("blsc", "overlay-test-model")?.source).toBe("user");
    // A price change must not be served from the stale memo.
    refreshUserCostOverlays({
      providers: {
        blsc: {
          adapter: "openai-chat",
          baseUrl: "https://example.invalid",
          modelCosts: {
            "deepseek-v4-flash": { ...USER_PRICE, input: 0.99 },
            "overlay-test-model": { ...USER_PRICE, input: 0.99 },
          },
        },
      },
    } as unknown as OcxConfig);
    const second = resolveMatchedPrice("blsc", "deepseek-v4-flash");
    expect(second?.cost4.input).toBe(0.99);
    expect(resolveMatchedPrice("blsc", "overlay-test-model")?.cost4.input).toBe(0.99);
    // Leave the registry empty for the rest of the file.
    refreshUserCostOverlays({ providers: {} } as unknown as OcxConfig);
    expect(resolveMatchedPrice("blsc", "overlay-test-model")).toBeNull();
    // Without the overlay, deepseek-v4-flash falls back to its jawcode vendor price.
    expect(resolveMatchedPrice("blsc", "deepseek-v4-flash")?.source).toBe("jawcode");
  });

  test("refresh with identical rows is a no-op for the version and memo", () => {
    const config = {
      providers: {
        blsc: {
          adapter: "openai-chat",
          baseUrl: "https://example.invalid",
          modelCosts: {
            "deepseek-v4-flash": USER_PRICE,
          },
        },
      },
    } as unknown as OcxConfig;
    refreshUserCostOverlays(config);
    const versionAfterFirst = userCostOverlayVersion();
    const rowsAfterFirst = activeUserCostOverlays();
    // Config reloads (server start, persist paths) pass the same rows again;
    // they must not churn the version or replace the active array identity.
    refreshUserCostOverlays(config);
    expect(userCostOverlayVersion()).toBe(versionAfterFirst);
    expect(activeUserCostOverlays()).toBe(rowsAfterFirst);
    expect(resolveMatchedPrice("blsc", "deepseek-v4-flash")?.source).toBe("user");
    // Leave the registry empty for the rest of the file.
    refreshUserCostOverlays({ providers: {} } as unknown as OcxConfig);
  });

  test("registry redacts token-shaped ids in display source but keeps raw matching and change detection", () => {
    const configWith = (provider: string, model: string) => ({
      providers: { [provider]: { modelCosts: { [model]: USER_PRICE } } },
    }) as unknown as OcxConfig;
    refreshUserCostOverlays(configWith("sk-provider-123", "sk-model-456"));
    const rows = activeUserCostOverlays();
    expect(rows).toHaveLength(1);
    // Matching fields stay raw so exact-name resolution still works.
    expect(rows[0].provider).toBe("sk-provider-123");
    expect(rows[0].modelId).toBe("sk-model-456");
    // The display-only source redacts token-shaped ids.
    expect(rows[0].source).not.toContain("sk-provider-123");
    expect(rows[0].source).not.toContain("sk-model-456");
    expect(rows[0].source).toContain("[REDACTED]");
    expect(resolveMatchedPrice("sk-provider-123", "sk-model-456")?.source).toBe("user");
    // Identical refresh stays a no-op.
    const versionBefore = userCostOverlayVersion();
    refreshUserCostOverlays(configWith("sk-provider-123", "sk-model-456"));
    expect(userCostOverlayVersion()).toBe(versionBefore);
    // A DIFFERENT secret-shaped id with the same rates must still bump: the
    // change-detection signature compares raw matching fields, not the redacted
    // display strings (both would otherwise collapse to "[REDACTED]").
    refreshUserCostOverlays(configWith("sk-provider-789", "sk-model-456"));
    expect(userCostOverlayVersion()).toBe(versionBefore + 1);
    expect(activeUserCostOverlays()[0].provider).toBe("sk-provider-789");
    // Leave the registry empty for the rest of the file.
    refreshUserCostOverlays({ providers: {} } as unknown as OcxConfig);
  });
});

describe("aggregator vendor-prefixed model ids (#3136)", () => {
  // CommandCode serves "deepseek/deepseek-v4-flash"; the cost catalog stores the bare id.
  // The exact lookup missed a price that is present, so every request through such a
  // provider reported no cost at all.
  test("a vendor-prefixed id resolves to the same price as its bare id", () => {
    const bare = resolveMatchedPrice("deepseek", "deepseek-v4-flash");
    const prefixed = resolveMatchedPrice("commandcode-api", "deepseek/deepseek-v4-flash");
    expect(bare?.cost4).toBeDefined();
    expect(prefixed?.cost4).toEqual(bare!.cost4);
    // Derived, not claimed as an exact catalog row for that provider.
    expect(prefixed?.status).toBe("verified-derived");
    expect(prefixed?.jawcodeProvider).toBe("deepseek");
  });

  test("the vendor prefix is compared after normalization, so x-ai matches xai", () => {
    // The same vendor is spelled differently across catalogs. Dashes and case are the
    // only variance this normalizes; anything further stays a miss.
    expect(resolveMatchedPrice("openrouter", "x-ai/grok-4.6")?.cost4).toBeDefined();
  });

  test("a prefix that disagrees with the matched vendor stays unpriced", () => {
    // This is the assertion that keeps the fix from becoming a mispricing.
    // findVendorCostByModelId returns whichever vendor COST_VENDOR_PRIORITY reaches
    // first, so an unchecked strip would price a Claude model from Anthropic's row while
    // the caller named OpenAI - a number that looks authoritative and is wrong.
    expect(resolveMatchedPrice("openrouter", "openai/claude-opus-4-6")).toBeNull();
  });

  test("an unknown tail is still unpriced rather than guessed", () => {
    expect(resolveMatchedPrice("openrouter", "google/gemini-3.6-pro")).toBeNull();
  });

  test("unprefixed ids are unchanged", () => {
    expect(resolveMatchedPrice("deepseek", "deepseek-v4-flash")?.cost4).toBeDefined();
    expect(resolveMatchedPrice("deepseek", "not-a-real-model-xyz")).toBeNull();
  });

  test("a doubly-slashed id is not treated as a vendor prefix", () => {
    // Only one prefix segment is understood; deeper paths are left alone rather than
    // being peeled until something matches.
    expect(resolveMatchedPrice("openrouter", "a/deepseek/deepseek-v4-flash")).toBeNull();
  });
});
