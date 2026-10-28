import { afterEach, describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import { gatherRoutedModels } from "../../src/codex/catalog";
import { clearModelCache } from "../../src/codex/model-cache";
import { buildModelsRequest } from "../../src/oauth";
import { KEY_LOGIN_PROVIDERS, validateApiKey } from "../../src/oauth/key-providers";
import { deriveInitProviders, deriveProviderPresets, providerConfigSeed } from "../../src/providers/derive";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { routeModel } from "../../src/router";
import { resolveWireProtocolOverride } from "../../src/server/adapter-resolve";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { isModelVisionSidecarConsumer } from "../../src/vision/eligibility";
import { withStubbedProviderFetch } from "../helpers/catalog-provider-fetch";

const originalFetch = globalThis.fetch;
const baseUrl = "https://api.cheapaimodel.ai/v1";
// The chat models the authenticated GET /v1/models listed on 2026-10-28.
const MODELS = ["deepseek-v4-1-flash", "glm-5.3", "glm-5.3-flash", "kimi-k3", "grok-4.7"] as const;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache("cheapaimodel");
});

function entry() {
  const row = PROVIDER_REGISTRY.find(candidate => candidate.id === "cheapaimodel");
  if (!row) throw new Error("missing cheapaimodel preset");
  return row;
}

function config(overrides: Partial<OcxProviderConfig> = {}): OcxConfig {
  return withStubbedProviderFetch({
    port: 10100,
    defaultProvider: "cheapaimodel",
    providers: { cheapaimodel: { ...providerConfigSeed(entry()), apiKey: "test-key", ...overrides } },
  });
}

describe("cheapaimodel provider", () => {
  test("is offered by ocx provider add, ocx init and the dashboard picker", () => {
    expect(deriveInitProviders().find(row => row.id === "cheapaimodel")).toMatchObject({
      label: "cheapaimodel", kind: "key", adapter: "openai-chat", baseUrl,
    });
    const preset = deriveProviderPresets().find(row => row.id === "cheapaimodel");
    expect(preset).toMatchObject({ auth: "key", dashboardUrl: "https://console.cheapaimodel.ai/keys" });
    expect(preset?.sponsor).toBeUndefined();
    expect(KEY_LOGIN_PROVIDERS.cheapaimodel?.defaultModel).toBe("deepseek-v4-1-flash");
  });

  test("seeds the catalog models with their windows, and only glm-5.3 as text-only", () => {
    const seeded = config().providers.cheapaimodel!;
    expect(seeded).toMatchObject({ adapter: "openai-chat", baseUrl, defaultModel: "deepseek-v4-1-flash", liveModels: true });
    expect(entry().models).toEqual([...MODELS]);
    expect(seeded.modelContextWindows).toEqual({
      "deepseek-v4-1-flash": 1_000_000, "glm-5.3": 1_000_000, "glm-5.3-flash": 1_000_000, "kimi-k3": 1_000_000, "grok-4.7": 500_000,
    });
    for (const model of MODELS) {
      expect(isModelVisionSidecarConsumer(seeded, model)).toBe(model === "glm-5.3");
    }
  });

  test.each(MODELS)("%s routes over Chat with its upstream id unchanged", model => {
    const route = routeModel(config(), `cheapaimodel/${model}`);
    expect(route.modelId).toBe(model);
    expect(route.provider).toMatchObject({ adapter: "openai-chat", baseUrl });
    for (const inbound of ["responses", "chat", "anthropic"] as const) {
      expect(resolveWireProtocolOverride("cheapaimodel", model, config().providers.cheapaimodel!, inbound).adapter)
        .toBe("openai-chat");
    }
  });

  test("drops temperature and top_p for kimi-k3 only", () => {
    const provider = config().providers.cheapaimodel!;
    const wire = (modelId: string): Record<string, unknown> => {
      const parsed: OcxParsedRequest = {
        modelId,
        context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
        stream: false,
        options: { temperature: 0.5, topP: 0.9 },
      };
      return JSON.parse(createOpenAIChatAdapter(provider).buildRequest(parsed).body as string);
    };
    expect(wire("kimi-k3")).not.toHaveProperty("temperature");
    expect(wire("kimi-k3")).not.toHaveProperty("top_p");
    expect(wire("deepseek-v4-1-flash")).toMatchObject({ temperature: 0.5, top_p: 0.9 });
  });

  test("keeps a same-named custom destination instead of retargeting it", () => {
    const custom = config({ baseUrl: "https://relay.example.test/v1" });
    expect(routeModel(custom, "cheapaimodel/custom-model").provider.baseUrl).toBe("https://relay.example.test/v1");
  });

  test("lists models from the authenticated live catalog", async () => {
    let requests = 0;
    globalThis.fetch = (async (input, init) => {
      requests++;
      expect(String(input)).toBe("https://api.cheapaimodel.ai/v1/models");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
      expect(init?.body ?? undefined).toBeUndefined();
      return Response.json({ object: "list", data: [
        { id: "deepseek-v4-1-flash", object: "model", created: 1626777600, owned_by: "custom" },
        { id: "kimi-k3", object: "model", created: 1626777600, owned_by: "custom" },
      ] });
    }) as typeof fetch;
    const models = (await gatherRoutedModels(config())).filter(row => row.provider === "cheapaimodel");
    expect(requests).toBe(1);
    expect(models.map(row => row.id).sort()).toEqual(["deepseek-v4-1-flash", "kimi-k3"]);
  });

  test("validates a key against the key-gated model list and separates rejection from an outage", async () => {
    expect(buildModelsRequest(config().providers.cheapaimodel!, "test-key", "cheapaimodel").url)
      .toBe("https://api.cheapaimodel.ai/v1/models");
    for (const [status, expected] of [[200, true], [401, false], [503, "unknown"]] as const) {
      globalThis.fetch = (async (input, init) => {
        expect(String(input)).toBe("https://api.cheapaimodel.ai/v1/models");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
        return new Response(status === 200 ? JSON.stringify({ object: "list", data: [] }) : null, { status });
      }) as typeof fetch;
      expect(await validateApiKey("cheapaimodel", KEY_LOGIN_PROVIDERS.cheapaimodel!, "test-key")).toBe(expected);
    }
  });
});
