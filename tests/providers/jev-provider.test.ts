import { describe, expect, test } from "bun:test";
import {
  fetchProviderModelsWithAuth,
  refreshingModelsAuthResolver,
} from "../../src/codex/catalog/provider-models";
import { captureGatherFlight, captureProviderGather } from "../../src/codex/catalog/gather-capture";
import { deriveKeyLoginMap, providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { KEY_LOGIN_PROVIDERS, validateApiKey } from "../../src/oauth/key-providers";

describe("TypeSafe JEV provider preset", () => {
  test("stores a paid decision-service credential without publishing a model", async () => {
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
      providerConfigSeed(entry!),
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
});

describe("OpenAI Decisions provider preset", () => {
  test("keeps the decision model out of the routable model catalog", () => {
    const entry = getProviderRegistryEntry("openai-decisions");

    expect(entry).toMatchObject({
      id: "openai-decisions",
      label: "OpenAI Decisions",
      adapter: "jev-decision",
      authKind: "key",
      credentialOnly: true,
      baseUrl: "https://api.openai.com/v1/decisions",
      dashboardUrl: "https://platform.openai.com/api-keys",
      defaultModel: "gpt-6-luna",
      liveModels: false,
      preserveCustomDestination: true,
      apiKeyValidation: "unknown",
    });
    expect(entry?.models).toBeUndefined();
    expect(deriveKeyLoginMap()["openai-decisions"]).toMatchObject({
      adapter: "jev-decision",
      baseUrl: "https://api.openai.com/v1/decisions",
      defaultModel: "gpt-6-luna",
      liveModels: false,
    });

    const captured = captureGatherFlight({
      port: 0,
      providers: {
        "openai-decisions": providerConfigSeed(entry!),
        worker: { adapter: "openai-chat", baseUrl: "https://worker.example/v1", models: ["worker"], liveModels: false },
      },
    }, () => refreshingModelsAuthResolver);
    expect(captured.providers.map(provider => provider.name)).toEqual(["worker"]);
  });
});

describe("decision-service key login", () => {
  test.each(["jev", "openai-decisions"])("accepts %s without probing a model-catalog endpoint", async provider => {
    expect(KEY_LOGIN_PROVIDERS[provider]).toBeDefined();
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
      expect(await validateApiKey(provider, KEY_LOGIN_PROVIDERS[provider]!, "decision-test-key")).toBe("unknown");
      expect(fetchCalls).toBe(0);
    } finally {
      Object.defineProperty(globalThis, "fetch", originalFetchDescriptor);
    }
  });
});
