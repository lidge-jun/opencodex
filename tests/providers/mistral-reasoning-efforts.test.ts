import { describe, expect, test } from "bun:test";
import { buildOpenAIChatPassthroughRequest } from "../../src/adapters/openai-chat/passthrough";
import { buildClientConfig, type OpencodeGeneratedConfig } from "../../src/clients/config-export";
import { applyProviderConfigHints } from "../../src/codex/catalog/model-hints";
import { enrichProviderFromRegistry } from "../../src/providers/derive";
import type { OcxProviderConfig } from "../../src/types";

/** The configuration from #8254: the Mistral preset with no effort declarations of its own. */
function mistral(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  const provider: OcxProviderConfig = {
    adapter: "openai-chat", baseUrl: "https://api.mistral.ai/v1", apiKey: "test-mistral-efforts",
    defaultModel: "codestral-latest", modelInputModalities: { "zai-glm-5-3": ["text"] }, ...overrides,
  };
  enrichProviderFromRegistry("mistral", provider);
  return provider;
}

/** Enabled OpenCode V1 variant keys and V2 variant ids exported for one Mistral model. */
function exportedVariants(provider: OcxProviderConfig, id: string) {
  const row = applyProviderConfigHints("mistral", provider, { provider: "mistral", id });
  const namespaced = `mistral/${id}`;
  const config = buildClientConfig("opencode", {
    baseUrl: "http://127.0.0.1:10100/v1", models: [{ ...row, namespaced }],
  }) as OpencodeGeneratedConfig;
  const v1 = config.provider.opencodex!.models[namespaced]!.variants ?? {};
  return {
    v1: Object.entries(v1).filter(([, value]) => !("disabled" in value)).map(([key]) => key),
    v2: config.providers.opencodex!.models[namespaced]!.variants.map(variant => variant.id),
  };
}

/** The `reasoning_effort` a native Chat passthrough request puts on the upstream wire. */
function wireEffort(provider: OcxProviderConfig, modelId: string, effort: string): unknown {
  const request = buildOpenAIChatPassthroughRequest(provider, {
    model: modelId, messages: [{ role: "user", content: "Reply with OK" }], reasoning_effort: effort,
  }, modelId, false);
  return (JSON.parse(request.body as string) as Record<string, unknown>).reasoning_effort;
}

describe("Mistral reasoning effort ladders (#8254)", () => {
  test("exports offer only the effort rungs Mistral accepts for each model", () => {
    const provider = mistral();
    const expected: Record<string, string[]> = {
      "zai-glm-5-3": ["low", "high", "max"],
      "zai-glm-5-3-flash": ["low", "high", "max"],
      "mistral-large-4": ["low", "medium", "high"],
      "mistral-large-4-0": ["low", "medium", "high"],
      "deepseek-v4-1-flash-1017": ["low", "high", "xhigh", "max"],
    };
    for (const [id, efforts] of Object.entries(expected)) {
      expect(exportedVariants(provider, id)).toEqual({ v1: efforts, v2: efforts });
    }
  });

  test("native Chat clamps medium to the existing rung at or below it", () => {
    for (const id of ["deepseek-v4-1-flash-1017", "zai-glm-5-3", "zai-glm-5-3-flash"]) {
      expect(wireEffort(mistral(), id, "medium")).toBe("low");
    }
    expect(wireEffort(mistral(), "mistral-large-4", "medium")).toBe("medium");
    expect(wireEffort(mistral(), "deepseek-v4-1-flash-1017", "none")).toBe("none");
    for (const effort of ["low", "high", "xhigh", "max"]) {
      expect(wireEffort(mistral(), "deepseek-v4-1-flash-1017", effort)).toBe(effort);
    }
    expect(wireEffort(mistral({ modelReasoningEfforts: { "zai-glm-5-3": ["low", "medium", "high"] } }), "zai-glm-5-3", "medium")).toBe("medium");
  });

  test("an operator ladder for a model still replaces the shipped one", () => {
    const provider = mistral({ modelReasoningEfforts: { "zai-glm-5-3": ["low", "medium", "high"] } });
    expect(exportedVariants(provider, "zai-glm-5-3").v2).toEqual(["low", "medium", "high"]);
    expect(exportedVariants(provider, "zai-glm-5-3-flash").v2).toEqual(["low", "high", "max"]);
  });

  test("native Chat folds ultra to the highest declared rung at or below max", () => {
    const provider = mistral();
    expect(wireEffort(provider, "zai-glm-5-3", "ultra")).toBe("max");
    expect(wireEffort(provider, "deepseek-v4-1-flash-1017", "ultra")).toBe("max");
    expect(wireEffort(provider, "mistral-large-4", "ultra")).toBe("high");
    // No declared ladder: ultra is still never a Chat wire value.
    expect(wireEffort(provider, "codestral-latest", "ultra")).toBe("max");
  });

  test("native Chat keeps every other caller value and a declared ultra rung as sent", () => {
    const provider = mistral();
    expect(wireEffort(provider, "zai-glm-5-3", "max")).toBe("max");
    expect(wireEffort(provider, "zai-glm-5-3", "high")).toBe("high");
    const declaresUltra: OcxProviderConfig = {
      adapter: "openai-chat", baseUrl: "https://gateway.example/v1", apiKey: "test-gateway",
      modelReasoningEfforts: { "frontier": ["low", "high", "max", "ultra"] },
    };
    expect(wireEffort(declaresUltra, "frontier", "ultra")).toBe("ultra");
    expect(wireEffort(declaresUltra, "other", "ultra")).toBe("max");
  });

  test("a folded ultra goes through the provider's wire alias map, including omission", () => {
    const gateway = (reasoningEffortMap: Record<string, string>): OcxProviderConfig => ({
      adapter: "openai-chat", baseUrl: "https://gateway.example/v1", apiKey: "test-gateway", reasoningEffortMap,
    });
    expect(wireEffort(gateway({ max: "high" }), "any", "ultra")).toBe("high");
    expect(wireEffort(gateway({ max: "__omit__" }), "any", "ultra")).toBeUndefined();
    // The alias wins before the ladder clamp: clamp-first would turn `max` into `high` and keep the field.
    const ladderedOmit = { ...gateway({ max: "__omit__" }), reasoningEfforts: ["low", "high"] };
    expect(wireEffort(ladderedOmit, "any", "ultra")).toBeUndefined();
    // A `max` → `ultra` alias heals `ultra` into the ladder, so the caller's `ultra` is kept.
    const aliasedUltra = { ...gateway({ max: "ultra" }), reasoningEfforts: ["low", "high", "max"] };
    expect(wireEffort(aliasedUltra, "any", "ultra")).toBe("ultra");
    // Caller values the proxy did not rewrite keep their spelling.
    expect(wireEffort(gateway({ max: "high" }), "any", "max")).toBe("max");
  });
});
