import { describe, expect, test } from "bun:test";
import { resolveCursorSelection } from "../../src/adapters/cursor/catalog";
import { CURSOR_STATIC_MODELS, cursorModelContextWindows, cursorModelIds, cursorModelReasoningEfforts } from "../../src/adapters/cursor/discovery";
import { projectStartupConfigRepairs } from "../../src/providers/model-rename-startup";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { findExpectedPriceOverlay } from "../../src/usage/expected-prices";
import type { OcxConfig } from "../../src/types";

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
      expect(row.modelDefaultReasoningEfforts?.[model]).toBe("max");
      expect(row.modelMaxOutputTokens?.[model]).toBe(131_072);
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

describe("OpenRouter seed (openrouter.ai/api/v1/models, 2026-11-26)", () => {
  test("seeds only OpenAI slugs OpenRouter's public catalog lists", () => {
    const openrouter = getProviderRegistryEntry("openrouter")!;
    // OpenAI documents bare gpt-5.6 as an alias of gpt-5.6-sol; OpenRouter lists only the tiers.
    expect(openrouter.models).not.toContain("openai/gpt-5.6");
    for (const id of ["openai/gpt-5.6-sol", "openai/gpt-5.6-terra", "openai/gpt-5.6-luna", "openai/gpt-6.2-sol", "openai/gpt-6.2-astra"]) {
      expect(openrouter.models).toContain(id);
    }
  });
});

describe("Cursor fallback seed (cursor.com/docs/models/gemini-4-neon, 2026-11-26)", () => {
  test("seeds gemini-4-neon as a preemptive cold-start row shaped like Hydrogen", () => {
    const cursor = getProviderRegistryEntry("cursor")!;
    expect(cursorModelIds(CURSOR_STATIC_MODELS)).toContain("gemini-4-neon");
    expect(cursor.models).toContain("gemini-4-neon");
    // Cursor's page shows the 200k default window and the 1M maximum; the row advertises the maximum,
    // as the Hydrogen row does for the identical pair.
    expect(cursorModelContextWindows(CURSOR_STATIC_MODELS)["gemini-4-neon"]).toBe(1_048_576);
    expect(cursorModelReasoningEfforts(CURSOR_STATIC_MODELS)["gemini-4-neon"]).toEqual(["low", "medium", "high", "xhigh"]);
    expect(resolveCursorSelection("gemini-4-neon", "xhigh").wireId).toBe("gemini-4-neon-xhigh");
  });
});

describe("saved static rosters follow the refreshed seeds without losing an id the operator could have selected", () => {
  type Row = Record<string, unknown>;
  const refresh = (provider: string, row: Row) => {
    const config = { providers: { [provider]: row } } as unknown as OcxConfig;
    const first = projectStartupConfigRepairs(config);
    const again = projectStartupConfigRepairs(structuredClone(first.config));
    return { changed: first.changed, row: first.config.providers![provider]! as Row, idempotent: !again.changed };
  };

  test.each(["deepseek-chat", "deepseek-reasoner", "deepseek-flash"])("DeepSeek's historical seed keeps %s as default and in the list", defaultModel => {
    const before = ["deepseek-chat", "deepseek-reasoner", "deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"];
    const { changed, row, idempotent } = refresh("deepseek", { adapter: "openai-chat", baseUrl: "https://api.deepseek.com", models: [...before], liveModels: false, defaultModel });
    expect(changed).toBe(true);
    expect(idempotent).toBe(true);
    expect(row.defaultModel).toBe(defaultModel);
    for (const id of [...before, "deepseek-v4-pro"]) expect(row.models).toContain(id);
  });

  test("the Gemini API seed gains Gemini 4 and keeps the redirected Flash ids a saved default may name", () => {
    const before = ["gemini-4-argon", "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview", "gemini-3.7-flash"];
    const { changed, row, idempotent } = refresh("google", {
      adapter: "google", baseUrl: "https://generativelanguage.googleapis.com", models: [...before], defaultModel: "gemini-3.5-flash",
      modelContextWindows: {}, modelDefaultReasoningEfforts: {},
    });
    expect(changed).toBe(true);
    expect(idempotent).toBe(true);
    expect(row.defaultModel).toBe("gemini-3.5-flash");
    for (const id of [...before, "gemini-4-neon", "gemini-4-hydrogen", "gemini-4-carbon"]) expect(row.models).toContain(id);
    expect((row.modelContextWindows as Record<string, number>)["gemini-4-neon"]).toBe(1_048_576);
    expect((row.modelDefaultReasoningEfforts as Record<string, string>)["gemini-4-hydrogen"]).toBe("high");
  });

  const glmBefore = ["glm-5.3", "glm-5.3[1m]", "glm-5.3-flash", "glm-5.2", "glm-5.2[1m]", "glm-5.1", "glm-5", "glm-4.6"];
  test.each([
    ["zai", "https://api.z.ai", "openai-responses", glmBefore, ["glm-5.4", "glm-5.4[1m]"], 1_048_576],
    ["zhipu-bigmodel-coding", "https://open.bigmodel.cn/api/coding/paas/v4", "openai-chat", glmBefore, ["glm-5.4", "glm-5.4[1m]"], 1_000_000],
    ["zhipu-bigmodel-responses", "https://open.bigmodel.cn/api/v1", "openai-responses", ["glm-5.3", "glm-5.3-flash", "glm-5-turbo"], ["glm-5.4"], 1_048_576],
  ] as const)("%s at %s gains GLM-5.4 from its previous seed", (provider, baseUrl, adapter, before, added, window) => {
    const { changed, row, idempotent } = refresh(provider, {
      adapter, baseUrl, models: [...before], defaultModel: "glm-5.3",
      modelContextWindows: {}, modelMaxOutputTokens: {}, modelDefaultReasoningEfforts: {},
    });
    expect(changed).toBe(true);
    expect(idempotent).toBe(true);
    expect(row.models).toEqual(getProviderRegistryEntry(provider)!.models);
    for (const id of added) {
      expect((row.modelContextWindows as Record<string, number>)[id]).toBe(window);
      expect((row.modelMaxOutputTokens as Record<string, number>)[id]).toBe(131_072);
      expect((row.modelDefaultReasoningEfforts as Record<string, string>)[id]).toBe("max");
    }
  });

  test("an edited list or a custom destination keeps its roster", () => {
    expect(refresh("zhipu-bigmodel-coding", { adapter: "openai-chat", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", models: [...glmBefore, "custom"] }).changed).toBe(false);
    expect(refresh("zai", { adapter: "openai-responses", baseUrl: "https://gateway.example/v1", models: [...glmBefore] }).changed).toBe(false);
  });

  test("both BigModel Coding Plan rows declare GLM-5.4's 128K output cap and max default", () => {
    for (const id of ["zhipu-bigmodel-coding", "zhipu-bigmodel-responses"]) {
      const row = getProviderRegistryEntry(id)!;
      for (const model of row.models!.filter(m => m.startsWith("glm-5.4"))) {
        expect(row.modelMaxOutputTokens?.[model]).toBe(131_072);
        expect(row.modelDefaultReasoningEfforts?.[model]).toBe("max");
      }
    }
  });
});
