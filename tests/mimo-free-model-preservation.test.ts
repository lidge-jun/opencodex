import { expect, test } from "bun:test";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { enrichProviderFromRegistry, providerConfigSeed } from "../src/providers/derive";
import { routeModel } from "../src/router";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

test("static-only canonical key provider preserves explicit configured models", () => {
  const entry = PROVIDER_REGISTRY.find(row => row.id === "mimo-free")!;
  const provider = {
    ...providerConfigSeed(entry),
    models: ["mimo-auto", "preview-model"],
    liveModels: true,
  };

  enrichProviderFromRegistry("mimo-free", provider);

  expect(provider.liveModels).toBe(false);
  expect(provider.models).toEqual(["mimo-auto", "preview-model"]);

  const config: OcxConfig = {
    port: 10100,
    defaultProvider: "mimo-free",
    providers: { "mimo-free": provider },
  };
  const route = routeModel(config, "mimo-free/mimo-auto");
  expect(route.provider.liveModels).toBe(false);
  expect(route.provider.models).toEqual(["mimo-auto", "preview-model"]);
});

test("legacy canonical MiMo row without auth mode is repaired to registry catalog", () => {
  const provider: OcxProviderConfig = {
    adapter: "mimo-free",
    baseUrl: "https://api.xiaomimimo.com/api/free-ai/openai/chat",
    liveModels: true,
    models: ["legacy-model"],
  };

  enrichProviderFromRegistry("mimo-free", provider);

  expect(provider).toMatchObject({
    authMode: "key",
    liveModels: false,
    models: ["mimo-auto"],
  });

  const config: OcxConfig = {
    port: 10100,
    defaultProvider: "mimo-free",
    providers: { "mimo-free": {
      adapter: "mimo-free",
      baseUrl: "https://api.xiaomimimo.com/api/free-ai/openai/chat",
      liveModels: true,
      models: ["legacy-model"],
    } },
  };
  const route = routeModel(config, "mimo-free/mimo-auto");
  expect(route.provider).toMatchObject({
    authMode: "key",
    liveModels: false,
    models: ["mimo-auto"],
  });
});
