import { describe, expect, test } from "bun:test";
import { KEY_LOGIN_PROVIDERS } from "../src/oauth/key-providers";
import { deriveProviderPresets } from "../src/providers/derive";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { routeModel } from "../src/router";
import type { OcxConfig } from "../src/types";
import { en } from "../gui/src/i18n/en";
import { interpolate, type TFn } from "../gui/src/i18n/shared";
import { formatProviderDisplayName, isCatalogProviderId } from "../gui/src/provider-icons";

const englishT: TFn = (key, vars) => interpolate(en[key], vars);

describe("Tencent Cloud Coding Plan provider", () => {
  test("publishes the coding-only OpenAI-compatible contract", () => {
    const entry = PROVIDER_REGISTRY.find(provider => provider.id === "tencent-coding-plan");
    expect(entry).toMatchObject({
      label: "Tencent Cloud Coding Plan",
      baseUrl: "https://api.lkeap.cloud.tencent.com/coding/v3",
      adapter: "openai-chat",
      authKind: "key",
      dashboardUrl: "https://console.cloud.tencent.com/tokenhub/codingplan",
      defaultModel: "tc-code-latest",
      models: ["tc-code-latest", "glm-5", "kimi-k2.5", "minimax-m2.5"],
      liveModels: true,
      noVisionModels: ["tc-code-latest", "glm-5", "kimi-k2.5", "minimax-m2.5"],
    });
    expect(entry?.note).toContain("Coding tools only");
    expect(entry?.note).toContain("non-interactive batch");
    expect(entry?.modelInputModalities).toEqual({
      "tc-code-latest": ["text"],
      "glm-5": ["text"],
      "kimi-k2.5": ["text"],
      "minimax-m2.5": ["text"],
    });
  });

  test("derives key login, GUI preset, and route metadata from the registry", () => {
    expect(KEY_LOGIN_PROVIDERS["tencent-coding-plan"]).toMatchObject({
      baseUrl: "https://api.lkeap.cloud.tencent.com/coding/v3",
      defaultModel: "tc-code-latest",
      liveModels: true,
    });
    expect(deriveProviderPresets().find(provider => provider.id === "tencent-coding-plan")).toMatchObject({
      auth: "key",
      defaultModel: "tc-code-latest",
    });

    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "tencent-coding-plan",
      providers: {
        "tencent-coding-plan": {
          adapter: "openai-chat",
          baseUrl: "https://api.lkeap.cloud.tencent.com/coding/v3",
          apiKey: "test-key",
        },
      },
    };
    const route = routeModel(config, "tencent-coding-plan/glm-5");
    expect(route.provider.noVisionModels).toContain("glm-5");
    expect(route.provider.modelInputModalities?.["glm-5"]).toEqual(["text"]);
  });
});

describe("SiliconFlow provider", () => {
  test("uses the official live OpenAI-compatible endpoint without frozen reasoning claims", () => {
    const entry = PROVIDER_REGISTRY.find(provider => provider.id === "siliconflow");
    expect(entry).toMatchObject({
      label: "SiliconFlow",
      baseUrl: "https://api.siliconflow.cn/v1",
      adapter: "openai-chat",
      authKind: "key",
      dashboardUrl: "https://cloud.siliconflow.cn/account/ak",
      liveModels: true,
    });
    expect(entry).not.toHaveProperty("models");
    expect(entry).not.toHaveProperty("thinkingBudgetModels");
    expect(entry).not.toHaveProperty("modelReasoningEfforts");
    expect(KEY_LOGIN_PROVIDERS.siliconflow).toMatchObject({
      baseUrl: "https://api.siliconflow.cn/v1",
      liveModels: true,
    });
    expect(deriveProviderPresets().find(provider => provider.id === "siliconflow")).toMatchObject({
      auth: "key",
      baseUrl: "https://api.siliconflow.cn/v1",
    });
  });

  test("registers canonical GUI display names for both providers", () => {
    expect(formatProviderDisplayName("siliconflow", englishT)).toBe("SiliconFlow");
    expect(formatProviderDisplayName("tencent-coding-plan", englishT)).toBe("Tencent Cloud Coding Plan");
    expect(isCatalogProviderId("siliconflow")).toBe(true);
    expect(isCatalogProviderId("tencent-coding-plan")).toBe(true);
  });
});
