import { afterEach, describe, expect, test } from "bun:test";
import {
  mergeConfiguredModelsIntoLiveCatalog,
  shouldRetainConfiguredProviderModel,
} from "../src/codex/catalog/provider-fetch";
import { gatherRoutedModels as gatherRoutedModelsDirect, resetCatalogRuntimeStateForTests } from "../src/codex/catalog";
import { clearModelCache } from "../src/codex/model-cache";
import { withStubbedProviderFetch } from "./helpers/catalog-provider-fetch";
import type { OcxConfig } from "../src/types";
import type { OcxProviderConfig } from "../src/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache();
  resetCatalogRuntimeStateForTests();
});

function stubLiveModels(ids: string[]): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (!String(input).includes("/models")) return new Response(null, { status: 404 });
    return Response.json({ data: ids.map(id => ({ id })) });
  }) as typeof fetch;
}

function discoveryConfig(prov: Partial<OcxProviderConfig>): OcxConfig {
  return withStubbedProviderFetch({
    port: 10100,
    defaultProvider: "demo",
    providers: {
      demo: {
        adapter: "openai-chat",
        baseUrl: "https://api.example.test/v1",
        apiKey: "k",
        liveModels: true,
        ...prov,
      },
    },
  } as unknown as OcxConfig);
}

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
  test("merge only retains what the caller seeded — the union happens at discovery", () => {
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

describe("retainModels through provider discovery (#1690)", () => {
  test("a retain-only id survives live discovery that omits it, with provider hints applied", async () => {
    stubLiveModels(["live-id"]);
    const models = await gatherRoutedModelsDirect(discoveryConfig({
      models: ["seen-id"],
      retainModels: ["retained-only"],
      modelContextWindows: { "retained-only": 123_456 },
    }));
    const demo = models.filter(m => m.provider === "demo");
    expect(demo.map(m => m.id).sort()).toEqual(["live-id", "retained-only"]);
    expect(demo.find(m => m.id === "retained-only")?.contextWindow).toBe(123_456);
  });

  test("a retained id the live catalog also returns yields one row", async () => {
    stubLiveModels(["both-id"]);
    const models = await gatherRoutedModelsDirect(discoveryConfig({ retainModels: ["both-id"] }));
    expect(models.filter(m => m.provider === "demo").map(m => m.id)).toEqual(["both-id"]);
  });

  test("liveModels: false lists retainModels alongside models", async () => {
    const models = await gatherRoutedModelsDirect(discoveryConfig({
      liveModels: false,
      models: ["static-id"],
      retainModels: ["static-id", "retained-only"],
    }));
    expect(models.filter(m => m.provider === "demo").map(m => m.id).sort()).toEqual(["retained-only", "static-id"]);
  });

  test("absent retainModels keeps today's drop behavior", async () => {
    stubLiveModels(["live-id"]);
    const models = await gatherRoutedModelsDirect(discoveryConfig({ models: ["unseen-id"] }));
    expect(models.filter(m => m.provider === "demo").map(m => m.id)).toEqual(["live-id"]);
  });
});
