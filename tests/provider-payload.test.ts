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

  test.each(["openai", "openai-multi"] as const)("posts the immutable canonical %s seed under its reserved id", id => {
    const preset = deriveProviderPresets().find(row => row.id === id)!;
    const registry = PROVIDER_REGISTRY.find(row => row.id === id)!;
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
    expect(result).toEqual({ name: id, provider: providerConfigSeed(registry) });
    expect(preset).toEqual(originalPreset);
    expect(result.provider).not.toBe(preset.provider);
    expect(result.provider).not.toHaveProperty("codexAccountMode");
    expect(result.provider).not.toHaveProperty("virtualModels");
    expect(result.provider).not.toHaveProperty("note");
  });

  test.each([
    ["openai", "prov.openaiDirectDesc"],
    ["openai-multi", "prov.openaiMultiDesc"],
  ] as const)("reserved %s uses localized copy and never API-key setup semantics", (id, expectedKey) => {
    const preset = deriveProviderPresets().find(row => row.id === id)!;
    expect(isReservedCodexForwardPreset(preset)).toBe(true);
    expect(codexPresetDescriptionKey(preset)).toBe(expectedKey);
    for (const locale of [en, ko, de, zh]) {
      expect(locale[expectedKey].trim().length).toBeGreaterThan(0);
      expect(locale[expectedKey]).not.toBe(preset.note);
      expect(locale[expectedKey].toLowerCase()).not.toContain("api key");
    }
  });

  test("reserved preset ids own detail copy even when mode metadata is absent or forged", () => {
    expect(codexPresetDescriptionKey({ id: "openai-multi" })).toBe("prov.openaiMultiDesc");
    expect(codexPresetDescriptionKey({ id: "openai-multi", codexAccountMode: "direct" })).toBe("prov.openaiMultiDesc");
    expect(codexPresetDescriptionKey({ id: "openai", codexAccountMode: "pool" })).toBe("prov.openaiDirectDesc");
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
