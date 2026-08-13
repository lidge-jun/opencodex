import { afterEach, describe, expect, test } from "bun:test";
import {
  captureModelCacheGeneration,
  getStaleCached,
  providerCacheGenerations,
  reconcileModelCacheProviders,
  setCached,
} from "../src/codex/model-cache";

let reconciliationGeneration = Date.now();

afterEach(() => {
  reconcileModelCacheProviders(new Set(), ++reconciliationGeneration);
});

describe("model-cache generation tombstones", () => {
  test("bounds generations while preserving removal authority", () => {
    const retainedProvider = "generation-retained-provider";
    const removedProvider = "generation-removed-provider";
    const churnedProviders = Array.from(
      { length: 100 },
      (_, index) => `generation-churned-provider-${index}`,
    );
    const staleGeneration = captureModelCacheGeneration(removedProvider);
    captureModelCacheGeneration(retainedProvider);
    for (const provider of churnedProviders) captureModelCacheGeneration(provider);

    const validProviders = new Set([retainedProvider]);
    expect(reconcileModelCacheProviders(validProviders, ++reconciliationGeneration)).toBeGreaterThanOrEqual(101);

    expect(providerCacheGenerations.has(removedProvider)).toBe(false);
    expect(providerCacheGenerations.size).toBeLessThanOrEqual(validProviders.size);
    expect(
      setCached(
        removedProvider,
        [{ provider: removedProvider, id: "late-model" }],
        Date.now(),
        staleGeneration,
      ),
    ).toBe(false);
    expect(getStaleCached(removedProvider)).toBeNull();

    const readdedGeneration = captureModelCacheGeneration(removedProvider);
    expect(readdedGeneration.endsWith(":0")).toBe(true);
    expect(providerCacheGenerations.get(removedProvider)).toBe(0);

    validProviders.add(removedProvider);
    reconcileModelCacheProviders(validProviders, ++reconciliationGeneration);
    expect(providerCacheGenerations.size).toBeLessThanOrEqual(validProviders.size);
  });
});
