import { describe, expect, test } from "bun:test";
import { applyProviderConfigHints } from "../../src/codex/catalog";
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

// Xiaomi's published V2.6 prices (USD per 1M tokens), as carried by models.dev on 2026-09-23.
const PRO = { input: 0.435, output: 0.87, cacheRead: 0.0036, cacheWrite: 0 };
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
