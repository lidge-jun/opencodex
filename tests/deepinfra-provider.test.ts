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
import { PROVIDER_REGISTRY, type ProviderRegistryEntry } from "../src/providers/registry";
import { routedSlug } from "../src/providers/slug-codec";
import { routeModel } from "../src/router";
import type { OcxConfig, OcxProviderConfig } from "../src/types";
import { withStubbedProviderFetch } from "./helpers/catalog-provider-fetch";

const FIXTURE = readFileSync(join(import.meta.dir, "fixtures/deepinfra-models.json"), "utf8");
const BASE_URL = "https://api.deepinfra.com/v1/openai";
const MODELS_URL = "https://api.deepinfra.com/v1/models";
const API_KEY = "di-test-key";
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache("deepinfra");
});

function registryEntry(): ProviderRegistryEntry {
  const entry = PROVIDER_REGISTRY.find(row => row.id === "deepinfra");
  if (!entry) throw new Error("missing deepinfra registry entry");
  return entry;
}

function providerConfig(overrides: Partial<OcxProviderConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "deepinfra",
    providers: {
      deepinfra: {
        adapter: "openai-chat",
        baseUrl: BASE_URL,
        authMode: "key",
        apiKey: API_KEY,
        liveModels: true,
        // Discovery stays fixture-only; this avoids platform-specific public-DNS classification.
        allowPrivateNetwork: true,
        ...overrides,
      },
    },
  };
}

describe("DeepInfra provider", () => {
  test("registers a fixed OpenAI transport with bounded chat-only discovery", () => {
    expect(registryEntry()).toMatchObject({
      id: "deepinfra",
      label: "DeepInfra",
      adapter: "openai-chat",
      baseUrl: BASE_URL,
      authKind: "key",
      dashboardUrl: "https://deepinfra.com/dash/api_keys",
      liveModels: true,
      preserveCustomDestination: true,
      modelDiscovery: {
        url: MODELS_URL,
        maxResponseBytes: 524_288,
        maxModels: 512,
        filter: {
          allOf: [{ path: ["metadata", "tags"], containsAny: ["chat"] }],
        },
      },
    });
    expect(registryEntry().note).toContain("non-chat rows");
  });

  test("derives CLI and dashboard presets without persisting registry trust policy", () => {
    const entry = registryEntry();
    expect(buildInitProviders()).toEqual(deriveInitProviders());
    expect(KEY_LOGIN_PROVIDERS.deepinfra).toMatchObject({
      adapter: "openai-chat",
      baseUrl: BASE_URL,
      dashboardUrl: entry.dashboardUrl,
      liveModels: true,
    });
    expect(buildInitProviders().find(row => row.id === "deepinfra")).toMatchObject({
      kind: "key",
      adapter: "openai-chat",
      baseUrl: BASE_URL,
    });
    expect(deriveProviderPresets().find(row => row.id === "deepinfra")).toMatchObject({
      auth: "key",
      dashboardUrl: entry.dashboardUrl,
    });

    const seed = providerConfigSeed(entry);
    expect(seed).toMatchObject({
      adapter: "openai-chat",
      baseUrl: BASE_URL,
      authMode: "key",
      liveModels: true,
    });
    expect(seed).not.toHaveProperty("modelDiscovery");
    expect(seed).not.toHaveProperty("preserveCustomDestination");
    expect(KEY_LOGIN_PROVIDERS.deepinfra).not.toHaveProperty("modelDiscovery");
    expect(KEY_LOGIN_PROVIDERS.deepinfra).not.toHaveProperty("preserveCustomDestination");
  });

  test("lists and validates models through the documented Bearer-authenticated endpoint", async () => {
    expect(buildModelsRequest(providerConfig().providers.deepinfra!, API_KEY, "deepinfra")).toEqual({
      url: MODELS_URL,
      headers: { Authorization: `Bearer ${API_KEY}` },
    });

    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe(MODELS_URL);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${API_KEY}`);
      expect(init?.redirect).toBe("error");
      return new Response(FIXTURE, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    expect(await validateApiKey("deepinfra", KEY_LOGIN_PROVIDERS.deepinfra!, API_KEY)).toBe(true);
  });

  test("filters mixed fixtures, preserves metadata, and routes slash ids in both selector forms", async () => {
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe(MODELS_URL);
      expect(new Headers(init?.headers).get("authorization")).toBeTruthy();
      expect(init?.redirect).toBe("manual");
      return new Response(FIXTURE, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const config = withStubbedProviderFetch(providerConfig());
    const models = (await gatherRoutedModels(config)).filter(row => row.provider === "deepinfra");

    expect(models.map(row => row.id)).toEqual([
      "deepseek-ai/DeepSeek-V3",
      "Qwen/Qwen2.5-VL-72B-Instruct",
    ]);
    expect(models[0]).toMatchObject({
      owned_by: "deepinfra",
      contextWindow: 131_072,
    });
    expect(models[1]).toMatchObject({
      owned_by: "deepinfra",
      contextWindow: 65_536,
    });

    for (const selector of [
      "deepinfra/deepseek-ai/DeepSeek-V3",
      routedSlug("deepinfra", "deepseek-ai/DeepSeek-V3"),
    ]) {
      expect(routeModel(config, selector).modelId).toBe("deepseek-ai/DeepSeek-V3");
    }
  });

  test("routes chat completions to the fixed inference host", () => {
    const route = routeModel(providerConfig(), "deepinfra/deepseek-ai/DeepSeek-V3");
    const request = createOpenAIChatAdapter(route.provider).buildRequest({
      modelId: route.modelId,
      context: { messages: [{ role: "user", content: "ping", timestamp: 0 }] },
      stream: true,
      options: {},
    });
    const body = JSON.parse(String(request.body)) as Record<string, unknown>;

    expect(request.url).toBe(`${BASE_URL}/chat/completions`);
    expect(request.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(body.model).toBe("deepseek-ai/DeepSeek-V3");
  });

  test("does not retarget an older same-named custom provider or apply discovery policy", () => {
    const customConfig = providerConfig({ baseUrl: "https://custom.example/v1" });
    const route = routeModel(customConfig, "deepinfra/custom-model");
    expect(route.provider).toMatchObject({
      adapter: "openai-chat",
      baseUrl: "https://custom.example/v1",
      authMode: "key",
    });
    expect(buildModelsRequest(customConfig.providers.deepinfra!, "custom-key", "deepinfra")).toEqual({
      url: "https://custom.example/v1/models",
      headers: { Authorization: "Bearer custom-key" },
    });

    const customAdapter = routeModel(providerConfig({
      adapter: "anthropic",
      baseUrl: "https://custom.example/anthropic",
    }), "deepinfra/custom-model");
    expect(customAdapter.provider).toMatchObject({
      adapter: "anthropic",
      baseUrl: "https://custom.example/anthropic",
      authMode: "key",
    });
  });
});
