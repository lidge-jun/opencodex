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
  test("rejects an in-flight write for a provider removed before it has a cache entry", () => {
    const captured = captureModelCacheGeneration(provider);

    expect(reconcileModelCacheProviders(new Set(), Date.now())).toBe(1);
    expect(setCached(provider, [{ provider, id: "late-model" }], Date.now(), captured)).toBe(false);
    expect(getStaleCached(provider)).toBeNull();
  });
});
