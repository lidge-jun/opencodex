import { describe, expect, test } from "bun:test";
import {
  fetchProviderModelsWithAuth,
  refreshingModelsAuthResolver,
} from "../../src/codex/catalog/provider-models";
import { captureProviderGather } from "../../src/codex/catalog/gather-capture";
import { deriveKeyLoginMap, providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { KEY_LOGIN_PROVIDERS, validateApiKey } from "../../src/oauth/key-providers";
import { handleManagementAPI } from "../../src/server/management-api";
import { ManagementRequest } from "../helpers/management-auth";
import type { OcxConfig } from "../../src/types";

describe("TypeSafe JEV provider preset", () => {
  test("management connection probe uses the custom decision endpoint and model", async () => {
    let sends = 0;
    const config: OcxConfig = {
      port: 0,
      defaultProvider: "openai",
      providers: {
        jev: {
          adapter: "jev-decision",
          baseUrl: "https://decisions.example/v1/decisions",
          authMode: "key",
          apiKey: "alternative-test-key",
          defaultModel: "decision-model-v1",
          liveModels: false,
          ...{ fetch: async (url: string, init: RequestInit) => {
            sends++;
            expect(url).toBe("https://decisions.example/v1/decisions");
            expect(new Headers(init.headers).get("authorization")).toBe("Bearer alternative-test-key");
            expect(init.redirect).toBe("manual");
            expect(JSON.parse(String(init.body)).model).toBe("decision-model-v1");
            return Response.json({ answers: { route: { choice: "jev/probe:none" } } });
          } },
        },
      },
    };
    const request = new ManagementRequest("http://127.0.0.1/api/providers/test?name=jev", { method: "POST" });
    const response = await handleManagementAPI(request, new URL(request.url), config, {});
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ ok: true });
    expect(sends).toBe(1);
  });

  test.each(["https://api.typesafe.ai/v1/systemone", "https://decisions.example/v1/decisions"])("keeps decision models out of the inference catalog at %s", async (baseUrl) => {
    const entry = getProviderRegistryEntry("jev");

    expect(entry).toMatchObject({
      id: "jev",
      label: "TypeSafe JEV",
      adapter: "jev-decision",
      authKind: "key",
      credentialOnly: true,
      baseUrl: "https://api.typesafe.ai/v1/systemone",
      dashboardUrl: "https://console.typesafe.ai",
      liveModels: false,
      preserveCustomDestination: true,
      apiKeyValidation: "unknown",
    });
    expect(entry?.freeTier).not.toBe(true);
    expect(entry?.models).toBeUndefined();
    expect(entry?.defaultModel).toBeUndefined();

    const keyLogin = deriveKeyLoginMap().jev;
    expect(keyLogin).toMatchObject({
      adapter: "jev-decision",
      baseUrl: "https://api.typesafe.ai/v1/systemone",
      dashboardUrl: "https://console.typesafe.ai",
      liveModels: false,
    });
    expect(keyLogin?.models).toBeUndefined();
    expect(keyLogin?.defaultModel).toBeUndefined();

    const captured = captureProviderGather(
      "jev",
      { ...providerConfigSeed(entry!), baseUrl, defaultModel: "decision-model-v1" },
      refreshingModelsAuthResolver,
    );
    const result = await fetchProviderModelsWithAuth(
      captured,
      0,
      undefined,
      refreshingModelsAuthResolver,
    );
    expect(result.models).toEqual([]);
    expect(result.outcome.state).toBe("authoritative");
  });

  test("CLI key login accepts JEV without probing a model-catalog endpoint", async () => {
    const originalFetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch")!;
    let fetchCalls = 0;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async () => {
        fetchCalls += 1;
        return new Response(null, { status: 500 });
      },
    });
    try {
      expect(await validateApiKey("jev", KEY_LOGIN_PROVIDERS.jev!, "test-jev-key")).toBe("unknown");
      expect(fetchCalls).toBe(0);
    } finally {
      Object.defineProperty(globalThis, "fetch", originalFetchDescriptor);
    }
  });
});
