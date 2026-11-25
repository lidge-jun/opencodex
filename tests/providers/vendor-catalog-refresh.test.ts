import { describe, expect, test } from "bun:test";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { findExpectedPriceOverlay } from "../../src/usage/expected-prices";

// Vendor catalog refresh, 2026-11-26. Each block pins one provider family to the vendor page it
// was read from, so a later edit that drifts from the source has to change a cited assertion.

describe("Google Gemini API preset (ai.google.dev models, deprecations and pricing, 2026-11-26)", () => {
  const google = getProviderRegistryEntry("google")!;

  test("defaults to the replacement Google names for the retired 3.5 Flash endpoint", () => {
    // gemini-3.5-flash is no longer offered in AI Studio; its endpoint routes to gemini-3.6-flash.
    expect(google.defaultModel).toBe("gemini-3.6-flash");
  });

  test("seeds every GA Gemini 4 model and drops the two redirected Flash ids from the picker", () => {
    for (const id of ["gemini-4-neon", "gemini-4-hydrogen", "gemini-4-carbon", "gemini-4-argon"]) {
      expect(google.models).toContain(id);
      expect(google.modelContextWindows?.[id]).toBe(1_048_576);
      expect(google.modelInputModalities?.[id]).toEqual(["text", "image"]);
      expect(google.modelReasoningEfforts?.[id]?.length).toBeGreaterThan(0);
    }
    expect(google.models).not.toContain("gemini-3.5-flash");
    expect(google.models).not.toContain("gemini-3.7-flash");
    // Saved selections of the redirected ids keep their metadata.
    expect(google.modelContextWindows?.["gemini-3.5-flash"]).toBeDefined();
    expect(google.modelContextWindows?.["gemini-3.7-flash"]).toBeDefined();
  });

  test("prices Gemini 4 Argon and Carbon at the durable list rate, not the introductory one", () => {
    const list = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 };
    for (const [provider, modelId] of [
      ["google", "gemini-4-argon"],
      ["google", "gemini-4-carbon"],
      ["google-antigravity", "gemini-4-argon"],
      ["google-antigravity", "gemini-4-argon-low"],
      ["google-antigravity", "gemini-4-argon-medium"],
      ["google-antigravity", "gemini-4-argon-high"],
    ] as const) {
      const row = findExpectedPriceOverlay(provider, modelId);
      expect(row?.cost4).toEqual(list);
      expect(row?.source).toContain("through 2026-11-30");
    }
  });
});

describe("GitHub Copilot cold-start seed (docs.github.com supported-models, 2026-11-26)", () => {
  const copilot = getProviderRegistryEntry("github-copilot")!;

  test("defaults to the long-term support model GitHub falls back to", () => {
    expect(copilot.defaultModel).toBe("gpt-5.3-codex");
  });

  test("drops ids GitHub lists as retired or no longer supports", () => {
    for (const retired of [
      "gpt-4o", "gpt-4.1", "gpt-4.1-mini", "claude-sonnet-4", "gemini-2.5-pro",
      "gpt-5-mini", "gpt-5.4", "gpt-5.4-mini", "gpt-5.5", "gpt-5.6-terra",
    ]) {
      expect(copilot.models).not.toContain(retired);
    }
    for (const ga of ["gpt-5.3-codex", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6.2-sol", "gpt-6.2-astra"]) {
      expect(copilot.models).toContain(ga);
    }
  });
});

describe("GLM-5.4 on the Z.ai / BigModel Coding Plan (docs.z.ai glm-5.4 + devpack latest-model, docs.bigmodel.cn latest-model, 2026-11-26)", () => {
  const rows = {
    zai: { ids: ["glm-5.4", "glm-5.4[1m]"], context: 1_048_576 },
    "zhipu-bigmodel-coding": { ids: ["glm-5.4", "glm-5.4[1m]"], context: 1_000_000 },
    "zhipu-bigmodel-responses": { ids: ["glm-5.4"], context: 1_048_576 },
  } as const;

  test.each(Object.entries(rows))("%s seeds GLM-5.4 with 1M context, native vision and the low/high/max fold", (id, { ids, context }) => {
    const row = getProviderRegistryEntry(id)!;
    expect(row.defaultModel).toBe("glm-5.3");
    for (const model of ids) {
      expect(row.models).toContain(model);
      expect(row.modelContextWindows?.[model]).toBe(context);
      // Upstream input modality: video / image / text / file. Never through the vision sidecar.
      expect(row.modelInputModalities?.[model]).toEqual(["text", "image"]);
      expect(row.noVisionModels ?? []).not.toContain(model);
      expect(row.modelReasoningEfforts?.[model]).toEqual(["low", "high", "max"]);
      // Same default as the row's GLM-5.3 entry (the upstream default is max for both).
      expect(row.modelDefaultReasoningEfforts?.[model]).toBe(row.modelDefaultReasoningEfforts?.["glm-5.3"]);
    }
  });

  test("the Z.ai row caps GLM-5.4 output at the documented 128K", () => {
    const zai = getProviderRegistryEntry("zai")!;
    expect(zai.modelMaxOutputTokens?.["glm-5.4"]).toBe(131_072);
    expect(zai.modelMaxOutputTokens?.["glm-5.4[1m]"]).toBe(131_072);
  });

  test("pay-as-you-go BigModel stays without GLM-5.4 until the Model API ships", () => {
    expect(getProviderRegistryEntry("zhipu-bigmodel")!.models).not.toContain("glm-5.4");
  });
});

describe("qwen4-max on the Alibaba Token Plan, Beijing only (help.aliyun.com token-plan-personal-quick-start + qwen4-max model page, 2026-11-26)", () => {
  const beijing = getProviderRegistryEntry("alibaba-token-plan")!;
  const intl = getProviderRegistryEntry("alibaba-token-plan-intl")!;

  test("Beijing seeds qwen4-max with its documented window, output, vision and direct effort ladder", () => {
    expect(beijing.defaultModel).toBe("qwen3.8-max");
    expect(beijing.models).toContain("qwen4-max");
    expect(beijing.modelContextWindows?.["qwen4-max"]).toBe(1_000_000);
    expect(beijing.modelMaxOutputTokens?.["qwen4-max"]).toBe(131_072);
    expect(beijing.modelInputModalities?.["qwen4-max"]).toEqual(["text", "image"]);
    expect(beijing.noVisionModels ?? []).not.toContain("qwen4-max");
    // reasoning_effort low / high / xhigh, default high (minimal->low, medium->high, max->xhigh).
    expect(beijing.modelReasoningEfforts?.["qwen4-max"]).toEqual(["low", "high", "xhigh"]);
    expect(beijing.modelDefaultReasoningEfforts?.["qwen4-max"]).toBe("high");
    expect(beijing.directReasoningEffortModels).toContain("qwen4-max");
    expect(beijing.thinkingBudgetModels ?? []).not.toContain("qwen4-max");
    expect(beijing.preserveReasoningContentModels).toContain("qwen4-max");
  });

  test("the International Team plan carries no qwen4-max row or metadata", () => {
    expect(intl.models).not.toContain("qwen4-max");
    for (const map of [intl.modelContextWindows, intl.modelMaxOutputTokens, intl.modelInputModalities, intl.modelReasoningEfforts, intl.modelDefaultReasoningEfforts]) {
      expect(map?.["qwen4-max"]).toBeUndefined();
    }
    expect(intl.directReasoningEffortModels ?? []).not.toContain("qwen4-max");
    expect(intl.preserveReasoningContentModels ?? []).not.toContain("qwen4-max");
  });
});

describe("DeepSeek first-party seed (api-docs.deepseek.com create-chat-completion + updates, 2026-11-26)", () => {
  const deepseek = getProviderRegistryEntry("deepseek")!;

  test("seeds only ids the API reference still accepts, led by the default", () => {
    // The model enum is deepseek-flash | deepseek-v4-pro; deepseek-chat / deepseek-reasoner were
    // discontinued on 2026-07-24. deepseek-v4-flash and its vision preview are documented as
    // accepted legacy names served by V4.1 Flash, so they stay.
    expect(deepseek.defaultModel).toBe("deepseek-flash");
    expect(deepseek.models?.[0]).toBe("deepseek-flash");
    expect(deepseek.models).not.toContain("deepseek-chat");
    expect(deepseek.models).not.toContain("deepseek-reasoner");
    expect(deepseek.models).toEqual(["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp"]);
  });
});
