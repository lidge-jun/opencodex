import { clearModelCache } from "../../src/codex/model-cache";
import { gatherRoutedModels } from "../../src/codex/catalog/provider-fetch";
import { applyProviderConfigHints } from "../../src/codex/catalog/provider-fetch";
import { buildCatalogEntries } from "../../src/codex/catalog/sync";
import { describe, expect, test } from "bun:test";
import { effectiveModelAliases } from "../../src/providers/default-aliases";
import { routeModel } from "../../src/router";
import type { OcxConfig } from "../../src/types";

function config(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "alpha",
    providers: {
      alpha: { adapter: "openai-chat", baseUrl: "https://alpha.test/v1", alias: "a", models: ["native", "vendor/claude-opus-5-202608"] , modelAliases: { native: "tiny" } },
      beta: { adapter: "openai-chat", baseUrl: "https://beta.test/v1", alias: "b", models: ["other"] },
    },
  };
}

describe("provider and model aliases", () => {
  test("qualified provider and model aliases resolve to the native upstream id", () => {
    expect(routeModel(config(), "a/tiny")).toMatchObject({ providerName: "alpha", modelId: "native" });
  });

  test("qualified canonical provider and native model win before aliases", () => {
    const c = config();
    c.providers.alpha.modelAliases = { other: "native" };
    expect(routeModel(c, "alpha/native")).toMatchObject({ providerName: "alpha", modelId: "native" });
  });

  test("bare alias wins only immediately before defaultProvider fallback", () => {
    expect(routeModel(config(), "tiny")).toMatchObject({ providerName: "alpha", modelId: "native", routeReason: "model-alias" });
    const absent = config();
    delete absent.providers.alpha.modelAliases;
    expect(routeModel(absent, "tiny")).toMatchObject({ providerName: "alpha", modelId: "tiny", routeReason: "default-provider" });
  });

  test("native family and configured native model steps cannot be shadowed", () => {
    const c = config();
    c.providers.openai = { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex" };
    c.providers.alpha.modelAliases = { native: "gpt-5.6-sol", "vendor/claude-opus-5-202608": "other" };
    expect(routeModel(c, "gpt-5.6-sol").providerName).toBe("openai");
    expect(routeModel(c, "other")).toMatchObject({ providerName: "beta", modelId: "other" });
  });

  test("bare ambiguity is deterministic and qualified aliases remain usable", () => {
    const c = config();
    c.providers.beta.modelAliases = { other: "tiny" };
    expect(() => routeModel(c, "tiny")).toThrow("model alias 'tiny' is ambiguous: a/tiny, b/tiny");
    expect(routeModel(c, "b/tiny")).toMatchObject({ providerName: "beta", modelId: "other" });
  });

  test("a built-in alias is disabled when multiple ids in one provider claim it", () => {
    const provider = { adapter: "openai-chat", baseUrl: "https://x.test", defaultAliases: true, models: ["anthropic/claude-opus-5-a", "anthropic/claude-opus-5-b"] };
    expect([...effectiveModelAliases({ defaultModelAliases: false }, provider, provider.models)]).toEqual([]);
  });

  test("an unambiguous aggregator tail receives its built-in alias", () => {
    const provider = { adapter: "openai-chat", baseUrl: "https://x.test", defaultAliases: true, models: ["anthropic/claude-opus-5-a"] };
    expect([...effectiveModelAliases({ defaultModelAliases: false }, provider, provider.models)]).toEqual([
      ["anthropic/claude-opus-5-a", { alias: "opus", source: "builtin" }],
    ]);
  });
  test("google-antigravity provider compact alias agy resolves to native google-antigravity", () => {
    const c = {
      port: 10100,
      defaultProvider: "google-antigravity",
      providers: {
        "google-antigravity": {
          adapter: "google",
          baseUrl: "https://daily-cloudcode-pa.googleapis.com",
          authMode: "oauth",
          models: ["gemini-3.8-flash", "claude-sonnet-4-6"],
        },
      },
    } as unknown as OcxConfig;

    // Resolves with agy prefix
    expect(routeModel(c, "agy/gemini-3.8-flash")).toMatchObject({
      providerName: "google-antigravity",
      modelId: "gemini-3.8-flash",
      routeReason: "explicit-provider-namespace",
    });

    // Case-insensitive alias
    expect(routeModel(c, "AGY/gemini-3.8-flash")).toMatchObject({
      providerName: "google-antigravity",
      modelId: "gemini-3.8-flash",
    });

    // Canonical full name remains valid and unaffected
    expect(routeModel(c, "google-antigravity/gemini-3.8-flash")).toMatchObject({
      providerName: "google-antigravity",
      modelId: "gemini-3.8-flash",
    });
  });

  test("custom provider alias overrides and disables the built-in registry alias", () => {
    const custom = {
      port: 10100,
      defaultProvider: "openai",
      providers: {
        "google-antigravity": {
          adapter: "google",
          baseUrl: "https://daily-cloudcode-pa.googleapis.com",
          authMode: "oauth",
          alias: "antigrav",
          models: ["gemini-3.8-flash"],
        },
      },
    } as unknown as OcxConfig;

    expect(routeModel(custom, "antigrav/gemini-3.8-flash")).toMatchObject({
      providerName: "google-antigravity",
      modelId: "gemini-3.8-flash",
      routeReason: "explicit-provider-namespace",
    });
    // Negative assertion: explicit user alias disables the built-in registry alias
    expect(() => routeModel(custom, "agy/gemini-3.8-flash")).toThrow("No provider configured for model: agy/gemini-3.8-flash");
  });

  test("explicit configured alias wins over registry fallback independent of insertion order", () => {
    const order1 = {
      port: 10100,
      defaultProvider: "google-antigravity",
      providers: {
        other: {
          adapter: "openai-chat",
          baseUrl: "https://other.test/v1",
          alias: "agy",
          models: ["model-x"],
        },
        "google-antigravity": {
          adapter: "google",
          baseUrl: "https://daily-cloudcode-pa.googleapis.com",
          models: ["gemini-3.8-flash"],
        },
      },
    } as unknown as OcxConfig;

    const order2 = {
      port: 10100,
      defaultProvider: "google-antigravity",
      providers: {
        "google-antigravity": {
          adapter: "google",
          baseUrl: "https://daily-cloudcode-pa.googleapis.com",
          models: ["gemini-3.8-flash"],
        },
        other: {
          adapter: "openai-chat",
          baseUrl: "https://other.test/v1",
          alias: "agy",
          models: ["model-x"],
        },
      },
    } as unknown as OcxConfig;

    expect(routeModel(order1, "agy/model-x")).toMatchObject({
      providerName: "other",
      modelId: "model-x",
    });
    expect(routeModel(order2, "agy/model-x")).toMatchObject({
      providerName: "other",
      modelId: "model-x",
    });
  });
  test("cross-provider alias ownership: when other explicitly claims agy, Google row suppresses agy and advertised namespace routes back to google-antigravity", async () => {
    const c = {
      port: 10100,
      defaultProvider: "openai",
      providers: {
        other: {
          adapter: "openai-chat",
          baseUrl: "https://other.test/v1",
          alias: "agy",
          models: ["model-x"],
        },
        "google-antigravity": {
          adapter: "google",
          baseUrl: "https://daily-cloudcode-pa.googleapis.com",
          authMode: "oauth",
          models: ["gemini-3.8-flash"],
        },
      },
    } as unknown as OcxConfig;

    c.providers.other.liveModels = false;
    c.providers["google-antigravity"].liveModels = false;

    // Real gather exercises captureGatherFlight and threads immutable effectiveAlias
    const models = await gatherRoutedModels(c);
    const googleModel = models.find(m => m.provider === "google-antigravity" && m.id === "gemini-3.8-flash")!;
    const otherModel = models.find(m => m.provider === "other" && m.id === "model-x")!;

    const entries = buildCatalogEntries(null, [], [googleModel, otherModel]);
    const googleEntry = entries.find(e => e.slug === "google-antigravity/gemini-3.8-flash")!;
    const otherEntry = entries.find(e => e.slug === "other/model-x")!;

    // 1. Ownership collision: 'other' explicitly claimed 'agy', so Google row suppresses 'agy'
    // and falls back to the canonical slug 'google-antigravity/gemini-3.8-flash'.
    expect(googleEntry.display_name).toBe("google-antigravity/gemini-3.8-flash");
    expect(otherEntry.display_name).toBe("other/model-x");

    // 2. Routing fidelity: Every advertised Google namespace routes back to google-antigravity!
    expect(routeModel(c, googleEntry.display_name)).toMatchObject({
      providerName: "google-antigravity",
      modelId: "gemini-3.8-flash",
      routeReason: "explicit-provider-namespace",
    });

    // 3. 'agy/model-x' routes to 'other' (explicit configured alias ownership)
    expect(routeModel(c, "agy/model-x")).toMatchObject({
      providerName: "other",
      modelId: "model-x",
      routeReason: "explicit-provider-namespace",
    });
  });
  test("static gather (liveModels: false) suppresses agy when other provider explicitly owns it", async () => {
    const c = {
      port: 10100,
      defaultProvider: "openai",
      providers: {
        other: {
          adapter: "openai-chat",
          baseUrl: "https://other.test/v1",
          alias: "agy",
          models: ["model-x"],
          liveModels: false,
        },
        "google-antigravity": {
          adapter: "google",
          baseUrl: "https://daily-cloudcode-pa.googleapis.com",
          authMode: "oauth",
          models: ["gemini-3.8-flash"],
          liveModels: false,
        },
      },
    } as unknown as OcxConfig;

    const models = await gatherRoutedModels(c);
    const googleModel = models.find(m => m.provider === "google-antigravity" && m.id === "gemini-3.8-flash")!;
    expect(googleModel).toBeDefined();
    // Static gather applies captured effectiveAlias (null due to cross-provider collision)
    expect(googleModel.providerAlias).toBeNull();

    const entries = buildCatalogEntries(null, [], [googleModel]);
    expect(entries[0]!.display_name).toBe("google-antigravity/gemini-3.8-flash");
  });
  test("real cache-boundary regression: live discovery primes cache and warm cache re-hints in both directions", async () => {
    clearModelCache("google-antigravity");
    clearModelCache("other");

    let fetchCalls = 0;
    const stubFetch = (async () => {
      fetchCalls++;
      return new Response(JSON.stringify({
        data: [{ id: "gemini-3.8-flash" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    try {
      const cAlone = {
        port: 10100,
        defaultProvider: "google-antigravity",
        modelCacheTtlMs: 60000,
        providers: {
          "google-antigravity": {
            adapter: "openai-chat",
            baseUrl: "https://mock.google.test/v1",
            authMode: "key",
            apiKey: "test-key",
            liveModels: true,
            fetch: stubFetch,
          },
        },
      } as unknown as OcxConfig;

      // 1. Initial live gather primes the cache under default alias ownership
      const models1 = await gatherRoutedModels(cAlone);
      expect(fetchCalls).toBe(1); // Exactly one outbound fetch
      const entries1 = buildCatalogEntries(null, [], models1);
      const e1 = entries1.find(e => e.slug === "google-antigravity/gemini-3.8-flash")!;
      expect(e1.display_name).toBe("agy/gemini-3.8-flash");

      // 2. Second gather inside TTL with conflicting ownership: cached row is re-hinted to canonical Google display
      const cConflicting = {
        port: 10100,
        defaultProvider: "google-antigravity",
        modelCacheTtlMs: 60000,
        providers: {
          other: {
            adapter: "openai-chat",
            baseUrl: "https://other.test/v1",
            alias: "agy",
            models: ["model-x"],
            liveModels: false,
          },
          "google-antigravity": {
            adapter: "openai-chat",
            baseUrl: "https://mock.google.test/v1",
            authMode: "key",
            apiKey: "test-key",
            liveModels: true,
            fetch: stubFetch,
          },
        },
      } as unknown as OcxConfig;

      const models2 = await gatherRoutedModels(cConflicting);
      expect(fetchCalls).toBe(1); // Cache hit, zero additional fetches
      const entries2 = buildCatalogEntries(null, [], models2);
      const e2 = entries2.find(e => e.slug === "google-antigravity/gemini-3.8-flash")!;
      expect(e2.display_name).toBe("google-antigravity/gemini-3.8-flash");

      // 3. Third gather inside TTL (inverse direction): conflict removed, cached row re-hints back to agy
      const models3 = await gatherRoutedModels(cAlone);
      expect(fetchCalls).toBe(1); // Cache hit, zero additional fetches
      const entries3 = buildCatalogEntries(null, [], models3);
      const e3 = entries3.find(e => e.slug === "google-antigravity/gemini-3.8-flash")!;
      expect(e3.display_name).toBe("agy/gemini-3.8-flash");
    } finally {
      clearModelCache("google-antigravity");
      clearModelCache("other");
    }
  });

  test("empty or cleared custom alias disables both custom and built-in registry alias", () => {
    const c = {
      port: 10100,
      defaultProvider: "openai",
      providers: {
        "google-antigravity": {
          adapter: "google",
          baseUrl: "https://daily-cloudcode-pa.googleapis.com",
          authMode: "oauth",
          alias: "", // explicit empty/cleared alias
          models: ["gemini-3.8-flash"],
        },
      },
    } as unknown as OcxConfig;

    // Setting empty alias disables built-in agy fallback
    expect(() => routeModel(c, "agy/gemini-3.8-flash")).toThrow("No provider configured for model: agy/gemini-3.8-flash");
    // Canonical name routes cleanly
    expect(routeModel(c, "google-antigravity/gemini-3.8-flash")).toMatchObject({
      providerName: "google-antigravity",
      modelId: "gemini-3.8-flash",
    });
  });
  test("boundary regression: collision-suppressed Google stays canonical while unaliased provider retains original model shape", async () => {
    const c = {
      port: 10100,
      defaultProvider: "openai",
      providers: {
        other: {
          adapter: "openai-chat",
          baseUrl: "https://other.test/v1",
          alias: "agy",
          models: ["model-x"],
          liveModels: false,
        },
        "google-antigravity": {
          adapter: "google",
          baseUrl: "https://daily-cloudcode-pa.googleapis.com",
          authMode: "oauth",
          models: ["gemini-3.8-flash"],
          liveModels: false,
        },
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          models: ["grok-4.6"],
          liveModels: false,
        },
      },
    } as unknown as OcxConfig;

    const models = await gatherRoutedModels(c);
    const googleModel = models.find(m => m.provider === "google-antigravity" && m.id === "gemini-3.8-flash")!;
    const xaiModel = models.find(m => m.provider === "xai" && m.id === "grok-4.6")!;

    // 1. Collision-suppressed Google has providerAlias: null and stays canonical in display
    expect(googleModel).toBeDefined();
    expect(googleModel.providerAlias).toBeNull();
    const entries = buildCatalogEntries(null, [], [googleModel]);
    expect(entries[0]!.display_name).toBe("google-antigravity/gemini-3.8-flash");

    // 2. Provider with no built-in/configured alias retains its original model shape (no providerAlias property)
    expect(xaiModel).toBeDefined();
    expect("providerAlias" in xaiModel).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(xaiModel, "providerAlias")).toBe(false);
  });
});
