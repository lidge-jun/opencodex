import { describe, expect, test } from "bun:test";
import { filterCatalogVisibleModels, shouldExposeRoutedModel } from "../../src/codex/catalog";

describe("routed catalog compatibility exclusions", () => {
  test("filters incompatible slugs while keeping live control models", () => {
    expect(shouldExposeRoutedModel({ provider: "opencode-go", id: "hy3-preview" })).toBe(false);
    // Issue #2330: uncallable or stale OpenCode Go models
    expect(shouldExposeRoutedModel({ provider: "opencode-go", id: "mimo-v2-omni" })).toBe(false);
    expect(shouldExposeRoutedModel({ provider: "opencode-go", id: "mimo-v2-pro" })).toBe(false);
    // First-party retirement was withdrawn; gateway availability remains independent.
    expect(shouldExposeRoutedModel({ provider: "deepseek", id: "deepseek-v4-pro" })).toBe(true);
    expect(shouldExposeRoutedModel({ provider: "opencode-go", id: "deepseek-v4-pro" })).toBe(false);
    expect(shouldExposeRoutedModel({ provider: "opencode-go", id: "grok-4.6" })).toBe(true);
    expect(shouldExposeRoutedModel({ provider: "opencode-go", id: "glm-5.2" })).toBe(true);
  });
});

describe("disabled model exclusions", () => {
  test("matches raw and encoded exclusions without treating bare routed ids as exclusions", () => {
    const models = [
      { provider: "vendor", id: "org/raw-hidden" },
      { provider: "vendor", id: "org/encoded-hidden" },
      { provider: "vendor", id: "org/bare-visible" },
      { provider: "other", id: "org/raw-hidden" },
      { provider: "combo", id: "native-route", alias: "native-alias", nativeAlias: true },
    ];
    const config = {
      disabledModels: ["vendor/org/raw-hidden", "vendor/org-encoded-hidden", "org/bare-visible", "native-alias"],
      providers: { vendor: {}, other: {} },
    };
    expect(filterCatalogVisibleModels(models, config)).toEqual(models.slice(2));
    expect(filterCatalogVisibleModels(models, {
      ...config,
      disabledModels: [...config.disabledModels, "combo/native-route"],
    })).toEqual(models.slice(2, 4));
  });
});
