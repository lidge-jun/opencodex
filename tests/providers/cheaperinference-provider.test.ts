import { afterEach, describe, expect, test } from "bun:test";
import { gatherRoutedModels } from "../../src/codex/catalog";
import { clearModelCache } from "../../src/codex/model-cache";
import { buildModelsRequest } from "../../src/oauth";
import { KEY_LOGIN_PROVIDERS, validateApiKey } from "../../src/oauth/key-providers";
import { deriveInitProviders, deriveProviderPresets, providerConfigSeed } from "../../src/providers/derive";
import { extractProviderModelItems, resolveProviderModelDiscovery } from "../../src/providers/model-discovery";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { routeModel } from "../../src/router";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { withStubbedProviderFetch } from "../helpers/catalog-provider-fetch";

const originalFetch = globalThis.fetch;
const baseUrl = "https://api.cheaperinference.com/v1";

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache("cheaperinference");
});

function config(overrides: Partial<OcxProviderConfig> = {}): OcxConfig {
  const entry = PROVIDER_REGISTRY.find(row => row.id === "cheaperinference");
  if (!entry) throw new Error("missing Cheaper Inference preset");
  return withStubbedProviderFetch({
    port: 10100,
    defaultProvider: "cheaperinference",
    providers: { cheaperinference: { ...providerConfigSeed(entry), apiKey: "test-key", ...overrides } },
  });
}

describe("Cheaper Inference provider", () => {
  test("is available through ordinary dashboard, init and key-login entry points", () => {
    expect(deriveInitProviders().find(row => row.id === "cheaperinference")).toMatchObject({
      label: "Cheaper Inference", kind: "key", adapter: "openai-chat", baseUrl,
    });
    const preset = deriveProviderPresets().find(row => row.id === "cheaperinference");
    expect(preset).toMatchObject({ auth: "key", dashboardUrl: "https://cheaperinference.com/signup" });
    expect(preset?.sponsor).toBeUndefined();
    expect(KEY_LOGIN_PROVIDERS.cheaperinference?.defaultModel).toBe("gpt-5.4-mini");
    const provider = config().providers.cheaperinference!;
    expect(provider).not.toHaveProperty("modelDiscovery");
    expect(provider).not.toHaveProperty("preserveCustomDestination");
  });

  test("routes a selected model without rewriting its upstream identity", () => {
    const route = routeModel(config(), "cheaperinference/gpt-5.4-mini");
    expect(route.modelId).toBe("gpt-5.4-mini");
    expect(route.provider).toMatchObject({ adapter: "openai-chat", baseUrl });
  });

  test("discovers with the key and preserves renamed and custom destinations", () => {
    const provider = config().providers.cheaperinference!;
    for (const name of ["cheaperinference", "my-cheaperinference-key"]) {
      const request = buildModelsRequest(provider, "test-key", name);
      expect(request.url).toBe("https://api.cheaperinference.com/v1/models");
      expect(request.headers.Authorization).toBe("Bearer test-key");
    }
    const custom = config({ baseUrl: "https://gateway.example.test/v1" });
    expect(routeModel(custom, "cheaperinference/custom-model").provider.baseUrl)
      .toBe("https://gateway.example.test/v1");
    expect(buildModelsRequest(custom.providers.cheaperinference!, "custom-key", "cheaperinference").url)
      .toBe("https://gateway.example.test/v1/models");
    expect(resolveProviderModelDiscovery("cheaperinference", custom.providers.cheaperinference!).spec).toBeUndefined();
  });

  test("admits only text rows from a mixed catalog", () => {
    const discovery = resolveProviderModelDiscovery("cheaperinference", config().providers.cheaperinference!);
    // Cheaper Inference model-list shape. These are independent contract examples, not registry data.
    const result = extractProviderModelItems({ data: [
      { id: "gpt-5.4-mini", type: "text" },
      { id: "claude-sonnet-5", type: "text" },
      { id: "image-model", type: "image" },
      { id: "video-model", type: "video" },
      { id: "untyped" },
    ] }, discovery);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.items.map(row => row.id)).toEqual(["gpt-5.4-mini", "claude-sonnet-5"]);
  });

  test("uses the authenticated live catalog", async () => {
    let requests = 0;
    globalThis.fetch = (async (input, init) => {
      requests++;
      expect(String(input)).toBe("https://api.cheaperinference.com/v1/models");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
      expect(init?.redirect).toBe("manual");
      return Response.json({ data: [
        { id: "deepseek-v4-flash", type: "text" },
        { id: "image-model", type: "image" },
      ] });
    }) as typeof fetch;
    const models = (await gatherRoutedModels(config())).filter(row => row.provider === "cheaperinference");
    expect(requests).toBe(1);
    expect(models.map(row => row.id)).toEqual(["deepseek-v4-flash"]);
  });

  test("validates a supplied key through discovery and distinguishes rejection from an outage", async () => {
    for (const [status, expected] of [[200, true], [401, false], [503, "unknown"]] as const) {
      globalThis.fetch = (async (input, init) => {
        expect(String(input)).toBe("https://api.cheaperinference.com/v1/models");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
        expect(init?.redirect).toBe("error");
        return new Response(null, { status });
      }) as typeof fetch;
      expect(await validateApiKey("cheaperinference", KEY_LOGIN_PROVIDERS.cheaperinference!, "test-key")).toBe(expected);
    }
  });
});
