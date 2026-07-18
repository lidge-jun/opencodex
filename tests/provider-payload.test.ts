import { describe, expect, test } from "bun:test";
import {
  buildProviderPayload,
  buildProviderPostBody,
  codexPresetDescriptionKey,
  isReservedCodexForwardPreset,
} from "../gui/src/provider-payload";
import { en } from "../gui/src/i18n/en";
import { ko } from "../gui/src/i18n/ko";
import { de } from "../gui/src/i18n/de";
import { zh } from "../gui/src/i18n/zh";
import { deriveProviderPresets, providerConfigSeed } from "../src/providers/derive";
import { PROVIDER_REGISTRY } from "../src/providers/registry";

describe("provider dashboard payload", () => {
  test("persists explicit API-key mode for built-in OAuth providers", () => {
    expect(buildProviderPayload({
      name: "xai",
      adapter: " openai-chat ",
      baseUrl: " https://api.x.ai/v1 ",
      authMode: "key",
      apiKey: " xai-key ",
      defaultModel: " grok-4.5 ",
    })).toEqual({
      adapter: "openai-chat",
      baseUrl: "https://api.x.ai/v1",
      authMode: "key",
      apiKey: "xai-key",
      defaultModel: "grok-4.5",
    });
  });

  test("does not persist secrets for forward or local modes", () => {
    const base = {
      name: "local",
      adapter: "openai-responses",
      baseUrl: "https://example.test/v1",
      apiKey: "must-not-leak",
      defaultModel: "",
    };
    expect(buildProviderPayload({ ...base, authMode: "forward" })).toEqual({
      adapter: "openai-responses",
      baseUrl: "https://example.test/v1",
      authMode: "forward",
    });
    expect(buildProviderPayload({ ...base, authMode: "local" })).toEqual({
      adapter: "openai-responses",
      baseUrl: "https://example.test/v1",
    });
  });

  test("posts the immutable canonical OpenAI Pool seed under its reserved id", () => {
    const preset = deriveProviderPresets().find(row => row.id === "openai")!;
    const registry = PROVIDER_REGISTRY.find(row => row.id === "openai")!;
    const originalPreset = structuredClone(preset);
    const form = {
      name: "attacker-name",
      adapter: "openai-chat",
      baseUrl: "https://attacker.example/v1",
      authMode: "key" as const,
      apiKey: "must-not-leak",
      defaultModel: "attacker-model",
    };
    const result = buildProviderPostBody(preset, form);
    expect(result).toEqual({ name: "openai", provider: providerConfigSeed(registry) });
    expect(preset).toEqual(originalPreset);
    expect(result.provider).not.toBe(preset.provider);
    expect(result.provider.codexAccountMode).toBe("pool");
    expect(result.provider).not.toHaveProperty("virtualModels");
    expect(result.provider).not.toHaveProperty("note");
  });

  test.each([
    ["pool", "prov.openaiPoolDesc"],
    ["direct", "prov.openaiDirectDesc"],
  ] as const)("reserved OpenAI %s mode uses localized copy and never API-key setup semantics", (mode, expectedKey) => {
    const preset = { ...deriveProviderPresets().find(row => row.id === "openai")!, codexAccountMode: mode };
    expect(isReservedCodexForwardPreset(preset)).toBe(true);
    expect(codexPresetDescriptionKey(preset)).toBe(expectedKey);
    for (const locale of [en, ko, de, zh]) {
      expect(locale[expectedKey].trim().length).toBeGreaterThan(0);
      expect(locale[expectedKey]).not.toBe(preset.note);
      expect(locale[expectedKey].toLowerCase()).not.toContain("api key");
    }
  });

  test("only OpenAI is reserved and missing mode resolves to Pool copy", () => {
    expect(isReservedCodexForwardPreset({ id: "openai-multi" })).toBe(false);
    expect(deriveProviderPresets().find(row => row.id === "openai-multi")).toBeUndefined();
    expect(codexPresetDescriptionKey({ id: "openai-multi", codexAccountMode: "direct" })).toBeNull();
    expect(codexPresetDescriptionKey({ id: "openai" })).toBe("prov.openaiPoolDesc");
    expect(codexPresetDescriptionKey({ id: "openai", codexAccountMode: "pool" })).toBe("prov.openaiPoolDesc");
    expect(codexPresetDescriptionKey({ id: "openai", codexAccountMode: "direct" })).toBe("prov.openaiDirectDesc");
  });

  test("reserved presets fail locally without a canonical seed", () => {
    expect(() => buildProviderPostBody({ id: "openai" }, {
      name: "openai",
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward",
      apiKey: "",
      defaultModel: "",
    })).toThrow("Missing canonical provider seed");
  });

  test("API and custom presets preserve form-owned names and payload behavior", () => {
    const form = {
      name: " custom-api ",
      adapter: " openai-chat ",
      baseUrl: " https://api.example.test/v1 ",
      authMode: "key" as const,
      apiKey: " secret ",
      defaultModel: " model ",
    };
    expect(buildProviderPostBody({ id: "openai-apikey" }, form)).toEqual({
      name: "custom-api",
      provider: buildProviderPayload(form),
    });
  });
});
