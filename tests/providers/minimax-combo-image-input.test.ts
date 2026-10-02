import { afterEach, describe, expect, test } from "bun:test";
import { comboImagesSupported } from "../../gui/src/combo-capabilities";
import { applyProviderConfigHints, deriveComboCatalogModel, gatherRoutedModels } from "../../src/codex/catalog";
import { clearModelCache } from "../../src/codex/model-cache";
import { enrichProviderFromRegistry, providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { listManagementModelRows } from "../../src/server/management/model-rows";
import { isModelVisionSidecarConsumer } from "../../src/vision/eligibility";
import type { CatalogModel, OcxConfig, OcxProviderConfig } from "../../src/types";

const M3 = "MiniMax-M3";
const PREVIEW = "MiniMax-M3.1-Flash-Preview";
const REGIONS = ["minimax", "minimax-cn"] as const;
const originalFetch = globalThis.fetch;

function seeded(region: typeof REGIONS[number]): OcxProviderConfig {
  const entry = getProviderRegistryEntry(region);
  if (!entry) throw new Error(`missing ${region} registry entry`);
  return { ...providerConfigSeed(entry), apiKey: "test-key" };
}

function config(region: typeof REGIONS[number], provider = seeded(region)): OcxConfig {
  return { port: 10100, defaultProvider: region, providers: { [region]: provider } } as OcxConfig;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache();
});

describe("MiniMax Coding Plan Combo image input", () => {
  test("both presets seed M3 image input and enrich missing saved declarations without replacing overrides", () => {
    for (const region of REGIONS) {
      const fresh = seeded(region);
      expect(fresh.modelInputModalities?.[M3]).toEqual(["text", "image"]);
      expect(fresh.modelInputModalities?.[PREVIEW]).toEqual(["text", "image"]);
      expect(fresh.modelInputModalities?.["MiniMax-M2.7"]).toBeUndefined();

      const saved: OcxProviderConfig = {
        adapter: "openai-chat", baseUrl: fresh.baseUrl,
        modelInputModalities: { "MiniMax-M2.7": ["text"] },
        modelCapabilities: { [M3]: { inputModalities: ["text"] } },
      };
      enrichProviderFromRegistry(region, saved);
      expect(saved.modelInputModalities).toMatchObject({
        [M3]: ["text", "image"], [PREVIEW]: ["text", "image"], "MiniMax-M2.7": ["text"],
      });
      expect(saved.modelCapabilities?.[M3]?.inputModalities).toEqual(["text"]);
      expect(isModelVisionSidecarConsumer(saved, M3)).toBe(true);
      expect(applyProviderConfigHints(region, saved, { provider: region, id: M3 }).inputModalities)
        .toEqual(["text", "image"]); // explicit text-only uses the existing vision sidecar
      expect(isModelVisionSidecarConsumer(fresh, M3)).toBe(false);
    }
  });

  test("id-only discovery and a warm cache yield management rows accepted by the Combo picker", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (!String(input).includes("/models")) throw new Error("unexpected request");
      return Response.json({ data: [{ id: M3 }] });
    }) as typeof fetch;

    for (const region of REGIONS) {
      const live = config(region);
      const first = await gatherRoutedModels(live);
      const cached = await gatherRoutedModels(live);
      for (const models of [first, cached]) {
        const m3 = models.find(model => model.provider === region && model.id === M3);
        expect(m3?.inputModalities).toEqual(["text", "image"]);
        const rows = await listManagementModelRows(live, { models });
        const row = rows.find(model => model.provider === region && model.id === M3);
        expect(row?.inputModalities).toEqual(["text", "image"]);
        expect(comboImagesSupported([{ provider: region, model: M3 }], rows)).toBe(true);
        expect(comboImagesSupported(
          [{ provider: region, model: M3 }, { provider: "other", model: "vision" }],
          [...rows, { provider: "other", id: "vision", inputModalities: ["text", "image"] }],
        )).toBe(true);
        expect(comboImagesSupported(
          [{ provider: region, model: M3 }, { provider: "other", model: "blind" }],
          [...rows, { provider: "other", id: "blind", inputModalities: ["text"] }],
        )).toBe(false);
      }
    }
  });

  test("static fallback and Combo catalog retain image unless the operator disables it", async () => {
    for (const region of REGIONS) {
      const provider = seeded(region);
      provider.liveModels = false;
      const models = await gatherRoutedModels(config(region, provider));
      const member = models.find(model => model.provider === region && model.id === M3);
      expect(member?.inputModalities).toEqual(["text", "image"]);
      const combo = (imageInput: "auto" | "disabled") => ({
        targets: [{ provider: region, model: M3 }], imageInput, defaultEffort: "medium",
      }) as never;
      expect(deriveComboCatalogModel("minimax-image", combo("auto"), [member as CatalogModel])?.inputModalities)
        .toContain("image");
      expect(deriveComboCatalogModel("minimax-image", combo("disabled"), [member as CatalogModel])?.inputModalities)
        .toEqual(["text"]);
    }
  });
});
