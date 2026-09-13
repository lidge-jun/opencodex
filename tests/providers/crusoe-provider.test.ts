import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import { gatherRoutedModels } from "../../src/codex/catalog";
import { clearModelCache } from "../../src/codex/model-cache";
import { buildInitProviders } from "../../src/cli/init";
import { buildModelsRequest } from "../../src/oauth";
import { KEY_LOGIN_PROVIDERS, validateApiKey } from "../../src/oauth/key-providers";
import {
  deriveInitProviders,
  deriveProviderPresets,
  providerConfigSeed,
} from "../../src/providers/derive";
import { resolveProviderModelDiscovery } from "../../src/providers/model-discovery";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { routedSlug } from "../../src/providers/slug-codec";
import { routeModel } from "../../src/router";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { withStubbedProviderFetch } from "../helpers/catalog-provider-fetch";
import { fixturePath } from "../helpers/repo-root";

const CRUSOE_FIXTURE = readFileSync(fixturePath("crusoe-models.json"), "utf8");
const BASE_URL = "https://api.inference.crusoecloud.com/v1";
const MODELS_URL = `${BASE_URL}/models`;
const TEST_KEY = "crusoe-test-key";
const EFFORT_MODEL = "openai/gpt-oss-120b";
const TOGGLE_MODEL = "zai-org/GLM-5.3";
const VISION_MODEL = "moonshotai/Kimi-K2.6";
const IMAGE_INPUT_MODELS = [
  "google/gemma-4-31b-it",
  "moonshotai/Kimi-K2.6",
  "nvidia/Nemotron-3-Nano-Omni-Reasoning-30B-A3B",
  "yutori/n2",
  "zai-org/GLM-5.3-Flash",
];
// Every public serverless row in the 2026-09-12 capture; the two `example/` rows in the fixture
// (a private deployment and an embedding model) must be filtered out.
const PUBLIC_CHAT_IDS = [
  "Qwen/Qwen3-235B-A22B-Instruct-2507",
  "deepseek-ai/DeepSeek-V3-0324",
  "deepseek-ai/DeepSeek-V4-Pro",
  "deepseek-ai/Deepseek-V4-Flash",
  "google/gemma-4-31b-it",
  "meta-llama/Llama-3.3-70B-Instruct",
  "moonshotai/Kimi-K2.6",
  "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
  "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B",
  "nvidia/Nemotron-3-Nano-Omni-Reasoning-30B-A3B",
  "nvidia/Nemotron-3.5-Lightning-30B-A3B",
  "openai/gpt-oss-120b",
  "yutori/n2",
  "zai-org/GLM-5.3",
  "zai-org/GLM-5.3-Flash",
  "zai/GLM-5.1",
  "zai/GLM-5.2",
];
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache("crusoe");
});

function registryEntry() {
  const entry = PROVIDER_REGISTRY.find(row => row.id === "crusoe");
  if (!entry) throw new Error("missing crusoe registry entry");
  return entry;
}

function providerConfig(overrides: Partial<OcxProviderConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "crusoe",
    providers: {
      crusoe: {
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

function fixtureFetch(expectedRedirect: RequestRedirect) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe(MODELS_URL);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TEST_KEY}`);
    expect(init?.redirect).toBe(expectedRedirect);
    return new Response(CRUSOE_FIXTURE, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function chatRequest(config: OcxConfig, modelId: string, reasoning: string) {
  const route = routeModel(config, `crusoe/${modelId}`);
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
    options: { reasoning },
  });
  return { request, body: JSON.parse(String(request.body)) as Record<string, unknown> };
}

describe("Crusoe provider", () => {
  test("registers a fixed Serverless Inference transport with public text-output discovery", () => {
    expect(registryEntry()).toMatchObject({
      id: "crusoe",
      label: "Crusoe",
      adapter: "openai-chat",
      baseUrl: BASE_URL,
      authKind: "key",
      dashboardUrl: "https://console.crusoecloud.com",
      liveModels: true,
      preserveCustomDestination: true,
      parallelToolCalls: false,
      reasoningEfforts: [],
      modelReasoningEfforts: { [EFFORT_MODEL]: ["low", "medium", "high"] },
      directReasoningEffortModels: [EFFORT_MODEL],
      modelInputModalities: Object.fromEntries(IMAGE_INPUT_MODELS.map(id => [id, ["text", "image"]])),
      modelDiscovery: {
        path: "models",
        maxResponseBytes: 262_144,
        maxModels: 256,
        filter: {
          allOf: [
            { path: ["is_public"], equalsAny: [true] },
            { path: ["architecture", "modality"], equalsAny: ["text", "multimodal"] },
          ],
        },
      },
    });
    expect(registryEntry()).not.toHaveProperty("apiKeyValidation");
    expect(registryEntry().note).toContain("Public Serverless Inference");
  });

  test("derives CLI and dashboard presets without persisting registry trust policy", () => {
    const entry = registryEntry();
    expect(buildInitProviders()).toEqual(deriveInitProviders());
    expect(KEY_LOGIN_PROVIDERS.crusoe).toMatchObject({
      adapter: "openai-chat",
      baseUrl: BASE_URL,
      dashboardUrl: entry.dashboardUrl,
      liveModels: true,
      reasoningEfforts: [],
    });
    expect(KEY_LOGIN_PROVIDERS.crusoe).not.toHaveProperty("apiKeyValidation");
    expect(buildInitProviders().find(row => row.id === "crusoe")).toMatchObject({
      kind: "key",
      adapter: "openai-chat",
      baseUrl: BASE_URL,
    });
    expect(deriveProviderPresets().find(row => row.id === "crusoe")).toMatchObject({
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
      modelReasoningEfforts: { [EFFORT_MODEL]: ["low", "medium", "high"] },
    });
    expect(seed).not.toHaveProperty("modelDiscovery");
    expect(seed).not.toHaveProperty("preserveCustomDestination");
    expect(seed).not.toHaveProperty("directReasoningEffortModels");
    expect(KEY_LOGIN_PROVIDERS.crusoe).not.toHaveProperty("modelDiscovery");
    expect(KEY_LOGIN_PROVIDERS.crusoe).not.toHaveProperty("preserveCustomDestination");
  });

  test("validates a key through the Bearer-authenticated model list", async () => {
    expect(buildModelsRequest(providerConfig().providers.crusoe!, TEST_KEY, "crusoe")).toEqual({
      url: MODELS_URL,
      headers: { Authorization: `Bearer ${TEST_KEY}` },
    });

    globalThis.fetch = fixtureFetch("error");
    expect(await validateApiKey("crusoe", KEY_LOGIN_PROVIDERS.crusoe!, TEST_KEY)).toBe(true);

    globalThis.fetch = (async () => new Response(JSON.stringify({ errors: ["Authentication failed"] }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
    expect(await validateApiKey("crusoe", KEY_LOGIN_PROVIDERS.crusoe!, "wrong-key")).toBe(false);
  });

  test("keeps public text-output rows, drops private and embedding rows, preserves ids and metadata", async () => {
    globalThis.fetch = fixtureFetch("manual");

    const config = withStubbedProviderFetch(providerConfig());
    const models = (await gatherRoutedModels(config)).filter(row => row.provider === "crusoe");
    const ids = models.map(row => row.id);
    expect([...ids].sort()).toEqual([...PUBLIC_CHAT_IDS].sort());
    expect(ids).not.toContain("example/private-deployment");
    expect(ids).not.toContain("example/embedding-model");

    const effortModel = models.find(row => row.id === EFFORT_MODEL);
    expect(effortModel).toMatchObject({
      owned_by: "openai",
      contextWindow: 131_072,
      pricingStatus: "paid",
      reasoningEfforts: ["low", "medium", "high"],
    });
    expect(effortModel).not.toHaveProperty("inputModalities");
    expect(models.find(row => row.id === TOGGLE_MODEL)).toMatchObject({
      owned_by: "zai-org",
      contextWindow: 1_048_576,
      reasoningEfforts: [],
    });
    expect(models.find(row => row.id === VISION_MODEL)).toMatchObject({
      owned_by: "moonshotai",
      contextWindow: 262_144,
      inputModalities: ["text", "image"],
    });
    expect(models.find(row => row.id === "nvidia/Nemotron-3.5-Lightning-30B-A3B")).toMatchObject({
      contextWindow: 262_144,
    });

    for (const modelId of ids) {
      expect(routeModel(config, `crusoe/${modelId}`).modelId).toBe(modelId);
      expect(routeModel(config, routedSlug("crusoe", modelId)).modelId).toBe(modelId);
    }
  });

  test("sends reasoning_effort only to gpt-oss-120b and never advertises parallel tool calls", () => {
    const config = providerConfig();

    const effort = chatRequest(config, EFFORT_MODEL, "high");
    expect(effort.request.url).toBe(`${BASE_URL}/chat/completions`);
    expect(effort.request.headers.Authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(effort.body.model).toBe(EFFORT_MODEL);
    expect(effort.body.reasoning_effort).toBe("high");
    expect(effort.body).not.toHaveProperty("parallel_tool_calls");

    const toggle = chatRequest(config, TOGGLE_MODEL, "high");
    expect(toggle.body.model).toBe(TOGGLE_MODEL);
    expect(toggle.body).not.toHaveProperty("reasoning_effort");
    expect(toggle.body).not.toHaveProperty("parallel_tool_calls");
  });

  test("does not retarget an older same-named custom provider or adapter", () => {
    const customConfig = providerConfig({ baseUrl: "https://custom.example/v1" });
    const route = routeModel(customConfig, "crusoe/custom-model");
    expect(route.provider).toMatchObject({
      adapter: "openai-chat",
      baseUrl: "https://custom.example/v1",
      authMode: "key",
    });
    expect(resolveProviderModelDiscovery("crusoe", customConfig.providers.crusoe!).spec).toBeUndefined();
    expect(buildModelsRequest(customConfig.providers.crusoe!, "custom-key", "crusoe")).toEqual({
      url: "https://custom.example/v1/models",
      headers: { Authorization: "Bearer custom-key" },
    });

    const nearMissConfig = providerConfig({ baseUrl: "https://api.inference.crusoecloud.com/v2" });
    expect(
      resolveProviderModelDiscovery("crusoe", nearMissConfig.providers.crusoe!).spec,
    ).toBeUndefined();

    const customAdapter = routeModel(providerConfig({
      adapter: "anthropic",
      baseUrl: "https://custom.example/anthropic",
    }), "crusoe/custom-model");
    expect(customAdapter.provider).toMatchObject({
      adapter: "anthropic",
      baseUrl: "https://custom.example/anthropic",
      authMode: "key",
    });
  });
});
