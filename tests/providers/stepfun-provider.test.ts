import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import { KEY_LOGIN_PROVIDERS } from "../../src/oauth/key-providers";
import { deriveProviderPresets, providerConfigSeed } from "../../src/providers/derive";
import { enrichProviderFromCatalog } from "../../src/oauth/key-providers";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { routeModel } from "../../src/router";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { en } from "../../gui/src/i18n/en";
import { interpolate, type TFn } from "../../gui/src/i18n/shared";
import { formatProviderDisplayName, isCatalogProviderId, providerIconSrc } from "../../gui/src/provider-icons";

const englishT: TFn = (key, vars) => interpolate(en[key], vars);

const BASE_URL = "https://api.stepfun.com/v1";
const TEST_KEY = "test-stepfun-key-12345";

function getStepFunRegistryEntry() {
  const entry = PROVIDER_REGISTRY.find(p => p.id === "stepfun");
  if (!entry) throw new Error("StepFun registry entry not found");
  return entry;
}

function createStepFunConfig(overrides: Partial<OcxProviderConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "stepfun",
    providers: {
      stepfun: {
        adapter: "openai-chat",
        baseUrl: BASE_URL,
        authMode: "key",
        apiKey: TEST_KEY,
        ...overrides,
      },
    },
  };
}

describe("StepFun provider", () => {
  test("appears in the provider registry and preset catalog", () => {
    const entry = getStepFunRegistryEntry();
    expect(entry).toMatchObject({
      id: "stepfun",
      label: "StepFun",
      adapter: "openai-chat",
      baseUrl: BASE_URL,
      authKind: "key",
      dashboardUrl: "https://platform.stepfun.com",
      defaultModel: "step-5-preview",
      liveModels: true,
      preserveCustomDestination: true,
    });
    expect(entry.models).toEqual([
      "step-5-preview",
      "step-3.5-flash",
      "step-3.7-flash",
    ]);

    // Check presence in derived presets for UI catalog
    const presets = deriveProviderPresets();
    const preset = presets.find(p => p.id === "stepfun");
    expect(preset).toBeDefined();
    expect(preset).toMatchObject({
      id: "stepfun",
      label: "StepFun",
      adapter: "openai-chat",
      baseUrl: BASE_URL,
      auth: "key",
      defaultModel: "step-5-preview",
      dashboardUrl: "https://platform.stepfun.com",
    });

    // Check presence in key login providers
    expect(KEY_LOGIN_PROVIDERS.stepfun).toMatchObject({
      baseUrl: BASE_URL,
      adapter: "openai-chat",
      dashboardUrl: "https://platform.stepfun.com",
      defaultModel: "step-5-preview",
      liveModels: true,
    });
  });

  test("can save API key and enrich config from catalog seed", () => {
    const entry = getStepFunRegistryEntry();
    const seed = providerConfigSeed(entry);
    expect(seed).toMatchObject({
      adapter: "openai-chat",
      baseUrl: BASE_URL,
      authMode: "key",
      defaultModel: "step-5-preview",
    });

    // Verify saving provider config with API Key and enriching metadata
    const userConfig: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: BASE_URL,
      authMode: "key",
      apiKey: TEST_KEY,
    };
    enrichProviderFromCatalog("stepfun", userConfig);

    expect(userConfig.apiKey).toBe(TEST_KEY);
    expect(userConfig.defaultModel).toBe("step-5-preview");
    expect(userConfig.models).toEqual([
      "step-5-preview",
      "step-3.5-flash",
      "step-3.7-flash",
    ]);
    expect(userConfig.modelContextWindows?.["step-5-preview"]).toBe(1_000_000);
    expect(userConfig.modelContextWindows?.["step-3.5-flash"]).toBe(256_000);
    expect(userConfig.modelContextWindows?.["step-3.7-flash"]).toBe(256_000);
  });

  test("models can be selected and routed with correct metadata", () => {
    const config = createStepFunConfig();

    // Model 1: step-5-preview
    const route5 = routeModel(config, "stepfun/step-5-preview");
    expect(route5.modelId).toBe("step-5-preview");
    expect(route5.provider.adapter).toBe("openai-chat");
    expect(route5.provider.baseUrl).toBe(BASE_URL);
    expect(route5.provider.modelContextWindows?.["step-5-preview"]).toBe(1_000_000);
    expect(route5.provider.modelInputModalities?.["step-5-preview"]).toEqual(["text", "image"]);

    // Model 2: step-3.5-flash
    const route35 = routeModel(config, "stepfun/step-3.5-flash");
    expect(route35.modelId).toBe("step-3.5-flash");
    expect(route35.provider.modelContextWindows?.["step-3.5-flash"]).toBe(256_000);
    expect(route35.provider.noVisionModels).toContain("step-3.5-flash");

    // Model 3: step-3.7-flash
    const route37 = routeModel(config, "stepfun/step-3.7-flash");
    expect(route37.modelId).toBe("step-3.7-flash");
    expect(route37.provider.modelContextWindows?.["step-3.7-flash"]).toBe(256_000);
    expect(route37.provider.modelInputModalities?.["step-3.7-flash"]).toEqual(["text", "image"]);
  });

  test("builds requests targeting the correct StepFun endpoint", () => {
    const config = createStepFunConfig();
    const route = routeModel(config, "stepfun/step-5-preview");
    const adapter = createOpenAIChatAdapter(route.provider);

    const request = adapter.buildRequest({
      modelId: route.modelId,
      context: {
        messages: [{ role: "user", content: "Hello StepFun", timestamp: Date.now() }],
      },
      stream: false,
      options: {},
    });

    expect(request.url).toBe("https://api.stepfun.com/v1/chat/completions");
    expect(request.headers.Authorization).toBe(`Bearer ${TEST_KEY}`);

    const parsedBody = JSON.parse(String(request.body));
    expect(parsedBody.model).toBe("step-5-preview");
    expect(parsedBody.messages[0].content).toBe("Hello StepFun");
  });

  test("resolves UI display name and brand icon", () => {
    expect(formatProviderDisplayName("stepfun", englishT)).toBe("StepFun");
    expect(isCatalogProviderId("stepfun")).toBe(true);
    expect(providerIconSrc("stepfun")).toBe("/provider-icons/stepfun-color.svg");
  });
});
