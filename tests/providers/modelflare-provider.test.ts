import { afterEach, describe, expect, test } from "bun:test";
import { buildModelsRequest } from "../../src/oauth";
import { KEY_LOGIN_PROVIDERS, validateApiKey } from "../../src/oauth/key-providers";
import { deriveInitProviders, deriveProviderPresets, providerConfigSeed } from "../../src/providers/derive";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { routeModel } from "../../src/router";
import { resolveWireProtocolOverride } from "../../src/server/adapter-resolve";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

const originalFetch = globalThis.fetch;
const baseUrl = "https://modelflare.dev/v1";
const VERIFIED_MODELS = ["glm-5.3-flash", "claude-sonnet-5-5", "gpt-6.1-sol", "deepseek-v4-flash"] as const;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function entry() {
  const row = PROVIDER_REGISTRY.find(candidate => candidate.id === "modelflare");
  if (!row) throw new Error("missing Modelflare preset");
  return row;
}

function config(overrides: Partial<OcxProviderConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "modelflare",
    providers: { modelflare: { ...providerConfigSeed(entry()), apiKey: "test-key", ...overrides } },
  };
}

describe("Modelflare provider", () => {
  test("is offered by ocx provider add, ocx init and the dashboard picker", () => {
    expect(deriveInitProviders().find(row => row.id === "modelflare")).toMatchObject({
      label: "Modelflare", kind: "key", adapter: "openai-chat", baseUrl,
    });
    const preset = deriveProviderPresets().find(row => row.id === "modelflare");
    expect(preset).toMatchObject({ auth: "key", dashboardUrl: "https://modelflare.dev" });
    expect(preset?.sponsor).toBeUndefined();
    expect(KEY_LOGIN_PROVIDERS.modelflare?.defaultModel).toBe("glm-5.3-flash");
  });

  test("seeds only the verified chat models and leaves the 503-only DeepSeek V4.1 Flash out", () => {
    const seeded = config().providers.modelflare!;
    expect(seeded).toMatchObject({ adapter: "openai-chat", baseUrl, defaultModel: "glm-5.3-flash" });
    expect(entry().models).toEqual([...VERIFIED_MODELS]);
    expect(entry().models).not.toContain("deepseek-v4.1-flash");
    expect(seeded.liveModels).not.toBe(true);
  });

  test.each(VERIFIED_MODELS)("%s routes over Chat with its upstream id unchanged", model => {
    const route = routeModel(config(), `modelflare/${model}`);
    expect(route.modelId).toBe(model);
    expect(route.provider).toMatchObject({ adapter: "openai-chat", baseUrl });
    for (const inbound of ["responses", "chat", "anthropic"] as const) {
      expect(resolveWireProtocolOverride("modelflare", model, config().providers.modelflare!, inbound).adapter)
        .toBe("openai-chat");
    }
  });

  test("keeps a same-named custom destination instead of retargeting it", () => {
    const custom = config({ baseUrl: "https://relay.example.test/v1" });
    expect(routeModel(custom, "modelflare/custom-model").provider.baseUrl).toBe("https://relay.example.test/v1");
  });

  test("validates a key against the key-gated model list and separates rejection from an outage", async () => {
    expect(buildModelsRequest(config().providers.modelflare!, "test-key", "modelflare").url)
      .toBe("https://modelflare.dev/v1/models");
    for (const [status, expected] of [[200, true], [401, false], [503, "unknown"]] as const) {
      globalThis.fetch = (async (input, init) => {
        expect(String(input)).toBe("https://modelflare.dev/v1/models");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
        return new Response(status === 200 ? JSON.stringify({ object: "list", data: [] }) : null, { status });
      }) as typeof fetch;
      expect(await validateApiKey("modelflare", KEY_LOGIN_PROVIDERS.modelflare!, "test-key")).toBe(expected);
    }
  });
});
