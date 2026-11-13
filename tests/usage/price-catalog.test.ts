import { describe, expect, setSystemTime, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  lookupCatalogPrice,
  PRICE_CATALOG_TTL_MS,
  priceCatalogKey,
  refreshPriceCatalogs,
  resetPriceCatalogForTests,
  setPriceCatalogFetchForTests,
} from "../../src/usage/price-catalog";
import { priceCatalogVersion } from "../../src/usage/price-catalog-version";
import { feedFetch, installCatalogSandbox, MODELS_DEV_URL, OPENROUTER_URL } from "../helpers/price-catalog-fixtures";

const sandbox = installCatalogSandbox();
const cacheFile = () => join(sandbox.dir, "price-catalog-cache.json");

describe("price catalog key matching", () => {
  test.each([
    ["cn:zephyr-flash-2", "zephyr-flash-2"],
    ["zd/zephyr-flash-2", "zephyr-flash-2"],
    ["deepseek-ai/Zephyr-Flash-2", "zephyr-flash-2"],
    ["ZEPHYR.FLASH.2", "zephyr-flash-2"],
    ["cn:acme/Moon-Pro-3.1[1m]", "moon-pro-3-1"],
  ])("%s collapses to %s", (id, key) => {
    expect(priceCatalogKey(id)).toBe(key);
  });

  test("a channel prefix, vendor prefixes, case and dots all find the same row", async () => {
    await refreshPriceCatalogs();
    for (const id of ["zephyr-flash-2", "cn:zephyr-flash-2", "zd/zephyr-flash-2", "deepseek-ai/Zephyr-Flash-2", "ZEPHYR-FLASH-2"]) {
      expect(lookupCatalogPrice(id)?.vendorModelId, id).toBe("zephyr-flash-2");
    }
    expect(lookupCatalogPrice("Moon-Pro-3.1")?.cost4).toEqual({ input: 1.5, output: 6, cacheRead: 0, cacheWrite: 0 });
    expect(lookupCatalogPrice("moon-pro-3-1")?.vendor).toBe("moonshotai");
    expect(lookupCatalogPrice("grok-quill-5.5")?.cost4).toEqual({ input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 });
    expect(lookupCatalogPrice("unknown-model-9")).toBeNull();
  });

  test("a key claimed by two rows with different prices in one source answers nothing", async () => {
    await refreshPriceCatalogs();
    expect(lookupCatalogPrice("twin-1")).toBeNull();
    expect(lookupCatalogPrice("dup-2")).toBeNull();
    expect(lookupCatalogPrice("same-1")?.cost4).toMatchObject({ input: 5, output: 6 });
  });

  test("models.dev providers that are not the model's own vendor are ignored", async () => {
    await refreshPriceCatalogs();
    expect(lookupCatalogPrice("reseller-only-1")).toBeNull();
    expect(lookupCatalogPrice("zephyr-flash-2")).toMatchObject({ source: "models-dev", vendor: "deepseek", cost4: { input: 0.1 } });
  });

  test("zero, missing and negative rates are skipped", async () => {
    await refreshPriceCatalogs();
    for (const id of ["gem-free-4", "gem-nocost-4", "gem-badrate-4", "negative-1"]) expect(lookupCatalogPrice(id), id).toBeNull();
  });

  test("models.dev rates are already per 1M tokens and a missing cache rate is zero", async () => {
    await refreshPriceCatalogs();
    expect(lookupCatalogPrice("zephyr-flash-2")).toMatchObject({
      source: "models-dev",
      url: MODELS_DEV_URL,
      cost4: { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0.2 },
    });
  });

  test("OpenRouter per-token prices become per-1M rates", async () => {
    await refreshPriceCatalogs();
    const price = lookupCatalogPrice("orb-only-7")!;
    expect(price).toMatchObject({ source: "openrouter", vendor: "acme", vendorModelId: "acme/orb-only-7", url: OPENROUTER_URL });
    expect(price.cost4.input).toBeCloseTo(0.5, 9);
    expect(price.cost4.output).toBeCloseTo(2, 9);
    expect(price.cost4.cacheRead).toBeCloseTo(0.1, 9);
    expect(price.cost4.cacheWrite).toBeCloseTo(1.25, 9);
  });

  test("OpenRouter :free variants and openrouter/ ids are ignored", async () => {
    await refreshPriceCatalogs();
    expect(lookupCatalogPrice("free-only-1")).toBeNull();
    expect(lookupCatalogPrice("auto")).toBeNull();
  });

  test("models.dev outranks OpenRouter for a model both list", async () => {
    await refreshPriceCatalogs();
    expect(lookupCatalogPrice("zephyr-flash-2")?.source).toBe("models-dev");
    sandbox.feeds.serve(MODELS_DEV_URL, { deepseek: { models: { "other-3": { cost: { input: 1, output: 1 } } } } });
    await refreshPriceCatalogs({ force: true });
    expect(lookupCatalogPrice("zephyr-flash-2")?.source).toBe("openrouter");
  });
});

describe("price catalog cache", () => {
  test("a refresh persists both snapshots and reports per-source status", async () => {
    const before = priceCatalogVersion();
    const status = await refreshPriceCatalogs();
    expect(status["models-dev"]).toMatchObject({ ok: true, count: 4 });
    expect(status["openrouter"]).toMatchObject({ ok: true, count: 2 });
    expect(Date.parse(status["models-dev"].fetchedAt!)).not.toBeNaN();
    expect(priceCatalogVersion()).toBeGreaterThan(before);
    const file = JSON.parse(readFileSync(cacheFile(), "utf8"));
    expect(file.version).toBe(1);
    expect(Object.keys(file.sources).sort()).toEqual(["models-dev", "openrouter"]);
  });

  test("a fresh cache is not refetched, an expired one is", async () => {
    const start = Date.now();
    await refreshPriceCatalogs();
    expect(sandbox.feeds.calls).toHaveLength(2);
    setSystemTime(start + PRICE_CATALOG_TTL_MS - 1000);
    await refreshPriceCatalogs();
    expect(sandbox.feeds.calls).toHaveLength(2);
    setSystemTime(start + PRICE_CATALOG_TTL_MS + 60_000);
    await refreshPriceCatalogs();
    expect(sandbox.feeds.callsTo(MODELS_DEV_URL)).toBe(2);
    expect(sandbox.feeds.callsTo(OPENROUTER_URL)).toBe(2);
  });

  test("a fresh cache file from a previous process is read without any fetch", async () => {
    await refreshPriceCatalogs();
    resetPriceCatalogForTests();
    const feeds = feedFetch();
    setPriceCatalogFetchForTests(feeds.fetch);
    expect(lookupCatalogPrice("zephyr-flash-2")?.source).toBe("models-dev");
    await refreshPriceCatalogs();
    expect(feeds.calls).toHaveLength(0);
  });

  test("concurrent refreshes coalesce into one fetch per source", async () => {
    const release = sandbox.feeds.hold();
    const runs = [refreshPriceCatalogs(), refreshPriceCatalogs(), refreshPriceCatalogs()];
    release();
    const results = await Promise.all(runs);
    expect(sandbox.feeds.callsTo(MODELS_DEV_URL)).toBe(1);
    expect(sandbox.feeds.callsTo(OPENROUTER_URL)).toBe(1);
    for (const result of results) expect(result["models-dev"].ok).toBe(true);
  });

  test("offline keeps the previous snapshot and answers with a short error code", async () => {
    const start = Date.now();
    await refreshPriceCatalogs();
    sandbox.feeds.failing.add(MODELS_DEV_URL);
    sandbox.feeds.failing.add(OPENROUTER_URL);
    setSystemTime(start + PRICE_CATALOG_TTL_MS + 60_000);
    const status = await refreshPriceCatalogs();
    expect(status["models-dev"]).toEqual({ ok: false, error: "fetch_failed" });
    expect(lookupCatalogPrice("zephyr-flash-2")?.source).toBe("models-dev");
    expect(lookupCatalogPrice("orb-only-7")?.source).toBe("openrouter");
  });

  test("offline with no cache stays at no catalog", async () => {
    sandbox.feeds.failing.add(MODELS_DEV_URL);
    sandbox.feeds.failing.add(OPENROUTER_URL);
    const status = await refreshPriceCatalogs();
    expect(status["openrouter"].ok).toBe(false);
    expect(lookupCatalogPrice("zephyr-flash-2")).toBeNull();
    expect(existsSync(cacheFile())).toBe(false);
  });

  test("bad JSON and an empty feed are failures with distinct short codes", async () => {
    sandbox.feeds.serve(MODELS_DEV_URL, "not json {");
    sandbox.feeds.serve(OPENROUTER_URL, { data: [] });
    const status = await refreshPriceCatalogs();
    expect(status["models-dev"]).toEqual({ ok: false, error: "bad_json" });
    expect(status["openrouter"]).toEqual({ ok: false, error: "empty" });
  });

  test("a failed source backs off for a minute but a forced refresh does not", async () => {
    sandbox.feeds.failing.add(OPENROUTER_URL);
    await refreshPriceCatalogs();
    expect(sandbox.feeds.callsTo(OPENROUTER_URL)).toBe(1);
    expect((await refreshPriceCatalogs())["openrouter"]).toEqual({ ok: false, error: "backoff" });
    expect(sandbox.feeds.callsTo(OPENROUTER_URL)).toBe(1);
    sandbox.feeds.failing.delete(OPENROUTER_URL);
    const forced = await refreshPriceCatalogs({ force: true });
    expect(forced["openrouter"].ok).toBe(true);
    expect(sandbox.feeds.callsTo(OPENROUTER_URL)).toBe(2);
  });

  test("a forced refresh refetches a fresh cache", async () => {
    await refreshPriceCatalogs();
    await refreshPriceCatalogs({ force: true });
    expect(sandbox.feeds.callsTo(MODELS_DEV_URL)).toBe(2);
    expect(sandbox.feeds.callsTo(OPENROUTER_URL)).toBe(2);
  });

  test("a corrupt cache file means no catalog and does not throw", async () => {
    writeFileSync(cacheFile(), "{ this is not json");
    expect(lookupCatalogPrice("zephyr-flash-2")).toBeNull();
    resetPriceCatalogForTests();
    writeFileSync(cacheFile(), JSON.stringify({ version: 2, sources: {} }));
    expect(lookupCatalogPrice("zephyr-flash-2")).toBeNull();
  });

  test("invalid rows inside an otherwise good cache file are dropped", async () => {
    writeFileSync(cacheFile(), JSON.stringify({ version: 1, sources: { "models-dev": { fetchedAt: Date.now(), prices: {
      good: { cost4: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, vendor: "deepseek", vendorModelId: "good" },
      bad: { cost4: { input: -1, output: 2, cacheRead: 0, cacheWrite: 0 }, vendor: "deepseek", vendorModelId: "bad" },
    } } } }));
    expect(lookupCatalogPrice("good")?.cost4.input).toBe(1);
    expect(lookupCatalogPrice("bad")).toBeNull();
  });
});
