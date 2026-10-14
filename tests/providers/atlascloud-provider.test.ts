import { afterEach, describe, expect, test } from "bun:test";
import { buildModelsRequest } from "../../src/oauth";
import { KEY_LOGIN_PROVIDERS, validateApiKey } from "../../src/oauth/key-providers";
import { deriveInitProviders, deriveProviderPresets, providerConfigSeed } from "../../src/providers/derive";
import { extractProviderModelItems, resolveProviderModelDiscovery } from "../../src/providers/model-discovery";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { routeModel } from "../../src/router";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

const originalFetch = globalThis.fetch;
const baseUrl = "https://api.atlascloud.ai/v1";

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function entry() {
  const row = PROVIDER_REGISTRY.find(candidate => candidate.id === "atlascloud");
  if (!row) throw new Error("missing Atlas Cloud preset");
  return row;
}

function config(overrides: Partial<OcxProviderConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "atlascloud",
    providers: { atlascloud: { ...providerConfigSeed(entry()), apiKey: "test-key", ...overrides } },
  };
}

describe("Atlas Cloud provider", () => {
  test("is offered by ocx provider add, ocx init and the dashboard picker", () => {
    expect(deriveInitProviders().find(row => row.id === "atlascloud")).toMatchObject({
      label: "Atlas Cloud", kind: "key", adapter: "openai-chat", baseUrl,
    });
    const preset = deriveProviderPresets().find(row => row.id === "atlascloud");
    expect(preset).toMatchObject({ auth: "key", dashboardUrl: "https://console.atlascloud.ai/api-keys" });
    expect(preset?.sponsor).toBeUndefined();
    expect(KEY_LOGIN_PROVIDERS.atlascloud?.defaultModel).toBe("deepseek-ai/deepseek-v4-flash");
  });

  test.each(entry().models)("%s routes over Chat with its vendor-prefixed upstream id unchanged", model => {
    const route = routeModel(config(), `atlascloud/${model}`);
    expect(route.modelId).toBe(model);
    expect(route.provider).toMatchObject({ adapter: "openai-chat", baseUrl });
  });

  test("keeps a same-named custom destination instead of retargeting it", () => {
    const custom = config({ baseUrl: "https://relay.example.test/v1" });
    expect(routeModel(custom, "atlascloud/custom/model").provider.baseUrl).toBe("https://relay.example.test/v1");
  });

  test("discovers ids from the public OpenAI-style catalog envelope", () => {
    const discovery = resolveProviderModelDiscovery("atlascloud", config().providers.atlascloud!);
    const result = extractProviderModelItems({ code: 200, msg: "succeed", data: [
      { id: "deepseek-ai/deepseek-v4-flash", object: "model" },
      { id: "zai-org/glm-5.3", object: "model" },
    ] }, discovery);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.items.map(row => row.id)).toEqual(["deepseek-ai/deepseek-v4-flash", "zai-org/glm-5.3"]);
  });

  test("validates a key through the model list and separates rejection from an outage", async () => {
    expect(buildModelsRequest(config().providers.atlascloud!, "test-key", "atlascloud").url)
      .toBe(`${baseUrl}/models`);
    for (const [status, expected] of [[200, true], [401, false], [503, "unknown"]] as const) {
      globalThis.fetch = (async (input, init) => {
        expect(String(input)).toBe(`${baseUrl}/models`);
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
        return new Response(status === 200 ? JSON.stringify({ data: [] }) : null, { status });
      }) as typeof fetch;
      expect(await validateApiKey("atlascloud", KEY_LOGIN_PROVIDERS.atlascloud!, "test-key")).toBe(expected);
    }
  });
});
