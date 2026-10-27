import { describe, expect, test } from "bun:test";
import { buildClientConfig, type ExportModel, type KiloGeneratedConfig, type OpencodeGeneratedConfig } from "../../src/clients/config-export";
import { deriveEntry } from "../../src/codex/catalog/derive-entry";
import { applyProviderConfigHints } from "../../src/codex/catalog/model-hints";

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

  test("toggle models offer only off/on and suppress regenerated legacy strength choices", () => {
    const { v1, v2, kilo } = configs({ ...model, supportsThinkingToggle: true,
      supportsReasoningEffort: false, defaultThinkingEnabled: true,
      reasoningEfforts: [], defaultReasoningEffort: undefined });
    expect(v2.variants).toEqual([
      { id: "none", settings: { reasoningEffort: "none" } },
      { id: "high", settings: { reasoningEffort: "high" } },
    ]);
    expect(v2.settings).toEqual({ reasoningEffort: "high" });
    for (const entry of [v1, kilo]) {
      expect(entry.reasoning).toBe(true);
      expect(entry.options).toEqual({ reasoningEffort: "high" });
      const generated = Object.fromEntries(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
        .map(effort => [effort, { reasoningEffort: effort }]));
      const merged = { ...generated, ...entry.variants };
      expect(Object.keys(merged).filter(id => !("disabled" in merged[id]!)).sort()).toEqual(["high", "none"]);
      for (const effort of ["none", "high"]) {
        expect({ ...entry.options, ...entry.variants![effort] }).toEqual({ reasoningEffort: effort });
      }
    }
  });

  test("toggle off defaults survive and stale strength metadata cannot add choices", () => {
    const { v1, v2, kilo } = configs({ ...model, supportsThinkingToggle: true,
      supportsReasoningEffort: false, defaultThinkingEnabled: false,
      reasoningEfforts: ["none", "low", "medium", "high", "max", "ultra"], defaultReasoningEffort: "none" });
    expect(v2.variants.map(variant => variant.id)).toEqual(["none", "high"]);
    expect(v2.settings).toEqual({ reasoningEffort: "none" });
    for (const entry of [v1, kilo]) {
      expect(entry.options).toEqual({ reasoningEffort: "none" });
      for (const effort of ["minimal", "low", "medium", "xhigh", "max", "ultra"]) {
        expect(entry.variants![effort]).toEqual({ disabled: true });
      }
    }
  });

  test("reasoning capability survives without effort or summary evidence", () => {
    for (const reasoningEfforts of [undefined, []]) {
      const { v1, v2, kilo } = configs({ ...model, reasoningEfforts,
        supportsReasoning: true, supportsReasoningSummaries: undefined, defaultReasoningEffort: undefined });
      expect(v2.variants).toEqual([]);
      for (const entry of [v1, kilo]) {
        expect(entry.reasoning).toBe(true);
        expect(entry.variants).toEqual(kiloSuppression);
        expect(entry.options).toBeUndefined();
      }
    }
  });

  test("fixed, effort-only and combined controls keep independent choices across clients and Codex", () => {
    const cases = [
      { supportsThinkingToggle: false, supportsReasoningEffort: false, expected: [] },
      { supportsThinkingToggle: false, supportsReasoningEffort: true, expected: ["low", "high"] },
      { supportsThinkingToggle: true, supportsReasoningEffort: true, expected: ["none", "low", "high"] },
      { supportsThinkingToggle: true, supportsReasoningEffort: false, expected: ["none", "high"] },
    ];
    for (const { expected, ...capabilities } of cases) {
      const row = { ...model, ...capabilities, reasoningEfforts: ["none", "low", "high"],
        defaultReasoningEffort: "low", defaultThinkingEnabled: false };
      const { v1, v2, kilo } = configs(row);
      expect(v2.variants.map(variant => variant.id)).toEqual(expected);
      for (const entry of [v1, kilo]) {
        expect(Object.entries(entry.variants!).filter(([, value]) => !("disabled" in value)).map(([id]) => id))
          .toEqual(expected);
        expect(entry.variants!.ultra).toEqual({ disabled: true });
      }
      for (const template of [null, { slug: "template", supported_reasoning_levels: [{ effort: "max" }] }]) {
        const entry = deriveEntry(template, row.namespaced, "test", 1, { ...row });
        expect(entry.supported_reasoning_levels.map((level: { effort: string }) => level.effort)).toEqual(expected);
        if (capabilities.supportsThinkingToggle) expect(entry.default_reasoning_level).toBe("none");
        if (expected.length === 0) expect(entry.default_reasoning_level).toBeUndefined();
      }
    }
  });

  test("an empty effort declaration leaves a declared toggle available, including an unknown default", () => {
    for (const reasoningEfforts of [undefined, []]) {
      const row = { ...model, reasoningEfforts, supportsThinkingToggle: true,
        supportsReasoningEffort: false, defaultThinkingEnabled: undefined, defaultReasoningEffort: "low" };
      const { v1, v2, kilo } = configs(row);
      expect(v2.variants.map(variant => variant.id)).toEqual(["none", "high"]);
      for (const entry of [v1, kilo]) expect(entry.options).toBeUndefined();
      const codex = deriveEntry(null, row.namespaced, "test", 1, row);
      expect(codex.supported_reasoning_levels.map((level: { effort: string }) => level.effort)).toEqual(["none", "high"]);
      expect(codex.default_reasoning_level).toBeUndefined();
    }
  });

  test("a negative toggle alone does not turn unknown effort support into false", () => {
    const bare: ExportModel = { namespaced: "mock/unknown-effort", provider: "mock", id: "unknown-effort",
      supportsThinkingToggle: false };
    const { v1, kilo } = configs(bare);
    for (const exported of [v1, kilo]) {
      expect(exported.variants).toEqual({ none: { disabled: true } });
      expect(exported.reasoning).toBeUndefined();
    }
    const row = { ...model, supportsThinkingToggle: false,
      reasoningEfforts: undefined, defaultReasoningEffort: undefined };
    const unknown = deriveEntry(null, model.namespaced, "test", 1, { ...row, supportsThinkingToggle: undefined });
    const entry = deriveEntry(null, model.namespaced, "test", 1, row);
    expect(entry.supported_reasoning_levels).toEqual(unknown.supported_reasoning_levels.filter(
      (level: { effort: string }) => level.effort !== "none"));
    expect(entry.default_reasoning_level).toBe(unknown.default_reasoning_level);
  });

  test("inferred positive effort support preserves legacy Codex max/ultra synthesis", () => {
    const row = applyProviderConfigHints("synthetic", { adapter: "openai-chat", baseUrl: "https://example.test/v1",
      reasoningEfforts: ["low", "medium", "high"], modelDefaultReasoningEfforts: { legacy: "medium" },
    }, { provider: "synthetic", id: "legacy" });
    expect(row.supportsReasoningEffort).toBe(true);
    expect(row.supportsThinkingToggle).toBeUndefined();
    for (const template of [null, { slug: "template", supported_reasoning_levels: [{ effort: "xhigh" }] }]) {
      const entry = deriveEntry(template, "synthetic/legacy", "test", 1, row);
      expect(entry.supported_reasoning_levels.map((level: { effort: string }) => level.effort))
        .toEqual(["low", "medium", "high", "max", "ultra"]);
      expect(entry.default_reasoning_level).toBe("medium");
      const suppressedMax = deriveEntry(template, "synthetic/legacy", "test", 1, { ...row, suppressSyntheticMax: true });
      expect(suppressedMax.supported_reasoning_levels.map((level: { effort: string }) => level.effort))
        .toEqual(["low", "medium", "high", "ultra"]);
      const exact = deriveEntry(template, "synthetic/legacy", "test", 1, { ...row, supportsThinkingToggle: false });
      expect(exact.supported_reasoning_levels.map((level: { effort: string }) => level.effort))
        .toEqual(["low", "medium", "high"]);
      const fixed = deriveEntry(template, "synthetic/legacy", "test", 1, { ...row, supportsReasoningEffort: false });
      expect(fixed.supported_reasoning_levels).toEqual([]);
      const disabled = deriveEntry(template, "synthetic/legacy", "test", 1, { ...row, supportsReasoning: false });
      expect(disabled.supported_reasoning_levels).toEqual([]);
    }
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
