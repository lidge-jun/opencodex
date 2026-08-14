import { describe, expect, test } from "bun:test";
import {
  baseUrlForChoice,
  matchChoiceId,
  resolvedBaseUrlForChoice,
} from "../gui/src/base-url-choice";
import {
  ALIBABA_INTL_BASE_URL_CHOICES,
  ALIBABA_INTL_TOKEN_PLAN_BASE_URL,
  ALIBABA_INTL_PAYG_BASE_URL,
  matchBaseUrlChoice,
} from "../src/providers/base-url-choices";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { deriveProviderPresets, enrichProviderFromRegistry } from "../src/providers/derive";

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
    expect(entry!.models).toContain("deepseek-v4-pro");
    expect(entry!.models).toContain("kimi-k2.7-code");
    expect(entry!.models).toContain("glm-5.2");
    expect(entry!.models).toContain("glm-5.3");
    expect(entry!.models).toContain("MiniMax-M2.5");
    expect(entry!.models).toContain("qwen3.8-max");
    expect(entry!.models!.length).toBe(16);
  });

  test("MiniMax case-insensitive normalization is set", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "alibaba-token-plan-intl");
    expect(entry!.metadataModelIdNormalize).toBe("case-insensitive");
  });

  test("qwen3.8-max has correct context window", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "alibaba-token-plan-intl");
    expect(entry!.modelContextWindows?.["qwen3.8-max"]).toBe(983_616);
  });

  test("every international chat model has an explicit context window", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "alibaba-token-plan-intl");
    expect(entry!.modelContextWindows?.["deepseek-v3.2"]).toBe(131_072);
    for (const model of entry!.models ?? []) {
      expect(entry!.modelContextWindows?.[model]).toBeGreaterThan(0);
    }
  });

  test("qwen3.8-max reasoning efforts", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "alibaba-token-plan-intl");
    expect(entry!.modelReasoningEfforts?.["qwen3.8-max"]).toEqual(["low", "medium", "xhigh"]);
    expect(entry!.directReasoningEffortModels).toEqual(["qwen3.8-max"]);
    expect(entry!.thinkingBudgetModels).not.toContain("qwen3.8-max");
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
      expect(entry.modelContextWindows?.["qwen3.8-max"]).toBe(983_616);
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
