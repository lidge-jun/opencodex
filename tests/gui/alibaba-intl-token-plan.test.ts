import { describe, expect, test } from "bun:test";
import {
  baseUrlForChoice,
  matchChoiceId,
  resolvedBaseUrlForChoice,
} from "../../gui/src/base-url-choice";
import {
  ALIBABA_INTL_BASE_URL_CHOICES,
  ALIBABA_INTL_TOKEN_PLAN_BASE_URL,
  ALIBABA_INTL_PAYG_BASE_URL,
  matchBaseUrlChoice,
} from "../../src/providers/base-url-choices";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { deriveProviderPresets, enrichProviderFromRegistry, providerConfigSeed } from "../../src/providers/derive";

const CHOICES = [...ALIBABA_INTL_BASE_URL_CHOICES];

describe("alibaba-token-plan-intl registry entry", () => {
  test("registry entry exists with correct base URL and choices", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "alibaba-token-plan-intl");
    expect(entry).toBeDefined();
    expect(entry!.baseUrl).toBe(ALIBABA_INTL_TOKEN_PLAN_BASE_URL);
    expect(entry!.allowBaseUrlOverride).toBe(true);
    expect(entry!.baseUrlChoices?.map(c => c.id)).toEqual(["token-plan", "payg", "custom"]);
    expect(entry!.baseUrlChoices).toEqual([...ALIBABA_INTL_BASE_URL_CHOICES]);
  });

  test("model list includes multi-vendor lineup", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "alibaba-token-plan-intl");
    expect(entry!.models).toContain("qwen3.7-max");
    expect(entry!.models).toContain("kimi-k2.7-code");
    expect(entry!.models).toContain("glm-5.2");
    expect(entry!.models).toContain("MiniMax-M2.5");
    expect(entry!.models).toContain("qwen3.8-max");
    // 260909 gateway re-probe (both regions, both tiers): deepseek-v4-pro is still
    // listed and callable on Token Plan, so the retirement drop is restored here.
    expect(entry!.models).toContain("deepseek-v4-pro");
    // Callable snapshots the gateway omits (or lists late) from /models, which is
    // also why liveModels must stay false for this provider.
    expect(entry!.models).toContain("qwen3.8-flash");
    expect(entry!.models).toContain("deepseek-v4-pro-0813");
    expect(entry!.models).toContain("deepseek-v4-flash-0731");
    // DeepSeek's 260910 rename row: listed on /models from 260915 on both tiers.
    expect(entry!.models).toContain("deepseek-v4.1-flash");
    // GLM-5.3 and GLM-5.3-flash exist on Z.AI endpoints but NOT on Token Plan: the
    // 260826 seed commit propagated them across every GLM-carrying catalog. Either
    // row 404s here (probed 260907 and 260909, both regions and both tiers).
    expect(entry!.models).not.toContain("glm-5.3");
    expect(entry!.models).not.toContain("glm-5.3-flash");
    expect(entry!.models!.length).toBe(19);
  });

  test("MiniMax case-insensitive normalization is set", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "alibaba-token-plan-intl");
    expect(entry!.metadataModelIdNormalize).toBe("case-insensitive");
  });

  test("qwen3.8-max has correct context window", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "alibaba-token-plan-intl");
    // 983_616 is the CLAUDE_CODE_MAX_CONTEXT_TOKENS client default, not the model
    // window. Both qwen3.8 GA rows serve 1,000,000 (probed 260720/260902).
    expect(entry!.modelContextWindows?.["qwen3.8-max"]).toBe(1_000_000);
    expect(entry!.modelContextWindows?.["qwen3.8-flash"]).toBe(1_000_000);
  });

  test("every international chat model has an explicit context window", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "alibaba-token-plan-intl");
    expect(entry!.modelContextWindows?.["deepseek-v3.2"]).toBe(131_072);
    expect(entry!.modelContextWindows?.["glm-5"]).toBe(202_752);
    expect(entry!.modelContextWindows?.["MiniMax-M2.5"]).toBe(196_608);
    for (const model of entry!.models ?? []) {
      expect(entry!.modelContextWindows?.[model]).toBeGreaterThan(0);
    }
  });

  test("qwen3.8-max reasoning efforts", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "alibaba-token-plan-intl");
    expect(entry!.modelReasoningEfforts?.["qwen3.8-max"]).toEqual(["low", "medium", "xhigh"]);
    // 260909: qwen3.8-flash graduated onto the same documented ladder (low/medium/xhigh,
    // default xhigh) and the same direct-effort transport.
    expect(entry!.modelReasoningEfforts?.["qwen3.8-flash"]).toEqual(["low", "medium", "xhigh"]);
    expect(entry!.directReasoningEffortModels).toEqual(["qwen3.8-max", "qwen3.8-flash"]);
    expect(entry!.thinkingBudgetModels).not.toContain("qwen3.8-max");
    expect(entry!.thinkingBudgetModels).not.toContain("qwen3.8-flash");
    expect(entry!.thinkingBudgetModels).toContain("qwen3.7-max");
  });

  test("qwen3.8-max default reasoning effort is xhigh", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "alibaba-token-plan-intl");
    expect(entry!.modelDefaultReasoningEfforts?.["qwen3.8-max"]).toBe("xhigh");
  });

  test("qwen3.8-max is in preserveReasoningContentModels", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "alibaba-token-plan-intl");
    expect(entry!.preserveReasoningContentModels).toContain("qwen3.8-max");
  });

  // 260804: Qwen3.8-Max left preview, and Alibaba documents the preview endpoint as
  // liable to be taken offline. The rename must carry EVERY capability key across both
  // Alibaba providers — a rename that silently drops one degrades the model without
  // failing anything else. Ablate by removing any single key below and this goes red.
  test("the preview id is fully retired and its metadata moved to the stable id", () => {
    for (const id of ["alibaba-token-plan", "alibaba-token-plan-intl"]) {
      const entry = PROVIDER_REGISTRY.find(e => e.id === id)!;
      expect(entry.models).toContain("qwen3.8-max");
      expect(entry.models).not.toContain("qwen3.8-max-preview");
      expect(entry.modelContextWindows?.["qwen3.8-max"]).toBe(1_000_000);
      expect(entry.modelContextWindows?.["qwen3.8-max-preview"]).toBeUndefined();
      expect(entry.modelInputModalities?.["qwen3.8-max"]).toEqual(["text", "image"]);
      expect(entry.preserveReasoningContentModels).toContain("qwen3.8-max");
      expect(entry.preserveReasoningContentModels).not.toContain("qwen3.8-max-preview");
    }
    // The intl entry additionally carries the effort ladder.
    const intl = PROVIDER_REGISTRY.find(e => e.id === "alibaba-token-plan-intl")!;
    expect(intl.modelReasoningEfforts?.["qwen3.8-max"]).toEqual(["low", "medium", "xhigh"]);
    expect(intl.modelDefaultReasoningEfforts?.["qwen3.8-max"]).toBe("xhigh");
    // Only the Beijing entry defaults to this model; intl deliberately defaults to
    // qwen3.7-max. That predates this rename and is left alone — renaming an id is not
    // a licence to change which model a provider selects by default.
    expect(PROVIDER_REGISTRY.find(e => e.id === "alibaba-token-plan")!.defaultModel).toBe("qwen3.8-max");
  });

  test("registry enrichment preserves deliberate case-varied Qwen3.8 overrides", () => {
    const provider = {
      adapter: "openai-chat",
      baseUrl: ALIBABA_INTL_TOKEN_PLAN_BASE_URL,
      modelReasoningEfforts: { "QWEN3.8-MAX": ["low", "high", "xhigh"] },
      modelDefaultReasoningEfforts: { "QWEN3.8-MAX": "high" },
      reasoningEffortMap: { xhigh: "max" },
      modelReasoningEffortMap: { "QWEN3.8-MAX": { medium: "high" } },
      thinkingBudgetModels: ["QWEN3.8-MAX", "qwen3.7-max"],
    };

    enrichProviderFromRegistry("alibaba-token-plan-intl", provider);

    expect(provider.modelReasoningEfforts["qwen3.8-max"]).toBeUndefined();
    expect(provider.modelReasoningEfforts["QWEN3.8-MAX"]).toEqual(["low", "high", "xhigh"]);
    expect(provider.modelDefaultReasoningEfforts["qwen3.8-max"]).toBeUndefined();
    expect(provider.modelDefaultReasoningEfforts["QWEN3.8-MAX"]).toBe("high");
    expect(provider.modelReasoningEffortMap?.["qwen3.8-max"]).toBeUndefined();
    expect(provider.modelReasoningEffortMap?.["QWEN3.8-MAX"]).toEqual({ medium: "high" });
    expect(provider.thinkingBudgetModels).toEqual(["QWEN3.8-MAX", "qwen3.7-max"]);
  });

  test("non-reasoning models are marked", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "alibaba-token-plan-intl");
    expect(entry!.noReasoningModels).toContain("kimi-k2.7-code");
    expect(entry!.noReasoningModels).toContain("kimi-k2.6");
    expect(entry!.noReasoningModels).toContain("kimi-k2.5");
    expect(entry!.noReasoningModels).toContain("deepseek-v3.2");
    expect(entry!.noReasoningModels).toContain("glm-5.1");
    expect(entry!.noReasoningModels).toContain("glm-5");
    expect(entry!.noReasoningModels).toContain("MiniMax-M2.5");
  });

  test("kimi-k2.7-code is not in noVisionModels", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "alibaba-token-plan-intl");
    expect(entry!.noVisionModels).not.toContain("kimi-k2.7-code");
  });

  test("260909 gateway re-probe: text-only rows, output ceilings, and cache key wiring", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "alibaba-token-plan-intl");
    expect(entry!.modelInputModalities?.["qwen3.7-max"]).toEqual(["text"]);
    expect(entry!.noVisionModels).toContain("qwen3.7-max");
    expect(entry!.modelContextWindows?.["deepseek-v4-pro-0813"]).toBe(1_000_000);
    expect(entry!.modelMaxOutputTokens?.["deepseek-v4-pro"]).toBe(393_216);
    expect(entry!.modelMaxOutputTokens?.["qwen3.8-max"]).toBe(131_072);
    expect(entry!.modelMaxOutputTokens?.["MiniMax-M2.5"]).toBe(32_768);
    // The gateway accepts prompt_cache_key on every Token Plan chat model (probed 260902).
    expect(entry!.promptCacheKey).toBe(true);
    const cn = PROVIDER_REGISTRY.find(e => e.id === "alibaba-token-plan");
    expect(cn!.promptCacheKey).toBe(true);
    // Beijing roster pinned exactly (Personal Edition subset), including phantom absence.
    const cnModels = PROVIDER_REGISTRY.find(e => e.id === "alibaba-token-plan")!.models;
    expect(cnModels).toEqual([
      "qwen3.8-max", "qwen3.8-flash", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-flash",
      "deepseek-v4-pro", "deepseek-v4-flash-0731", "deepseek-v4.1-flash", "glm-5.2",
    ]);
    // The 260910 DeepSeek rename row is wired: vision-capable, effort ladder, and the
    // json_schema downgrade the plan gateway needs (probed 260915).
    const v41 = PROVIDER_REGISTRY.find(e => e.id === "alibaba-token-plan-intl")!;
    expect(v41.modelInputModalities?.["deepseek-v4.1-flash"]).toEqual(["text", "image"]);
    expect(v41.modelReasoningEfforts?.["deepseek-v4.1-flash"]).toEqual(["low", "high", "max"]);
    expect(v41.noJsonSchemaModels).toContain("deepseek-v4.1-flash");
    expect(v41.modelMaxOutputTokens?.["deepseek-v4.1-flash"]).toBe(393_216);
    expect(v41.modelContextWindows?.["deepseek-v4.1-flash"]).toBe(1_000_000);
    expect(v41.preserveReasoningContentModels).toContain("deepseek-v4.1-flash");
    expect(v41.noVisionModels).not.toContain("deepseek-v4.1-flash");
    expect(cnModels).not.toContain("glm-5.3");
    expect(cnModels).not.toContain("glm-5.3-flash");
    // providerConfigSeed and enrichProviderFromRegistry are the two paths that carry
    // the flag from the registry into a live provider config.
    expect(providerConfigSeed(cn!).promptCacheKey).toBe(true);
    const live: Record<string, unknown> = { adapter: "openai-chat", baseUrl: entry!.baseUrl };
    enrichProviderFromRegistry("alibaba-token-plan-intl", live as never);
    expect(live.promptCacheKey).toBe(true);
  });

  test("presets API projection includes baseUrlChoices", () => {
    const preset = deriveProviderPresets().find(p => p.id === "alibaba-token-plan-intl");
    expect(preset?.baseUrl).toBe(ALIBABA_INTL_TOKEN_PLAN_BASE_URL);
    expect(preset?.baseUrlChoices?.map(c => c.id)).toEqual(["token-plan", "payg", "custom"]);
    const payg = preset?.baseUrlChoices?.find(c => c.id === "payg");
    expect(payg?.baseUrl).toBe(ALIBABA_INTL_PAYG_BASE_URL);
  });
});

describe("alibaba-intl endpoint choice helpers", () => {
  test("matchBaseUrlChoice maps known hosts", () => {
    expect(matchBaseUrlChoice(ALIBABA_INTL_BASE_URL_CHOICES, ALIBABA_INTL_TOKEN_PLAN_BASE_URL)).toBe("token-plan");
    expect(matchBaseUrlChoice(ALIBABA_INTL_BASE_URL_CHOICES, ALIBABA_INTL_PAYG_BASE_URL + "/")).toBe("payg");
    expect(matchBaseUrlChoice(ALIBABA_INTL_BASE_URL_CHOICES, "https://example.com/v1")).toBe("custom");
  });

  test("gui choice helpers work with intl choices", () => {
    expect(baseUrlForChoice(CHOICES, "token-plan", "")).toBe(ALIBABA_INTL_TOKEN_PLAN_BASE_URL);
    expect(baseUrlForChoice(CHOICES, "payg", ALIBABA_INTL_TOKEN_PLAN_BASE_URL)).toBe(ALIBABA_INTL_PAYG_BASE_URL);
    expect(baseUrlForChoice(CHOICES, "custom", ALIBABA_INTL_TOKEN_PLAN_BASE_URL)).toBe("");
    expect(resolvedBaseUrlForChoice(CHOICES, "payg", "https://stale/v1")).toBe(ALIBABA_INTL_PAYG_BASE_URL);
    expect(matchChoiceId(CHOICES, ALIBABA_INTL_TOKEN_PLAN_BASE_URL + "/")).toBe("token-plan");
  });
});
