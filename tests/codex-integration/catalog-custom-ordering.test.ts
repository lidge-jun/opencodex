import { afterEach, describe, expect, test } from "bun:test";
import fixture from "../fixtures/opengateway-models.json";
import { buildCatalogEntries, gatherRoutedModels } from "../../src/codex/catalog";
import { resolveSlugAliasCollisions } from "../../src/codex/catalog/aggregation";
import { CODEX_CUSTOM_MODEL_CATALOG_KIND } from "../../src/codex/catalog/parsing";
import { clearModelCache } from "../../src/codex/model-cache";
import { providerConfigSeed } from "../../src/providers/derive";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { withStubbedProviderFetch } from "../helpers/catalog-provider-fetch";
import type { OcxConfig } from "../../src/types";

// A custom row that replaces a discovered row of a provider with declared discovery order
// (preferFirst) keeps that row's slot; other providers keep discovered rows first, custom rows after.
const entry = PROVIDER_REGISTRY.find(row => row.id === "opengateway")!;
const discovered = ["deepseek/deepseek-v4.1-flash-ultrafast", "z-ai/glm-5.3-flash-ultrafast", "openai/o4-mini", "openai/o3-pro"];
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache("opengateway");
  clearModelCache("static");
});

function openGatewayConfig(customModels: OcxConfig["customModels"]): OcxConfig {
  const provider = { ...providerConfigSeed(entry), apiKey: "test-key" };
  return withStubbedProviderFetch({
    port: 10100,
    defaultProvider: "opengateway",
    providers: { opengateway: provider },
    customModels,
  } as OcxConfig);
}

async function gatheredOpenGateway(config: OcxConfig) {
  return (await gatherRoutedModels(config)).filter(row => row.provider === "opengateway");
}

const sionicRow = (id: string) => ({ id, object: "model", status: "active", endpoints: ["chat_completions"], providers: [{ id: "sionic-ai" }] });

describe("custom rows in a preferFirst provider", () => {
  test("a custom row replacing a preferred OpenGateway model keeps the discovered slot", async () => {
    globalThis.fetch = (async () => Response.json(fixture)) as unknown as typeof fetch;
    const config = openGatewayConfig([
      { id: "u1", provider: "opengateway", modelId: discovered[0]!, displayName: "Pinned DS", contextWindow: 200000 },
    ]);
    for (let pass = 0; pass < 2; pass++) {
      const rows = await gatheredOpenGateway(config);
      expect(rows.map(row => row.id)).toEqual(discovered);
      expect(rows[0]).toMatchObject({ catalogKind: CODEX_CUSTOM_MODEL_CATALOG_KIND, displayName: "Pinned DS", contextWindow: 200000 });
      expect(rows.filter(row => row.id === discovered[0]).length).toBe(1);
      const catalog = buildCatalogEntries(null, [], rows);
      expect(catalog.map(row => row.slug)).toEqual(discovered.map(id => `opengateway/${id.replaceAll("/", "-")}`));
      expect(catalog.slice().sort((a, b) => Number(a.priority) - Number(b.priority)).map(row => row.slug))
        .toEqual(catalog.map(row => row.slug));
    }
  });

  test("an encoded-slug custom row takes the slot of the discovered row it collides with", async () => {
    globalThis.fetch = (async () => Response.json(fixture)) as unknown as typeof fetch;
    const rows = await gatheredOpenGateway(openGatewayConfig([
      { id: "u2", provider: "opengateway", modelId: "z-ai-glm-5.3-flash-ultrafast", displayName: "Hyphen GLM" },
    ]));
    expect(rows.map(row => row.id)).toEqual([discovered[0], "z-ai-glm-5.3-flash-ultrafast", discovered[2], discovered[3]]);
    expect(rows[1]).toMatchObject({ catalogKind: CODEX_CUSTOM_MODEL_CATALOG_KIND, displayName: "Hyphen GLM" });
  });

  test("an unmatched custom row is still appended after discovered rows", async () => {
    globalThis.fetch = (async () => Response.json(fixture)) as unknown as typeof fetch;
    const rows = await gatheredOpenGateway(openGatewayConfig([
      { id: "u3", provider: "opengateway", modelId: "vendor/not-in-catalog" },
    ]));
    expect(rows.map(row => row.id)).toEqual([...discovered, "vendor/not-in-catalog"]);
  });

  test("cold-start seeds keep a replaced seed's slot when discovery fails", async () => {
    clearModelCache("opengateway");
    globalThis.fetch = (async () => new Response("unavailable", { status: 500 })) as unknown as typeof fetch;
    const seeds = entry.models!;
    const rows = await gatheredOpenGateway(openGatewayConfig([
      { id: "u4", provider: "opengateway", modelId: seeds[0]!, displayName: "Pinned seed" },
    ]));
    expect(rows.map(row => row.id)).toEqual(seeds);
    expect(rows[0]).toMatchObject({ catalogKind: CODEX_CUSTOM_MODEL_CATALOG_KIND, displayName: "Pinned seed" });
  });

  test("a slug shared by two discovered rows and two custom rows yields one slot with both custom rows", async () => {
    const ids = ["other/first", "acme/x", "acme-x", "other/last"];
    globalThis.fetch = (async () => Response.json({ object: "list", data: ids.map(sionicRow) })) as unknown as typeof fetch;
    const rows = (await gatheredOpenGateway(openGatewayConfig([
      { id: "c1", provider: "opengateway", modelId: "acme/x", displayName: "C1" },
      { id: "c2", provider: "opengateway", modelId: "acme-x", displayName: "C2" },
    ]))).filter(row => ids.includes(row.id));
    expect(rows.map(row => row.id)).toEqual(["other/first", "acme/x", "acme-x", "other/last"]);
    expect(rows.slice(1, 3).map(row => [row.catalogKind, row.displayName]))
      .toEqual([[CODEX_CUSTOM_MODEL_CATALOG_KIND, "C1"], [CODEX_CUSTOM_MODEL_CATALOG_KIND, "C2"]]);
    const skipped = resolveSlugAliasCollisions(rows);
    expect(rows.filter(row => !skipped.has(row) && (row.id === "acme/x" || row.id === "acme-x")).map(row => row.displayName))
      .toEqual(["C2"]);
  });
});

describe("custom rows in a provider without preferFirst", () => {
  test("keep the historical order: discovered rows alphabetically, then custom rows", async () => {
    const config = {
      port: 10100,
      defaultProvider: "static",
      providers: {
        static: { adapter: "openai-chat", baseUrl: "https://static.invalid/v1", apiKey: "k", liveModels: false, models: ["c", "a", "b"] },
      },
      customModels: [{ id: "s1", provider: "static", modelId: "a", displayName: "Custom A" }],
    } as unknown as OcxConfig;
    const rows = (await gatherRoutedModels(config)).filter(row => row.provider === "static");
    expect(rows.map(row => row.id)).toEqual(["b", "c", "a"]);
    expect(rows[2]).toMatchObject({ catalogKind: CODEX_CUSTOM_MODEL_CATALOG_KIND, displayName: "Custom A" });
  });
});
