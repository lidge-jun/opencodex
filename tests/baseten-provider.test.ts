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
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { routedSlug } from "../src/providers/slug-codec";
import { routeModel } from "../src/router";
import type { OcxConfig, OcxProviderConfig } from "../src/types";
import { withStubbedProviderFetch } from "./helpers/catalog-provider-fetch";

const FIXTURE = readFileSync(join(import.meta.dir, "fixtures/baseten-models.json"), "utf8");
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache("baseten");
});

function basetenEntry() {
  const entry = PROVIDER_REGISTRY.find(row => row.id === "baseten");
  if (!entry) throw new Error("missing Baseten registry entry");
  return entry;
}

function basetenConfig(overrides: Partial<OcxProviderConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "baseten",
    providers: {
      baseten: {
        adapter: "openai-chat",
        baseUrl: "https://inference.baseten.co/v1",
        authMode: "key",
        apiKey: "bt-test-key",
        liveModels: true,
        // Some test environments resolve public hosts through a NAT64 prefix. The fetch itself is
        // fixture-only; this opt-in keeps this test focused on the provider contract.
        allowPrivateNetwork: true,
        ...overrides,
      },
    },
  };
}

describe("Baseten Model APIs provider", () => {
  test("registers the fixed shared Model APIs transport and bounded discovery policy", () => {
    expect(basetenEntry()).toMatchObject({
      id: "baseten",
      label: "Baseten Model APIs",
      adapter: "openai-chat",
      baseUrl: "https://inference.baseten.co/v1",
      authKind: "key",
      dashboardUrl: "https://app.baseten.co/settings/api_keys",
      liveModels: true,
      preserveCustomDestination: true,
      parallelToolCalls: true,
      reasoningEfforts: [],
      modelInputModalities: {
        "thinkingmachines/inkling": ["text", "image"],
        "moonshotai/Kimi-K2.6": ["text", "image"],
        "moonshotai/Kimi-K2.7-Code": ["text", "image"],
        "moonshotai/Kimi-K3": ["text", "image"],
      },
      modelDiscovery: {
        path: "models",
        maxResponseBytes: 1_048_576,
        maxModels: 256,
      },
    });
    expect(basetenEntry().modelReasoningEfforts).toEqual({
      "deepseek-ai/DeepSeek-V4-Pro": ["low", "medium", "high", "xhigh", "max"],
      "thinkingmachines/inkling": ["low", "medium", "high", "xhigh", "max"],
      "openai/gpt-oss-120b": ["low", "medium", "high", "xhigh", "max"],
      "moonshotai/Kimi-K3": ["low", "high", "max"],
      "zai-org/GLM-5.3": ["low", "high", "max"],
      "zai-org/GLM-5.3-Fast": ["low", "high", "max"],
      "zai-org/GLM-5.2": ["high", "max"],
      "zai-org/GLM-5.2-Fast": ["high", "max"],
    });
    expect(basetenEntry().modelReasoningEffortMap).toEqual({
      "deepseek-ai/DeepSeek-V4-Pro": { none: "none", minimal: "minimal" },
      "thinkingmachines/inkling": { none: "none", minimal: "minimal" },
      "openai/gpt-oss-120b": { none: "none", minimal: "minimal" },
      "moonshotai/Kimi-K3": { none: "none" },
      "zai-org/GLM-5.3": { none: "none" },
      "zai-org/GLM-5.3-Fast": { none: "none" },
      "zai-org/GLM-5.2": { none: "none" },
      "zai-org/GLM-5.2-Fast": { none: "none" },
    });
    expect(basetenEntry().modelDefaultReasoningEfforts).toEqual({
      "deepseek-ai/DeepSeek-V4-Pro": "medium",
      "thinkingmachines/inkling": "high",
      "openai/gpt-oss-120b": "medium",
      "moonshotai/Kimi-K3": "max",
    });
    expect(basetenEntry().note).toContain("Shared Model APIs only");
    expect(basetenEntry().note).toContain("personal API key");
    expect(basetenEntry().note).toContain("Truss predict endpoints");
  });

  test("derives key-login, init, and dashboard presets without persisting trust policy", () => {
    expect(KEY_LOGIN_PROVIDERS.baseten).toMatchObject({
      label: "Baseten Model APIs",
      adapter: "openai-chat",
      baseUrl: "https://inference.baseten.co/v1",
      dashboardUrl: "https://app.baseten.co/settings/api_keys",
      liveModels: true,
    });
    expect(buildInitProviders()).toEqual(deriveInitProviders());
    expect(buildInitProviders().find(row => row.id === "baseten")).toMatchObject({
      kind: "key",
      adapter: "openai-chat",
      baseUrl: "https://inference.baseten.co/v1",
    });
    expect(deriveProviderPresets().find(row => row.id === "baseten")).toMatchObject({
      auth: "key",
      dashboardUrl: "https://app.baseten.co/settings/api_keys",
    });

    const seed = providerConfigSeed(basetenEntry());
    expect(seed).toMatchObject({
      adapter: "openai-chat",
      baseUrl: "https://inference.baseten.co/v1",
      authMode: "key",
      liveModels: true,
      parallelToolCalls: true,
      reasoningEfforts: [],
    });
    expect(seed.modelReasoningEfforts?.["deepseek-ai/DeepSeek-V4-Pro"])
      .toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(seed.modelInputModalities?.["moonshotai/Kimi-K2.6"])
      .toEqual(["text", "image"]);
    expect(seed).not.toHaveProperty("modelDiscovery");
    expect(seed).not.toHaveProperty("preserveCustomDestination");
    expect(KEY_LOGIN_PROVIDERS.baseten).not.toHaveProperty("modelDiscovery");
    expect(KEY_LOGIN_PROVIDERS.baseten).not.toHaveProperty("preserveCustomDestination");
  });

  test("lists and validates models through the same Bearer-authenticated endpoint", async () => {
    const request = buildModelsRequest(
      basetenConfig().providers.baseten!,
      "bt-model-list-key",
      "baseten",
    );
    expect(request).toEqual({
      url: "https://inference.baseten.co/v1/models",
      headers: { Authorization: "Bearer bt-model-list-key" },
    });

    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe("https://inference.baseten.co/v1/models");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer bt-validation-key");
      expect(init?.redirect).toBe("error");
      return new Response(FIXTURE, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    expect(await validateApiKey(
      "baseten",
      KEY_LOGIN_PROVIDERS.baseten!,
      "bt-validation-key",
    )).toBe(true);
  });

  test("routes chat completions to the shared inference host with documented tool parallelism", () => {
    const route = routeModel(
      basetenConfig(),
      "baseten/deepseek-ai/DeepSeek-V4-Pro",
    );
    expect(route.provider.parallelToolCalls).toBe(true);
    expect(route.modelId).toBe("deepseek-ai/DeepSeek-V4-Pro");

    const request = createOpenAIChatAdapter(route.provider).buildRequest({
      modelId: route.modelId,
      context: {
        messages: [{ role: "user", content: "ping", timestamp: 0 }],
        tools: [{ name: "lookup", description: "Lookup", parameters: { type: "object" } }],
      },
      stream: true,
      options: {},
    });
    const body = JSON.parse(String(request.body)) as Record<string, unknown>;

    expect(request.url).toBe("https://inference.baseten.co/v1/chat/completions");
    expect(request.headers.Authorization).toBe("Bearer bt-test-key");
    expect(body.model).toBe("deepseek-ai/DeepSeek-V4-Pro");
    expect(body.parallel_tool_calls).toBe(true);
  });

  test("forwards only the documented per-model reasoning effort ladders", () => {
    const deepseekRoute = routeModel(basetenConfig(), "baseten/deepseek-ai/DeepSeek-V4-Pro");
    const deepseekBody = JSON.parse(String(createOpenAIChatAdapter(deepseekRoute.provider).buildRequest({
      modelId: deepseekRoute.modelId,
      context: { messages: [{ role: "user", content: "ping", timestamp: 0 }] },
      stream: false,
      options: { reasoning: "minimal" },
    }).body)) as Record<string, unknown>;
    expect(deepseekBody.reasoning_effort).toBe("minimal");

    const glmRoute = routeModel(basetenConfig(), "baseten/zai-org/GLM-5.2");
    const glmBody = JSON.parse(String(createOpenAIChatAdapter(glmRoute.provider).buildRequest({
      modelId: glmRoute.modelId,
      context: { messages: [{ role: "user", content: "ping", timestamp: 0 }] },
      stream: false,
      options: { reasoning: "low" },
    }).body)) as Record<string, unknown>;
    // GLM 5.2 accepts only high/max, so a lower Codex rung clamps to its lowest real rung.
    expect(glmBody.reasoning_effort).toBe("high");

    const kimiRoute = routeModel(basetenConfig(), "baseten/moonshotai/Kimi-K2.6");
    const kimiBody = JSON.parse(String(createOpenAIChatAdapter(kimiRoute.provider).buildRequest({
      modelId: kimiRoute.modelId,
      context: { messages: [{ role: "user", content: "ping", timestamp: 0 }] },
      stream: false,
      options: { reasoning: "high" },
    }).body)) as Record<string, unknown>;
    // K2.6 uses chat_template_args instead of reasoning_effort; do not send an ignored claim.
    expect(kimiBody).not.toHaveProperty("reasoning_effort");
  });

  test("discovers slash-containing model ids from a local fixture and routes both selector forms", async () => {
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe("https://inference.baseten.co/v1/models");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer bt-test-key");
      expect(init?.redirect).toBe("manual");
      return new Response(FIXTURE, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const config = withStubbedProviderFetch(basetenConfig());
    const models = (await gatherRoutedModels(config)).filter(row => row.provider === "baseten");
    expect(models.map(row => row.id)).toEqual([
      "deepseek-ai/DeepSeek-V4-Pro",
      "moonshotai/Kimi-K2.6",
    ]);
    expect(models[0]).toMatchObject({
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "medium",
      parallelToolCalls: true,
    });
    expect(models[1]).toMatchObject({
      inputModalities: ["text", "image"],
      reasoningEfforts: [],
      parallelToolCalls: true,
    });
    expect(routedSlug("baseten", models[0]!.id)).toBe("baseten/deepseek-ai-DeepSeek-V4-Pro");

    expect(routeModel(config, "baseten/deepseek-ai/DeepSeek-V4-Pro").modelId)
      .toBe("deepseek-ai/DeepSeek-V4-Pro");
    expect(routeModel(config, "baseten/deepseek-ai-DeepSeek-V4-Pro").modelId)
      .toBe("deepseek-ai/DeepSeek-V4-Pro");
  });

  test("does not retarget an older same-named custom provider", () => {
    const customBaseUrl = routeModel(basetenConfig({
      baseUrl: "https://custom.example/v1",
    }), "baseten/custom-model");
    expect(customBaseUrl.provider).toMatchObject({
      adapter: "openai-chat",
      baseUrl: "https://custom.example/v1",
      authMode: "key",
    });

    const customAdapter = routeModel(basetenConfig({
      adapter: "anthropic",
      baseUrl: "https://custom.example/anthropic",
    }), "baseten/custom-model");
    expect(customAdapter.provider).toMatchObject({
      adapter: "anthropic",
      baseUrl: "https://custom.example/anthropic",
      authMode: "key",
    });
  });
});
