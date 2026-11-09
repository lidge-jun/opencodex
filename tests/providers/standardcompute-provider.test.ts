import { afterEach, describe, expect, test } from "bun:test";
import { gatherRoutedModels } from "../../src/codex/catalog";
import { clearModelCache } from "../../src/codex/model-cache";
import { buildModelsRequest } from "../../src/oauth";
import { KEY_LOGIN_PROVIDERS, validateApiKey } from "../../src/oauth/key-providers";
import { deriveInitProviders, deriveProviderPresets, providerConfigSeed } from "../../src/providers/derive";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { routeModel } from "../../src/router";
import { resolveWireProtocolOverride } from "../../src/server/adapter-resolve";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { isModelVisionSidecarConsumer } from "../../src/vision/eligibility";
import { withStubbedProviderFetch } from "../helpers/catalog-provider-fetch";

const originalFetch = globalThis.fetch;
const baseUrl = "https://api.stdcmpt.com/v1";
// The seeded ids from the public GET /v1/models on 2026-11-09: the routed id plus four pinned models.
const MODELS = [
  "StandardCompute",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
  "z-ai/glm-5.3",
  "moonshotai/kimi-k3",
] as const;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache("standardcompute");
});

function entry() {
  const row = PROVIDER_REGISTRY.find(candidate => candidate.id === "standardcompute");
  if (!row) throw new Error("missing standardcompute preset");
  return row;
}

function config(overrides: Partial<OcxProviderConfig> = {}): OcxConfig {
  return withStubbedProviderFetch({
    port: 10100,
    defaultProvider: "standardcompute",
    providers: { standardcompute: { ...providerConfigSeed(entry()), apiKey: "test-key", ...overrides } },
  });
}

describe("standardcompute provider", () => {
  test("is offered by ocx provider add, ocx init and the dashboard picker", () => {
    expect(deriveInitProviders().find(row => row.id === "standardcompute")).toMatchObject({
      label: "Standard Compute", kind: "key", adapter: "openai-chat", baseUrl,
    });
    const preset = deriveProviderPresets().find(row => row.id === "standardcompute");
    expect(preset).toMatchObject({ auth: "key", dashboardUrl: "https://standardcompute.com/dashboard" });
    expect(preset?.sponsor).toBeUndefined();
    expect(KEY_LOGIN_PROVIDERS.standardcompute?.defaultModel).toBe("StandardCompute");
    expect(KEY_LOGIN_PROVIDERS.standardcompute).toMatchObject({ apiKeyValidation: "unknown" });
  });

  test("seeds the catalog models with their windows, and only kimi-k3 and the routed id read images", () => {
    const seeded = config().providers.standardcompute!;
    expect(seeded).toMatchObject({ adapter: "openai-chat", baseUrl, defaultModel: "StandardCompute", liveModels: true });
    expect(entry().models).toEqual([...MODELS]);
    expect(seeded.modelContextWindows).toEqual({
      StandardCompute: 1_000_000, "deepseek/deepseek-v4-pro": 1_048_576, "deepseek/deepseek-v4-flash": 1_048_576,
      "z-ai/glm-5.3": 1_048_576, "moonshotai/kimi-k3": 1_048_576,
    });
    for (const model of MODELS) {
      expect(isModelVisionSidecarConsumer(seeded, model)).toBe(model !== "moonshotai/kimi-k3" && model !== "StandardCompute");
    }
  });

  test.each(MODELS)("%s routes over Chat with its upstream id unchanged", model => {
    const route = routeModel(config(), `standardcompute/${model}`);
    expect(route.modelId).toBe(model);
    expect(route.provider).toMatchObject({ adapter: "openai-chat", baseUrl });
    for (const inbound of ["responses", "chat", "anthropic"] as const) {
      expect(resolveWireProtocolOverride("standardcompute", model, config().providers.standardcompute!, inbound).adapter)
        .toBe("openai-chat");
    }
  });

  test("keeps a same-named custom destination instead of retargeting it", () => {
    const custom = config({ baseUrl: "https://us.stdcmpt.com/v1" });
    expect(routeModel(custom, "standardcompute/StandardCompute").provider.baseUrl).toBe("https://us.stdcmpt.com/v1");
  });

  test("lists models from the live catalog", async () => {
    let requests = 0;
    globalThis.fetch = (async (input, init) => {
      requests++;
      expect(String(input)).toBe("https://api.stdcmpt.com/v1/models");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
      expect(init?.body ?? undefined).toBeUndefined();
      return Response.json({ object: "list", data: [
        { id: "StandardCompute", object: "model", created: 0, owned_by: "StandardCompute" },
        { id: "deepseek/deepseek-v4-pro", object: "model", created: 0, owned_by: "StandardCompute" },
      ] });
    }) as typeof fetch;
    const models = (await gatherRoutedModels(config())).filter(row => row.provider === "standardcompute");
    expect(requests).toBe(1);
    expect(models.map(row => row.id).sort()).toEqual(["StandardCompute", "deepseek/deepseek-v4-pro"]);
  });

  test("reports key validation as unknown because the model list is public", async () => {
    expect(buildModelsRequest(config().providers.standardcompute!, "test-key", "standardcompute").url)
      .toBe("https://api.stdcmpt.com/v1/models");
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      return Response.json({ object: "list", data: [] });
    }) as typeof fetch;
    expect(await validateApiKey("standardcompute", KEY_LOGIN_PROVIDERS.standardcompute!, "test-key")).toBe("unknown");
    expect(requests).toBe(0);
  });
});
