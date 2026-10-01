import { describe, expect, test } from "bun:test";
import {
  applyNewModelPolicy,
  effectiveNewModelPolicy,
  MODEL_REMOVAL_GRACE_FETCHES,
  reconcileSuccessfulModelDiscoveries,
} from "../../src/providers/new-model-policy";

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

  /**
   * GET /v1/models is polled far more often than convergence runs, so the read side reconciles
   * from the same roster repeatedly. Advancing the removal grace once per poll would retire a
   * transiently absent id after three polls and write config.json each time. Only convergence may
   * move an id toward `removed`.
   */
  describe("removal grace is advanced by convergence only", () => {
    const seedBaseline = { ids: ["a", "b", "c"], removed: [] as string[], updatedAt: "2026-01-01T00:00:00Z" };
    const roster = [{ provider: "vendor", id: "a" }, { provider: "vendor", id: "b" }];

    test("read-side reconciliation never retires an id that disappears from the roster", () => {
      let baseline = seedBaseline;
      for (let poll = 0; poll < MODEL_REMOVAL_GRACE_FETCHES * 4; poll++) {
        const result = applyNewModelPolicy({
          provider: "vendor", discoveredIds: ["a", "b"], baseline, policy: "off", now, mode: "discovery",
        });
        expect(result.newIds).toEqual([]);
        expect(result.nextBaseline.ids).toEqual(["a", "b", "c"]);
        expect(result.nextBaseline.removed).toEqual([]);
        expect(result.nextBaseline.missing).toBeUndefined();
        baseline = result.nextBaseline;
      }
    });

    test("convergence still retires the same id after the grace fetches (control)", () => {
      let baseline = seedBaseline;
      for (let cycle = 0; cycle < MODEL_REMOVAL_GRACE_FETCHES; cycle++) {
        baseline = applyNewModelPolicy({
          provider: "vendor", discoveredIds: ["a", "b"], baseline, policy: "off", now, mode: "converge",
        }).nextBaseline;
      }
      expect(baseline.ids).toEqual(["a", "b"]);
      expect(baseline.removed).toEqual(["c"]);
    });

    test("read-side reconciliation still hides a genuine arrival but a reappearance clears its pending removal", () => {
      const arrival = applyNewModelPolicy({
        provider: "vendor", discoveredIds: ["a", "b"], baseline: { ids: ["a"], removed: [], updatedAt: now },
        policy: "off", now, mode: "discovery",
      });
      expect(arrival.newIds).toEqual(["b"]);
      expect(arrival.slugsToDisable).toEqual(["vendor/b"]);

      const resumed = applyNewModelPolicy({
        provider: "vendor", discoveredIds: ["a", "c"],
        baseline: { ids: ["a", "c"], removed: [], missing: { c: MODEL_REMOVAL_GRACE_FETCHES - 1 }, updatedAt: now },
        policy: "off", now, mode: "discovery",
      });
      expect(resumed.nextBaseline.missing).toBeUndefined();
      expect(resumed.nextBaseline.removed).toEqual([]);
    });

    test("repeated read-side reconciliation of the same roster never shrinks the baseline or reports a change", () => {
      const config = {
        port: 10100, defaultProvider: "vendor", providers: { vendor: {} },
        modelDiscovery: { newModelPolicy: "off" as const, knownModels: { vendor: structuredClone(seedBaseline) } },
      } as Parameters<typeof reconcileSuccessfulModelDiscoveries>[0]["config"];
      for (let poll = 0; poll < MODEL_REMOVAL_GRACE_FETCHES * 3; poll++) {
        const changed = reconcileSuccessfulModelDiscoveries({
          config, models: roster, authoritativeProviders: ["vendor"], now, mode: "discovery",
        });
        expect(changed).toBe(false);
      }
      const known = config.modelDiscovery!.knownModels!.vendor!;
      expect(known.ids).toEqual(["a", "b", "c"]);
      expect(known.removed).toEqual([]);
      expect(known.missing).toBeUndefined();
    });

    test("repeated convergence of the same shrinking roster retires the id (control)", () => {
      const config = {
        port: 10100, defaultProvider: "vendor", providers: { vendor: {} },
        modelDiscovery: { newModelPolicy: "off" as const, knownModels: { vendor: structuredClone(seedBaseline) } },
      } as Parameters<typeof reconcileSuccessfulModelDiscoveries>[0]["config"];
      for (let cycle = 0; cycle < MODEL_REMOVAL_GRACE_FETCHES; cycle++) {
        reconcileSuccessfulModelDiscoveries({
          config, models: roster, authoritativeProviders: ["vendor"], now,
        });
      }
      expect(config.modelDiscovery!.knownModels!.vendor!.removed).toEqual(["c"]);
    });
  });

  describe("effective per-provider policy override", () => {
    /** Minimal convergence config: one known id, an optional provider-level override. */
    const convergenceConfig = (global: "on" | "off", local?: "on" | "off") => ({
      port: 10100, defaultProvider: "vendor",
      providers: { vendor: local ? { newModelPolicy: local } : {} },
      modelDiscovery: {
        newModelPolicy: global,
        knownModels: { vendor: { ids: ["a"], removed: [], updatedAt: "2026-01-01T00:00:00Z" } },
      },
    } as Parameters<typeof reconcileSuccessfulModelDiscoveries>[0]["config"]);

    test("the provider value wins, and an inherited/absent value falls back to the global flag", () => {
      const config = {
        port: 10100, defaultProvider: "alpha",
        providers: {
          alpha: { newModelPolicy: "off" as const }, beta: { newModelPolicy: "on" as const },
          gamma: { newModelPolicy: "inherit" as const }, delta: {},
        },
        modelDiscovery: { newModelPolicy: "on" as const },
      } as Parameters<typeof effectiveNewModelPolicy>[0];
      expect(effectiveNewModelPolicy(config, "alpha")).toBe("off");
      expect(effectiveNewModelPolicy(config, "beta")).toBe("on");
      expect(effectiveNewModelPolicy(config, "gamma")).toBe("on");
      expect(effectiveNewModelPolicy(config, "delta")).toBe("on");
      const globalOff = { ...config, modelDiscovery: { newModelPolicy: "off" as const } } as typeof config;
      expect(effectiveNewModelPolicy(globalOff, "delta")).toBe("off");
      expect(effectiveNewModelPolicy(globalOff, "beta")).toBe("on");
    });

    test("a provider off override hides a genuine arrival under a global on", () => {
      const config = convergenceConfig("on", "off");
      const changed = reconcileSuccessfulModelDiscoveries({
        config,
        models: [{ provider: "vendor", id: "a" }, { provider: "vendor", id: "b" }],
        authoritativeProviders: ["vendor"], now,
      });
      expect(changed).toBe(true);
      expect(config.disabledModels).toEqual(["vendor/b"]);
    });

    test("a provider on override lets a genuine arrival through under a global off", () => {
      const config = convergenceConfig("off", "on");
      const changed = reconcileSuccessfulModelDiscoveries({
        config,
        models: [{ provider: "vendor", id: "a" }, { provider: "vendor", id: "b" }],
        authoritativeProviders: ["vendor"], now,
      });
      expect(changed).toBe(true);
      expect(config.disabledModels).toBeUndefined();
      expect(config.modelDiscovery!.recentArrivals!.vendor).toEqual([{ id: "b", at: now }]);
    });

    test("an explicit disabled choice survives a provider on override", () => {
      const config = convergenceConfig("off", "on");
      config.disabledModels = ["vendor/b"];
      reconcileSuccessfulModelDiscoveries({
        config,
        models: [{ provider: "vendor", id: "a" }, { provider: "vendor", id: "b" }],
        authoritativeProviders: ["vendor"], now,
      });
      expect(config.disabledModels).toEqual(["vendor/b"]);
    });
  });
});
