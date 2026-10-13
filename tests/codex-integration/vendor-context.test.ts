import { candidateCapabilityEvidence } from "../../src/routing/capability";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { createVendorContextLookup, vendorContextWindow, canInferVendorContext } from "../../src/codex/catalog/vendor-context";
import { applyProviderConfigHints } from "../../src/codex/catalog/model-hints";
import { buildCatalogEntries, gatherRoutedModels } from "../../src/codex/catalog";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { buildClaudeContextWindows } from "../../src/claude/context-windows";
import type { CatalogModel } from "../../src/codex/catalog/parsing";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

const provider: OcxProviderConfig = { adapter: "anthropic", baseUrl: "https://relay.invalid/v1", inferContextWindow: true };
const optedOut: OcxProviderConfig = { adapter: "anthropic", baseUrl: "https://relay.invalid/v1" };
const id = "claude-opus-5-5";
const row = (extra: Partial<CatalogModel> = {}): CatalogModel => ({ provider: "custom-relay", id, ...extra });
const hint = (model = row(), config = provider, cap?: number) => applyProviderConfigHints("custom-relay", config, model, cap);
const catalog = (model: CatalogModel) => buildCatalogEntries(null, [], [model])[0]!;

describe("vendor context fallback", () => {
  test("inference is opt-in; an unset or false flag keeps the #1073 cap/128k fallback", async () => {
    for (const config of [optedOut, { ...optedOut, inferContextWindow: false }]) {
      expect(canInferVendorContext("custom-relay", config)).toBe(false);
      const model = hint(row(), config);
      expect(model.contextWindow).toBeUndefined();
      expect(model.contextWindowInference).toBeUndefined();
      expect(catalog(model).context_window).toBe(128_000);
      const capped = hint(row(), config, 350_000);
      expect(capped.contextWindow).toBe(350_000);
      expect(capped.contextWindowInference).toBeUndefined();
      const gathered = (await gatherRoutedModels({
        providers: { "custom-relay": { ...config, liveModels: false, models: [] } },
        customModels: [{ provider: "custom-relay", modelId: id }],
      } as OcxConfig)).find(m => m.id === id)!;
      expect(gathered.contextWindowInference).toBeUndefined();
    }
    expect(canInferVendorContext("custom-relay", provider)).toBe(true);
  });
  for (const [model, expected] of [[id, 1_000_000], ["claude-sonnet-5", 1_000_000],
    ["gemini-3.1-pro-preview", 1_048_576], ["kimi-k3", 1_048_576]] as const) {
    test(`fills ${model} from the bundled model identity`, () => {
      expect(hint(row({ id: model })).contextWindow).toBe(expected);
    });
  }
  test("caps only lower inferred windows; an unknown id retains cap/128k fallback", () => {
    for (const cap of [1, 128_000, 350_000, 999_999, 1_000_000, 2_000_000]) {
      expect(hint(row(), provider, cap).contextWindow).toBe(Math.min(cap, 1_000_000));
    }
    expect(hint(row({ id: "e-ge-3.1-p-p" })).contextWindow).toBeUndefined();
    expect(catalog(hint(row({ id: "e-ge-3.1-p-p" }))).context_window).toBe(128_000);
    expect(hint(row({ id: "e-ge-3.1-p-p" }), provider, 350_000).contextWindow).toBe(350_000);
  });
  test("explicit configuration and discovery win, including values above the estimate", () => {
    for (const contextWindow of [200_000, 1_100_000]) {
      expect(hint(row({ contextWindow })).contextWindow).toBe(contextWindow);
      expect(hint(row(), { ...provider, modelContextWindows: { [id]: contextWindow } }).contextWindow).toBe(contextWindow);
    }
    const configured = hint(row({ contextWindow: 400_000 }), { ...provider, modelContextWindows: { [id]: 200_000 } });
    expect(configured.contextWindow).toBe(200_000);
    expect(configured.contextWindowInference).toBeUndefined();
    expect(hint(row(), { ...provider, contextWindow: 250_000 }).contextWindow).toBe(250_000);
  });
  test("all built-in names remain outside inference, even those without metadata aliases", () => {
    for (const builtin of PROVIDER_REGISTRY) {
      expect(canInferVendorContext(builtin.id, provider)).toBe(false);
      expect(canInferVendorContext(builtin.id.toUpperCase(), provider)).toBe(false);
      const result = applyProviderConfigHints(builtin.id, provider, { provider: builtin.id, id });
      expect(result.contextWindowInference).toBeUndefined();
    }
    expect(applyProviderConfigHints("anthropic", provider, { provider: "anthropic", id }).contextWindow).toBeUndefined();
    expect(applyProviderConfigHints("openai", provider, { provider: "openai", id: "gpt-5.5" }).contextWindowInference).toBeUndefined();
  });
  test("normalization is bounded; floating and unrecognized aliases are not guessed", () => {
    expect(vendorContextWindow("CLAUDE-OPUS-5.5")).toBe(1_000_000);
    for (const alias of ["~anthropic/claude-opus-5-5", "claude-opus-5-5-custom", "claude-opus-5-5-latest", "unknown/claude-opus-5-5", "", "__proto__"]) {
      expect(vendorContextWindow(alias)).toBeUndefined();
    }
    expect(vendorContextWindow("gpt-5.5")).toBe(1_050_000);
    expect(vendorContextWindow("minimax-m3")).toBe(512_000);
    expect(vendorContextWindow("MiniMax-M3")).toBe(1_000_000);
    expect(vendorContextWindow("MINIMAX-M3")).toBeUndefined();
    expect(vendorContextWindow("longcat-2.0")).toBeUndefined();
  });
  test("conflicting keys fail closed while exact spelling wins over a normalized collision", () => {
    const meta = (provider: string, id: string, contextWindow: number) => ({ provider, id, contextWindow });
    const lookup = createVendorContextLookup([
      meta("one", "a.b", 100), meta("two", "a-b", 200),
      meta("one", "same", 100), meta("two", "same", 200),
      meta("one", "wins", 100), meta("one", "invalid", NaN), meta("one", "negative", -1),
      meta("one", "fraction", 1.5), meta("one", "infinite", Infinity),
    ], [meta("agg", "prefix/same", 500), meta("agg", "prefix/wins", 500),
      meta("agg", "one/collision", 100), meta("agg", "two/collision", 200), meta("agg", "~one/float", 500)]);
    expect(lookup("a.b")?.contextWindow).toBe(100);
    expect(lookup("a-b")?.contextWindow).toBe(200);
    expect(lookup("A.B")).toBeUndefined();
    expect(lookup("same")).toBeUndefined();
    expect(lookup("collision")).toBeUndefined();
    expect(lookup("one/collision")?.contextWindow).toBe(100);
    expect(lookup("wins")?.contextWindow).toBe(100);
    for (const bad of ["invalid", "negative", "fraction", "infinite", "float"]) expect(lookup(bad)).toBeUndefined();
  });
  test("cached window inference and cap labels are recomputed without promotion to an observation", () => {
    const first = hint(row(), provider, 350_000);
    expect(hint(first).contextWindow).toBe(1_000_000);
    expect(hint(first).contextCap).toBeUndefined();
    expect(hint(first).contextCapped).toBeUndefined();
    const configured = hint(first, { ...provider, modelContextWindows: { [id]: 200_000 } });
    expect(configured.contextWindow).toBe(200_000);
    expect(configured.contextWindowInference).toBeUndefined();
    expect(hint({ ...first, id: "unknown-model" }).contextWindow).toBeUndefined();
    expect(applyProviderConfigHints("anthropic", provider, first).contextWindow).toBeUndefined();
  });
  test("catalog publishes the compaction budget but records the inference separately", () => {
    const model = hint();
    const entry = catalog(model);
    expect(entry.context_window).toBe(1_000_000);
    expect(entry.max_context_window).toBe(1_000_000);
    expect(entry.auto_compact_token_limit).toBe(900_000);
    expect(entry.opencodex_capability_provenance).toMatchObject({
      inferred_context_window: 1_000_000,
      context_window_inference: { provider: "anthropic", modelId: id, source: "vendor", contextWindow: 1_000_000 },
    });
    expect((entry.opencodex_capability_provenance as Record<string, unknown>).context_window).toBeUndefined();
    expect((catalog(hint(row({ contextWindow: 200_000 }))).opencodex_capability_provenance as Record<string, unknown>).context_window).toBe(200_000);
    expect(buildClaudeContextWindows([], [model])[`custom-relay/${id}`]).toBe(1_000_000);
    expect(catalog(hint(row({ maxInputTokens: 180_000 }))).auto_compact_token_limit).toBeLessThanOrEqual(180_000);
  });
  test("routing reads asserted capabilities but never treats an inferred window as proof", () => {
    const oldHome = process.env.CODEX_HOME;
    const root = mkdtempSync(join(tmpdir(), "vendor-context-routing-"));
    process.env.CODEX_HOME = root;
    try {
      for (const cap of [undefined, 350_000]) {
        const model = hint(row({ inputModalities: ["text", "image"] }), provider, cap);
        const entry = catalog(model);
        writeFileSync(join(root, "opencodex-catalog.json"), JSON.stringify({ models: [entry] }));
        const evidence = candidateCapabilityEvidence({ providers: { "custom-relay": provider } } as OcxConfig, "custom-relay", id);
        expect(evidence.contextWindow).toBeUndefined();
        expect(evidence.image).toBe(true);
        expect(evidence.tools).toBe(true);
      }
      const configured = { ...provider, modelContextWindows: { [id]: 200_000 } };
      expect(candidateCapabilityEvidence({ providers: { "custom-relay": configured } } as OcxConfig, "custom-relay", id).contextWindow).toBe(200_000);
    } finally {
      if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("Azure destination metadata precedes the bundled fallback without network access", () => {
    const root = mkdtempSync(join(tmpdir(), "vendor-context-azure-"));
    try {
      writeFileSync(join(root, "azure-model-metadata-cache.json"), JSON.stringify({
        version: 1, fetchedAt: Date.now(), models: { [id]: { contextWindow: 333_333 } },
      }));
      const model = applyProviderConfigHints("custom-azure", { ...provider, baseUrl: "https://resource.openai.azure.com/openai" },
        { provider: "custom-azure", id }, undefined, undefined, undefined, root);
      expect(model.contextWindow).toBe(333_333);
      expect(model.contextWindowInference).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("a custom explicit window replaces inference before combo derivation", async () => {
    const config = { providers: { "custom-relay": { ...provider, liveModels: false, models: [id] } },
      customModels: [{ provider: "custom-relay", modelId: id, contextWindow: 200_000 }],
      combos: { selected: { targets: [{ provider: "custom-relay", model: id }] } },
    } as OcxConfig;
    const models = await gatherRoutedModels(config);
    const custom = models.find(m => m.provider === "custom-relay" && m.id === id)!;
    const combo = models.find(m => m.provider === "combo" && m.id === "selected")!;
    expect(custom.contextWindow).toBe(200_000);
    expect(custom.contextWindowInference).toBeUndefined();
    expect(combo.contextWindow).toBe(200_000);
    expect(catalog(combo).auto_compact_token_limit).toBeLessThanOrEqual(180_000);
  });
  test("custom-only models inherit only missing context, with caps and explicit overrides intact", async () => {
    for (const listed of [false, true]) {
      const config = { providers: { "custom-relay": { ...provider, liveModels: false, models: listed ? [id] : [] } },
        customModels: [{ provider: "custom-relay", modelId: id, inputModalities: ["text"], reasoningEfforts: [] }],
        providerContextCaps: { "custom-relay": 350_000 },
      } as OcxConfig;
      const models = await gatherRoutedModels(config);
      const custom = models.find(m => m.id === id)!;
      expect(custom.contextWindow).toBe(350_000);
      expect(custom.contextWindowInference?.provider).toBe("anthropic");
      expect(custom.contextCap).toBe(350_000);
      expect(custom.contextCapped).toBe(true);
      expect(custom.inputModalities).toEqual(["text"]);
      expect(custom.reasoningEfforts).toEqual([]);
      expect((catalog(custom).opencodex_capability_provenance as Record<string, unknown>).context_window).toBeUndefined();
      config.customModels![0]!.contextWindow = 200_000;
      const explicit = (await gatherRoutedModels(config)).find(m => m.id === id)!;
      expect(explicit.contextWindow).toBe(200_000);
      expect(explicit.contextWindowInference).toBeUndefined();
    }
  });
});
