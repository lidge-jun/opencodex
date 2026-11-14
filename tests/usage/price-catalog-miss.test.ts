import { describe, expect, setSystemTime, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { settleBackgroundWork } from "../../src/lib/background-work";
import { resolveMatchedPrice } from "../../src/usage/cost";
import {
  lookupCatalogPrice,
  notePriceCatalogMiss,
  PRICE_CATALOG_MISS_COOLDOWN_MS,
  refreshPriceCatalogs,
  resetPriceCatalogForTests,
  resolveCatalogPrice,
  setPriceCatalogFetchForTests,
} from "../../src/usage/price-catalog";
import { feedFetch, installCatalogSandbox, MODELS_DEV_URL, nextTick } from "../helpers/price-catalog-fixtures";

const sandbox = installCatalogSandbox();

/** A miss flushes on a zero-delay timer; let it start, then wait for the fetch it began. */
async function drainMisses(): Promise<void> {
  await nextTick();
  await settleBackgroundWork();
}

describe("price catalog miss path", () => {
  test("a miss triggers one background fetch per source and the next lookup hits", async () => {
    expect(resolveCatalogPrice("zephyr-flash-2")).toBeNull();
    expect(sandbox.feeds.calls).toHaveLength(0);
    await drainMisses();
    expect(sandbox.feeds.calls.sort()).toEqual(["https://models.dev/api.json", "https://openrouter.ai/api/v1/models"]);
    expect(resolveCatalogPrice("zephyr-flash-2")?.source).toBe("models-dev");
  });

  test("many misses in one tick share one fetch per source", async () => {
    for (const id of ["zephyr-flash-2", "moon-pro-3.1", "orb-only-7", "cn:grok-quill-5.5", "nothing-1"]) resolveCatalogPrice(id);
    await drainMisses();
    expect(sandbox.feeds.calls).toHaveLength(2);
    expect(lookupCatalogPrice("orb-only-7")?.source).toBe("openrouter");
    expect(lookupCatalogPrice("moon-pro-3-1")?.source).toBe("models-dev");
  });

  test("the same key queued twice in one tick is fetched once", async () => {
    notePriceCatalogMiss("zephyr-flash-2");
    notePriceCatalogMiss("ZEPHYR.FLASH.2");
    await drainMisses();
    expect(sandbox.feeds.calls).toHaveLength(2);
  });

  test("resolveMatchedPrice returns null at once while the fetch is still pending, then prices it", async () => {
    const release = sandbox.feeds.hold();
    const first = resolveMatchedPrice("acme-relay", "zephyr-flash-2");
    expect(first).toBeNull();
    await nextTick();
    expect(sandbox.feeds.calls).toHaveLength(1);
    expect(resolveMatchedPrice("acme-relay", "zephyr-flash-2")).toBeNull();
    release();
    await settleBackgroundWork();
    expect(sandbox.feeds.calls).toHaveLength(2);
    expect(resolveMatchedPrice("acme-relay", "zephyr-flash-2")).toMatchObject({
      source: "models-dev",
      status: "verified-derived",
      cost4: { input: 0.1, output: 0.4 },
    });
  });

  test("a key still missing afterwards cools down: no second fetch for it", async () => {
    resolveCatalogPrice("nothing-9");
    await drainMisses();
    expect(sandbox.feeds.calls).toHaveLength(2);
    resolveCatalogPrice("nothing-9");
    resolveCatalogPrice("NOTHING.9");
    await drainMisses();
    expect(sandbox.feeds.calls).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(sandbox.dir, "price-catalog-cache.json"), "utf8")).missCooldown).toHaveProperty("nothing-9");
  });

  test("the cooldown survives a restart and expires after six hours", async () => {
    const start = Date.now();
    resolveCatalogPrice("nothing-9");
    await drainMisses();
    resetPriceCatalogForTests();
    const feeds = feedFetch();
    setPriceCatalogFetchForTests(feeds.fetch);
    resolveCatalogPrice("nothing-9");
    await drainMisses();
    expect(feeds.calls).toHaveLength(0);
    setSystemTime(start + PRICE_CATALOG_MISS_COOLDOWN_MS + 60_000);
    resolveCatalogPrice("nothing-9");
    await drainMisses();
    expect(feeds.calls).toHaveLength(2);
  });

  test("a fresh source gets at most one miss-driven fetch per cooldown window", async () => {
    const start = Date.now();
    await refreshPriceCatalogs();
    sandbox.feeds.calls.length = 0;
    resolveCatalogPrice("late-model-4");
    await drainMisses();
    expect(sandbox.feeds.calls).toHaveLength(2);
    resolveCatalogPrice("late-model-5");
    await drainMisses();
    expect(sandbox.feeds.calls).toHaveLength(2);
    setSystemTime(start + PRICE_CATALOG_MISS_COOLDOWN_MS + 60_000);
    resolveCatalogPrice("late-model-5");
    await drainMisses();
    expect(sandbox.feeds.calls).toHaveLength(4);
  });

  test("a miss-driven fetch merges only the missing keys and leaves other rows untouched", async () => {
    await refreshPriceCatalogs();
    const fetchedAt = JSON.parse(readFileSync(join(sandbox.dir, "price-catalog-cache.json"), "utf8")).sources["models-dev"].fetchedAt;
    sandbox.feeds.serve(MODELS_DEV_URL, { deepseek: { models: {
      "zephyr-flash-2": { cost: { input: 77, output: 88 } },
      "late-model-4": { cost: { input: 3, output: 4 } },
      "unrelated-5": { cost: { input: 5, output: 6 } },
    } } });
    resolveCatalogPrice("late-model-4");
    await drainMisses();
    expect(lookupCatalogPrice("late-model-4")?.cost4).toMatchObject({ input: 3, output: 4 });
    expect(lookupCatalogPrice("zephyr-flash-2")?.cost4).toMatchObject({ input: 0.1, output: 0.4 });
    expect(lookupCatalogPrice("moon-pro-3-1")?.cost4.input).toBe(1.5);
    expect(lookupCatalogPrice("unrelated-5")).toBeNull();
    const file = JSON.parse(readFileSync(join(sandbox.dir, "price-catalog-cache.json"), "utf8"));
    expect(file.sources["models-dev"].fetchedAt).toBe(fetchedAt);
  });

  test("a forced refresh clears cooldowns so a still-missing key is asked for again", async () => {
    resolveCatalogPrice("nothing-9");
    await drainMisses();
    sandbox.feeds.calls.length = 0;
    await refreshPriceCatalogs({ force: true });
    expect(sandbox.feeds.calls).toHaveLength(2);
    resolveCatalogPrice("nothing-9");
    await drainMisses();
    expect(sandbox.feeds.calls).toHaveLength(4);
  });

  test("a failed miss fetch records no cooldown, so the key is retried later", async () => {
    sandbox.feeds.failing.add(MODELS_DEV_URL);
    sandbox.feeds.failing.add("https://openrouter.ai/api/v1/models");
    resolveCatalogPrice("zephyr-flash-2");
    await drainMisses();
    expect(lookupCatalogPrice("zephyr-flash-2")).toBeNull();
    sandbox.feeds.failing.clear();
    await refreshPriceCatalogs({ force: true });
    expect(lookupCatalogPrice("zephyr-flash-2")?.source).toBe("models-dev");
  });

  test("a failed source does not cool down a key the other source lacked", async () => {
    const start = Date.now();
    sandbox.feeds.failing.add(MODELS_DEV_URL);
    resolveCatalogPrice("late-model-6");
    await drainMisses();
    expect(lookupCatalogPrice("late-model-6")).toBeNull();
    sandbox.feeds.failing.clear();
    sandbox.feeds.serve(MODELS_DEV_URL, { deepseek: { models: { "late-model-6": { cost: { input: 2, output: 3 } } } } });
    setSystemTime(start + 120_000);
    resolveCatalogPrice("late-model-6");
    await drainMisses();
    expect(lookupCatalogPrice("late-model-6")?.source).toBe("models-dev");
  });

  test("a miss that joins another key's held fetch still merges its own key", async () => {
    await refreshPriceCatalogs();
    sandbox.feeds.serve(MODELS_DEV_URL, { deepseek: { models: {
      "late-model-a": { cost: { input: 2, output: 3 } },
      "late-model-b": { cost: { input: 4, output: 5 } },
    } } });
    const release = sandbox.feeds.hold();
    resolveCatalogPrice("late-model-a");
    await nextTick();
    resolveCatalogPrice("late-model-b");
    await nextTick();
    release();
    await settleBackgroundWork();
    expect(lookupCatalogPrice("late-model-a")?.cost4).toMatchObject({ input: 2, output: 3 });
    expect(lookupCatalogPrice("late-model-b")?.cost4).toMatchObject({ input: 4, output: 5 });
    expect(JSON.parse(readFileSync(join(sandbox.dir, "price-catalog-cache.json"), "utf8")).missCooldown ?? {}).not.toHaveProperty("late-model-b");
  });

  test("a memoized miss retries through resolveMatchedPrice after the cooldown", async () => {
    const start = Date.now();
    await refreshPriceCatalogs();
    expect(resolveMatchedPrice("acme-relay", "late-model-7")).toBeNull();
    await drainMisses();
    sandbox.feeds.serve(MODELS_DEV_URL, { deepseek: { models: { "late-model-7": { cost: { input: 2, output: 3 } } } } });
    setSystemTime(start + PRICE_CATALOG_MISS_COOLDOWN_MS + 60_000);
    expect(resolveMatchedPrice("acme-relay", "late-model-7")).toBeNull();
    await drainMisses();
    expect(resolveMatchedPrice("acme-relay", "late-model-7")).toMatchObject({ source: "models-dev", cost4: { input: 2, output: 3 } });
  });

  test("without an injected fetch the test environment never reaches the network", async () => {
    setPriceCatalogFetchForTests(null);
    resolveCatalogPrice("zephyr-flash-2");
    await drainMisses();
    expect(sandbox.feeds.calls).toHaveLength(0);
  });
});
