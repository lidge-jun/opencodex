import { describe, expect, test } from "bun:test";
import { applyNewModelPolicy, reconcileSuccessfulModelDiscoveries } from "../src/providers/new-model-policy";

const now = "2026-08-24T02:11:00Z";

describe("new-model policy", () => {
  test("bootstraps without hiding the existing catalog", () => {
    const r = applyNewModelPolicy({ provider: "openrouter", discoveredIds: ["a", "b"], policy: "off", now });
    expect(r.newIds).toEqual([]); expect(r.slugsToDisable).toEqual([]); expect(r.nextBaseline.ids).toEqual(["a", "b"]);
  });

  test("walks the design scenario and auto-disables each id at most once", () => {
    let baseline = { ids: ["a", "b", "c"], removed: [], updatedAt: now };
    let r = applyNewModelPolicy({ provider: "openrouter", discoveredIds: ["a", "b", "c", "d"], baseline, policy: "off", now });
    expect(r.slugsToDisable).toEqual(["openrouter/d"]); baseline = r.nextBaseline;
    r = applyNewModelPolicy({ provider: "openrouter", discoveredIds: ["a", "b", "c", "d"], baseline, policy: "off", now });
    expect(r.newIds).toEqual([]); baseline = r.nextBaseline;
    for (let i = 0; i < 3; i++) baseline = applyNewModelPolicy({ provider: "openrouter", discoveredIds: ["a", "b", "c"], baseline, policy: "off", now }).nextBaseline;
    expect(baseline.removed).toContain("d");
    r = applyNewModelPolicy({ provider: "openrouter", discoveredIds: ["a", "b", "c", "d"], baseline, policy: "off", now });
    expect(r.newIds).toEqual([]); expect(r.slugsToDisable).toEqual([]);
    baseline = r.nextBaseline;
    r = applyNewModelPolicy({ provider: "openrouter", discoveredIds: ["a", "b", "d", "c-v2"], baseline, policy: "off", now });
    expect(r.slugsToDisable).toEqual(["openrouter/c-v2"]);
  });

  test("preset mode is a deliberate no-op while still recording the arrival", () => {
    const r = applyNewModelPolicy({ provider: "openrouter", discoveredIds: ["a", "d"], baseline: { ids: ["a"], removed: [], updatedAt: now }, policy: "off", hasSelectedModels: true, now });
    expect(r.newIds).toEqual(["d"]); expect(r.arrivals).toEqual([{ id: "d", at: now }]); expect(r.slugsToDisable).toEqual([]);
  });

  test("degraded providers do not poison a persisted baseline", () => {
    const config = { port: 10100, defaultProvider: "vendor", providers: { vendor: {} }, modelDiscovery: { newModelPolicy: "off" as const, knownModels: { vendor: { ids: ["a", "b"], removed: [], updatedAt: now } } } };
    expect(reconcileSuccessfulModelDiscoveries({ config, models: [{ provider: "vendor", id: "a" }], authoritativeProviders: [], now })).toBe(false);
    expect(config.modelDiscovery.knownModels.vendor.ids).toEqual(["a", "b"]);
  });

  /**
   * The steady state is the common case: a provider's roster is identical on almost every
   * convergence, and convergence runs on every catalog write. Reporting "changed" there would
   * rewrite config.json each time and move the config generation that other writers revalidate
   * against — a write amplification with no user-visible cause.
   */
  test("an unchanged roster reports no change, so convergence does not rewrite config", () => {
    const config = {
      port: 10100, defaultProvider: "vendor", providers: { vendor: {} },
      modelDiscovery: {
        newModelPolicy: "off" as const,
        knownModels: { vendor: { ids: ["a", "b"], removed: [], updatedAt: "2026-01-01T00:00:00Z" } },
      },
    };
    const changed = reconcileSuccessfulModelDiscoveries({
      config,
      models: [{ provider: "vendor", id: "a" }, { provider: "vendor", id: "b" }],
      authoritativeProviders: ["vendor"],
      now,
    });
    expect(changed).toBe(false);
    // The timestamp is deliberately NOT advanced: a bumped updatedAt would make the very next
    // comparison look dirty and reintroduce the rewrite it just avoided.
    expect(config.modelDiscovery.knownModels.vendor.updatedAt).toBe("2026-01-01T00:00:00Z");
  });

  test("a genuine arrival still reports a change and records the disable", () => {
    const config = {
      port: 10100, defaultProvider: "vendor", providers: { vendor: {} },
      modelDiscovery: {
        newModelPolicy: "off" as const,
        knownModels: { vendor: { ids: ["a"], removed: [], updatedAt: "2026-01-01T00:00:00Z" } },
      },
    } as Parameters<typeof reconcileSuccessfulModelDiscoveries>[0]["config"];
    const changed = reconcileSuccessfulModelDiscoveries({
      config,
      models: [{ provider: "vendor", id: "a" }, { provider: "vendor", id: "b" }],
      authoritativeProviders: ["vendor"],
      now,
    });
    expect(changed).toBe(true);
    expect(config.disabledModels).toEqual(["vendor/b"]);
    expect(config.modelDiscovery!.knownModels!.vendor!.updatedAt).toBe(now);
  });
});
