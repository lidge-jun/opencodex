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

const NOVITA_FIXTURE = readFileSync(join(import.meta.dir, "fixtures/novita-models.json"), "utf8");
const BASE_URL = "https://api.novita.ai/openai/v1";
const MODELS_URL = `${BASE_URL}/models`;
const TEST_KEY = "novita-test-key";
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache("novita");
});

function registryEntry() {
  const entry = PROVIDER_REGISTRY.find(row => row.id === "novita");
  if (!entry) throw new Error("missing novita registry entry");
  return entry;
}

function providerConfig(overrides: Partial<OcxProviderConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "novita",
    providers: {
      novita: {
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

describe("Novita AI provider", () => {
  test("registers a fixed transport with bounded Chat Completions discovery", () => {
    expect(registryEntry()).toMatchObject({
      id: "novita",
      label: "Novita AI",
      adapter: "openai-chat",
      baseUrl: BASE_URL,
      authKind: "key",
      dashboardUrl: "https://novita.ai/settings/key-management",
      liveModels: true,
      preserveCustomDestination: true,
      apiKeyValidation: "unknown",
      parallelToolCalls: false,
      reasoningEfforts: [],
      modelDiscovery: {
        path: "models",
        maxResponseBytes: 524_288,
        maxModels: 256,
        filter: {
          allOf: [
            { path: ["model_type"], equalsAny: ["chat"] },
            { path: ["endpoints"], containsAny: ["chat/completions"] },
          ],
        },
      },
    });
    expect(registryEntry().note).toContain("key validity remains unknown");
  });

  test("derives CLI and dashboard presets without persisting registry trust policy", () => {
    const entry = registryEntry();
    expect(buildInitProviders()).toEqual(deriveInitProviders());
    expect(KEY_LOGIN_PROVIDERS.novita).toMatchObject({
      adapter: "openai-chat",
      baseUrl: BASE_URL,
      dashboardUrl: entry.dashboardUrl,
      liveModels: true,
      apiKeyValidation: "unknown",
      reasoningEfforts: [],
    });
    expect(buildInitProviders().find(row => row.id === "novita")).toMatchObject({
      kind: "key",
      adapter: "openai-chat",
      baseUrl: BASE_URL,
    });
    expect(deriveProviderPresets().find(row => row.id === "novita")).toMatchObject({
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
    expect(KEY_LOGIN_PROVIDERS.novita).not.toHaveProperty("modelDiscovery");
    expect(KEY_LOGIN_PROVIDERS.novita).not.toHaveProperty("preserveCustomDestination");
  });

  test("uses the documented Bearer endpoint without treating its public catalog as key proof", async () => {
    expect(buildModelsRequest(providerConfig().providers.novita!, TEST_KEY, "novita")).toEqual({
      url: MODELS_URL,
      headers: { Authorization: `Bearer ${TEST_KEY}` },
    });

    globalThis.fetch = (async () => {
      throw new Error("public-catalog validation must not fetch");
    }) as typeof fetch;
    expect(await validateApiKey("novita", KEY_LOGIN_PROVIDERS.novita!, TEST_KEY)).toBe("unknown");
  });

  test("filters by chat type and endpoint while preserving safe metadata and slash ids", async () => {
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe(MODELS_URL);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TEST_KEY}`);
      expect(init?.redirect).toBe("manual");
      return new Response(NOVITA_FIXTURE, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const config = withStubbedProviderFetch(providerConfig());
    const models = (await gatherRoutedModels(config)).filter(row => row.provider === "novita");
    expect(models.map(row => row.id)).toEqual([
      "example/sparse-chat-model",
      "moonshotai/kimi-k3",
      "zai-org/glm-5.2",
    ]);

    const kimi = models.find(row => row.id === "moonshotai/kimi-k3");
    const glm = models.find(row => row.id === "zai-org/glm-5.2");
    const sparse = models.find(row => row.id === "example/sparse-chat-model");
    expect(kimi).toMatchObject({
      owned_by: "unknown",
      contextWindow: 1_048_576,
      inputModalities: ["text", "image"],
      capabilities: ["serverless", "function-calling", "structured-outputs", "reasoning"],
      reasoningEfforts: [],
    });
    expect(glm).toMatchObject({
      contextWindow: 1_048_576,
      inputModalities: ["text"],
      reasoningEfforts: [],
    });
    expect(sparse).toMatchObject({ owned_by: "fixture", reasoningEfforts: [] });
    expect(sparse).not.toHaveProperty("contextWindow");
    expect(sparse).not.toHaveProperty("inputModalities");

    for (const modelId of models.map(row => row.id)) {
      expect(routeModel(config, `novita/${modelId}`).modelId).toBe(modelId);
      expect(routeModel(config, routedSlug("novita", modelId)).modelId).toBe(modelId);
    }
  });

  test("routes tool requests without unsupported reasoning or parallel fields", () => {
    const modelId = "moonshotai/kimi-k3";
    const route = routeModel(providerConfig(), `novita/${modelId}`);
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
    const route = routeModel(customConfig, "novita/custom-model");
    expect(route.provider).toMatchObject({
      adapter: "openai-chat",
      baseUrl: "https://custom.example/v1",
      authMode: "key",
    });
    expect(resolveProviderModelDiscovery("novita", customConfig.providers.novita!).spec).toBeUndefined();
    expect(buildModelsRequest(customConfig.providers.novita!, "custom-key", "novita")).toEqual({
      url: "https://custom.example/v1/models",
      headers: { Authorization: "Bearer custom-key" },
    });

    const nearMissConfig = providerConfig({ baseUrl: "https://api.novita.ai/openai/v2" });
    expect(
      resolveProviderModelDiscovery("novita", nearMissConfig.providers.novita!).spec,
    ).toBeUndefined();

    const customAdapter = routeModel(providerConfig({
      adapter: "anthropic",
      baseUrl: "https://custom.example/anthropic",
    }), "novita/custom-model");
    expect(customAdapter.provider).toMatchObject({
      adapter: "anthropic",
      baseUrl: "https://custom.example/anthropic",
      authMode: "key",
    });
  });
});
