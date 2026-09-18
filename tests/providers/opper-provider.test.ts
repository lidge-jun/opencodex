import { describe, expect, test } from "bun:test";
import { KEY_LOGIN_PROVIDERS } from "../../src/oauth/key-providers";
import { deriveProviderPresets, providerConfigSeed } from "../../src/providers/derive";
import { resolveProviderModelDiscoveryUrl } from "../../src/providers/model-discovery";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { routeModel } from "../../src/router";
import type { OcxConfig } from "../../src/types";
import { en } from "../../gui/src/i18n/en";
import { interpolate, type TFn } from "../../gui/src/i18n/shared";
import { formatProviderDisplayName, providerIconPaint, providerIconSrc } from "../../gui/src/provider-icons";

const englishT: TFn = (key, vars) => interpolate(en[key], vars);
const OPPER_BASE_URL = "https://api.opper.ai/v3/compat";

function registryEntry() {
  const entry = PROVIDER_REGISTRY.find(row => row.id === "opper");
  if (!entry) throw new Error("missing opper registry entry");
  return entry;
}

describe("Opper gateway provider", () => {
  test("is a fixed OpenAI-compatible API-key gateway seeded with bare pool ids", () => {
    const entry = registryEntry();
    expect(entry).toMatchObject({
      label: "Opper",
      adapter: "openai-chat",
      baseUrl: OPPER_BASE_URL,
      authKind: "key",
      liveModels: true,
      preserveCustomDestination: true,
      defaultModel: "claude-sonnet-4-6",
    });
    expect(entry.allowBaseUrlOverride).toBeUndefined();
    expect(entry.models).toContain(entry.defaultModel!);
    for (const id of entry.models ?? []) {
      // Pool names carry no vendor prefix; Opper resolves the route per request.
      expect(id).toMatch(/^[a-z0-9.-]+$/);
      expect(entry.modelContextWindows?.[id]).toBeGreaterThan(0);
      expect(entry.modelMaxOutputTokens?.[id]).toBeGreaterThan(0);
      expect(entry.modelMaxOutputTokens?.[id]).toBeLessThanOrEqual(entry.modelContextWindows?.[id] ?? 0);
      expect(entry.modelInputModalities?.[id]?.[0]).toBe("text");
    }
    // Only pools whose every member takes images advertise the image modality.
    expect(entry.modelInputModalities?.["claude-sonnet-4-6"]).toEqual(["text", "image"]);
    expect(entry.modelInputModalities?.["deepseek-v4-pro"]).toEqual(["text"]);
    expect(entry.modelInputModalities?.["kimi-k3"]).toEqual(["text"]);
  });

  test("derives the key-login preset and config seed from the registry row", () => {
    const entry = registryEntry();
    expect(KEY_LOGIN_PROVIDERS.opper).toMatchObject({
      label: "Opper",
      adapter: "openai-chat",
      baseUrl: OPPER_BASE_URL,
      defaultModel: "claude-sonnet-4-6",
    });
    expect(deriveProviderPresets().find(row => row.id === "opper")).toMatchObject({ auth: "key" });
    const seed = providerConfigSeed(entry);
    expect(seed).toMatchObject({
      adapter: "openai-chat",
      baseUrl: OPPER_BASE_URL,
      liveModels: true,
      models: entry.models,
      modelContextWindows: entry.modelContextWindows,
    });
    expect(seed).not.toHaveProperty("preserveCustomDestination");
    expect(seed).not.toHaveProperty("note");
  });

  test("uses the authenticated compat model list for key validation", () => {
    // The original provider author reported that /v3/compat/models answers 401 without a key;
    // this test statically pins the resulting registry policy and URL, not that upstream behavior.
    expect(registryEntry().apiKeyValidation).toBeUndefined();
    expect(resolveProviderModelDiscoveryUrl(
      "opper",
      { adapter: "openai-chat", baseUrl: OPPER_BASE_URL, authMode: "key" },
      OPPER_BASE_URL,
      `${OPPER_BASE_URL}/models`,
    )).toBe("https://api.opper.ai/v3/compat/models");
  });

  test("routes the provider prefix and forwards pool and pinned model ids unchanged", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "opper",
      providers: {
        opper: { ...providerConfigSeed(registryEntry()), apiKey: "test-key" },
      },
    };
    // Bare pool id: Opper picks the provider.
    const pooled = routeModel(config, "opper/claude-sonnet-4-6");
    expect(pooled.modelId).toBe("claude-sonnet-4-6");
    expect(pooled.provider.baseUrl).toBe(OPPER_BASE_URL);
    expect(pooled.provider.adapter).toBe("openai-chat");
    // Vendor-prefixed id pins one route; the extra slash must survive the provider split.
    const pinned = routeModel(config, "opper/anthropic/claude-sonnet-4-6");
    expect(pinned.modelId).toBe("anthropic/claude-sonnet-4-6");
    expect(pinned.provider.baseUrl).toBe(OPPER_BASE_URL);
  });

  test("ships a masked single-ink mark and a brand display name in the dashboard", () => {
    expect(providerIconSrc("opper")).toBe("/provider-icons/opper.svg");
    expect(providerIconPaint(providerIconSrc("opper"))).toBe("mask");
    expect(formatProviderDisplayName("opper", englishT)).toBe("Opper");
  });
});
