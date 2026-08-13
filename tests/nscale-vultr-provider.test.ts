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

const NSCALE_BASE_URL = "https://inference.api.nscale.com/v1";
const VULTR_BASE_URL = "https://api.vultrinference.com/v1";
const NSCALE_MODEL = "meta-llama/Llama-3.1-8B-Instruct";
const VULTR_MODEL = "kimi-k2-instruct";
const API_KEY = "provider-test-key";
const fixtures = {
  nscale: readFileSync(join(import.meta.dir, "fixtures/nscale-models.json"), "utf8"),
  vultr: readFileSync(join(import.meta.dir, "fixtures/vultr-models.json"), "utf8"),
};
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache("nscale");
  clearModelCache("vultr");
});

function entry(providerId: "nscale" | "vultr") {
  const value = PROVIDER_REGISTRY.find(row => row.id === providerId);
  if (!value) throw new Error(`missing ${providerId} registry entry`);
  return value;
}

function config(
  providerId: "nscale" | "vultr",
  overrides: Partial<OcxProviderConfig> = {},
): OcxConfig {
  const baseUrl = providerId === "nscale" ? NSCALE_BASE_URL : VULTR_BASE_URL;
  return {
    port: 10100,
    defaultProvider: providerId,
    providers: {
      [providerId]: {
        adapter: "openai-chat",
        baseUrl,
        authMode: "key",
        apiKey: API_KEY,
        liveModels: true,
        // Fetches are fixture-only; this avoids public-host DNS classification affecting tests.
        allowPrivateNetwork: true,
        ...overrides,
      },
    },
  };
}

describe("Nscale and Vultr provider presets", () => {
  test("register fixed transports with bounded, evidence-gated discovery", () => {
    expect(entry("nscale")).toMatchObject({
      id: "nscale",
      label: "Nscale Serverless Inference",
      adapter: "openai-chat",
      baseUrl: NSCALE_BASE_URL,
      authKind: "key",
      dashboardUrl: "https://console.nscale.com",
      defaultModel: NSCALE_MODEL,
      models: [NSCALE_MODEL],
      liveModels: true,
      preserveCustomDestination: true,
      parallelToolCalls: false,
      reasoningEfforts: [],
      modelDiscovery: {
        path: "models",
        maxResponseBytes: 256 * 1024,
        maxModels: 256,
        filter: {
          allOf: [{ path: ["id"], equalsAny: [NSCALE_MODEL] }],
        },
      },
    });
    expect(entry("vultr")).toMatchObject({
      id: "vultr",
      label: "Vultr Serverless Inference",
      adapter: "openai-chat",
      baseUrl: VULTR_BASE_URL,
      authKind: "key",
      dashboardUrl: "https://my.vultr.com",
      defaultModel: VULTR_MODEL,
      models: [VULTR_MODEL],
      liveModels: true,
      preserveCustomDestination: true,
      parallelToolCalls: false,
      reasoningEfforts: [],
      modelDiscovery: {
        path: "models",
        maxResponseBytes: 256 * 1024,
        maxModels: 256,
        filter: {
          allOf: [{ path: ["id"], equalsAny: [VULTR_MODEL] }],
        },
      },
    });
  });

  test("derives CLI, dashboard, and key-login presets without persisting trust policy", () => {
    expect(buildInitProviders()).toEqual(deriveInitProviders());
    for (const providerId of ["nscale", "vultr"] as const) {
      const baseUrl = providerId === "nscale" ? NSCALE_BASE_URL : VULTR_BASE_URL;
      expect(KEY_LOGIN_PROVIDERS[providerId]).toMatchObject({
        adapter: "openai-chat",
        baseUrl,
        liveModels: true,
        reasoningEfforts: [],
      });
      expect(buildInitProviders().find(row => row.id === providerId)).toMatchObject({
        kind: "key",
        adapter: "openai-chat",
        baseUrl,
      });
      expect(deriveProviderPresets().find(row => row.id === providerId)).toMatchObject({
        auth: "key",
      });

      const seed = providerConfigSeed(entry(providerId));
      expect(seed).toMatchObject({
        adapter: "openai-chat",
        baseUrl,
        authMode: "key",
        liveModels: true,
        parallelToolCalls: false,
        reasoningEfforts: [],
      });
      expect(seed).not.toHaveProperty("modelDiscovery");
      expect(seed).not.toHaveProperty("preserveCustomDestination");
      expect(KEY_LOGIN_PROVIDERS[providerId]).not.toHaveProperty("modelDiscovery");
      expect(KEY_LOGIN_PROVIDERS[providerId]).not.toHaveProperty("preserveCustomDestination");
    }
  });

  test("lists and validates models with the provider bearer key", async () => {
    for (const providerId of ["nscale", "vultr"] as const) {
      const baseUrl = providerId === "nscale" ? NSCALE_BASE_URL : VULTR_BASE_URL;
      expect(buildModelsRequest(config(providerId).providers[providerId]!, API_KEY, providerId)).toEqual({
        url: `${baseUrl}/models`,
        headers: { Authorization: `Bearer ${API_KEY}` },
      });

      globalThis.fetch = (async (input, init) => {
        expect(String(input)).toBe(`${baseUrl}/models`);
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${API_KEY}`);
        expect(init?.redirect).toBe("error");
        return new Response(fixtures[providerId], {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;

      expect(await validateApiKey(providerId, KEY_LOGIN_PROVIDERS[providerId]!, API_KEY)).toBe(true);
    }
  });

  test("filters mixed catalogs to officially documented tool-capable models", async () => {
    for (const providerId of ["nscale", "vultr"] as const) {
      const baseUrl = providerId === "nscale" ? NSCALE_BASE_URL : VULTR_BASE_URL;
      globalThis.fetch = (async (input, init) => {
        expect(String(input)).toBe(`${baseUrl}/models`);
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${API_KEY}`);
        expect(init?.redirect).toBe("manual");
        return new Response(fixtures[providerId], {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;

      const routed = (await gatherRoutedModels(withStubbedProviderFetch(config(providerId))))
        .filter(row => row.provider === providerId);
      expect(routed.map(row => row.id)).toEqual([
        providerId === "nscale" ? NSCALE_MODEL : VULTR_MODEL,
      ]);
      expect(routed[0]).toMatchObject({
        reasoningEfforts: [],
      });
      if (providerId === "nscale") {
        expect(routed[0]?.contextWindow).toBe(131_072);
      }
    }
  });

  test("preserves namespaced Nscale ids in raw and flattened selector forms", () => {
    expect(routedSlug("nscale", NSCALE_MODEL)).toBe("nscale/meta-llama-Llama-3.1-8B-Instruct");
    for (const selector of [
      `nscale/${NSCALE_MODEL}`,
      routedSlug("nscale", NSCALE_MODEL),
    ]) {
      expect(routeModel(config("nscale"), selector).modelId).toBe(NSCALE_MODEL);
    }
  });

  test("routes tool requests to the fixed chat endpoints without parallel or reasoning claims", () => {
    for (const [providerId, modelId] of [
      ["nscale", NSCALE_MODEL],
      ["vultr", VULTR_MODEL],
    ] as const) {
      const baseUrl = providerId === "nscale" ? NSCALE_BASE_URL : VULTR_BASE_URL;
      const route = routeModel(config(providerId), `${providerId}/${modelId}`);
      const request = createOpenAIChatAdapter(route.provider).buildRequest({
        modelId: route.modelId,
        context: {
          messages: [{ role: "user", content: "ping", timestamp: 0 }],
          tools: [{ name: "lookup", description: "Lookup", parameters: { type: "object" } }],
        },
        stream: true,
        options: { reasoning: "high" },
      });
      const body = JSON.parse(String(request.body)) as Record<string, unknown>;

      expect(request.url).toBe(`${baseUrl}/chat/completions`);
      expect(request.headers.Authorization).toBe(`Bearer ${API_KEY}`);
      expect(body.model).toBe(modelId);
      expect(body.tools).toBeArray();
      expect(body).not.toHaveProperty("parallel_tool_calls");
      expect(body).not.toHaveProperty("reasoning_effort");
    }
  });

  test("does not retarget older same-named custom providers or apply fixed discovery", () => {
    for (const providerId of ["nscale", "vultr"] as const) {
      const custom = config(providerId, { baseUrl: "https://custom.example/v1" });
      expect(routeModel(custom, `${providerId}/custom-model`).provider).toMatchObject({
        adapter: "openai-chat",
        baseUrl: "https://custom.example/v1",
        authMode: "key",
      });
      expect(buildModelsRequest(custom.providers[providerId]!, "custom-key", providerId)).toEqual({
        url: "https://custom.example/v1/models",
        headers: { Authorization: "Bearer custom-key" },
      });

      expect(routeModel(config(providerId, {
        adapter: "anthropic",
        baseUrl: "https://custom.example/anthropic",
      }), `${providerId}/custom-model`).provider).toMatchObject({
        adapter: "anthropic",
        baseUrl: "https://custom.example/anthropic",
        authMode: "key",
      });
    }
  });
});
