import { describe, expect, test } from "bun:test";
import { buildInitProviders } from "../src/cli/init";
import { deriveProviderPresets } from "../src/providers/derive";
import { FREE_PROVIDER_DIRECTORY } from "../src/providers/free-directory";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { routeModel } from "../src/router";
import type { OcxConfig } from "../src/types";
import { formatProviderDisplayName, isCatalogProviderId } from "../gui/src/provider-icons";
import type { TFn } from "../gui/src/i18n/shared";

const identityT: TFn = key => key;

describe("Apertis reference directory entry", () => {
  test("is inert and makes no integration or entitlement claim", () => {
    const entry = FREE_PROVIDER_DIRECTORY.find(row => row.id === "apertis");

    expect(entry).toMatchObject({
      id: "apertis",
      label: "Apertis",
      adapter: "openai-chat",
      baseUrl: "",
      authKind: "key",
      accessGroups: ["reference-only"],
      supportLevel: "reference",
      verification: "unverified",
      discovery: "unsupported",
      liveModels: false,
    });
    expect(entry).not.toHaveProperty("lastVerified");
    expect(entry).not.toHaveProperty("documentationUrl");
    expect(entry).not.toHaveProperty("dashboardUrl");
  });

  test("does not derive a canonical provider or GUI preset", () => {
    expect(PROVIDER_REGISTRY.some(entry => entry.id === "apertis")).toBe(false);
    expect(buildInitProviders().some(entry => entry.id === "apertis")).toBe(false);
    expect(deriveProviderPresets().some(entry => entry.id === "apertis")).toBe(false);
    expect(isCatalogProviderId("apertis")).toBe(false);
    expect(formatProviderDisplayName("apertis", identityT)).toBe("Apertis");
  });

  test("keeps a same-named custom provider's adapter and destination", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "apertis",
      providers: {
        apertis: {
          adapter: "anthropic",
          baseUrl: "https://custom.example.test/anthropic",
          apiKey: "test-key",
          liveModels: true,
        },
      },
    };

    const routed = routeModel(config, "apertis/custom-model");
    expect(routed.provider).toMatchObject({
      adapter: "anthropic",
      baseUrl: "https://custom.example.test/anthropic",
      liveModels: true,
    });
    expect(routed.modelId).toBe("custom-model");
  });
});
