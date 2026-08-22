import { describe, expect, test } from "bun:test";
import { createMimoFreeAdapter, MIMO_CHAT_URL } from "../src/adapters/mimo-free";
import { enrichProviderFromRegistry, providerConfigSeed } from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
import {
  providerMatchesRegistryTransportWithStaticGuards,
  providerSupportsLiveModelDiscovery,
  registryEntrySupportsLiveModelDiscovery,
} from "../src/providers/static-model-discovery";
import { routedProviderConfig } from "../src/router";
import type { OcxProviderConfig } from "../src/types";

function provider(overrides: Partial<OcxProviderConfig>): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://example.com/v1",
    ...overrides,
  };
}

describe("static provider model discovery policy", () => {
  test("ClinePass and MiMo Free seeds are static without changing the registry catalog", () => {
    for (const id of ["cline-pass", "mimo-free"] as const) {
      const entry = getProviderRegistryEntry(id);
      expect(entry).toBeDefined();
      expect(registryEntrySupportsLiveModelDiscovery(entry!)).toBeFalse();
      expect(providerConfigSeed(entry!).liveModels).toBeFalse();
    }
  });

  test("stale canonical ClinePass discovery is disabled without replacing saved models", () => {
    const savedModels = ["cline-pass/kimi-k3", "saved-selector"];
    const config = provider({
      adapter: "openai-chat",
      baseUrl: "https://api.cline.bot/api/v1",
      authMode: "key",
      liveModels: true,
      models: [...savedModels],
    });

    enrichProviderFromRegistry("cline-pass", config);
    expect(config.liveModels).toBeFalse();
    expect(config.models).toEqual(savedModels);

    const routed = routedProviderConfig("cline-pass", provider({
      adapter: "openai-chat",
      baseUrl: "https://api.cline.bot/api/v1",
      authMode: "key",
      liveModels: true,
      models: [...savedModels],
    }));
    expect(routed.liveModels).toBeFalse();
    expect(routed.models).toEqual(savedModels);
  });

  test("the normal Cline API stays live even though it shares the ClinePass destination", () => {
    const config = provider({
      adapter: "openai-chat",
      baseUrl: "https://api.cline.bot/api/v1",
      authMode: "key",
      liveModels: true,
      defaultModel: "anthropic/claude-sonnet-4-6",
    });

    expect(providerSupportsLiveModelDiscovery("cline", config)).toBeTrue();
    expect(providerSupportsLiveModelDiscovery("my-cline", config)).toBeTrue();
  });

  test("legacy canonical MiMo Free auth is repaired without replacing saved models", () => {
    const config = provider({
      adapter: "mimo-free",
      baseUrl: MIMO_CHAT_URL,
      authMode: "local",
      liveModels: true,
      models: ["mimo-auto", "saved-selector"],
    });

    enrichProviderFromRegistry("mimo-free", config);
    expect(config.authMode).toBe("key");
    expect(config.liveModels).toBeFalse();
    expect(config.models).toEqual(["mimo-auto", "saved-selector"]);

    const routed = routedProviderConfig("mimo-free", provider({
      adapter: "mimo-free",
      baseUrl: MIMO_CHAT_URL,
      authMode: "local",
      liveModels: true,
      models: ["mimo-auto", "saved-selector"],
    }));
    expect(routed.authMode).toBe("key");
    expect(routed.liveModels).toBeFalse();
    expect(routed.models).toEqual(["mimo-auto", "saved-selector"]);
  });

  test("same-named custom MiMo Free rows are not claimed by the canonical preset", () => {
    const custom = provider({
      adapter: "openai-chat",
      baseUrl: "https://example.com/v1",
      authMode: "key",
      liveModels: true,
      models: ["custom-model"],
    });

    expect(providerMatchesRegistryTransportWithStaticGuards("mimo-free", custom)).toBeFalse();
    const routed = routedProviderConfig("mimo-free", custom);
    expect(routed.adapter).toBe("openai-chat");
    expect(routed.baseUrl).toBe("https://example.com/v1");
    expect(routed.liveModels).toBeTrue();
    expect(routed.models).toEqual(["custom-model"]);
  });

  test("the bespoke MiMo Free adapter refuses a custom destination", () => {
    expect(() => createMimoFreeAdapter(provider({
      adapter: "mimo-free",
      baseUrl: "https://example.com/v1",
    }))).toThrow("only supports the canonical Xiaomi MiMo Free endpoint");
  });
});
