import { expect, test } from "bun:test";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { enrichProviderFromRegistry, providerConfigSeed } from "../src/providers/derive";
import { routeModel } from "../src/router";
import type { OcxConfig } from "../src/types";

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
