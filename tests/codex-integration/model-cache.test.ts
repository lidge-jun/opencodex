import { afterEach, describe, expect, test } from "bun:test";
import {
  captureModelCacheGeneration,
  clearModelCache,
  getStaleCached,
  isModelsFetchCoolingDown,
  markModelsFetchFailure,
  reconcileModelCacheProviders,
  setCached,
} from "../../src/codex/model-cache";

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

  test("an upstream retry deadline extends the default discovery cooldown", () => {
    const now = 10_000;
    const authority = "account-a";
    markModelsFetchFailure(provider, now, authority, now + 600_000);

    expect(isModelsFetchCoolingDown(provider, undefined, now + 31_000, authority)).toBe(true);
    expect(isModelsFetchCoolingDown(provider, undefined, now + 599_999, authority)).toBe(true);
    expect(isModelsFetchCoolingDown(provider, undefined, now + 600_000, authority)).toBe(false);
    expect(isModelsFetchCoolingDown(provider, undefined, now + 31_000, "account-b")).toBe(false);
  });

  test("a failure without upstream advice keeps the default cooldown", () => {
    const now = 20_000;
    markModelsFetchFailure(provider, now);

    expect(isModelsFetchCoolingDown(provider, undefined, now + 29_999)).toBe(true);
    expect(isModelsFetchCoolingDown(provider, undefined, now + 30_000)).toBe(false);
  });
});
