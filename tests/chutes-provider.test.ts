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
import { resolveProviderModelDiscovery } from "../src/providers/model-discovery";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { routedSlug } from "../src/providers/slug-codec";
import { routeModel } from "../src/router";
import type { OcxConfig, OcxProviderConfig } from "../src/types";
import { withStubbedProviderFetch } from "./helpers/catalog-provider-fetch";

const CHUTES_FIXTURE = readFileSync(join(import.meta.dir, "fixtures/chutes-models.json"), "utf8");
const BASE_URL = "https://llm.chutes.ai/v1";
const MODELS_URL = `${BASE_URL}/models`;
const TEST_KEY = "chutes-test-key";
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache("chutes");
});

function registryEntry() {
  const entry = PROVIDER_REGISTRY.find(row => row.id === "chutes");
  if (!entry) throw new Error("missing chutes registry entry");
  return entry;
}

function providerConfig(overrides: Partial<OcxProviderConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "chutes",
    providers: {
      chutes: {
        adapter: "openai-chat",
        baseUrl: BASE_URL,
        authMode: "key",
        apiKey: TEST_KEY,
        liveModels: true,
        ...overrides,
      },
    },
  };
}

describe("Chutes provider", () => {
  test("registers the fixed shared LLM transport with bounded tool-model discovery", () => {
    expect(registryEntry()).toMatchObject({
      id: "chutes",
      label: "Chutes",
      adapter: "openai-chat",
      baseUrl: BASE_URL,
      authKind: "key",
      dashboardUrl: "https://chutes.ai/auth/start",
      liveModels: true,
      preserveCustomDestination: true,
      apiKeyValidation: "unknown",
      parallelToolCalls: false,
      reasoningEfforts: [],
      modelDiscovery: {
        path: "models",
        maxResponseBytes: 262_144,
        maxModels: 128,
        filter: {
          allOf: [{ path: ["supported_features"], containsAny: ["tools"] }],
        },
      },
    });
    expect(registryEntry().note).toContain("custom Chute endpoints");
  });

  test("derives CLI and dashboard presets without persisting registry trust policy", () => {
    const entry = registryEntry();
    expect(buildInitProviders()).toEqual(deriveInitProviders());
    expect(KEY_LOGIN_PROVIDERS.chutes).toMatchObject({
      adapter: "openai-chat",
      baseUrl: BASE_URL,
      dashboardUrl: entry.dashboardUrl,
      liveModels: true,
      apiKeyValidation: "unknown",
      reasoningEfforts: [],
    });
    expect(buildInitProviders().find(row => row.id === "chutes")).toMatchObject({
      kind: "key",
      adapter: "openai-chat",
      baseUrl: BASE_URL,
    });
    expect(deriveProviderPresets().find(row => row.id === "chutes")).toMatchObject({
      auth: "key",
      dashboardUrl: entry.dashboardUrl,
    });

    const seed = providerConfigSeed(entry);
    expect(seed).toMatchObject({
      adapter: "openai-chat",
      baseUrl: BASE_URL,
      authMode: "key",
      liveModels: true,
      parallelToolCalls: false,
      reasoningEfforts: [],
    });
    expect(seed).not.toHaveProperty("modelDiscovery");
    expect(seed).not.toHaveProperty("preserveCustomDestination");
    expect(KEY_LOGIN_PROVIDERS.chutes).not.toHaveProperty("modelDiscovery");
    expect(KEY_LOGIN_PROVIDERS.chutes).not.toHaveProperty("preserveCustomDestination");
  });

  test("uses the documented Bearer endpoint without treating its public catalog as key proof", async () => {
    expect(buildModelsRequest(providerConfig().providers.chutes!, TEST_KEY, "chutes")).toEqual({
      url: MODELS_URL,
      headers: { Authorization: `Bearer ${TEST_KEY}` },
    });

    globalThis.fetch = (async () => {
      throw new Error("public-catalog validation must not fetch");
    }) as typeof fetch;
    expect(await validateApiKey("chutes", KEY_LOGIN_PROVIDERS.chutes!, TEST_KEY)).toBe("unknown");
  });

  test("filters to tool-capable rows and preserves safe live metadata and slash ids", async () => {
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe(MODELS_URL);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TEST_KEY}`);
      expect(init?.redirect).toBe("manual");
      return new Response(CHUTES_FIXTURE, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const config = withStubbedProviderFetch(providerConfig());
    const models = (await gatherRoutedModels(config)).filter(row => row.provider === "chutes");
    expect(models.map(row => row.id)).toEqual([
      "example/sparse-tool-model",
      "moonshotai/Kimi-K2.6-TEE",
      "Qwen/Qwen3-32B-TEE",
    ]);
    const qwen = models.find(row => row.id === "Qwen/Qwen3-32B-TEE");
    const kimi = models.find(row => row.id === "moonshotai/Kimi-K2.6-TEE");
    const sparse = models.find(row => row.id === "example/sparse-tool-model");
    expect(qwen).toMatchObject({
      owned_by: "sglang",
      contextWindow: 40_960,
      inputModalities: ["text"],
      capabilities: ["json_mode", "tools", "structured_outputs", "reasoning"],
      reasoningEfforts: [],
    });
    expect(qwen).not.toHaveProperty("parallelToolCalls");
    expect(kimi).toMatchObject({
      contextWindow: 262_144,
      inputModalities: ["text", "image"],
      capabilities: ["json_mode", "structured_outputs", "tools", "reasoning"],
      reasoningEfforts: [],
    });
    expect(sparse).toMatchObject({
      owned_by: "fixture",
      capabilities: ["tools"],
      reasoningEfforts: [],
    });
    expect(sparse).not.toHaveProperty("contextWindow");
    expect(sparse).not.toHaveProperty("inputModalities");

    for (const modelId of models.map(row => row.id)) {
      expect(routeModel(config, `chutes/${modelId}`).modelId).toBe(modelId);
      expect(routeModel(config, routedSlug("chutes", modelId)).modelId).toBe(modelId);
    }
  });

  test("routes tool requests to the fixed host without unsupported reasoning or parallel fields", () => {
    const modelId = "Qwen/Qwen3-32B-TEE";
    const route = routeModel(providerConfig(), `chutes/${modelId}`);
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

    expect(request.url).toBe(`${BASE_URL}/chat/completions`);
    expect(request.headers.Authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(body.model).toBe(modelId);
    expect(body).not.toHaveProperty("parallel_tool_calls");
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  test("does not retarget an older same-named custom provider or adapter", () => {
    const customConfig = providerConfig({ baseUrl: "https://custom.example/v1" });
    const route = routeModel(customConfig, "chutes/custom-model");
    expect(route.provider).toMatchObject({
      adapter: "openai-chat",
      baseUrl: "https://custom.example/v1",
      authMode: "key",
    });
    expect(resolveProviderModelDiscovery("chutes", customConfig.providers.chutes!).spec).toBeUndefined();
    expect(buildModelsRequest(customConfig.providers.chutes!, "custom-key", "chutes")).toEqual({
      url: "https://custom.example/v1/models",
      headers: { Authorization: "Bearer custom-key" },
    });

    const nearMissConfig = providerConfig({ baseUrl: "https://llm.chutes.ai/v2" });
    expect(
      resolveProviderModelDiscovery("chutes", nearMissConfig.providers.chutes!).spec,
    ).toBeUndefined();

    const customAdapter = routeModel(providerConfig({
      adapter: "anthropic",
      baseUrl: "https://custom.example/anthropic",
    }), "chutes/custom-model");
    expect(customAdapter.provider).toMatchObject({
      adapter: "anthropic",
      baseUrl: "https://custom.example/anthropic",
      authMode: "key",
    });
  });
});
