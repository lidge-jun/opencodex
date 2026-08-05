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
import { PROVIDER_REGISTRY, type ProviderRegistryEntry } from "../src/providers/registry";
import { routeModel } from "../src/router";
import type { OcxConfig, OcxProviderConfig } from "../src/types";
import { formatProviderDisplayName, isCatalogProviderId } from "../gui/src/provider-icons";
import type { TFn } from "../gui/src/i18n/shared";
import { withStubbedProviderFetch } from "./helpers/catalog-provider-fetch";

const FIXTURE = readFileSync(join(import.meta.dir, "fixtures/apertis-models.json"), "utf8");
const BASE_URL = "https://api.apertis.ai/v1";
const API_KEY = "apertis-test-key";
const identityT: TFn = key => key;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache("apertis");
});

function registryEntry(): ProviderRegistryEntry {
  const entry = PROVIDER_REGISTRY.find(row => row.id === "apertis");
  if (!entry) throw new Error("missing apertis registry entry");
  return entry;
}

function providerConfig(overrides: Partial<OcxProviderConfig> = {}): OcxConfig {
  return withStubbedProviderFetch({
    port: 10100,
    defaultProvider: "apertis",
    providers: {
      apertis: {
        adapter: "openai-chat",
        baseUrl: BASE_URL,
        authMode: "key",
        apiKey: API_KEY,
        liveModels: true,
        // Discovery is fixture-only; this avoids platform-specific public-DNS classification.
        allowPrivateNetwork: true,
        ...overrides,
      },
    },
  });
}

describe("Apertis provider", () => {
  test("registers a fixed OpenAI transport with live discovery", () => {
    expect(registryEntry()).toMatchObject({
      id: "apertis",
      label: "Apertis",
      adapter: "openai-chat",
      baseUrl: BASE_URL,
      authKind: "key",
      dashboardUrl: "https://apertis.ai/setting?tab=keys",
      liveModels: true,
      preserveCustomDestination: true,
    });
    expect(registryEntry()).not.toHaveProperty("models");
    expect(registryEntry()).not.toHaveProperty("defaultModel");
    expect(registryEntry()).not.toHaveProperty("modelDiscovery");
  });

  test("derives CLI and dashboard presets without persisting registry trust policy", () => {
    const entry = registryEntry();
    expect(buildInitProviders()).toEqual(deriveInitProviders());
    expect(KEY_LOGIN_PROVIDERS.apertis).toMatchObject({
      adapter: "openai-chat",
      baseUrl: BASE_URL,
      dashboardUrl: entry.dashboardUrl,
      liveModels: true,
    });
    expect(buildInitProviders().find(row => row.id === "apertis")).toMatchObject({
      kind: "key",
      adapter: "openai-chat",
      baseUrl: BASE_URL,
    });
    expect(deriveProviderPresets().find(row => row.id === "apertis")).toMatchObject({
      auth: "key",
      dashboardUrl: entry.dashboardUrl,
    });

    const seed = providerConfigSeed(entry);
    expect(seed).toMatchObject({
      adapter: "openai-chat",
      baseUrl: BASE_URL,
      authMode: "key",
      liveModels: true,
    });
    expect(seed).not.toHaveProperty("models");
    expect(seed).not.toHaveProperty("defaultModel");
    expect(seed).not.toHaveProperty("modelDiscovery");
    expect(seed).not.toHaveProperty("preserveCustomDestination");
    expect(KEY_LOGIN_PROVIDERS.apertis).not.toHaveProperty("modelDiscovery");
    expect(KEY_LOGIN_PROVIDERS.apertis).not.toHaveProperty("preserveCustomDestination");
    expect(formatProviderDisplayName("apertis", identityT)).toBe("Apertis");
    expect(isCatalogProviderId("apertis")).toBe(true);
  });

  test("lists and validates models through the documented Bearer-authenticated endpoint", async () => {
    expect(buildModelsRequest(providerConfig().providers.apertis!, API_KEY, "apertis")).toEqual({
      url: `${BASE_URL}/models`,
      headers: { Authorization: `Bearer ${API_KEY}` },
    });

    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe(`${BASE_URL}/models`);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${API_KEY}`);
      expect(init?.redirect).toBe("error");
      return new Response(FIXTURE, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    expect(await validateApiKey("apertis", KEY_LOGIN_PROVIDERS.apertis!, API_KEY)).toBe(true);
  });

  test("rejects unauthorized keys without claiming validation", async () => {
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe(`${BASE_URL}/models`);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${API_KEY}`);
      return new Response("unauthorized", { status: 401 });
    }) as typeof fetch;

    expect(await validateApiKey("apertis", KEY_LOGIN_PROVIDERS.apertis!, API_KEY)).toBe(false);
  });

  test("rejects forbidden keys without claiming validation", async () => {
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe(`${BASE_URL}/models`);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${API_KEY}`);
      return new Response("forbidden", { status: 403 });
    }) as typeof fetch;

    expect(await validateApiKey("apertis", KEY_LOGIN_PROVIDERS.apertis!, API_KEY)).toBe(false);
  });

  test("keeps transient endpoint failures unknown", async () => {
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe(`${BASE_URL}/models`);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${API_KEY}`);
      return new Response("temporarily unavailable", { status: 503 });
    }) as typeof fetch;

    expect(await validateApiKey("apertis", KEY_LOGIN_PROVIDERS.apertis!, API_KEY)).toBe("unknown");

    globalThis.fetch = (async () => {
      throw new TypeError("network unavailable");
    }) as typeof fetch;
    expect(await validateApiKey("apertis", KEY_LOGIN_PROVIDERS.apertis!, API_KEY)).toBe("unknown");
  });

  test("discovers OpenAI-shaped model ids", async () => {
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe(`${BASE_URL}/models`);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${API_KEY}`);
      expect(init?.redirect).toBe("manual");
      return new Response(FIXTURE, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const models = await gatherRoutedModels(providerConfig());
    expect(models.filter(row => row.provider === "apertis").map(row => row.id)).toEqual([
      "claude-sonnet-4.5",
      "gpt-4.1",
    ]);
  });

  test("routes chat completions to the fixed provider host", () => {
    const route = routeModel(providerConfig(), "apertis/gpt-4.1");
    const request = createOpenAIChatAdapter(route.provider).buildRequest({
      modelId: route.modelId,
      context: { messages: [{ role: "user", content: "ping", timestamp: 0 }] },
      stream: true,
      options: {},
    });
    const body = JSON.parse(String(request.body)) as Record<string, unknown>;

    expect(request.url).toBe(`${BASE_URL}/chat/completions`);
    expect(request.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(body.model).toBe("gpt-4.1");
  });

  test("does not retarget same-named custom providers", () => {
    const customConfig = providerConfig({ baseUrl: "https://custom.example/v1" });
    const route = routeModel(customConfig, "apertis/custom-model");
    expect(route.provider).toMatchObject({
      adapter: "openai-chat",
      baseUrl: "https://custom.example/v1",
      authMode: "key",
    });
    expect(buildModelsRequest(customConfig.providers.apertis!, "custom-key", "apertis")).toEqual({
      url: "https://custom.example/v1/models",
      headers: { Authorization: "Bearer custom-key" },
    });

    const customAdapter = routeModel(providerConfig({
      adapter: "anthropic",
      baseUrl: "https://custom.example/anthropic",
    }), "apertis/custom-model");
    expect(customAdapter.provider).toMatchObject({
      adapter: "anthropic",
      baseUrl: "https://custom.example/anthropic",
      authMode: "key",
    });
  });
});
