import { afterEach, describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import { gatherRoutedModels } from "../../src/codex/catalog";
import { clearModelCache } from "../../src/codex/model-cache";
import { KEY_LOGIN_PROVIDERS, validateApiKey } from "../../src/oauth/key-providers";
import { deriveInitProviders, deriveProviderPresets, providerConfigSeed } from "../../src/providers/derive";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { routeModel } from "../../src/router";
import { resolveWireProtocolOverride } from "../../src/server/adapter-resolve";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { isModelVisionSidecarConsumer } from "../../src/vision/eligibility";
import { withStubbedProviderFetch } from "../helpers/catalog-provider-fetch";

const originalFetch = globalThis.fetch;
const baseUrl = "https://api.abliteratedllm.dev/v1";
// The models the public GET /v1/models listed on 2026-11-14.
const MODELS = [
  "glm-5.3-flash-abliterated", "deepseek-v4.1-flash-1017", "deepseek-v4.1-flash-1017-ultrafast",
  "deepseek-v4.1-flash-original", "glm-5.3-flash", "glm-5.3", "glm-5.3-fast", "kimi-k3", "kimi-k3.1-pro",
  "kimi-k3-fast", "ember-1", "muse-spark-open", "qwen3.8-max", "qwen3.8-2.4t-a95b", "minimax-m3",
] as const;
const TEXT_ONLY: readonly string[] = ["glm-5.3", "glm-5.3-fast"];

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache("abliteratedllm");
});

function entry() {
  const row = PROVIDER_REGISTRY.find(candidate => candidate.id === "abliteratedllm");
  if (!row) throw new Error("missing AbliteratedLLM preset");
  return row;
}

function config(overrides: Partial<OcxProviderConfig> = {}): OcxConfig {
  return withStubbedProviderFetch({
    port: 10100,
    defaultProvider: "abliteratedllm",
    providers: { abliteratedllm: { ...providerConfigSeed(entry()), apiKey: "test-key", ...overrides } },
  });
}

describe("AbliteratedLLM provider", () => {
  test("is offered by ocx provider add, ocx init and the dashboard picker", () => {
    expect(deriveInitProviders().find(row => row.id === "abliteratedllm")).toMatchObject({
      label: "AbliteratedLLM", kind: "key", adapter: "openai-chat", baseUrl,
    });
    const preset = deriveProviderPresets().find(row => row.id === "abliteratedllm");
    expect(preset).toMatchObject({ auth: "key", dashboardUrl: "https://abliteratedllm.dev/dashboard/keys" });
    expect(preset?.sponsor).toBeUndefined();
    expect(KEY_LOGIN_PROVIDERS.abliteratedllm?.defaultModel).toBe("glm-5.3-flash-abliterated");
  });

  test("seeds the catalog models with their windows, and only glm-5.3 and glm-5.3-fast as text-only", () => {
    const seeded = config().providers.abliteratedllm!;
    expect(seeded).toMatchObject({ adapter: "openai-chat", baseUrl, defaultModel: "glm-5.3-flash-abliterated", liveModels: true });
    expect(entry().models).toEqual([...MODELS]);
    expect(seeded.modelContextWindows).toEqual({
      ...Object.fromEntries(MODELS.map(model => [model, 1_048_576])),
      "qwen3.8-max": 262_144, "qwen3.8-2.4t-a95b": 262_144, "minimax-m3": 512_000,
    });
    expect(seeded.modelMaxOutputTokens).toEqual({ "glm-5.3-flash-abliterated": 131_072 });
    for (const model of MODELS) {
      expect(isModelVisionSidecarConsumer(seeded, model), model).toBe(TEXT_ONLY.includes(model));
    }
  });

  test.each(MODELS)("%s routes over Chat with its upstream id unchanged", model => {
    const route = routeModel(config(), `abliteratedllm/${model}`);
    expect(route.modelId).toBe(model);
    expect(route.provider).toMatchObject({ adapter: "openai-chat", baseUrl });
    for (const inbound of ["responses", "chat", "anthropic"] as const) {
      expect(resolveWireProtocolOverride("abliteratedllm", model, config().providers.abliteratedllm!, inbound).adapter)
        .toBe("openai-chat");
    }
  });

  test("sends reasoning_effort only as low, medium or high", () => {
    const provider = config().providers.abliteratedllm!;
    const effort = (reasoning: string | undefined): unknown => {
      const parsed: OcxParsedRequest = {
        modelId: "glm-5.3-flash-abliterated",
        context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
        stream: false,
        options: reasoning === undefined ? {} : { reasoning },
      };
      return JSON.parse(createOpenAIChatAdapter(provider).buildRequest(parsed).body as string).reasoning_effort;
    };
    expect(effort("low")).toBe("low");
    expect(effort("medium")).toBe("medium");
    expect(effort("high")).toBe("high");
    // The documented values are low, medium and high, so higher Codex levels clamp to high.
    expect(effort("xhigh")).toBe("high");
    expect(effort("max")).toBe("high");
    expect(effort("minimal")).toBe("low");
    expect(effort("none")).toBeUndefined();
    expect(effort(undefined)).toBeUndefined();
  });

  test("keeps a same-named custom destination instead of retargeting it", () => {
    const custom = config({ baseUrl: "https://relay.example.test/v1" });
    expect(routeModel(custom, "abliteratedllm/custom-model").provider.baseUrl).toBe("https://relay.example.test/v1");
  });

  test("lists models from the public live catalog", async () => {
    let requests = 0;
    globalThis.fetch = (async (input, init) => {
      requests++;
      expect(String(input)).toBe("https://api.abliteratedllm.dev/v1/models");
      expect(init?.body ?? undefined).toBeUndefined();
      return Response.json({ object: "list", data: [
        {
          id: "glm-5.3-flash-abliterated", object: "model", created: 1793664000, owned_by: "AbliteratedLLM",
          name: "GLM-5.3 Flash Abliterated", context_length: 1048576, max_output_tokens: 131072,
          pricing: { input: "0.0977", output: "0.3421", cached_input: "0.0098", priority: null },
          input_modalities: ["text", "image"],
        },
        {
          id: "glm-5.3", object: "model", created: 1793664000, owned_by: "AbliteratedLLM",
          name: "GLM-5.3", context_length: 1048576, max_output_tokens: 1048576,
          pricing: { input: "1.26", output: "3.96", cached_input: "0.234", priority: null },
          input_modalities: ["text"],
        },
      ] });
    }) as typeof fetch;
    const models = (await gatherRoutedModels(config())).filter(row => row.provider === "abliteratedllm");
    expect(requests).toBe(1);
    expect(models.map(row => row.id).sort()).toEqual(["glm-5.3", "glm-5.3-flash-abliterated"]);
  });

  test("reports a key as unverified instead of probing the public catalog", async () => {
    expect(KEY_LOGIN_PROVIDERS.abliteratedllm?.apiKeyValidation).toBe("unknown");
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return Response.json({ object: "list", data: [] });
    }) as unknown as typeof fetch;
    expect(await validateApiKey("abliteratedllm", KEY_LOGIN_PROVIDERS.abliteratedllm!, "test-key")).toBe("unknown");
    expect(calls).toBe(0);
  });
});
