import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  captureModelCacheGeneration,
  clearModelCache,
  getStaleCached,
  getPinnedCached,
  isModelCacheGenerationCurrent,
  modelCacheRetainedStoreSnapshot,
  evictOldestModelCacheForBudget,
  pinCachedModels,
  MODEL_CACHE_MAX_PINNED_BYTES,
  reconcileModelCacheProviders,
  setCached,
} from "../../src/codex/model-cache";
import { configureAppOwnedMemoryBudget, registerRetainedStore, resetAppOwnedMemoryForTests } from "../../src/lib/app-owned-memory";

const provider = "removed-provider-generation";

afterEach(() => clearModelCache(provider));

describe("model-cache provider reconciliation", () => {
  test.each([
    ["provider", () => clearModelCache(provider, "eviction")],
    ["global", () => clearModelCache(undefined, "eviction")],
  ])("%s eviction keeps an in-flight discovery authorized", (_scope, evict) => {
    const captured = captureModelCacheGeneration(provider);

    evict();

    expect(setCached(provider, [{ provider, id: "late-model" }], Date.now(), captured)).toBe(true);
    expect(getStaleCached(provider)).toEqual([{ provider, id: "late-model" }]);
  });

  test.each([
    ["provider", () => clearModelCache(provider)],
    ["global", () => clearModelCache()],
  ])("%s authority change rejects an in-flight discovery", (_scope, revokeAuthority) => {
    const captured = captureModelCacheGeneration(provider);

    revokeAuthority();

    expect(setCached(provider, [{ provider, id: "late-model" }], Date.now(), captured)).toBe(false);
    expect(getStaleCached(provider)).toBeNull();
  });

  test("rejects an in-flight write for a provider removed before it has a cache entry", () => {
    const captured = captureModelCacheGeneration(provider);

    expect(reconcileModelCacheProviders(new Set(), Date.now())).toBe(1);
    expect(setCached(provider, [{ provider, id: "late-model" }], Date.now(), captured)).toBe(false);
    expect(getStaleCached(provider)).toBeNull();
  });
});

describe("model-cache publication leases", () => {
  const budget = 64 * 1024 * 1024;
  beforeEach(() => {
    resetAppOwnedMemoryForTests(); clearModelCache(); configureAppOwnedMemoryBudget(budget);
    registerRetainedStore({ id: "model_cache", category: "caches",
      snapshot: modelCacheRetainedStoreSnapshot, evictOldest: evictOldestModelCacheForBudget });
  });
  afterEach(() => { clearModelCache(); resetAppOwnedMemoryForTests(); });

  test("authority revocation removes lookup but keeps detached leases accounted until release", () => {
    const generation = captureModelCacheGeneration(provider);
    const releaseOld = pinCachedModels(provider, [{ id: "old", provider }], Date.now(), generation)!;
    const oldBytes = modelCacheRetainedStoreSnapshot().pinnedBytes;
    let releaseNew: (() => void) | null = null;
    try {
      clearModelCache(provider);
      expect(isModelCacheGenerationCurrent(provider, generation)).toBe(false);
      expect(getPinnedCached(provider)).toBeNull();
      expect(getStaleCached(provider)).toBeNull();
      expect(modelCacheRetainedStoreSnapshot()).toMatchObject({ count: 1, bytes: oldBytes, pinnedBytes: oldBytes, evictableBytes: 0 });
      releaseNew = pinCachedModels(provider, [{ id: "new", provider }], Date.now(), captureModelCacheGeneration(provider));
      expect(releaseNew).not.toBeNull();
      expect(modelCacheRetainedStoreSnapshot().count).toBe(2);
      releaseOld();
      const remaining = modelCacheRetainedStoreSnapshot().pinnedBytes;
      releaseOld();
      expect(modelCacheRetainedStoreSnapshot().pinnedBytes).toBe(remaining);
      expect(getPinnedCached(provider)?.[0]?.id).toBe("new");
    } finally { releaseOld(); releaseNew?.(); }
    expect(modelCacheRetainedStoreSnapshot().pinnedBytes).toBe(0);
  });

  test("entry and byte admission caps bound concurrent publication leases", () => {
    const releases: (() => void)[] = [];
    try {
      for (let index = 0; index < 16; index++) {
        const name = "lease-" + index;
        const release = pinCachedModels(name, [{ id: "small", provider: name }], Date.now(), captureModelCacheGeneration(name));
        expect(release).not.toBeNull(); releases.push(release!);
      }
      expect(pinCachedModels("overflow", [], Date.now(), captureModelCacheGeneration("overflow"))).toBeNull();
    } finally { for (const release of releases) release(); }
    expect(pinCachedModels("oversize", [{ id: "x".repeat(MODEL_CACHE_MAX_PINNED_BYTES), provider: "oversize" }],
      Date.now(), captureModelCacheGeneration("oversize"))).toBeNull();
    expect(modelCacheRetainedStoreSnapshot().pinnedBytes).toBe(0);
  });

  test("admission rechecks the generation after reclaiming another store", () => {
    let bytes = budget;
    registerRetainedStore({ id: "changing-continuation", category: "continuation",
      snapshot: () => ({ count: bytes ? 1 : 0, bytes, pinnedBytes: 0, evictableBytes: bytes, oldestAt: bytes ? 1 : null }),
      evictOldest: () => { const released = bytes; bytes = 0; clearModelCache(provider); return released; },
    });
    expect(pinCachedModels(provider, [{ id: "stale", provider }], Date.now(), captureModelCacheGeneration(provider))).toBeNull();
    expect(getStaleCached(provider)).toBeNull();
    expect(modelCacheRetainedStoreSnapshot().pinnedBytes).toBe(0);
  });
});
