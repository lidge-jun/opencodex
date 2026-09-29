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
const baseUrl = "https://api.tokenlab.sh/v1";

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache("tokenlab");
});

function config(overrides: Partial<OcxProviderConfig> = {}): OcxConfig {
  const entry = PROVIDER_REGISTRY.find(row => row.id === "tokenlab");
  if (!entry) throw new Error("missing TokenLab preset");
  return withStubbedProviderFetch({
    port: 10100,
    defaultProvider: "tokenlab",
    providers: { tokenlab: { ...providerConfigSeed(entry), apiKey: "test-key", ...overrides } },
  });
}

describe("TokenLab provider", () => {
  test("is available through ordinary dashboard, init and key-login entry points", () => {
    expect(deriveInitProviders().find(row => row.id === "tokenlab")).toMatchObject({
      label: "TokenLab", kind: "key", adapter: "openai-chat", baseUrl,
    });
    const preset = deriveProviderPresets().find(row => row.id === "tokenlab");
    expect(preset).toMatchObject({ auth: "key", dashboardUrl: "https://tokenlab.sh/dashboard/api?tab=keys" });
    expect(preset?.sponsor).toBeUndefined();
    expect(KEY_LOGIN_PROVIDERS.tokenlab?.defaultModel).toBe("gpt-5.6-terra");
    const provider = config().providers.tokenlab!;
    expect(provider).not.toHaveProperty("modelDiscovery");
    expect(provider).not.toHaveProperty("preserveCustomDestination");
  });

  test("routes a selected model without rewriting its upstream identity", () => {
    const route = routeModel(config(), "tokenlab/gpt-5.6-terra");
    expect(route.modelId).toBe("gpt-5.6-terra");
    expect(route.provider).toMatchObject({ adapter: "openai-chat", baseUrl });
  });

  test("scopes discovery to chat and preserves renamed and custom destinations", () => {
    const provider = config().providers.tokenlab!;
    for (const name of ["tokenlab", "my-tokenlab-workspace"]) {
      const request = buildModelsRequest(provider, "test-key", name);
      expect(request.url).toBe("https://api.tokenlab.sh/v1/models?category=chat");
      expect(request.headers.Authorization).toBe("Bearer test-key");
    }
    const custom = config({ baseUrl: "https://gateway.example.test/v1" });
    expect(routeModel(custom, "tokenlab/custom-model").provider.baseUrl)
      .toBe("https://gateway.example.test/v1");
    expect(buildModelsRequest(custom.providers.tokenlab!, "custom-key", "tokenlab").url)
      .toBe("https://gateway.example.test/v1/models");
    expect(resolveProviderModelDiscovery("tokenlab", custom.providers.tokenlab!).spec).toBeUndefined();
  });

  test("admits only explicit tool-capable chat rows from a mixed catalog", () => {
    const discovery = resolveProviderModelDiscovery("tokenlab", config().providers.tokenlab!);
    // Public TokenLab model-list shape. These are independent contract examples, not registry data.
    const result = extractProviderModelItems({ object: "list", data: [
      { id: "eligible-chat", tokenlab: { category: "chat", capabilities: ["vision", "tool-use"] } },
      { id: "plain-chat", tokenlab: { category: "chat", capabilities: [] } },
      { id: "gpt-image-2", tokenlab: { category: "image", capabilities: ["tool-use"] } },
      { id: "video-model", tokenlab: { category: "video", capabilities: ["tool-use"] } },
      { id: "embedding-model", tokenlab: { category: "embedding", capabilities: [] } },
      { id: "jev-1.13", tokenlab: { category: "decision", capabilities: ["tool-use"] } },
      { id: "missing-capabilities", tokenlab: { category: "chat" } },
      { id: "missing-category", tokenlab: { capabilities: ["tool-use"] } },
      { id: "unclassified" },
    ] }, discovery);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.items.map(row => row.id)).toEqual(["eligible-chat"]);
  });

  test("uses the authenticated live catalog without resurrecting an unavailable seeded model", async () => {
    let requests = 0;
    globalThis.fetch = (async (input, init) => {
      requests++;
      expect(String(input)).toBe("https://api.tokenlab.sh/v1/models?category=chat");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
      expect(init?.redirect).toBe("manual");
      return Response.json({ object: "list", data: [
        { id: "claude-sonnet-4-6", tokenlab: { category: "chat", capabilities: ["tool-use"] } },
        { id: "image-model", tokenlab: { category: "image", capabilities: [] } },
      ] });
    }) as typeof fetch;
    const models = (await gatherRoutedModels(config())).filter(row => row.provider === "tokenlab");
    expect(requests).toBe(1);
    expect(models.map(row => row.id)).toEqual(["claude-sonnet-4-6"]);
  });

  test("validates a supplied key through discovery and distinguishes rejection from an outage", async () => {
    for (const [status, expected] of [[200, true], [401, false], [503, "unknown"]] as const) {
      globalThis.fetch = (async (input, init) => {
        expect(String(input)).toBe("https://api.tokenlab.sh/v1/models?category=chat");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
        expect(init?.redirect).toBe("error");
        return new Response(null, { status });
      }) as typeof fetch;
      expect(await validateApiKey("tokenlab", KEY_LOGIN_PROVIDERS.tokenlab!, "test-key")).toBe(expected);
    }
  });
});
