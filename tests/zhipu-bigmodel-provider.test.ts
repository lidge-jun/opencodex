import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { KEY_LOGIN_PROVIDERS } from "../src/oauth/key-providers";
import { deriveJawcodeAliases, deriveProviderPresets } from "../src/providers/derive";
import { FREE_PROVIDER_DIRECTORY } from "../src/providers/free-directory";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { routeModel } from "../src/router";
import type { OcxConfig } from "../src/types";

const BASE_URL = "https://open.bigmodel.cn/api/paas/v4";

function bigmodelConfig(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "zhipu-bigmodel",
    providers: {
      "zhipu-bigmodel": {
        adapter: "openai-chat",
        baseUrl: BASE_URL,
        apiKey: "test-key",
      },
    },
  };
}

async function buildBody(modelRef: string, reasoning: string): Promise<Record<string, unknown>> {
  const route = routeModel(bigmodelConfig(), modelRef);
  const adapter = createOpenAIChatAdapter(route.provider);
  const request = await adapter.buildRequest({
    modelId: route.modelId,
    context: { messages: [{ role: "user", content: "hi" }] },
    stream: true,
    options: { reasoning },
  });
  return JSON.parse(request.body as string) as Record<string, unknown>;
}

describe("Zhipu BigModel provider", () => {
  test("publishes the domestic pay-as-you-go contract", () => {
    const entry = PROVIDER_REGISTRY.find(provider => provider.id === "zhipu-bigmodel");
    expect(entry).toMatchObject({
      label: "Zhipu AI — BigModel",
      baseUrl: BASE_URL,
      adapter: "openai-chat",
      authKind: "key",
      dashboardUrl: "https://bigmodel.cn/console/usercenter/apikeys",
      defaultModel: "glm-4.6",
      jawcodeBundle: "zai",
    });

    // Without this the catalog falls back to a generic 128k window and Codex compacts
    // ~76,800 tokens early on the default model.
    expect(entry?.modelContextWindows?.["glm-4.6"]).toBe(204_800);

    // Modalities are declared per model. `noVisionModels` is deliberately unused here: in this
    // repository it ADDS image input to route attachments through the proxy's vision sidecar
    // (src/codex/catalog/provider-fetch.ts), a coverage claim nobody verified for this host.
    expect(entry?.modelInputModalities?.["glm-4.6"]).toEqual(["text"]);
    expect(entry?.modelInputModalities?.["glm-4.6v"]).toEqual(["text", "image"]);
    expect(entry?.noVisionModels).toBeUndefined();

    // A live-discovery claim we have not seen answer would produce an empty picker at runtime.
    expect(entry?.liveModels).toBeUndefined();
    expect(entry?.models).toContain("glm-4.6v");
  });

  test("does not claim an id that already resolves somewhere else", () => {
    const entry = PROVIDER_REGISTRY.find(provider => provider.id === "zhipu-bigmodel");
    expect(entry).toBeDefined();

    // `glm` and `glm-cn` are bound in the free-provider directory to Z.AI and to the BigModel
    // CODING path respectively. Registering either id here would let routedProviderConfig()
    // canonicalize a saved config onto this baseUrl and send its API key to another host.
    const directoryIds = new Set(FREE_PROVIDER_DIRECTORY.map(row => row.id));
    expect(directoryIds.has("glm")).toBe(true);
    expect(directoryIds.has("glm-cn")).toBe(true);
    expect(directoryIds.has("zhipu-bigmodel")).toBe(false);

    // A saved `glm` provider keeps its own destination, unaffected by this registry entry.
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "glm",
      providers: {
        glm: {
          adapter: "openai-chat",
          baseUrl: "https://api.z.ai/api/coding/paas/v4",
          apiKey: "zai-key",
        },
      },
    };
    expect(routeModel(config, "glm/glm-4.6").provider.baseUrl).toBe("https://api.z.ai/api/coding/paas/v4");
  });

  test("maps reasoning effort onto the GLM thinking toggle instead of reasoning_effort", async () => {
    // GLM exposes a binary thinking knob; these models reject reasoning_effort outright.
    const high = await buildBody("zhipu-bigmodel/glm-4.6", "high");
    expect(high.thinking).toEqual({ type: "enabled" });
    expect(high.reasoning_effort).toBeUndefined();

    // The disabled half matters: a one-sided assertion still passes when the map is stuck.
    const low = await buildBody("zhipu-bigmodel/glm-4.6", "low");
    expect(low.thinking).toEqual({ type: "disabled" });
    expect(low.reasoning_effort).toBeUndefined();
  });

  test("derives key login, GUI preset, and metadata bundle from the registry", () => {
    expect(KEY_LOGIN_PROVIDERS["zhipu-bigmodel"]).toMatchObject({
      label: "Zhipu AI — BigModel",
      adapter: "openai-chat",
      baseUrl: BASE_URL,
      defaultModel: "glm-4.6",
    });
    expect(KEY_LOGIN_PROVIDERS["zhipu-bigmodel"]).not.toHaveProperty("liveModels");
    expect(deriveProviderPresets().find(preset => preset.id === "zhipu-bigmodel")).toMatchObject({
      auth: "key",
      defaultModel: "glm-4.6",
    });
    expect(deriveJawcodeAliases()["zhipu-bigmodel"]).toBe("zai");
  });
});
