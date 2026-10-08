import { resetSpendLedgerOwnerForTests } from "../../src/lib/spend-ledger-owner";
import { describe, expect, test } from "bun:test";
import { flushConfigDirHardeningAndReaps, resetConfigDirCacheForTests } from "../../src/config/paths";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { syncCatalogModels } from "../../src/codex/catalog/sync";
import { resolveNativeContextVariant } from "../../src/codex/catalog/context-variants";
import { buildCatalogEntriesFromObservedState } from "../../src/codex/catalog/build-entries";
import { loadBundledCodexCatalog } from "../../src/codex/catalog/bundled";
import { NATIVE_GPT6_SOL_MODEL } from "../../src/codex/catalog/native-models";
import { routeModel } from "../../src/router";
import { checkInputAdmission, resolveInputCeiling } from "../../src/server/responses/input-admission";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { withTestTranslatorBudget } from "../helpers/translator-budget";
import { OPENAI_PROVIDER_TIER_VERSION, type OcxConfig } from "../../src/types";
import { parseRequest } from "../../src/responses/parser";
import { applyFinalRouteRequestNormalization } from "../../src/server/responses/core-normalize";
import type { RequestLogContext } from "../../src/server/request-log";

import { loadConfig, saveConfig } from "../../src/config";
import { isEligibleConfiguredNativeOpenAiModel, setDiscoveredNativeOpenAiModels, discoveredNativeOpenAiModels } from "../../src/codex/catalog/native-models";
import { mergeCatalogEntriesFromObservedState, CANONICAL_NATIVE_CATALOG_CONTENT_POLICY } from "../../src/codex/catalog/build-entries";
import { startServer } from "../../src/server";
import { createTempHome } from "../helpers/temp-home";
import { resetCodexModelEntitlementCacheForTests } from "../../src/codex/model-entitlements";

const verified = { contextWindow: 272_000, maxContextWindow: 872_000, maxInputTokens: 872_000 } as const;

async function rawModels(config: OcxConfig, headers?: HeadersInit): Promise<Array<Record<string, any>>> {
  const home = createTempHome("ocx-native-large-http-");
  let server: ReturnType<typeof startServer> | undefined;
  const orig = process.env.OPENCODEX_HOME;
  try {
    process.env.OPENCODEX_HOME = home.path;
    resetConfigDirCacheForTests();
    saveConfig(config);
    server = startServer(0);
    const response = await fetch(new URL("/v1/models", server.url), { headers });
    expect(response.status).toBe(200);
    return (await response.json() as { data: Array<Record<string, any>> }).data;
  } finally {
    if (server) await server.stop(true);
    resetSpendLedgerOwnerForTests();
    resetCodexModelEntitlementCacheForTests();
    delete process.env.OPENCODEX_HOME;
    resetConfigDirCacheForTests();
    home.remove();
  }
}

function nativeConfig(): OcxConfig {
  return { port: 0, hostname: "127.0.0.1", openaiProviderTierVersion: OPENAI_PROVIDER_TIER_VERSION, defaultProvider: "openai", fastRows: false, providers: {
    openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", liveModels: false },
    external: { adapter: "openai-responses", baseUrl: "https://gateway.example/v1", authMode: "key", liveModels: false, models: ["gpt-6-sol"] },
    "openai-apikey": { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", authMode: "key", liveModels: false, models: ["gpt-6-sol"] },
  } };
}

describe("native Codex large-context variants", () => {
  test("configured alias survives real config load HTTP and retained sync without duplicate registration", async () => {
    const home = createTempHome("ocx-large-configured-");
    let server: ReturnType<typeof startServer> | undefined;
    const orig = process.env.OPENCODEX_HOME ? String(process.env.OPENCODEX_HOME) : undefined;
    try {
      process.env.OPENCODEX_HOME = home.path;
      resetConfigDirCacheForTests();
      mkdirSync(home.codexHome, { recursive: true });
      writeFileSync(join(home.codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n');
      const path = join(home.codexHome, "catalog.json");
      writeFileSync(path, JSON.stringify(loadBundledCodexCatalog()));
      const config = nativeConfig();
      config.providers.openai!.models = ["gpt-6-sol", "gpt-6-sol-900k"];
      config.providers.external!.models = ["gpt-6-sol-900k"];
      config.providers["openai-apikey"]!.models = ["gpt-6-sol-900k"];
      config.codexAccountNamespaces = { "codex-main": "@main" };
      config.codexAccountPickerEnabled = true;
      for (const cap of [undefined, 400_000]) {
        config.providerContextCaps = cap ? { openai: cap } : undefined;
        saveConfig(config);
        const loaded = loadConfig();
        server = startServer(0);
        const response = await fetch(new URL("/v1/models", server.url));
        const rows = (await response.json() as { data: Array<Record<string, any>> }).data;
        const aliases = rows.filter(row => row.id === "gpt-6-sol-900k");
        expect(aliases).toHaveLength(1);
        expect(aliases[0]!.context_window).toBe(cap ?? 872_000);
        expect(rows.some(row => row.id === "external/gpt-6-sol-900k")).toBe(true);
        expect(routeModel(loaded, "openai-apikey/gpt-6-sol-900k").modelId).toBe("gpt-6-sol-900k");
        await server.stop(true); server = undefined;
        delete loaded.providers.external; delete loaded.providers["openai-apikey"];
        saveConfig(loaded);
        await syncCatalogModels(loaded, { allowWhenDesiredDisabled: true });
        const first = readFileSync(path, "utf8");
        const retained = JSON.parse(first).models as Array<Record<string, any>>;
        for (const slug of ["gpt-6-sol-900k", "codex-main/gpt-6-sol-900k"]) {
          const matching = retained.filter(row => row.slug === slug);
          expect(matching).toHaveLength(1);
          expect(matching[0]!.context_window).toBe(cap ?? 872_000);
        }
        if (cap === undefined) expect(retained.find(row => row.slug === "gpt-6-sol")?.context_window).toBe(272_000);
        await syncCatalogModels(loaded, { allowWhenDesiredDisabled: true });
        expect(readFileSync(path, "utf8")).toBe(first);
      }
    } finally {
      if (server) await server.stop(true);
      resetSpendLedgerOwnerForTests();
      resetCodexModelEntitlementCacheForTests();
      delete process.env.OPENCODEX_HOME;
      resetConfigDirCacheForTests();
      home.remove();
    }
  }, 30_000);

  test("retained merge regenerates stale synthetic rows without accumulation", () => {
    const merge = (catalogModels: Record<string, unknown>[], cap?: number) => mergeCatalogEntriesFromObservedState({
      catalogModels, routedEntries: [], baselineCatalogModels: [], baseline: new Map(), featured: [], wsEnabled: false,
      template: loadBundledCodexCatalog(), disabledModels: new Set(), selectedModelsByProvider: new Map(),
      gatheredProviderNames: new Set(), degradedProviderNames: new Set(), legacyCustomModelSlugs: new Set(),
      multiAgentMode: "default", multiAgentV2Enabled: false, exactComboSlugs: new Set(),
      hasPhysicalComboProvider: false, includeNativeOpenAi: true, accountBoundEntries: [],
      policy: { ...CANONICAL_NATIVE_CATALOG_CONTENT_POLICY, unsupportedNativeEntries: "preserve" }, openaiContextCap: cap,
    });
    let rows: Record<string, unknown>[] = [{ slug: "gpt-6-sol", display_name: "GPT-6 Sol", context_window: 272_000 },
      { slug: "gpt-6-sol-900k", display_name: "Stale synthetic", context_window: 272_000 }];
    for (const cap of [undefined, undefined, 400_000, 400_000]) {
      rows = merge(rows, cap);
      const aliases = rows.filter(row => row.slug === "gpt-6-sol-900k");
      expect(aliases).toHaveLength(1);
      expect(aliases[0]!.context_window).toBe(cap ?? 872_000);
    }
  });

  test("synthetic aliases cannot register as configured or discovered natives", () => {
    expect(isEligibleConfiguredNativeOpenAiModel("gpt-6-sol-900k")).toBe(false);
    setDiscoveredNativeOpenAiModels([{ slug: "gpt-6-sol-900k" }]);
    try { expect(discoveredNativeOpenAiModels()).not.toContain("gpt-6-sol-900k"); }
    finally { setDiscoveredNativeOpenAiModels([]); }
  });

  test("HTTP raw models publishes subscription-only aliases with exact effective metadata", async () => {
    const rows = await rawModels(nativeConfig());
    const base = rows.find(row => row.id === "gpt-6-sol");
    const alias = rows.find(row => row.id === "gpt-6-sol-900k");
    expect(base).toBeDefined();
    expect(alias).toBeDefined();
    expect(alias).toMatchObject({ owned_by: "openai", context_window: 872_000, context_length: 872_000,
      max_context_window: 872_000, max_input_tokens: 872_000, capabilities: { context_length: 872_000 } });
    expect(alias!.pricing).toBeUndefined(); // Alias is one effective window, not a client-side tier selector.
    expect(alias!.reasoning_efforts).toEqual(base!.reasoning_efforts);
    expect(alias!.max_output_tokens).toBe(base!.max_output_tokens);
    expect(alias!.capabilities.input_modalities).toEqual(base!.capabilities.input_modalities);
    expect(rows.map(row => row.id)).not.toContain("external/gpt-6-sol-900k");
    expect(rows.map(row => row.id)).not.toContain("openai-apikey/gpt-6-sol-900k");
    expect(rows.map(row => row.id)).not.toContain("gpt-6.1-sol-900k");
  }, 30_000);
  test("HTTP raw aliases retain visibility and canonical per-key scope", async () => {
    const config = nativeConfig();
    config.hostname = "0.0.0.0"; // Require configured-key admission, not unscoped loopback admission.
    config.disabledModels = ["gpt-6-luna", "gpt-6-astra-900k"];
    const key = "ocx_data_" + "z".repeat(40);
    config.apiKeys = [{ id: "large-fixture", name: "fixture", key, createdAt: "2026-01-01T00:00:00.000Z",
      allowedProviders: ["openai"], allowedModels: ["gpt-6-sol", "gpt-6-astra"] }];
    const rows = await rawModels(config, { "x-opencodex-api-key": key });
    const ids = rows.map(row => row.id);
    expect(ids).toContain("gpt-6-sol");
    expect(ids).toContain("gpt-6-astra");
    expect(ids).not.toContain("gpt-6-luna-900k");
    expect(ids.every(id => !id.includes("/"))).toBe(true);
  }, 30_000);

  test("HTTP raw models works without a canonical subscription provider", async () => {
    const config = nativeConfig();
    delete config.providers.openai;
    config.defaultProvider = "external";
    const rows = await rawModels(config);
    expect(rows.some(row => row.id === "external/gpt-6-sol")).toBe(true);
    expect(rows.some(row => row.id === "gpt-6-sol-900k")).toBe(false);
  }, 30_000);

  test("HTTP raw aliases cannot revive a disabled subscription provider", async () => {
    const config = nativeConfig();
    config.providers.openai!.disabled = true;
    const rows = await rawModels(config);
    expect(rows.some(row => row.id === "gpt-6-sol-900k")).toBe(false);
    expect(rows.some(row => row.id === "external/gpt-6-sol")).toBe(true);
  }, 30_000);

  test("HTTP raw alias input metadata honors exact operator input limits", async () => {
    const config = nativeConfig();
    config.providers.openai!.modelMaxInputTokens = { "gpt-6-sol": 300_000, "gpt-6-sol-900k": 500_000 };
    const rows = await rawModels(config);
    expect(rows.find(row => row.id === "gpt-6-sol-900k")?.max_input_tokens).toBe(300_000);
  }, 30_000);

  test("routes the opt-in through capped admission and canonical native outbound", async () => {
    const config: OcxConfig = { port: 10100, defaultProvider: "openai", providers: {
      openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" },
    } };
    const base = routeModel(config, "gpt-6-sol");
    const large = routeModel(config, "gpt-6-sol-900k");
    expect(large.modelId).toBe("gpt-6-sol");
    expect(large.nativeContextVariant?.requestedModel).toBe("gpt-6-sol-900k");
    expect(large.staticPolicy).toEqual(base.staticPolicy);
    expect(large.codexAccountMode).toBe(base.codexAccountMode);
    expect(resolveInputCeiling(large.provider, large.providerName, large.nativeContextVariant!.requestedModel)).toBe(872_000);
    const parsed = parseRequest({ model: "gpt-6-sol-900k", input: [], reasoning: { effort: "high" } });
    await applyFinalRouteRequestNormalization({ parsed, route: large, config,
      req: new Request("http://localhost/v1/responses"), logCtx: {} as RequestLogContext, inboundWire: "responses" });
    expect(parsed.modelId).toBe("gpt-6-sol");
    expect(parsed._nativeContextModelId).toBe("gpt-6-sol-900k");
    expect(checkInputAdmission(parsed, large.provider, large.providerName, parsed.modelId).ceiling).toBe(872_000);
    const raw = { model: large.modelId, input: [], reasoning: { effort: "high" } };
    const adapter = withTestTranslatorBudget(createResponsesPassthroughAdapter(large.provider));
    const outbound = adapter.buildRequest({ modelId: large.modelId, context: { messages: [] }, stream: true, options: {}, _rawBody: raw }, { headers: new Headers() });
    expect(JSON.parse(outbound.body)).toMatchObject({ model: "gpt-6-sol", reasoning: { effort: "high" } });
    expect(resolveInputCeiling(base.provider, base.providerName, base.modelId)).toBe(272_000);
  });
  test("large selector preserves the base blocked-model redirect", () => {
    const config = nativeConfig();
    config.blockedModelRedirects = { "gpt-6-sol": "gpt-6-luna" };
    expect(routeModel(config, "gpt-6-sol").modelId).toBe("gpt-6-luna");
    const large = routeModel(config, "gpt-6-sol-900k");
    expect(large.modelId).toBe("gpt-6-luna");
    expect(large.nativeContextVariant).toBeUndefined();
  });

  test("does not carry large admission into a different final native model", () => {
    const provider = nativeConfig().providers.openai!;
    const parsed = parseRequest({ model: "gpt-6-sol", input: [] });
    parsed._nativeContextModelId = "gpt-6-sol-900k";
    expect(checkInputAdmission(parsed, provider, "openai", "gpt-6-luna").ceiling).toBe(272_000);
  });

  test("narrows alias admission by provider, base, alias and input-only caps", () => {
    const provider = { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" as const };
    const alias = "gpt-6-sol-900k";
    expect(resolveInputCeiling(provider, "openai", alias, { cap: 400_000 })).toBe(400_000);
    expect(resolveInputCeiling({ ...provider, contextWindow: 372_000 }, "openai", alias)).toBe(372_000);
    expect(resolveInputCeiling({ ...provider, modelContextWindows: { "gpt-6-sol": 320_000, [alias]: 600_000 } }, "openai", alias)).toBe(320_000);
    expect(resolveInputCeiling({ ...provider, modelMaxInputTokens: { "gpt-6-sol": 300_000, [alias]: 500_000 } }, "openai", alias)).toBe(300_000);
    expect(resolveInputCeiling(provider, "openai", "gpt-6.1-sol-900k")).toBeNull();
    expect(resolveInputCeiling({ ...provider, baseUrl: "https://gateway.example/v1" }, "openai", alias)).toBeNull();
    expect(resolveInputCeiling({ ...provider, authMode: "key", contextWindow: 128_000 }, "openai", alias)).toBe(128_000);
  });

  test("keeps invalid, external and API-key routing identities unchanged", () => {
    const config: OcxConfig = { port: 10100, defaultProvider: "openai", providers: {
      openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" },
      external: { adapter: "openai-responses", baseUrl: "https://gateway.example/v1", authMode: "forward" },
      "openai-apikey": { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", authMode: "key" },
    } };
    for (const [selector, expected] of [["gpt-6-sol", "gpt-6-sol"], ["gpt-6-sol-900k-900k", "gpt-6-sol-900k-900k"],
      ["gpt-6.1-sol-900k", "gpt-6.1-sol-900k"], ["external/gpt-6-sol-900k", "gpt-6-sol-900k"],
      ["openai-apikey/gpt-6-sol-900k", "gpt-6-sol-900k"]]) {
      const route = routeModel(config, selector!);
      expect(route.modelId).toBe(expected!);
      expect(route.nativeContextVariant).toBeUndefined();
    }
  });

  test("adds opt-in catalog aliases beside unchanged native base rows", () => {
    const entries = buildCatalogEntriesFromObservedState({
      template: loadBundledCodexCatalog(),
      gptSlugs: [NATIVE_GPT6_SOL_MODEL],
      goModels: [],
      wsEnabled: false,
      multiAgentMode: "default",
      exactComboSlugs: new Set(),
      accountSelectors: [],
      suppressedBareNativeSlugs: new Set(),
      disabledNativeAccountSlugs: new Set(),
      multiAgentV2Enabled: false,
      openaiContextCap: undefined,
    });
    expect(entries.map(row => row.slug)).toContain("gpt-6-sol");
    expect(entries.map(row => row.slug)).toContain("gpt-6-sol-900k");
    expect(entries.find(row => row.slug === "gpt-6-sol")?.context_window).toBe(272_000);
    expect(entries.find(row => row.slug === "gpt-6-sol-900k")?.context_window).toBe(872_000);
    expect(entries.find(row => row.slug === "gpt-6-sol-900k")?.max_context_window).toBe(872_000);
  });

  test("large alias compaction applies lowering-only base and alias budgets to qualified rows", () => {
    for (const [budgets, expected] of [
      [{ "gpt-6-sol": 100_000, "gpt-6-sol-900k": 150_000 }, 100_000],
      [{ "gpt-6-sol": 150_000, "gpt-6-sol-900k": 100_000 }, 100_000],
      [{ "gpt-6-sol-900k": 999_999 }, 784_800],
    ] as const) {
      const entries = buildCatalogEntriesFromObservedState({ template: loadBundledCodexCatalog(),
        gptSlugs: [NATIVE_GPT6_SOL_MODEL], goModels: [], wsEnabled: false, multiAgentMode: "default",
        exactComboSlugs: new Set(), accountSelectors: ["codex-main"], suppressedBareNativeSlugs: new Set(),
        disabledNativeAccountSlugs: new Set(), multiAgentV2Enabled: false,
        openaiContextCap: { modelAutoCompactTokenLimits: budgets } });
      for (const slug of ["gpt-6-sol-900k", "codex-main/gpt-6-sol-900k"]) {
        expect(entries.find(row => row.slug === slug)?.auto_compact_token_limit).toBe(expected);
        expect(entries.find(row => row.slug === slug)?.context_window).toBe(872_000);
      }
    }
  });

  test("Codex alias metadata shares effective capped limits with admission", () => {
    for (const limits of [{ cap: 400_000 }, { modelWindows: { "gpt-6-sol-900k": 320_000 } },
      { providerWindow: 372_000, modelMaxInputTokens: { "gpt-6-sol": 300_000 } }]) {
      const entries = buildCatalogEntriesFromObservedState({ template: loadBundledCodexCatalog(),
        gptSlugs: [NATIVE_GPT6_SOL_MODEL], goModels: [], wsEnabled: false, multiAgentMode: "default",
        exactComboSlugs: new Set(), accountSelectors: [], suppressedBareNativeSlugs: new Set(),
        disabledNativeAccountSlugs: new Set(), multiAgentV2Enabled: false, openaiContextCap: limits });
      const alias = entries.find(row => row.slug === "gpt-6-sol-900k");
      expect(alias).toBeDefined();
      expect(alias!.context_window).toBe(limits.cap ?? limits.modelWindows?.["gpt-6-sol-900k"] ?? 372_000);
      expect(alias!.max_context_window).toBe(resolveInputCeiling(nativeConfig().providers.openai!, "openai", "gpt-6-sol-900k", limits));
    }
  });

  test("Codex visibility honors base, alias and account selector disabling", async () => {
    const config = nativeConfig();
    config.codexAccountNamespaces = { "codex-main": "@main" };
    config.codexAccountPickerEnabled = true;
    config.disabledModels = ["gpt-6-luna", "gpt-6-astra-900k", "codex-main/gpt-6-sol-900k"];
    const home = createTempHome("ocx-large-visibility-");
    let server: ReturnType<typeof startServer> | undefined;
    const orig = process.env.OPENCODEX_HOME ?? "";
    try {
      process.env.OPENCODEX_HOME = home.path;
      resetConfigDirCacheForTests();
      saveConfig(config); server = startServer(0);
      const response = await fetch(new URL("/v1/models?client_version=0.100.0", server.url));
      const rows = (await response.json() as { models: Array<Record<string, any>> }).models;
      expect(rows.find(row => row.slug === "gpt-6-sol-900k")?.visibility).toBe("hide");
      expect(rows.find(row => row.slug === "gpt-6-astra-900k")?.visibility).toBe("hide");
      expect(rows.find(row => row.slug === "codex-main/gpt-6-luna-900k")?.visibility).toBe("hide");
      expect(rows.find(row => row.slug === "codex-main/gpt-6-sol-900k")?.visibility).toBe("hide");
      expect(rows.find(row => row.slug === "codex-main/gpt-6-sol")?.visibility).toBe("list");
    } finally {
      if (server) await server.stop(true);
      resetSpendLedgerOwnerForTests();
      delete process.env.OPENCODEX_HOME;
      resetConfigDirCacheForTests();
      home.remove();
    }
  }, 30_000);

  test("retained sync keeps lowering-only base and alias compaction budgets", async () => {
    const home = createTempHome("ocx-large-soft-budget-");
    try {
      mkdirSync(home.codexHome, { recursive: true });
      writeFileSync(join(home.codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n');
      const path = join(home.codexHome, "catalog.json");
      writeFileSync(path, JSON.stringify(loadBundledCodexCatalog()));
      const config = nativeConfig();
      delete config.providers.external; delete config.providers["openai-apikey"];
      config.codexAccountNamespaces = { "codex-main": "@main" };
      config.codexAccountPickerEnabled = true;
      for (const [baseBudget, aliasBudget, expected] of [[100_000, 150_000, 100_000],
        [150_000, 100_000, 100_000], [999_999, 999_999, 784_800]]) {
        config.providers.openai!.modelAutoCompactTokenLimits = {
          "gpt-6-sol": baseBudget!, "gpt-6-sol-900k": aliasBudget!,
        };
        saveConfig(config);
        const loaded = loadConfig();
        expect(loaded.providers.openai!.modelAutoCompactTokenLimits).toEqual(config.providers.openai!.modelAutoCompactTokenLimits);
        await syncCatalogModels(loaded, { allowWhenDesiredDisabled: true });
        const first = readFileSync(path, "utf8");
        const rows = JSON.parse(first).models as Array<Record<string, any>>;
        for (const slug of ["gpt-6-sol-900k", "codex-main/gpt-6-sol-900k"]) {
          expect(rows.find(row => row.slug === slug)?.auto_compact_token_limit).toBe(expected!);
          expect(rows.find(row => row.slug === slug)?.context_window).toBe(872_000);
        }
        await syncCatalogModels(loaded, { allowWhenDesiredDisabled: true });
        expect(readFileSync(path, "utf8")).toBe(first);
      }
    } finally { home.remove(); }
  }, 30_000);

  test("retained sync persists bare and qualified aliases byte-idempotently", async () => {
    const home = createTempHome("ocx-large-retained-");
    try {
      mkdirSync(home.codexHome, { recursive: true });
      writeFileSync(join(home.codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n');
      const path = join(home.codexHome, "catalog.json");
      writeFileSync(path, JSON.stringify(loadBundledCodexCatalog()));
      const config = nativeConfig();
      delete config.providers.external; delete config.providers["openai-apikey"];
      config.codexAccountNamespaces = { "codex-main": "@main" };
      config.codexAccountPickerEnabled = true;
      saveConfig(config);
      await syncCatalogModels(config, { allowWhenDesiredDisabled: true });
      const first = readFileSync(path, "utf8");
      const rows = JSON.parse(first).models as Array<Record<string, any>>;
      expect(rows.find(row => row.slug === "gpt-6-sol-900k")?.context_window).toBe(872_000);
      expect(rows.find(row => row.slug === "codex-main/gpt-6-sol-900k")?.context_window).toBe(872_000);
      await syncCatalogModels(config, { allowWhenDesiredDisabled: true });
      expect(readFileSync(path, "utf8")).toBe(first);
    } finally { home.remove(); }
  }, 30_000);

  test("configured combo identity wins a synthetic large alias collision", () => {
    const alias = "gpt-6-sol-900k";
    const entries = buildCatalogEntriesFromObservedState({ template: loadBundledCodexCatalog(),
      gptSlugs: [NATIVE_GPT6_SOL_MODEL], goModels: [{ id: "chosen", provider: "combo", alias,
        nativeAlias: true, owned_by: "combo", contextWindow: 128_000, maxInputTokens: 100_000,
        inputModalities: ["text"], reasoningEfforts: ["medium"] }], wsEnabled: false,
      multiAgentMode: "default", exactComboSlugs: new Set([alias]), accountSelectors: [],
      suppressedBareNativeSlugs: new Set(), disabledNativeAccountSlugs: new Set(), multiAgentV2Enabled: false });
    const rows = entries.filter(row => row.slug === alias);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.context_window).toBe(128_000);
    expect(rows[0]!.owned_by).toBe("combo");
  });

  test("HTTP raw and Codex collision metadata agree with configured routing", async () => {
    const config = nativeConfig();
    config.combos = { chosen: { alias: "gpt-6-sol-900k", nativeAlias: true, displayName: "Configured identity",
      contextWindow: 128_000, targets: [{ provider: "external", model: "gpt-6-sol" }] } };
    const route = routeModel(config, "gpt-6-sol-900k");
    expect(route.modelId).toBe("gpt-6-sol");
    expect(route.nativeContextVariant).toBeUndefined();
    const rows = (await rawModels(config)).filter(row => row.id === "gpt-6-sol-900k");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some(row => row.context_window === 128_000)).toBe(true);
  });

  test("HTTP raw aliases remain present under a global lowering cap", async () => {
    const config = nativeConfig();
    config.providerContextCaps = { openai: 400_000 };
    const rows = await rawModels(config);
    expect(rows.find(row => row.id === "gpt-6-sol-900k")?.context_window).toBe(400_000);
  }, 30_000);

  test("keeps the regular slug and window unchanged", () => {
    expect(resolveNativeContextVariant("gpt-6-sol", verified)).toEqual({
      requestedModel: "gpt-6-sol",
      wireModel: "gpt-6-sol",
      mode: "standard",
      contextWindow: 272_000,
      maxInputTokens: 272_000,
    });
  });

  test("resolves an allowlisted opt-in suffix to its base slug and verified ceiling", () => {
    expect(resolveNativeContextVariant("gpt-6-sol-900k", verified)).toEqual({
      requestedModel: "gpt-6-sol-900k",
      wireModel: "gpt-6-sol",
      mode: "large",
      contextWindow: 872_000,
      maxInputTokens: 872_000,
    });
  });

  test("caps the large alias to a lower live maximum", () => {
    expect(resolveNativeContextVariant("gpt-6-sol-900k", { ...verified, maxContextWindow: 640_000, maxInputTokens: 600_000 }))
      .toMatchObject({ wireModel: "gpt-6-sol", mode: "large", contextWindow: 640_000, maxInputTokens: 600_000 });
  });

  test("matches Hermes live-verified exact eligibility and rejects unverified models", () => {
    expect(resolveNativeContextVariant("gpt-6.1-sol-900k", verified)).toBeNull();
    expect(resolveNativeContextVariant("gpt-6-luna-900k", verified)).toMatchObject({ wireModel: "gpt-6-luna" });
  });

  test("leaves third-party and malformed variants untouched", () => {
    expect(resolveNativeContextVariant("vendor/model-900k", verified)).toBeNull();
    expect(resolveNativeContextVariant("gpt-6-sol-900k-900k", verified)).toBeNull();
    expect(resolveNativeContextVariant("gpt-6-sol--fast-900k", verified)).toBeNull();
    expect(resolveNativeContextVariant("gpt-6-sol-mini-900k", verified)).toBeNull();
  });

  test("keeps the large alias out when evidence is absent or does not support a larger tier", () => {
    expect(resolveNativeContextVariant("gpt-6-sol-900k", undefined)).toBeNull();
    expect(resolveNativeContextVariant("gpt-6-sol-900k", { contextWindow: 272_000, maxContextWindow: 272_000, maxInputTokens: 272_000 })).toBeNull();
  });

  test("honors hard operator caps without claiming a larger effective window", () => {
    expect(resolveNativeContextVariant("gpt-6-sol-900k", verified, { hardContextCap: 372_000 }))
      .toMatchObject({ mode: "large", contextWindow: 372_000, maxInputTokens: 372_000 });
    expect(resolveNativeContextVariant("gpt-6-sol-900k", verified, { hardContextCap: 128_000 })).toBeNull();
  });
});
