import { afterEach, describe, expect, test } from "bun:test";
import {
  captureModelCacheGeneration,
  clearModelCache,
  getStaleCached,
  reconcileModelCacheProviders,
  setCached,
} from "../src/codex/model-cache";

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
