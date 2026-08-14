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
import { PROVIDER_REGISTRY, type ProviderRegistryEntry } from "../src/providers/registry";
import { routedSlug } from "../src/providers/slug-codec";
import { routeModel } from "../src/router";
import type { OcxConfig, OcxProviderConfig } from "../src/types";
import { withStubbedProviderFetch } from "./helpers/catalog-provider-fetch";

const DIGITALOCEAN_FIXTURE = readFileSync(join(import.meta.dir, "fixtures/digitalocean-models.json"), "utf8");
const SCALEWAY_FIXTURE = readFileSync(join(import.meta.dir, "fixtures/scaleway-models.json"), "utf8");
const originalFetch = globalThis.fetch;

type ProviderId = "digitalocean" | "scaleway";

const PROVIDERS: Record<ProviderId, {
  baseUrl: string;
  dashboardUrl: string;
  fixture: string;
  key: string;
  modelsUrl: string;
}> = {
  digitalocean: {
    baseUrl: "https://inference.do-ai.run/v1",
    dashboardUrl: "https://cloud.digitalocean.com/model-studio/manage-keys",
    fixture: DIGITALOCEAN_FIXTURE,
    key: "digitalocean-test-key",
    modelsUrl: "https://inference.do-ai.run/v1/models",
  },
  scaleway: {
    baseUrl: "https://api.scaleway.ai/v1",
    dashboardUrl: "https://console.scaleway.com/generative-api",
    fixture: SCALEWAY_FIXTURE,
    key: "scaleway-test-key",
    modelsUrl: "https://api.scaleway.ai/v1/models",
  },
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache("digitalocean");
  clearModelCache("scaleway");
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

function discoveryAllowlist(entry: ProviderRegistryEntry): readonly unknown[] {
  const predicate = entry.modelDiscovery?.filter?.allOf?.[0];
  if (!predicate || !("equalsAny" in predicate)) throw new Error(`missing ${entry.id} discovery allowlist`);
  return predicate.equalsAny;
}

describe("DigitalOcean and Scaleway providers", () => {
  test("registers fixed OpenAI transports with bounded fail-closed chat discovery", () => {
    expect(registryEntry("digitalocean")).toMatchObject({
      id: "digitalocean",
      label: "DigitalOcean Serverless Inference",
      adapter: "openai-chat",
      baseUrl: PROVIDERS.digitalocean.baseUrl,
      authKind: "key",
      dashboardUrl: PROVIDERS.digitalocean.dashboardUrl,
      liveModels: true,
      preserveCustomDestination: true,
      parallelToolCalls: false,
      reasoningEfforts: [],
      modelDiscovery: {
        path: "models",
        maxResponseBytes: 262_144,
        maxModels: 256,
      },
    });
    const digitaloceanModels = discoveryAllowlist(registryEntry("digitalocean"));
    expect(digitaloceanModels).toHaveLength(27);
    expect(digitaloceanModels).toContain("openai-gpt-5.6-sol");
    expect(digitaloceanModels).toContain("meta-llama/Meta-Llama-3.1-8B-Instruct");
    expect(digitaloceanModels).not.toContain("openai-gpt-5.5");
    expect(digitaloceanModels).not.toContain("openai-gpt-image-2");
    expect(registryEntry("digitalocean").note).toContain("Responses-only");

    expect(registryEntry("scaleway")).toMatchObject({
      id: "scaleway",
      label: "Scaleway Generative APIs",
      adapter: "openai-chat",
      baseUrl: PROVIDERS.scaleway.baseUrl,
      authKind: "key",
      dashboardUrl: PROVIDERS.scaleway.dashboardUrl,
      liveModels: true,
      freeTier: true,
      preserveCustomDestination: true,
      parallelToolCalls: false,
      reasoningEfforts: [],
      modelInputModalities: {
        "pixtral-12b-2409": ["text", "image"],
      },
      modelDiscovery: {
        path: "models",
        maxResponseBytes: 131_072,
        maxModels: 128,
      },
    });
    const scalewayModels = discoveryAllowlist(registryEntry("scaleway"));
    expect(scalewayModels).toHaveLength(11);
    expect(scalewayModels).toContain("qwen3.6-35b-a3b");
    expect(scalewayModels).toContain("pixtral-12b-2409");
    expect(scalewayModels).not.toContain("gpt-oss-120b");
    expect(scalewayModels).not.toContain("qwen3-embedding-8b");
    expect(scalewayModels).not.toContain("whisper-large-v3");
    expect(registryEntry("scaleway").note).toContain("project-qualified");
  });

  test("derives CLI and dashboard presets without persisting registry trust policy", () => {
    expect(buildInitProviders()).toEqual(deriveInitProviders());

    for (const id of ["digitalocean", "scaleway"] as const) {
      const entry = registryEntry(id);
      const provider = PROVIDERS[id];
      expect(KEY_LOGIN_PROVIDERS[id]).toMatchObject({
        adapter: "openai-chat",
        baseUrl: provider.baseUrl,
        dashboardUrl: provider.dashboardUrl,
        liveModels: true,
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
      if (id === "scaleway") {
        expect(seed.freeTier).toBe(true);
        expect(seed.modelInputModalities).toEqual({
          "pixtral-12b-2409": ["text", "image"],
        });
      } else {
        expect(seed.freeTier).toBeUndefined();
      }
      expect(seed).not.toHaveProperty("modelDiscovery");
      expect(seed).not.toHaveProperty("preserveCustomDestination");
      expect(KEY_LOGIN_PROVIDERS[id]).not.toHaveProperty("modelDiscovery");
      expect(KEY_LOGIN_PROVIDERS[id]).not.toHaveProperty("preserveCustomDestination");
    }

    expect(FREE_PROVIDER_DIRECTORY.find(row => row.id === "scaleway")).toMatchObject({
      supportLevel: "supported",
      verification: "official",
      documentationUrl: "https://www.scaleway.com/en/docs/generative-apis/api-cli/using-generative-apis/",
      modelsUrl: PROVIDERS.scaleway.modelsUrl,
      lastVerified: "2026-08-01",
    });
  });

  test("lists and validates models through each Bearer-authenticated endpoint", async () => {
    for (const id of ["digitalocean", "scaleway"] as const) {
      const provider = PROVIDERS[id];
      expect(buildModelsRequest(providerConfig(id).providers[id]!, provider.key, id)).toEqual({
        url: provider.modelsUrl,
        headers: { Authorization: `Bearer ${provider.key}` },
      });

      globalThis.fetch = (async (input, init) => {
        expect(String(input)).toBe(provider.modelsUrl);
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${provider.key}`);
        expect(init?.redirect).toBe("error");
        return new Response(provider.fixture, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;

      expect(await validateApiKey(id, KEY_LOGIN_PROVIDERS[id]!, provider.key)).toBe(true);
    }
  });

  test("intersects mixed live catalogs with the docs-backed chat allowlists", async () => {
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      expect(new Headers(init?.headers).get("authorization")).toBeTruthy();
      expect(init?.redirect).toBe("manual");
      if (url === PROVIDERS.digitalocean.modelsUrl) {
        return new Response(DIGITALOCEAN_FIXTURE, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === PROVIDERS.scaleway.modelsUrl) {
        return new Response(SCALEWAY_FIXTURE, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected discovery URL: ${url}`);
    }) as typeof fetch;

    const config = withStubbedProviderFetch({
      port: 10100,
      defaultProvider: "digitalocean",
      providers: {
        digitalocean: providerConfig("digitalocean").providers.digitalocean!,
        scaleway: providerConfig("scaleway").providers.scaleway!,
      },
    } satisfies OcxConfig);
    const models = await gatherRoutedModels(config);
    const digitaloceanModels = models.filter(row => row.provider === "digitalocean");
    const scalewayModels = models.filter(row => row.provider === "scaleway");

    expect(digitaloceanModels.map(row => row.id)).toEqual([
      "deepseek-v4-pro",
      "meta-llama/Meta-Llama-3.1-8B-Instruct",
      "openai-gpt-5.6-sol",
    ]);
    expect(digitaloceanModels[1]).toMatchObject({
      owned_by: "digitalocean",
      reasoningEfforts: [],
    });
    expect(scalewayModels.map(row => row.id)).toEqual([
      "glm-5.2",
      "pixtral-12b-2409",
      "qwen3.6-35b-a3b",
    ]);
    expect(scalewayModels[2]).toMatchObject({ owned_by: "qwen" });
    expect(scalewayModels[1]).toMatchObject({
      owned_by: "mistral",
      inputModalities: ["text", "image"],
      reasoningEfforts: [],
    });

    const slashModel = "meta-llama/Meta-Llama-3.1-8B-Instruct";
    expect(routeModel(config, `digitalocean/${slashModel}`).modelId).toBe(slashModel);
    expect(routeModel(config, routedSlug("digitalocean", slashModel)).modelId).toBe(slashModel);
    expect(routeModel(config, "scaleway/qwen3.6-35b-a3b").modelId).toBe("qwen3.6-35b-a3b");
  });

  test("routes tool requests to the fixed chat hosts without claiming parallel support", () => {
    const cases = [
      ["digitalocean", "openai-gpt-5.6-sol"],
      ["scaleway", "qwen3.6-35b-a3b"],
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
    for (const id of ["digitalocean", "scaleway"] as const) {
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
  });
});
