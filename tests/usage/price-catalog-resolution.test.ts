import { describe, expect, test } from "bun:test";
import { costResult } from "../../src/server/management/shared";
import { estimateRequestCost, resolveMatchedPrice } from "../../src/usage/cost";
import { refreshPriceCatalogs } from "../../src/usage/price-catalog";
import { refreshUserCostOverlays } from "../../src/usage/user-cost-overlays";
import type { OcxConfig } from "../../src/types";
import { installCatalogSandbox, MODELS_DEV_URL } from "../helpers/price-catalog-fixtures";

const sandbox = installCatalogSandbox();
const USAGE = { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedInputTokens: 0, cacheCreationInputTokens: 0 };
const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function configure(providers: Record<string, Record<string, unknown>>): void {
  refreshUserCostOverlays({
    port: 0,
    defaultProvider: Object.keys(providers)[0] ?? "none",
    providers: Object.fromEntries(Object.entries(providers).map(([name, extra]) =>
      [name, { adapter: "openai-chat", baseUrl: "https://relay.example.invalid/v1", models: [], ...extra }])),
  } as unknown as OcxConfig);
}

async function loadCatalog(): Promise<void> {
  sandbox.feeds.serve(MODELS_DEV_URL, {
    deepseek: { models: { "zephyr-flash-2": { cost: { input: 0.1, output: 0.4 } } } },
    openai: { models: { "gpt-6.1-terra": { cost: { input: 99, output: 99 } } } },
  });
  await refreshPriceCatalogs();
}

describe("price resolution tiers", () => {
  test("a catalog price is a verified-derived estimate and names its source", async () => {
    configure({ acme: {} });
    await loadCatalog();
    const price = resolveMatchedPrice("acme", "zephyr-flash-2")!;
    expect(price).toMatchObject({ source: "models-dev", status: "verified-derived", cost4: { input: 0.1, output: 0.4 }, sourceRef: "https://models.dev/api.json" });
    expect(Date.parse(price.verifiedAt!)).not.toBeNaN();
    const estimate = estimateRequestCost({ provider: "acme", model: "zephyr-flash-2", usage: USAGE, usageStatus: "reported" })!;
    expect(estimate.estimated).toBe(true);
    expect(estimate.cost.total).toBeCloseTo(0.5, 9);
    expect(resolveMatchedPrice("acme", "unknown-model-9")).toBeNull();
  });

  test("OpenRouter prices a model models.dev does not list", async () => {
    configure({ acme: {} });
    await refreshPriceCatalogs();
    expect(resolveMatchedPrice("acme", "orb-only-7")).toMatchObject({ source: "openrouter", status: "verified-derived" });
  });

  test("a manual price beats the catalog, and manual zero rates still win", async () => {
    configure({ acme: { modelCosts: { "zephyr-flash-2": { input: 7, output: 9, cacheRead: 0, cacheWrite: 0 } } } });
    await loadCatalog();
    expect(resolveMatchedPrice("acme", "zephyr-flash-2")).toMatchObject({ source: "user", cost4: { input: 7, output: 9 } });
    configure({ acme: { modelCosts: { "zephyr-flash-2": ZERO } } });
    const free = resolveMatchedPrice("acme", "zephyr-flash-2")!;
    expect(free.source).toBe("user");
    expect(free.cost4).toEqual(ZERO);
  });

  test("an official price beats the catalog", async () => {
    configure({});
    await loadCatalog();
    const price = resolveMatchedPrice("openai-apikey", "gpt-6.1-terra")!;
    expect(["expected", "jawcode"]).toContain(price.source);
    expect(price.cost4.input).toBe(1);
  });

  test("allowModelLevelFallback: false skips the catalog", async () => {
    configure({ acme: {} });
    await loadCatalog();
    expect(resolveMatchedPrice("acme", "zephyr-flash-2", undefined, undefined, { allowModelLevelFallback: false })).toBeNull();
    expect(resolveMatchedPrice("acme", "zephyr-flash-2")?.source).toBe("models-dev");
  });

  test("a vendor prefix and a channel prefix on the logged id still reach the catalog price", async () => {
    configure({ acme: {} });
    await loadCatalog();
    for (const id of ["cn:zephyr-flash-2", "zd/zephyr-flash-2", "Zephyr.Flash.2"]) {
      expect(resolveMatchedPrice("acme", id)?.cost4.input, id).toBe(0.1);
    }
  });
});

describe("relay price multiplier", () => {
  test("scales catalog and official prices but never a manual price", async () => {
    configure({ relay: { priceMultiplier: 2, modelCosts: { "manual-model-1": { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 } } } });
    await loadCatalog();
    expect(resolveMatchedPrice("relay", "zephyr-flash-2")).toMatchObject({ source: "models-dev", multiplier: 2, cost4: { input: 0.2, output: 0.8 } });
    expect(resolveMatchedPrice("relay", "manual-model-1")).toMatchObject({ source: "user", cost4: { input: 3, output: 4 } });
    expect(resolveMatchedPrice("relay", "manual-model-1")!.multiplier).toBeUndefined();
    configure({ relay: { priceMultiplier: 0.5 }, plain: {} });
    expect(resolveMatchedPrice("relay", "gpt-6.1-terra")!.multiplier).toBe(0.5);
  });

  test("changing or removing the multiplier takes effect on the memoized price", async () => {
    configure({ relay: { priceMultiplier: 2 } });
    await loadCatalog();
    expect(resolveMatchedPrice("relay", "zephyr-flash-2")!.cost4.input).toBeCloseTo(0.2, 12);
    configure({ relay: { priceMultiplier: 10 } });
    expect(resolveMatchedPrice("relay", "zephyr-flash-2")!.cost4.input).toBeCloseTo(1, 12);
    configure({ relay: {} });
    const plain = resolveMatchedPrice("relay", "zephyr-flash-2")!;
    expect(plain.cost4.input).toBeCloseTo(0.1, 12);
    expect(plain.multiplier).toBeUndefined();
  });

  test("an unset multiplier, or one on another provider, changes nothing", async () => {
    configure({ relay: { priceMultiplier: 4 }, plain: {} });
    await loadCatalog();
    expect(resolveMatchedPrice("plain", "zephyr-flash-2")!.cost4.input).toBe(0.1);
    expect(resolveMatchedPrice("plain", "zephyr-flash-2")!.multiplier).toBeUndefined();
  });

  test("the cost estimate uses the scaled rates", async () => {
    configure({ relay: { priceMultiplier: 3 } });
    await loadCatalog();
    const estimate = estimateRequestCost({ provider: "relay", model: "zephyr-flash-2", usage: USAGE, usageStatus: "reported" })!;
    expect(estimate.cost.total).toBeCloseTo(1.5, 9);
  });
});

describe("subscription API-equivalent label", () => {
  test("oauth and forward providers and Codex account identities carry apiEquivalent; key providers do not", async () => {
    configure({
      "sub-oauth": { authMode: "oauth" },
      "sub-forward": { authMode: "forward" },
      "pay-key": { authMode: "key" },
      "pay-default": {},
    });
    await loadCatalog();
    expect(resolveMatchedPrice("sub-oauth", "zephyr-flash-2")!.apiEquivalent).toBe(true);
    expect(resolveMatchedPrice("sub-forward", "zephyr-flash-2")!.apiEquivalent).toBe(true);
    expect(resolveMatchedPrice("openai-main", "gpt-6.1-terra")!.apiEquivalent).toBe(true);
    expect(resolveMatchedPrice("pay-key", "zephyr-flash-2")!.apiEquivalent).toBeUndefined();
    expect(resolveMatchedPrice("pay-default", "zephyr-flash-2")!.apiEquivalent).toBeUndefined();
  });

  test("a manual price on a subscription provider is not relabelled", async () => {
    configure({ "sub-oauth": { authMode: "oauth", modelCosts: { "zephyr-flash-2": { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } } } });
    await loadCatalog();
    expect(resolveMatchedPrice("sub-oauth", "zephyr-flash-2")!.apiEquivalent).toBeUndefined();
  });

  test("switching a provider's auth mode refreshes the label", async () => {
    configure({ flip: { authMode: "key" } });
    await loadCatalog();
    expect(resolveMatchedPrice("flip", "zephyr-flash-2")!.apiEquivalent).toBeUndefined();
    configure({ flip: { authMode: "oauth" } });
    expect(resolveMatchedPrice("flip", "zephyr-flash-2")!.apiEquivalent).toBe(true);
  });
});

describe("cost result reasons", () => {
  const entry = (provider: string, model: string) =>
    ({ provider, model, usage: USAGE, usageStatus: "reported" }) as unknown as Parameters<typeof costResult>[0];
  const reasonsOf = (provider: string, model: string): string[] => {
    const result = costResult(entry(provider, model));
    if (result.kind !== "value") throw new Error(`no estimate for ${provider}/${model}`);
    return result.estimateReasons;
  };

  test("a plain catalog price reports only online_price_catalog", async () => {
    configure({ acme: {} });
    await loadCatalog();
    const reasons = reasonsOf("acme", "zephyr-flash-2");
    expect(reasons).toContain("online_price_catalog");
    expect(reasons).not.toContain("relay_price_multiplier");
    expect(reasons).not.toContain("subscription_api_equivalent");
  });

  test("multiplier and subscription add their reasons", async () => {
    configure({ relay: { priceMultiplier: 2 }, "sub-oauth": { authMode: "oauth" } });
    await loadCatalog();
    expect(reasonsOf("relay", "zephyr-flash-2")).toEqual(expect.arrayContaining(["online_price_catalog", "relay_price_multiplier"]));
    expect(reasonsOf("sub-oauth", "zephyr-flash-2")).toEqual(expect.arrayContaining(["online_price_catalog", "subscription_api_equivalent"]));
  });

  test("a manual price carries provider_cost_overlay and none of the automatic reasons", async () => {
    configure({ relay: { priceMultiplier: 2, modelCosts: { "zephyr-flash-2": { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } } } });
    await loadCatalog();
    const reasons = reasonsOf("relay", "zephyr-flash-2");
    expect(reasons).toContain("provider_cost_overlay");
    for (const reason of ["online_price_catalog", "relay_price_multiplier", "subscription_api_equivalent"]) expect(reasons).not.toContain(reason);
  });
});
