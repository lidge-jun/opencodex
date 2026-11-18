import { afterEach, describe, expect, test } from "bun:test";
import { gatherRoutedModels } from "../../src/codex/catalog";
import { clearModelCache } from "../../src/codex/model-cache";
import { buildModelsRequest } from "../../src/oauth";
import { KEY_LOGIN_PROVIDERS, validateApiKey } from "../../src/oauth/key-providers";
import { deriveInitProviders, deriveProviderPresets, providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { routeModel } from "../../src/router";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { withStubbedProviderFetch } from "../helpers/catalog-provider-fetch";

const originalFetch = globalThis.fetch;
const baseUrl = "https://amr-link.open-design.ai/v1";

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache("opendesign-go");
});

function config(overrides: Partial<OcxProviderConfig> = {}): OcxConfig {
  const entry = getProviderRegistryEntry("opendesign-go");
  if (!entry) throw new Error("missing OpenDesign Go preset");
  return withStubbedProviderFetch({
    port: 10100,
    defaultProvider: "opendesign-go",
    providers: { "opendesign-go": { ...providerConfigSeed(entry), apiKey: "test-key", ...overrides } },
  });
}

describe("OpenDesign Go provider", () => {
  test("appears in the dashboard, init and key-login surfaces through the registry", () => {
    expect(deriveInitProviders().find(row => row.id === "opendesign-go")).toMatchObject({
      label: "OpenDesign Go", kind: "key", adapter: "openai-chat", baseUrl,
    });
    expect(deriveProviderPresets().find(row => row.id === "opendesign-go")).toMatchObject({
      auth: "key", dashboardUrl: "https://go.open-design.ai/", defaultModel: "deepseek-v4.1-flash",
    });
    expect(KEY_LOGIN_PROVIDERS["opendesign-go"]?.baseUrl).toBe(baseUrl);
  });

  test("keeps upstream model ids intact and preserves older custom destinations", () => {
    const route = routeModel(config(), "opendesign-go/deepseek-v4.1-flash");
    expect(route.modelId).toBe("deepseek-v4.1-flash");
    expect(route.provider).toMatchObject({ adapter: "openai-chat", baseUrl, reasoningEfforts: [] });
    const custom = config({ baseUrl: "https://gateway.example.test/v1" });
    expect(routeModel(custom, "opendesign-go/custom-model").provider.baseUrl)
      .toBe("https://gateway.example.test/v1");
    expect(buildModelsRequest(custom.providers["opendesign-go"]!, "test-key", "opendesign-go").url)
      .toBe("https://gateway.example.test/v1/models");
  });

  test("discovers workspace models without restoring a default absent from the key's catalog", async () => {
    let requests = 0;
    globalThis.fetch = (async (input, init) => {
      requests++;
      expect(String(input)).toBe(`${baseUrl}/models`);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
      expect(init?.redirect).toBe("manual");
      return Response.json({ object: "list", data: [{ id: "mimo-v2.6-flash", object: "model" }] });
    }) as typeof fetch;
    const models = (await gatherRoutedModels(config())).filter(row => row.provider === "opendesign-go");
    expect(requests).toBe(1);
    expect(models.map(row => row.id)).toEqual(["mimo-v2.6-flash"]);
  });

  test("validates keys using authenticated discovery and distinguishes outage from rejection", async () => {
    for (const [status, expected] of [[200, true], [401, false], [503, "unknown"]] as const) {
      globalThis.fetch = (async (input, init) => {
        expect(String(input)).toBe(`${baseUrl}/models`);
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
        expect(init?.redirect).toBe("error");
        return new Response(null, { status });
      }) as typeof fetch;
      expect(await validateApiKey("opendesign-go", KEY_LOGIN_PROVIDERS["opendesign-go"]!, "test-key"))
        .toBe(expected);
    }
  });
});
