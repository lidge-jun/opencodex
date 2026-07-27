import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { KEY_LOGIN_PROVIDERS } from "../src/oauth/key-providers";
import { deriveProviderPresets } from "../src/providers/derive";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { routeModel } from "../src/router";
import type { OcxConfig, OcxParsedRequest } from "../src/types";
import { formatProviderDisplayName, isCatalogProviderId } from "../gui/src/provider-icons";

function minimalRequest(modelId: string): OcxParsedRequest {
  return {
    modelId,
    stream: false,
    context: { messages: [{ role: "user", content: "ping" }], tools: [] },
    options: {},
  };
}

describe("Modelsell provider", () => {
  test("publishes the fixed OpenAI-compatible endpoint and live catalog", () => {
    const entry = PROVIDER_REGISTRY.find(provider => provider.id === "modelsell");
    expect(entry).toMatchObject({
      label: "Modelsell",
      adapter: "openai-chat",
      baseUrl: "https://modelsell.com/v1",
      authKind: "key",
      dashboardUrl: "https://modelsell.com/console/token",
      liveModels: true,
    });
    expect(entry).not.toHaveProperty("models");
    expect(entry).not.toHaveProperty("defaultModel");
  });

  test("derives CLI, dashboard, and key-login metadata from the registry", () => {
    expect(KEY_LOGIN_PROVIDERS.modelsell).toMatchObject({
      label: "Modelsell",
      adapter: "openai-chat",
      baseUrl: "https://modelsell.com/v1",
      dashboardUrl: "https://modelsell.com/console/token",
      liveModels: true,
    });
    expect(deriveProviderPresets().find(provider => provider.id === "modelsell")).toMatchObject({
      auth: "key",
      adapter: "openai-chat",
      baseUrl: "https://modelsell.com/v1",
    });
    expect(formatProviderDisplayName("modelsell")).toBe("Modelsell");
    expect(isCatalogProviderId("modelsell")).toBe(true);
  });

  test("routes chat completions to the canonical Modelsell endpoint with bearer auth", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "modelsell",
      providers: {
        modelsell: {
          adapter: "openai-chat",
          baseUrl: "https://user-supplied.example/v1",
          apiKey: "test-key",
          liveModels: true,
        },
      },
    };
    const route = routeModel(config, "modelsell/gpt-5.4-mini");
    expect(route.modelId).toBe("gpt-5.4-mini");
    expect(route.provider.baseUrl).toBe("https://modelsell.com/v1");

    const request = createOpenAIChatAdapter(route.provider).buildRequest(minimalRequest(route.modelId));
    expect(request.url).toBe("https://modelsell.com/v1/chat/completions");
    expect(request.headers).toMatchObject({ Authorization: "Bearer test-key" });
  });
});
