import { describe, expect, test } from "bun:test";
import { buildClientConfig, type ExportModel, type KiloGeneratedConfig, type OpencodeGeneratedConfig } from "../../src/clients/config-export";

const model: ExportModel = {
  namespaced: "mock/reasoner", provider: "mock", id: "reasoner", contextWindow: 100_000,
  maxInputTokens: 80_000, maxTokens: 8_192, inputModalities: ["text", "image"],
  supportsTools: true, supportsReasoning: true, supportsReasoningSummaries: true,
  reasoningEfforts: ["high", "none", "low", "max", "low"], defaultReasoningEffort: "low",
};
const kiloSuppression = Object.fromEntries(["none", "minimal", "low", "medium", "high", "xhigh", "max"].map(id => [id, { disabled: true }]));
function configs(row: ExportModel = model) {
  const ctx = { baseUrl: "http://127.0.0.1:10100/v1", models: [row] };
  const oc = buildClientConfig("opencode", ctx) as OpencodeGeneratedConfig;
  const kilo = buildClientConfig("kilo", ctx) as KiloGeneratedConfig;
  return {
    v1: oc.provider.opencodex!.models[row.namespaced]!,
    v2: oc.providers.opencodex!.models[row.namespaced]!,
    kilo: kilo.provider.opencodex!.models[row.namespaced]!,
  };
}

describe("OpenCode and Kilo export real per-model controls", () => {
  test("both generations and Kilo preserve limits, defaults, capabilities and exact effort choices", () => {
    const { v1, v2, kilo } = configs();
    for (const entry of [v1, v2, kilo]) {
      expect(entry.limit).toEqual({ context: 100_000, input: 80_000, output: 8_192 });
    }
    const variants = {
      none: { reasoningEffort: "none" }, low: { reasoningEffort: "low" },
      high: { reasoningEffort: "high" }, max: { reasoningEffort: "max" },
    };
    for (const entry of [v1, kilo]) {
      expect(entry).toMatchObject({
        reasoning: true, tool_call: true, attachment: true,
        interleaved: { field: "reasoning_content" }, options: { reasoningEffort: "low" }, variants,
      });
      expect(entry).not.toHaveProperty("settings");
    }
    expect(v2).toMatchObject({
      capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
      compatibility: { reasoningField: "reasoning_content" }, settings: { reasoningEffort: "low" },
      variants: Object.entries(variants).map(([id, settings]) => ({ id, settings })),
    });
    expect(v2).not.toHaveProperty("attachment");
    expect(v2).not.toHaveProperty("modalities");
    expect(v2).not.toHaveProperty("options");
  });

  test("variant options override the declared client default, including explicit off", () => {
    const { v1, v2, kilo } = configs();
    for (const effort of ["none", "low", "high", "max"]) {
      for (const entry of [v1, kilo]) {
        expect({ ...entry.options, ...entry.variants![effort] }).toEqual({ reasoningEffort: effort });
      }
      expect({ ...v2.settings, ...v2.variants.find(v => v.id === effort)!.settings })
        .toEqual({ reasoningEffort: effort });
    }
  });

  test("an explicit off default is carried, not replaced by a positive preference", () => {
    const { v1, v2, kilo } = configs({ ...model, defaultReasoningEffort: "none" });
    for (const entry of [v1, kilo]) expect(entry.options).toEqual({ reasoningEffort: "none" });
    expect(v2.settings).toEqual({ reasoningEffort: "none" });
  });

  test("an empty ladder suppresses inferred choices without falsely declaring inability to reason", () => {
    const { v1, v2, kilo } = configs({ ...model, reasoningEfforts: [] });
    expect(v2.variants).toEqual([]);
    expect(v2.settings).toBeUndefined();
    for (const entry of [v1, kilo]) {
      expect(entry.reasoning).toBe(true);
      expect(entry.options).toBeUndefined();
    }
    expect(v1.variants).toEqual(kiloSuppression);
    expect(kilo.variants).toEqual(kiloSuppression);
  });

  test("unknown and malformed metadata cannot create ladders, defaults, prices or capability booleans", () => {
    const bare: ExportModel = { namespaced: "mock/bare", provider: "mock", id: "bare" };
    for (const row of [bare, { ...bare, reasoningEfforts: ["turbo"], defaultReasoningEffort: "turbo" }]) {
      const { v1, v2, kilo } = configs(row);
      expect(v2).toEqual({ name: "bare (mock)", variants: [] });
      for (const entry of [v1, kilo]) expect(entry).toEqual({ name: "bare (mock)" });
    }
  });

  test("a known fixed-depth reasoner with no ladder does not gain low/medium/high", () => {
    const { v1, v2, kilo } = configs({ ...model, reasoningEfforts: undefined, defaultReasoningEffort: undefined });
    expect(v2.variants).toEqual([]);
    expect(v1.variants).toEqual(kiloSuppression);
    expect(kilo.variants).toEqual(kiloSuppression);
  });

  test("declared negative capabilities remain negative, and optional input limits are clamped", () => {
    const { v1, v2, kilo } = configs({ ...model, supportsTools: false, supportsReasoning: false,
      supportsReasoningSummaries: false, reasoningEfforts: [], maxInputTokens: 200_000 });
    expect(v2.capabilities!.tools).toBe(false);
    expect(v2.compatibility).toBeUndefined();
    for (const entry of [v1, v2, kilo]) expect(entry.limit!.input).toBe(100_000);
    for (const entry of [v1, kilo]) {
      expect(entry.tool_call).toBe(false);
      expect(entry.reasoning).toBe(false);
      expect(entry.interleaved).toBeUndefined();
    }
  });

  test("unknown tool support cannot create an invalid partial V2 capabilities object", () => {
    const { v1, v2 } = configs({ ...model, supportsTools: undefined });
    expect(v2.capabilities).toBeUndefined();
    expect(v1.modalities).toEqual({ input: ["text", "image"], output: ["text"] });
    expect(v1.attachment).toBe(true);
    expect(v1.tool_call).toBeUndefined();
    expect(v2.variants.map(variant => variant.id)).toEqual(["none", "low", "high", "max"]);
  });
});
