import { describe, expect, test } from "bun:test";
import { applyProviderConfigHints } from "../../src/codex/catalog";
import { providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { resolveModelPolicy } from "../../src/providers/resolved-model-policy";
import { routeModel } from "../../src/router";
import type { OcxConfig } from "../../src/types";

// Xiaomi's model pages (mimo.mi.com/models/en-US/<id>, fetched 2026-09-24): 1M context,
// 128K max output, and text/image/video/audio input for V2.6 Pro/Flash and V2.5 (V2.5 Pro
// documents text only). The catalog vocabulary has no video or audio entry.
const CONTEXT_WINDOW = 1_048_576;
const MAX_OUTPUT = 131_072;
const ROSTER = ["mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.5-pro", "mimo-v2.5"];

const entry = () => getProviderRegistryEntry("mimo")!;

function policy(modelId: string) {
  return resolveModelPolicy({
    providerName: "mimo",
    modelId,
    provider: { adapter: "openai-chat", baseUrl: entry().baseUrl, authMode: "key" },
    registryEntry: entry(),
    transportMatchedRegistry: true,
    effectiveAuth: { authMode: "key" },
  });
}

describe("MiMo token-plan capacity facts", () => {
  test("the registry entry carries the vendor window, output and modality maps", () => {
    const mimo = entry();
    expect(mimo.modelContextWindows).toEqual(Object.fromEntries(ROSTER.map(id => [id, CONTEXT_WINDOW])));
    expect(mimo.modelMaxOutputTokens).toEqual(Object.fromEntries(ROSTER.map(id => [id, MAX_OUTPUT])));
    expect(mimo.modelInputModalities).toEqual({
      "mimo-v2.6-pro": ["text", "image"],
      "mimo-v2.6-flash": ["text", "image"],
      "mimo-v2.5": ["text", "image"],
      "mimo-v2.5-pro": ["text"],
    });
    // Every map key is on the roster, and no plan-specific entitlement is claimed.
    for (const id of ROSTER) expect(mimo.models, id).toContain(id);
    expect(mimo.jawcodeBundle).toBeUndefined();
  });

  test("the seed carries the facts, so a saved token-plan config inherits them", () => {
    const seed = providerConfigSeed(entry());
    expect(seed.modelContextWindows).toEqual(Object.fromEntries(ROSTER.map(id => [id, CONTEXT_WINDOW])));
    expect(seed.modelMaxOutputTokens).toEqual(Object.fromEntries(ROSTER.map(id => [id, MAX_OUTPUT])));
    expect(seed.modelInputModalities).toEqual(entry().modelInputModalities!);
    expect(seed.noVisionModels).toEqual(["mimo-v2.5-pro"]);
  });

  test("a routed V2.6 Pro row reports the vendor window, output and image input", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "mimo",
      providers: { mimo: { ...providerConfigSeed(entry()), apiKey: "k", liveModels: true } },
    };
    const route = routeModel(config, "mimo/mimo-v2.6-pro");
    const row = applyProviderConfigHints("mimo", route.provider, { provider: "mimo", id: route.modelId });
    expect(row.contextWindow).toBe(CONTEXT_WINDOW);
    expect(row.maxOutputTokens).toBe(MAX_OUTPUT);
    expect(row.inputModalities).toEqual(["text", "image"]);
    // V2.6 Flash is the sibling the same pages cover.
    expect(applyProviderConfigHints("mimo", route.provider, { provider: "mimo", id: "mimo-v2.6-flash" }).inputModalities)
      .toEqual(["text", "image"]);
  });

  test("the token-plan policy reports V2.5 Pro as text-only and V2.5 as image-capable", () => {
    for (const id of ROSTER) {
      const resolved = policy(id);
      expect(resolved.model.contextWindow, id).toBe(CONTEXT_WINDOW);
      expect(resolved.model.maxOutputTokens, id).toBe(MAX_OUTPUT);
      // The maps are model facts, not plan prices: no per-model reasoning or tier claim is added.
      expect(resolved.model.reasoningEfforts, id).toEqual(["low", "medium", "high"]);
    }
    const v25 = policy("mimo-v2.5");
    expect(v25.model.inputModalities).toEqual(["text", "image"]);
    // The claim is read from the registry, not from a vendor-free default.
    expect(v25.provenance.model.inputModalities).toBe("registry");
    // V2.5 Pro documents text-only input upstream, so the modality map must not widen it.
    expect(policy("mimo-v2.5-pro").model.inputModalities).toEqual(["text"]);
  });
});
