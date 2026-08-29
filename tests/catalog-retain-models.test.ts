import { describe, expect, test } from "bun:test";
import {
  mergeConfiguredModelsIntoLiveCatalog,
  shouldRetainConfiguredProviderModel,
} from "../src/codex/catalog/provider-fetch";
import type { OcxProviderConfig } from "../src/types";

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://example.test/v1",
    apiKey: "sk-test",
    authMode: "key",
    ...overrides,
  };
}

function configured(ids: string[]) {
  return ids.map(id => ({ id, provider: "demo" }));
}

function live(ids: string[]) {
  return ids.map(id => ({ id, provider: "demo" }));
}

describe("shouldRetainConfiguredProviderModel", () => {
  test("empty retainModels does not change behavior", () => {
    expect(shouldRetainConfiguredProviderModel("demo", "any-id")).toBe(false);
    expect(shouldRetainConfiguredProviderModel("demo", "any-id", provider())).toBe(false);
    expect(
      shouldRetainConfiguredProviderModel("demo", "any-id", provider({ retainModels: [] })),
    ).toBe(false);
  });

  test("retainModels preserves listed id", () => {
    expect(
      shouldRetainConfiguredProviderModel(
        "demo",
        "kept-id",
        provider({ retainModels: ["kept-id", "another"] }),
      ),
    ).toBe(true);
  });

  test("retainModels supports the family-suffix matcher used elsewhere", () => {
    // modelInList treats entries ending with ":tag" as a wildcard for `id:tag` siblings.
    expect(
      shouldRetainConfiguredProviderModel(
        "demo",
        "kimi-k2.5:free",
        provider({ retainModels: ["kimi-k2.5:free"] }),
      ),
    ).toBe(true);
    expect(
      shouldRetainConfiguredProviderModel(
        "demo",
        "kimi-k2.5:free",
        provider({ retainModels: ["kimi-k2.5"] }),
      ),
    ).toBe(true);
  });

  test("built-in kimi / xai hardcoded tables still win", () => {
    // Mirrors the canonical compatibility allow-list; ensures the new branch is purely additive.
    expect(shouldRetainConfiguredProviderModel("kimi", "k3[1m]")).toBe(true);
    expect(shouldRetainConfiguredProviderModel("xai", "grok-4.3")).toBe(true);
    expect(shouldRetainConfiguredProviderModel("opencode-free", "big-pickle")).toBe(true);
  });
});

describe("mergeConfiguredModelsIntoLiveCatalog with retainModels", () => {
  test("retainModels is purely retentive — does not invent ids not in `models`", () => {
    const prov = provider({
      models: ["configured-id"],
      retainModels: ["configured-id", "ghost-id"],
    });
    const { models, droppedConfiguredIds } = mergeConfiguredModelsIntoLiveCatalog({
      name: "demo",
      provider: prov,
      models: live([]),
      configured: configured(["configured-id"]),
    });
    expect(models.map(m => m.id)).toEqual(["configured-id"]);
    expect(droppedConfiguredIds).toEqual([]);
  });

  test("retainModels keeps a configured id when live discovery omits it", () => {
    const prov = provider({
      models: ["kept-id", "dropped-id"],
      retainModels: ["kept-id"],
    });
    const { models, droppedConfiguredIds } = mergeConfiguredModelsIntoLiveCatalog({
      name: "demo",
      provider: prov,
      models: live(["other-live-id"]),
      configured: configured(["kept-id", "dropped-id"]),
    });
    expect(models.map(m => m.id).sort()).toEqual(["kept-id", "other-live-id"]);
    expect(droppedConfiguredIds).toEqual(["dropped-id"]);
  });

  test("live discovery empty (404-style) still keeps retained rows and surfaces the rest", () => {
    const prov = provider({
      models: ["kept-id", "dropped-id"],
      retainModels: ["kept-id"],
    });
    const { models, droppedConfiguredIds } = mergeConfiguredModelsIntoLiveCatalog({
      name: "demo",
      provider: prov,
      models: live([]),
      configured: configured(["kept-id", "dropped-id"]),
    });
    expect(models.map(m => m.id)).toEqual(["kept-id"]);
    expect(droppedConfiguredIds).toEqual(["dropped-id"]);
  });
});
