import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { gatherRoutedModels } from "../src/codex/catalog";
import { clearModelCache } from "../src/codex/model-cache";
import { buildInitProviders } from "../src/cli/init";
import { buildModelsRequest } from "../src/oauth";
import { KEY_LOGIN_PROVIDERS, validateApiKey } from "../src/oauth/key-providers";
import {
  deriveInitProviders,
  deriveProviderPresets,
  providerConfigSeed,
} from "../src/providers/derive";
import { FREE_PROVIDER_DIRECTORY } from "../src/providers/free-directory";
import { resolveProviderModelDiscovery } from "../src/providers/model-discovery";
import { PROVIDER_REGISTRY, type ProviderRegistryEntry } from "../src/providers/registry";
import { routedSlug } from "../src/providers/slug-codec";
import { routeModel } from "../src/router";
import type { OcxConfig, OcxProviderConfig } from "../src/types";
import { withStubbedProviderFetch } from "./helpers/catalog-provider-fetch";

const SAMBANOVA_FIXTURE = readFileSync(join(import.meta.dir, "fixtures/sambanova-models.json"), "utf8");
const NEBIUS_FIXTURE = readFileSync(join(import.meta.dir, "fixtures/nebius-models.json"), "utf8");
const originalFetch = globalThis.fetch;

type ProviderId = "sambanova" | "nebius";

const PROVIDERS: Record<ProviderId, {
  baseUrl: string;
  dashboardUrl: string;
  fixture: string;
  key: string;
  modelsUrl: string;
}> = {
  sambanova: {
    baseUrl: "https://api.sambanova.ai/v1",
    dashboardUrl: "https://cloud.sambanova.ai/apis",
    fixture: SAMBANOVA_FIXTURE,
    key: "sambanova-test-key",
    modelsUrl: "https://api.sambanova.ai/v1/models",
  },
  nebius: {
    baseUrl: "https://api.tokenfactory.nebius.com/v1",
    dashboardUrl: "https://tokenfactory.nebius.com",
    fixture: NEBIUS_FIXTURE,
    key: "nebius-test-key",
    modelsUrl: "https://api.tokenfactory.nebius.com/v1/models?verbose=true",
  },
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache("sambanova");
  clearModelCache("nebius");
  clearModelCache("nebius-team");
});

function registryEntry(id: ProviderId): ProviderRegistryEntry {
  const entry = PROVIDER_REGISTRY.find(row => row.id === id);
  if (!entry) throw new Error(`missing ${id} registry entry`);
  return entry;
}

function providerConfig(id: ProviderId, overrides: Partial<OcxProviderConfig> = {}): OcxConfig {
  const provider = PROVIDERS[id];
  return {
    port: 10100,
    defaultProvider: id,
    providers: {
      [id]: {
        adapter: "openai-chat",
        baseUrl: provider.baseUrl,
        authMode: "key",
        apiKey: provider.key,
        liveModels: true,
        // Discovery stays fixture-only; this avoids platform-specific public-DNS classification.
        allowPrivateNetwork: true,
        ...overrides,
      },
    },
  };
}

describe("SambaNova and Nebius providers", () => {
  test("registers fixed OpenAI transports with bounded text-output discovery", () => {
    expect(registryEntry("sambanova")).toMatchObject({
      id: "sambanova",
      label: "SambaNova Cloud",
      adapter: "openai-chat",
      baseUrl: PROVIDERS.sambanova.baseUrl,
      authKind: "key",
      dashboardUrl: PROVIDERS.sambanova.dashboardUrl,
      liveModels: true,
      preserveCustomDestination: true,
      apiKeyValidation: "unknown",
      parallelToolCalls: false,
      reasoningEfforts: [],
      modelDiscovery: {
        path: "models",
        maxResponseBytes: 131_072,
        maxModels: 128,
      },
    });
    expect(registryEntry("sambanova").note).toContain("SambaStudio");

    expect(registryEntry("nebius")).toMatchObject({
      id: "nebius",
      label: "Nebius Token Factory",
      adapter: "openai-chat",
      baseUrl: PROVIDERS.nebius.baseUrl,
      authKind: "key",
      dashboardUrl: PROVIDERS.nebius.dashboardUrl,
      liveModels: true,
      preserveCustomDestination: true,
      parallelToolCalls: false,
      reasoningEfforts: [],
      modelDiscovery: {
        path: "models",
        query: { verbose: "true" },
        maxResponseBytes: 524_288,
        maxModels: 512,
        filter: {
          allOf: [{ path: ["architecture", "modality"], containsAny: ["->text"] }],
        },
      },
    });
    expect(registryEntry("nebius").note).toContain("embedding and image-generation rows");
    expect(FREE_PROVIDER_DIRECTORY.find(row => row.id === "sambanova")).toMatchObject({
      label: "SambaNova Cloud",
      lastVerified: "2026-08-02",
      modelsUrl: PROVIDERS.sambanova.modelsUrl,
    });
    expect(FREE_PROVIDER_DIRECTORY.find(row => row.id === "nebius")).toMatchObject({
      label: "Nebius Token Factory",
      lastVerified: "2026-08-02",
      modelsUrl: PROVIDERS.nebius.modelsUrl,
    });
  });

  test("derives CLI and dashboard presets without persisting registry trust policy", () => {
    expect(buildInitProviders()).toEqual(deriveInitProviders());

    for (const id of ["sambanova", "nebius"] as const) {
      const entry = registryEntry(id);
      const provider = PROVIDERS[id];
      expect(KEY_LOGIN_PROVIDERS[id]).toMatchObject({
        adapter: "openai-chat",
        baseUrl: provider.baseUrl,
        dashboardUrl: provider.dashboardUrl,
        liveModels: true,
        ...(id === "sambanova" ? { apiKeyValidation: "unknown" } : {}),
      });
      expect(buildInitProviders().find(row => row.id === id)).toMatchObject({
        kind: "key",
        adapter: "openai-chat",
        baseUrl: provider.baseUrl,
      });
      expect(deriveProviderPresets().find(row => row.id === id)).toMatchObject({
        auth: "key",
        dashboardUrl: provider.dashboardUrl,
      });

      const seed = providerConfigSeed(entry);
      expect(seed).toMatchObject({
        adapter: "openai-chat",
        baseUrl: provider.baseUrl,
        authMode: "key",
        liveModels: true,
        parallelToolCalls: false,
        reasoningEfforts: [],
      });
      expect(seed).not.toHaveProperty("apiKeyValidation");
      expect(seed).not.toHaveProperty("modelDiscovery");
      expect(seed).not.toHaveProperty("preserveCustomDestination");
      expect(KEY_LOGIN_PROVIDERS[id]).not.toHaveProperty("modelDiscovery");
      expect(KEY_LOGIN_PROVIDERS[id]).not.toHaveProperty("preserveCustomDestination");
    }
  });

  test("builds each registry-owned models request and validates the authenticated Nebius catalog", async () => {
    for (const id of ["sambanova", "nebius"] as const) {
      const provider = PROVIDERS[id];
      expect(buildModelsRequest(providerConfig(id).providers[id]!, provider.key, id)).toEqual({
        url: provider.modelsUrl,
        headers: { Authorization: `Bearer ${provider.key}` },
      });
    }

    const provider = PROVIDERS.nebius;
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe(provider.modelsUrl);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${provider.key}`);
      expect(init?.redirect).toBe("error");
      return new Response(provider.fixture, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    expect(await validateApiKey("nebius", KEY_LOGIN_PROVIDERS.nebius!, provider.key)).toBe(true);
  });

  test("does not treat SambaNova's public model catalog as proof that a key is valid", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response(SAMBANOVA_FIXTURE, { status: 200 });
    }) as typeof fetch;

    expect(await validateApiKey(
      "sambanova",
      KEY_LOGIN_PROVIDERS.sambanova!,
      PROVIDERS.sambanova.key,
    )).toBe("unknown");
    expect(fetchCalled).toBe(false);
  });

  test("filters Nebius mixed rows and preserves model metadata and native ids", async () => {
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      expect(new Headers(init?.headers).get("authorization")).toBeTruthy();
      expect(init?.redirect).toBe("manual");
      if (url === PROVIDERS.sambanova.modelsUrl) {
        return new Response(SAMBANOVA_FIXTURE, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === PROVIDERS.nebius.modelsUrl) {
        return new Response(NEBIUS_FIXTURE, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected discovery URL: ${url}`);
    }) as typeof fetch;

    const config = withStubbedProviderFetch({
      port: 10100,
      defaultProvider: "sambanova",
      providers: {
        sambanova: providerConfig("sambanova").providers.sambanova!,
        nebius: providerConfig("nebius").providers.nebius!,
      },
    } satisfies OcxConfig);
    const models = await gatherRoutedModels(config);
    const sambanovaModels = models.filter(row => row.provider === "sambanova");
    const nebiusModels = models.filter(row => row.provider === "nebius");

    expect(sambanovaModels.map(row => row.id)).toEqual([
      "gpt-oss-120b",
      "Meta-Llama-3.3-70B-Instruct",
    ]);
    expect(sambanovaModels[1]).toMatchObject({
      owned_by: "sambanova",
      contextWindow: 131_072,
      reasoningEfforts: [],
    });
    expect(nebiusModels.map(row => row.id)).toEqual([
      "meta-llama/Meta-Llama-3.1-8B-Instruct-fast",
      "Qwen/Qwen3-VL-235B-A22B-Instruct",
    ]);
    expect(nebiusModels[0]).toMatchObject({
      owned_by: "system",
      contextWindow: 131_072,
      inputModalities: ["text"],
      capabilities: ["function-calling", "json-mode"],
      reasoningEfforts: [],
    });
    expect(nebiusModels[1]).toMatchObject({
      contextWindow: 262_144,
      inputModalities: ["text", "image"],
    });

    const selectors = [
      ["sambanova", "Meta-Llama-3.3-70B-Instruct"],
      ["nebius", "meta-llama/Meta-Llama-3.1-8B-Instruct-fast"],
    ] as const;
    for (const [providerId, modelId] of selectors) {
      expect(routeModel(config, `${providerId}/${modelId}`).modelId).toBe(modelId);
      expect(routeModel(config, routedSlug(providerId, modelId)).modelId).toBe(modelId);
    }
  });

  test("keeps Nebius query and text-output filtering when the preset is renamed", async () => {
    const provider = PROVIDERS.nebius;
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe(provider.modelsUrl);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${provider.key}`);
      expect(init?.redirect).toBe("manual");
      return new Response(provider.fixture, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const renamed = "nebius-team";
    const config = withStubbedProviderFetch({
      port: 10100,
      defaultProvider: renamed,
      providers: {
        [renamed]: providerConfig("nebius").providers.nebius!,
      },
    } satisfies OcxConfig);
    const models = await gatherRoutedModels(config);
    expect(models.filter(row => row.provider === renamed).map(row => row.id)).toEqual([
      "meta-llama/Meta-Llama-3.1-8B-Instruct-fast",
      "Qwen/Qwen3-VL-235B-A22B-Instruct",
    ]);
  });

  test("routes tool requests to the fixed hosts without claiming parallel tool calls", () => {
    const cases = [
      ["sambanova", "Meta-Llama-3.3-70B-Instruct"],
      ["nebius", "meta-llama/Meta-Llama-3.1-8B-Instruct-fast"],
    ] as const;

    for (const [providerId, modelId] of cases) {
      const route = routeModel(providerConfig(providerId), `${providerId}/${modelId}`);
      const request = createOpenAIChatAdapter(route.provider).buildRequest({
        modelId: route.modelId,
        context: {
          messages: [{ role: "user", content: "ping", timestamp: 0 }],
          tools: [{
            name: "ping",
            description: "Return pong",
            parameters: { type: "object", properties: {} },
          }],
        },
        stream: true,
        options: { reasoning: "high" },
      });
      const body = JSON.parse(String(request.body)) as Record<string, unknown>;

      expect(request.url).toBe(`${PROVIDERS[providerId].baseUrl}/chat/completions`);
      expect(request.headers.Authorization).toBe(`Bearer ${PROVIDERS[providerId].key}`);
      expect(body.model).toBe(modelId);
      expect(body).not.toHaveProperty("parallel_tool_calls");
      expect(body).not.toHaveProperty("reasoning_effort");
    }
  });

  test("does not retarget older same-named custom providers or adapters", () => {
    for (const id of ["sambanova", "nebius"] as const) {
      const customConfig = providerConfig(id, { baseUrl: "https://custom.example/v1" });
      const route = routeModel(customConfig, `${id}/custom-model`);
      expect(route.provider).toMatchObject({
        adapter: "openai-chat",
        baseUrl: "https://custom.example/v1",
        authMode: "key",
      });
      expect(buildModelsRequest(customConfig.providers[id]!, "custom-key", id)).toEqual({
        url: "https://custom.example/v1/models",
        headers: { Authorization: "Bearer custom-key" },
      });

      const customAdapter = routeModel(providerConfig(id, {
        adapter: "anthropic",
        baseUrl: "https://custom.example/anthropic",
      }), `${id}/custom-model`);
      expect(customAdapter.provider).toMatchObject({
        adapter: "anthropic",
        baseUrl: "https://custom.example/anthropic",
        authMode: "key",
      });
    }

    const crossPreset = providerConfig("sambanova", {
      baseUrl: PROVIDERS.nebius.baseUrl,
    }).providers.sambanova!;
    expect(resolveProviderModelDiscovery("sambanova", crossPreset).spec).toBeUndefined();
    expect(buildModelsRequest(crossPreset, "custom-key", "sambanova")).toEqual({
      url: `${PROVIDERS.nebius.baseUrl}/models`,
      headers: { Authorization: "Bearer custom-key" },
    });
  });
});
