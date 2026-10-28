import { describe, expect, test } from "bun:test";
import { applyProviderConfigHints, gatherRoutedModels } from "../../src/codex/catalog";
import { generatedModelMetadata } from "../../src/codex/catalog/parsing";
import { getModelMetadata, resolveMetadataProvider } from "../../src/generated/model-metadata";
import { enrichProviderFromRegistry, providerConfigSeed } from "../../src/providers/derive";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import {
  CLINE_PASS_IMAGE_MODELS,
  CLINE_PASS_MODEL_CONTEXT_WINDOWS,
  CLINE_PASS_MODELS,
  OPENCODE_GO_THINKING_TOGGLE_MODELS,
} from "../../src/providers/registry/model-seeds";
import { routeModel } from "../../src/router";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { resolveMatchedPrice } from "../../src/usage/cost";
import { modelCapabilityFields } from "../../src/server/models-capabilities";
import { deriveEntry } from "../../src/codex/catalog/derive-entry";
import { MIMO_THINKING_MODELS } from "../../src/providers/mimo-thinking";
import { resolveReasoningCapabilities } from "../../src/providers/reasoning-capabilities";
import { catalogHintsFromModelsApiItem, copyReasoningHintSource, withVisionSidecarInput } from "../../src/codex/catalog/model-hints";
import { augmentRoutedModelsWithMetadata } from "../../src/codex/catalog/routed-gather";
import { mergeConfiguredModelsIntoLiveCatalog } from "../../src/codex/catalog/model-visibility";
import { clearModelCache, getFreshCached, setCached } from "../../src/codex/model-cache";
import { fetchProviderModels } from "../../src/codex/catalog/provider-models";

// Xiaomi's published V2.6 prices (USD per 1M tokens), as carried by models.dev on 2026-09-23.
const PRO = { input: 0.435, output: 0.87, cacheRead: 0.0036, cacheWrite: 0 };

describe("independent reasoning capabilities", () => {
  test("retained warm-cache rows withdraw removed configuration-only reasoning axes", async () => {
    const name = "retained-reasoning-provenance";
    const modelId = "retained-model";
    let requests = 0;
    const provider: OcxProviderConfig = {
      adapter: "openai-chat", baseUrl: "https://synthetic.example.test/v1", authMode: "key",
      apiKey: "test-key", models: [modelId], retainModels: [modelId],
      fetch: (async () => { requests++; return Response.json({ data: [] }); }) as typeof fetch,
    };
    try {
      const first = await fetchProviderModels(name, { ...provider, modelCapabilities: {
        [modelId]: { supportsThinkingToggle: true, supportsReasoningEffort: false },
      } }, 60_000);
      expect(first.find(row => row.id === modelId)).toMatchObject({
        supportsThinkingToggle: true, supportsReasoningEffort: false,
      });
      const warm = await fetchProviderModels(name, provider, 60_000);
      const row = warm.find(row => row.id === modelId)!;
      expect(row).toBeDefined();
      expect(row.supportsThinkingToggle).toBeUndefined();
      expect(row.supportsReasoningEffort).toBeUndefined();
      expect(requests).toBe(1);
    } finally {
      clearModelCache(name);
    }
  });
  const base = { adapter: "openai-chat", baseUrl: "https://synthetic.example.test/v1" };
  const id = "synthetic-model";
  test.each([
    { supportsReasoning: true, supportsThinkingToggle: false, supportsReasoningEffort: false, defaultThinkingEnabled: true },
    { supportsReasoning: true, supportsThinkingToggle: true, supportsReasoningEffort: false, defaultThinkingEnabled: false },
    { supportsReasoning: true, supportsThinkingToggle: false, supportsReasoningEffort: true },
    { supportsReasoning: true, supportsThinkingToggle: true, supportsReasoningEffort: true },
    {},
  ])("synthetic fixed/toggle/effort/both/unknown contract %j", capabilities => {
    const provider = { ...base, modelCapabilities: { [id]: capabilities } };
    expect(resolveReasoningCapabilities(provider, id)).toEqual(capabilities);
    const row = applyProviderConfigHints("synthetic", provider, { provider: "synthetic", id });
    for (const field of ["supportsReasoning", "supportsThinkingToggle", "supportsReasoningEffort", "defaultThinkingEnabled"] as const) {
      expect(row[field]).toBe(capabilities[field]);
    }
  });
  test("toggle and effort declarations remain independent, including empty and none-only lists", () => {
    const toggle = { ...base, thinkingToggleModels: [id], modelReasoningEfforts: { [id]: [] }, modelCapabilities: { [id]: { supportsThinkingToggle: true } } };
    expect(resolveReasoningCapabilities(toggle, id)).toEqual({ supportsReasoning: true, supportsThinkingToggle: true });
    expect(resolveReasoningCapabilities({ ...base, modelReasoningEfforts: { [id]: ["none"] } }, id))
      .toEqual({});
    expect(resolveReasoningCapabilities({ ...base, thinkingToggleModels: [id] }, id)).toEqual({});
    expect(resolveReasoningCapabilities({ ...base, modelCapabilities: { [id]: { supportsThinkingToggle: false } }, thinkingToggleModels: [id] }, id))
      .toEqual({ supportsThinkingToggle: false });
    const suppressed = resolveReasoningCapabilities({ ...toggle, noReasoningModels: [id] }, id);
    expect(suppressed).toEqual({ supportsReasoning: false, supportsThinkingToggle: false, supportsReasoningEffort: false, defaultThinkingEnabled: false });
  });
  test.each(["zhipu-bigmodel", "opencode-go", "volcengine", "minimax"])("%s toggle wire aliases do not assert genuine strengths", preset => {
    const entry = PROVIDER_REGISTRY.find(row => row.id === preset)!;
    const id = entry.thinkingToggleModels![0]!;
    const provider = providerConfigSeed(entry);
    const resolved = resolveReasoningCapabilities(provider, id);
    expect(resolved.supportsThinkingToggle).toBeUndefined();
    expect(resolved.supportsReasoning).toBe(true);
    expect(resolved.supportsReasoningEffort).toBeUndefined();
    const row = applyProviderConfigHints(preset, provider, { provider: preset, id });
    expect(row.supportsReasoningEffort).toBeUndefined();
    expect(row.reasoningEfforts?.length).toBeGreaterThan(0);
    const explicit = { ...provider, modelCapabilities: { [id]: { supportsThinkingToggle: true, supportsReasoningEffort: true } } };
    expect(resolveReasoningCapabilities(explicit, id).supportsThinkingToggle).toBe(true);
    expect(resolveReasoningCapabilities(explicit, id).supportsReasoningEffort).toBe(true);
    expect(applyProviderConfigHints(preset, explicit, { provider: preset, id }).reasoningEfforts).toEqual(row.reasoningEfforts);
  });
  test("mapped strength inference follows folded overrides and preserves empty overrides", () => {
    const provider = { ...base, thinkingToggleModels: [id], modelReasoningEfforts: { [id]: ["low", "high"] },
      modelReasoningEffortMap: { "SYNTHETIC-MODEL": { low: "disabled", high: "enabled" } } };
    expect(resolveReasoningCapabilities(provider, id).supportsReasoningEffort).toBeUndefined();
    expect(resolveReasoningCapabilities({ ...provider, modelReasoningEffortMap: { [id]: {} } }, id).supportsReasoningEffort).toBe(true);
    expect(resolveReasoningCapabilities({ ...base, modelReasoningEfforts: { [id]: ["none"] }, reasoningEffortMap: { none: "high" } }, id)).toEqual({});
    const registered = PROVIDER_REGISTRY.find(row => row.id === "zhipu-bigmodel-responses")!;
    expect(resolveReasoningCapabilities({ adapter: registered.adapter, baseUrl: registered.baseUrl,
      modelReasoningEfforts: { "GLM-5.3": [] } }, "glm-5.3").supportsReasoningEffort).toBeUndefined();
  });
  test("toggle-only does not inherit an old provider-wide ladder or default", () => {
    const provider = { ...base, reasoningEfforts: ["low", "medium", "high"], modelDefaultReasoningEfforts: { [id]: "high" },
      modelCapabilities: { [id]: { supportsReasoning: true, supportsThinkingToggle: true, supportsReasoningEffort: false } } };
    const row = applyProviderConfigHints("synthetic", provider, { provider: "synthetic", id, reasoningEfforts: ["low", "high"], defaultReasoningEffort: "high" });
    expect(row.reasoningEfforts).toEqual([]);
    expect(row.defaultReasoningEffort).toBeUndefined();
    expect(row.supportsThinkingToggle).toBe(true);
    const enabled = applyProviderConfigHints("synthetic", { ...provider, modelCapabilities: { [id]: { supportsReasoningEffort: true } } }, row);
    expect(enabled.reasoningEfforts).toEqual(["low", "medium", "high"]);
  });
  test("cached config projections rederive flags and retain original discovery metadata", () => {
    const discovered = { provider: "synthetic", id, supportsReasoning: true, supportsThinkingToggle: true, supportsReasoningEffort: false, defaultThinkingEnabled: false };
    const cached = applyProviderConfigHints("synthetic", { ...base, modelCapabilities: { [id]: { supportsThinkingToggle: false } } }, discovered);
    expect(cached.supportsThinkingToggle).toBe(false);
    expect(applyProviderConfigHints("synthetic", { ...base, modelCapabilities: { [id]: { supportsThinkingToggle: false } } }, cached)).toEqual(cached);
    const restored = applyProviderConfigHints("synthetic", base, cached);
    expect(restored).toMatchObject(discovered);
    const configured = applyProviderConfigHints("synthetic", { ...base, modelCapabilities: { [id]: { supportsThinkingToggle: true } } }, { provider: "synthetic", id });
    expect(applyProviderConfigHints("synthetic", base, configured).supportsThinkingToggle).toBeUndefined();
  });
  test("dated aliases inherit discovery evidence, not the dated row's config projection", () => {
    const datedId = `${id}-20261001`;
    const discovered = { provider: "synthetic", id: datedId, supportsReasoning: true,
      supportsThinkingToggle: true, supportsReasoningEffort: true, defaultThinkingEnabled: true,
      reasoningEfforts: ["low", "high"], defaultReasoningEffort: "low" };
    const provider = { ...base, modelCapabilities: { [datedId]: { supportsReasoning: false } } };
    const dated = applyProviderConfigHints("synthetic", provider, discovered);
    expect(dated.reasoningEfforts).toEqual([]);
    const merged = mergeConfiguredModelsIntoLiveCatalog({ name: "synthetic", provider, models: [dated],
      configured: [{ provider: "synthetic", id }] });
    const alias = merged.models.find(row => row.id === id)!;
    expect(alias).toMatchObject({ ...discovered, id });
    expect(alias).toEqual(applyProviderConfigHints("synthetic", provider, { ...discovered, id }));
    expect(applyProviderConfigHints("synthetic", provider, copyReasoningHintSource(alias, { ...alias }))).toEqual(alias);
    expect(dated.supportsReasoning).toBe(false);
  });
  test("routed spread clones restore discovery and withdraw removed config-only hints", () => {
    const discovered = { provider: "synthetic", id, supportsReasoning: true, supportsThinkingToggle: true,
      supportsReasoningEffort: true, reasoningEfforts: ["low", "high"], defaultReasoningEffort: "low" };
    const disabled = applyProviderConfigHints("synthetic", { ...base, noReasoningModels: [id] }, discovered);
    const routed = copyReasoningHintSource(disabled, { ...disabled, providerAlias: "routed", contextWindow: 100_000 });
    const restoredDiscovery = applyProviderConfigHints("synthetic", base, routed);
    expect(restoredDiscovery).toMatchObject(discovered);
    expect(applyProviderConfigHints("synthetic", base, copyReasoningHintSource(restoredDiscovery, { ...restoredDiscovery }))).toEqual(restoredDiscovery);
    const configured = applyProviderConfigHints("synthetic", { ...base,
      modelCapabilities: { [id]: { supportsThinkingToggle: true } },
      modelReasoningEfforts: { [id]: ["high"] }, modelDefaultReasoningEfforts: { [id]: "high" },
    }, { provider: "synthetic", id });
    const restored = applyProviderConfigHints("synthetic", base, copyReasoningHintSource(configured, { ...configured, providerAlias: "routed" }));
    for (const field of ["supportsReasoning", "supportsThinkingToggle", "supportsReasoningEffort", "reasoningEfforts", "defaultReasoningEffort"] as const) {
      expect(restored[field]).toBeUndefined();
    }
    expect(JSON.parse(JSON.stringify(routed))).toEqual({ ...JSON.parse(JSON.stringify(disabled)),
      providerAlias: "routed", contextWindow: 100_000 });
    expect(Object.getOwnPropertySymbols(routed)).toEqual([]);
    expect(routed).toEqual(JSON.parse(JSON.stringify(routed)));
    expect(Object.getOwnPropertySymbols(JSON.parse(JSON.stringify(routed)))).toEqual([]);
    expect(JSON.stringify(routed)).not.toContain("reasoningHintSource");
  });
  test("cache reads and spread clones retain discovery through repeated config changes", () => {
    const provider = "reasoning-provenance-test";
    const discovered = { provider, id, supportsReasoning: true, supportsThinkingToggle: true,
      supportsReasoningEffort: true, reasoningEfforts: ["low", "high"], defaultReasoningEffort: "low" };
    try {
      const disabled = applyProviderConfigHints(provider, { ...base, noReasoningModels: [id] }, discovered);
      setCached(provider, [disabled]);
      const [cached] = getFreshCached(provider, 60_000)!;
      expect(cached).toEqual(disabled);
      const restored = applyProviderConfigHints(provider, base, copyReasoningHintSource(cached!, { ...cached! }));
      expect(restored).toEqual(applyProviderConfigHints(provider, base, discovered));
      expect(applyProviderConfigHints(provider, base, restored)).toEqual(restored);
      expect(cached!.supportsReasoning).toBe(false);
      expect(discovered.reasoningEfforts).toEqual(["low", "high"]);
    } finally {
      clearModelCache(provider);
    }
  });
  test("metadata window fills retain discovery through repeated config changes", () => {
    const provider = "opencode-go";
    const modelId = "glm-5.2";
    const discovered = { provider, id: modelId, supportsThinkingToggle: true, reasoningEfforts: ["low", "high"] };
    const config = { ...base, modelCapabilities: { [modelId]: { supportsThinkingToggle: false } } };
    const projected = applyProviderConfigHints(provider, config, discovered);
    expect(projected.contextWindow).toBeUndefined();
    const augmented = augmentRoutedModelsWithMetadata([projected], [provider], { [provider]: config });
    const seeded = augmented.find(row => row.provider === provider && row.id === modelId)!;
    expect(seeded.contextWindow).toBeGreaterThan(0);
    expect(seeded.supportsThinkingToggle).toBe(false);
    expect(applyProviderConfigHints(provider, base, seeded)).toMatchObject(discovered);
    expect(applyProviderConfigHints(provider, config, seeded)).toEqual(seeded);
  });
  test("sidecar attachment clones preserve discovery without adding object metadata", () => {
    const discovered = { provider: "synthetic", id, supportsThinkingToggle: true };
    const projected = applyProviderConfigHints("synthetic", { ...base,
      modelCapabilities: { [id]: { supportsThinkingToggle: false } } }, discovered);
    const attached = withVisionSidecarInput(projected, { ...base, noVisionModels: [id] });
    expect(attached.inputModalities).toEqual(["text", "image"]);
    expect(Object.getOwnPropertySymbols(attached)).toEqual([]);
    expect(attached).toEqual(JSON.parse(JSON.stringify(attached)));
    expect(applyProviderConfigHints("synthetic", base, attached).supportsThinkingToggle).toBe(true);
  });
  test("unknown reasoning stays absent through a public discovery roundtrip", () => {
    const fields = modelCapabilityFields({});
    expect(fields.capabilities).not.toHaveProperty("supports_reasoning");
    const hints = catalogHintsFromModelsApiItem("chain", { id, ...JSON.parse(JSON.stringify(fields)) });
    for (const field of ["supportsReasoning", "supportsThinkingToggle", "supportsReasoningEffort", "defaultThinkingEnabled", "reasoningEfforts"] as const) {
      expect(hints).not.toHaveProperty(field);
    }
  });
  test.each([
    { efforts: [], cap: undefined, sidecar: false },
    { efforts: ["high"], cap: undefined, sidecar: false },
    { efforts: [], cap: 350_000, sidecar: true },
    { efforts: ["high"], cap: 350_000, sidecar: true },
  ])("custom reasoning overrides remain authoritative for combo members: %j", async ({ efforts, cap, sidecar }) => {
    const provider = "custom-reasoning-provenance";
    const config: OcxConfig = {
      port: 10100, defaultProvider: provider,
      providers: { [provider]: { ...base, authMode: "key", apiKey: "test-key", liveModels: true, models: [id],
        modelCapabilities: { [id]: { supportsThinkingToggle: true } }, ...(sidecar ? { noVisionModels: [id] } : {}),
        fetch: (() => { throw new Error("cached discovery must not fetch"); }) as typeof fetch,
      } },
      ...(cap !== undefined ? { providerContextCaps: { [provider]: cap } } : {}),
      customModels: [{ id: "custom", provider, modelId: id, reasoningEfforts: efforts,
        addedAt: "2026-10-23T00:00:00.000Z" }],
      combos: { solo: { targets: [{ provider, model: id }] } },
    };
    try {
      setCached(provider, [{ provider, id, reasoningEfforts: ["low", "high"] }]);
      const discovered = await gatherRoutedModels({ ...config, customModels: [], combos: undefined });
      expect(discovered.find(row => row.provider === provider && row.id === id)?.reasoningEfforts).toEqual(["low", "high"]);
      const models = await gatherRoutedModels(config);
      const custom = models.find(row => row.provider === provider && row.id === id);
      const combo = models.find(row => row.provider === "combo" && row.id === "solo");
      expect(custom).toBeDefined();
      expect(combo).toBeDefined();
      expect(custom!.reasoningEfforts).toEqual(efforts);
      expect(combo!.reasoningEfforts).toEqual(efforts);
    } finally {
      clearModelCache(provider);
    }
  });
  test("chained public model flags preserve false and unknown independently of efforts", () => {
    const hints = catalogHintsFromModelsApiItem("chain", { id, capabilities: {
      supports_reasoning: true, supports_thinking_toggle: true, supports_reasoning_effort: false,
      default_thinking_enabled: false, reasoning_effort: ["low", "high"],
    } });
    expect(hints).toMatchObject({ supportsReasoning: true, supportsThinkingToggle: true, supportsReasoningEffort: false, defaultThinkingEnabled: false });
    expect(hints.reasoningEfforts).toEqual([]);
    const chained = applyProviderConfigHints("chain", { ...base, reasoningEfforts: ["low", "medium", "high"] }, { provider: "chain", id, ...hints });
    expect(chained.supportsReasoningEffort).toBe(false);
    expect(chained.reasoningEfforts).toEqual([]);
    const unknown = catalogHintsFromModelsApiItem("chain", { id, capabilities: {} });
    expect(unknown.supportsReasoning).toBeUndefined();
    expect(unknown.supportsThinkingToggle).toBeUndefined();
    const explicitFalse = catalogHintsFromModelsApiItem("chain", { id, capabilities: { supports_reasoning: false, supports_thinking_toggle: false } });
    expect(explicitFalse).toMatchObject({ supportsReasoning: false, supportsThinkingToggle: false });
    expect(explicitFalse.supportsReasoningEffort).toBeUndefined();
  });
  test.each(["supports_reasoning", "supports_reasoning_effort"])("chained %s=false clears contradictory efforts", field => {
    const hints = catalogHintsFromModelsApiItem("chain", { id, capabilities: {
      [field]: false, reasoning_effort: ["low", "high"],
    } });
    expect(hints.reasoningEfforts).toEqual([]);
  });
});

describe("MiMo V2.6 thinking switch", () => {
  test.each(["xiaomi", "xiaomi-mimo", "my-mimo"])("public Chat under %s exposes capabilities without synthetic strengths", name => {
    const provider: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://api.xiaomimimo.com/v1", authMode: "key" };
    enrichProviderFromRegistry(name, provider);
    for (const id of MIMO_THINKING_MODELS) {
      const row = applyProviderConfigHints(name, provider, { provider: name, id });
      expect(row).toMatchObject({ supportsReasoning: true, supportsThinkingToggle: true, supportsReasoningEffort: false, defaultThinkingEnabled: true, reasoningEfforts: [] });
      expect(row.defaultReasoningEffort).toBeUndefined();
      expect(modelCapabilityFields(row).capabilities).toMatchObject({ supports_reasoning: true, supports_thinking_toggle: true, supports_reasoning_effort: false, default_thinking_enabled: true });
      expect(modelCapabilityFields(row).capabilities.reasoning_effort).toBeUndefined();
      const catalog = deriveEntry(null, `${name}/${id}`, "MiMo", 1, row);
      expect(catalog.supported_reasoning_levels?.map(level => level.effort)).toEqual(["none", "high"]);
      expect(catalog.default_reasoning_level).toBe("high");
    }
    expect(provider.modelReasoningEfforts).toBeUndefined();
    expect(provider.modelDefaultReasoningEfforts).toBeUndefined();
  });
  test.each([
    { adapter: "openai-chat", baseUrl: "https://api.xiaomimimo.com/v1" },
    { adapter: "anthropic", baseUrl: "https://api.xiaomimimo.com/anthropic" },
  ])("destination capability overrides remain authoritative on $adapter", transport => {
    const id = "mimo-v2.6-pro";
    const provider: OcxProviderConfig = { ...transport, modelCapabilities: { [id]: { supportsThinkingToggle: false, defaultThinkingEnabled: false } } };
    enrichProviderFromRegistry("my-mimo", provider);
    expect(resolveReasoningCapabilities(provider, id)).toEqual({ supportsReasoning: true, supportsThinkingToggle: false, supportsReasoningEffort: false, defaultThinkingEnabled: false });
    expect(resolveReasoningCapabilities({ ...transport, baseUrl: "https://foreign.example.test/v1" }, id)).toEqual({});
    const custom = resolveReasoningCapabilities(transport, `${id}-custom`);
    expect(custom.supportsThinkingToggle).toBeUndefined();
    expect(custom.defaultThinkingEnabled).toBeUndefined();
    expect(custom.supportsReasoningEffort).not.toBe(false);
  });
  test("explicit real effort opt-in preserves case-folded legacy ladder overrides", () => {
    const id = "mimo-v2.6-pro";
    const provider: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://api.xiaomimimo.com/v1",
      modelCapabilities: { [id]: { supportsReasoningEffort: true } },
      modelReasoningEfforts: { "MIMO-V2.6-PRO": ["low", "high"] },
      modelDefaultReasoningEfforts: { "MIMO-V2.6-PRO": "low" } };
    enrichProviderFromRegistry("my-mimo", provider);
    expect(applyProviderConfigHints("my-mimo", provider, { provider: "my-mimo", id }))
      .toMatchObject({ supportsReasoningEffort: true, reasoningEfforts: ["low", "high"], defaultReasoningEffort: "low" });
  });
});
const FLASH = { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 };
const entry = (id: string) => PROVIDER_REGISTRY.find(row => row.id === id)!;

describe("MiMo V2.6 metadata", () => {
  test("first-party rows carry the published window, output and image input", () => {
    for (const id of ["mimo-v2.6-pro", "mimo-v2.6-pro-ultraspeed", "mimo-v2.6-flash"]) {
      expect(getModelMetadata("xiaomi", id), id).toMatchObject({ contextWindow: 1_048_576, maxTokens: 131_072, input: ["text", "image"] });
    }
    // V2.5 Pro stays text-only; the new mapping must not widen it.
    expect(getModelMetadata("xiaomi", "mimo-v2.5-pro")?.input).toEqual(["text"]);
  });

  test("OpenCode Go keeps V2.6 text-only until its route is probed", () => {
    for (const id of ["mimo-v2.6-pro", "mimo-v2.6-flash"]) {
      expect(getModelMetadata("opencode-go", id)?.input, id).toEqual(["text"]);
      expect(entry("opencode-go").noVisionModels, id).toContain(id);
      expect(OPENCODE_GO_THINKING_TOGGLE_MODELS, id).toContain(id);
    }
  });

  test("paid V2.6 usage is priced on every route that serves it", () => {
    expect(resolveMatchedPrice("xiaomi-mimo", "mimo-v2.6-flash")?.cost4).toEqual(FLASH);
    expect(resolveMatchedPrice("xiaomi", "mimo-v2.6-pro")?.cost4).toEqual(PRO);
    expect(resolveMatchedPrice("xiaomi", "mimo-v2.6-pro-ultraspeed")?.cost4).toEqual({ input: 4.35, output: 8.7, cacheRead: 0.036, cacheWrite: 0 });
    expect(resolveMatchedPrice("openrouter", "xiaomi/mimo-v2.6-pro")?.cost4).toEqual(PRO);
    expect(resolveMatchedPrice("command-code", "xiaomi/mimo-v2.6-flash")?.cost4).toEqual(FLASH);
    expect(resolveMatchedPrice("opencode-go", "mimo-v2.6-pro")?.cost4).toEqual({ ...PRO, cacheRead: 0.003625 });
  });
});

describe("Xiaomi presets move to V2.6", () => {
  test("first-party presets read the xiaomi bundle; the token plan does not", () => {
    expect(resolveMetadataProvider("xiaomi")).toBe("xiaomi");
    expect(resolveMetadataProvider("xiaomi-mimo")).toBe("xiaomi");
    expect(resolveMetadataProvider("mimo")).toBeUndefined();
    // The token plan keeps the model-level fallback it already used for V2.5: a pay-as-you-go
    // equivalent estimate, not a plan price.
    expect(resolveMatchedPrice("mimo", "mimo-v2.6-pro")).toMatchObject({ cost4: PRO, status: "verified-derived" });
  });

  test("defaults and rosters lead with V2.6 and keep V2.5 until its retirement", () => {
    expect(entry("xiaomi")).toMatchObject({
      defaultModel: "mimo-v2.6-pro",
      models: ["mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.6-pro-ultraspeed", "mimo-v2.5-pro", "mimo-v2.5"],
    });
    expect(entry("xiaomi-mimo")).toMatchObject({
      defaultModel: "mimo-v2.6-flash",
      models: ["mimo-v2.6-flash", "mimo-v2.6-pro", "mimo-v2.6-pro-ultraspeed", "mimo-v2.5"],
    });
    expect(entry("mimo")).toMatchObject({
      defaultModel: "mimo-v2.6-pro",
      models: ["mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.5-pro", "mimo-v2.5"],
      noVisionModels: ["mimo-v2.5-pro"],
    });
  });

  test("a saved V2.5 choice survives registry enrichment", () => {
    const saved: OcxProviderConfig = {
      adapter: "openai-chat", baseUrl: "https://api.xiaomimimo.com/v1", authMode: "key", apiKey: "k",
      defaultModel: "mimo-v2.5", models: ["mimo-v2.5"],
    };
    enrichProviderFromRegistry("xiaomi-mimo", saved);
    expect(saved.defaultModel).toBe("mimo-v2.5");
    expect(saved.models).toEqual(["mimo-v2.5"]);
  });

  test("the Chat preset advertises the V2.6 window and image input in the catalog", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "xiaomi-mimo",
      providers: { "xiaomi-mimo": { adapter: "openai-chat", baseUrl: "https://api.xiaomimimo.com/v1", authMode: "key", apiKey: "k", liveModels: true } },
    };
    const route = routeModel(config, "xiaomi-mimo/mimo-v2.6-flash");
    const row = applyProviderConfigHints("xiaomi-mimo", route.provider, { provider: "xiaomi-mimo", id: route.modelId });
    expect(row.maxOutputTokens).toBe(131_072);
    // The catalog writes window and modalities from the same generated row (applyCatalogMetadata).
    expect(generatedModelMetadata("xiaomi-mimo", "mimo-v2.6-flash")).toMatchObject({ contextWindow: 1_048_576, input: ["text", "image"] });
  });
});

describe("Cline Pass static catalog", () => {
  test("lists V2.6 ahead of V2.5 with its window and no unprobed image claim", () => {
    const ids = [...CLINE_PASS_MODELS];
    for (const id of ["cline-pass/mimo-v2.6-pro", "cline-pass/mimo-v2.6-flash"]) {
      expect(ids.indexOf(id), id).toBeGreaterThanOrEqual(0);
      expect(ids.indexOf(id), id).toBeLessThan(ids.indexOf("cline-pass/mimo-v2.5"));
      expect(CLINE_PASS_MODEL_CONTEXT_WINDOWS[id], id).toBe(1_048_576);
      expect(CLINE_PASS_IMAGE_MODELS.has(id), id).toBe(false);
    }
  });
});

describe("Command Code MiMo slugs decode without a discovery cache", () => {
  test("both presets send the native MiMo id on a cold start", () => {
    for (const provider of ["command-code", "commandcode"]) {
      const seed = providerConfigSeed(entry(provider));
      const config = { port: 10100, defaultProvider: provider, providers: { [provider]: { ...seed, apiKey: "k" } } } as OcxConfig;
      for (const id of ["xiaomi/mimo-v2.6-pro", "xiaomi/mimo-v2.6-pro-ultraspeed", "xiaomi/mimo-v2.6-flash", "xiaomi/mimo-v2.5-pro", "xiaomi/mimo-v2.5"]) {
        expect(routeModel(config, `${provider}/${id.replace("/", "-")}`).modelId, `${provider} ${id}`).toBe(id);
      }
    }
    // Decode ids are not a roster: the OAuth preset still has no static model list.
    expect(entry("command-code").models).toBeUndefined();
  });
});
