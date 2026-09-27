import { describe, expect, test } from "bun:test";
import {
  fetchProviderModelsWithAuth,
  refreshingModelsAuthResolver,
} from "../../src/codex/catalog/provider-models";
import { captureProviderGather } from "../../src/codex/catalog/gather-capture";
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
