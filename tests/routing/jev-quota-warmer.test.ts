import { afterEach, describe, expect, test } from "bun:test";
import {
  configNeedsJevQuotaWarmth,
  isJevQuotaWarmerRunning,
  jevQuotaWarmerRefreshCountForTests,
  resetJevQuotaWarmerForTests,
  runJevQuotaWarmerTickForTests,
  startJevQuotaWarmer,
  stopJevQuotaWarmer,
} from "../../src/combos/jev-quota-warmer";
import { firstLoadTimePathTo, resolvedImportEdges } from "../helpers/import-graph";

afterEach(() => resetJevQuotaWarmerForTests());

const levelCombo = { strategy: "jev", decisionMode: "level", decisionQuotaSignals: true, targets: [] };

describe("JEV quota warmer", () => {
  test("any quota-aware JEV combo needs warm quota rows, in either decision mode", () => {
    expect(configNeedsJevQuotaWarmth({ combos: { auto: levelCombo } })).toBeTrue();
    expect(configNeedsJevQuotaWarmth({ combos: { auto: { ...levelCombo, decisionMode: undefined } } })).toBeTrue();
    expect(configNeedsJevQuotaWarmth({ combos: { auto: { ...levelCombo, decisionMode: "route" } } })).toBeTrue();
    for (const combo of [
      { ...levelCombo, decisionQuotaSignals: false },
      { ...levelCombo, decisionQuotaSignals: undefined },
      { ...levelCombo, strategy: "failover" },
      null,
    ]) {
      expect(configNeedsJevQuotaWarmth({ combos: { auto: combo } })).toBeFalse();
    }
    expect(configNeedsJevQuotaWarmth({})).toBeFalse();
    expect(configNeedsJevQuotaWarmth(undefined)).toBeFalse();
  });

  test("a tick refreshes only while such a combo exists, and joins a refresh in flight", async () => {
    const refreshed: unknown[] = [];
    let config: { combos?: Record<string, unknown> } = { combos: { plain: { strategy: "jev" } } };
    let release: () => void = () => {};
    const deps = {
      loadConfig: () => config,
      refresh: (value: unknown) => {
        refreshed.push(value);
        return new Promise<void>(resolve => { release = resolve; });
      },
    };
    await runJevQuotaWarmerTickForTests(deps);
    expect(refreshed).toEqual([]);

    config = { combos: { auto: levelCombo } };
    const first = runJevQuotaWarmerTickForTests(deps);
    const second = runJevQuotaWarmerTickForTests(deps);
    expect(second).toBe(first);
    await Bun.sleep(0);
    release();
    await first;
    expect(refreshed).toEqual([config]);
    expect(jevQuotaWarmerRefreshCountForTests()).toBe(1);
  });

  test("a failed refresh or config read never escapes the tick", async () => {
    await runJevQuotaWarmerTickForTests({
      loadConfig: () => ({ combos: { auto: levelCombo } }),
      refresh: async () => { throw new Error("quota endpoint down"); },
    });
    await runJevQuotaWarmerTickForTests({
      loadConfig: () => { throw new Error("config unreadable"); },
      refresh: async () => undefined,
    });
    expect(jevQuotaWarmerRefreshCountForTests()).toBe(1);
  });

  test("start is idempotent and stop cancels the pending tick", async () => {
    const refreshed: unknown[] = [];
    const deps = { loadConfig: () => ({ combos: { auto: levelCombo } }), refresh: async (value: unknown) => { refreshed.push(value); } };
    expect(isJevQuotaWarmerRunning()).toBeFalse();
    startJevQuotaWarmer({ initialDelayMs: 5, intervalMs: 5, deps });
    startJevQuotaWarmer({ initialDelayMs: 5, intervalMs: 5, deps });
    expect(isJevQuotaWarmerRunning()).toBeTrue();
    stopJevQuotaWarmer();
    expect(isJevQuotaWarmerRunning()).toBeFalse();
    await Bun.sleep(30);
    expect(refreshed).toEqual([]);
    expect(jevQuotaWarmerRefreshCountForTests()).toBe(0);
  });

  test("a completed tick schedules the next one", async () => {
    let refreshes = 0;
    const deps = { loadConfig: () => ({ combos: { auto: levelCombo } }), refresh: async () => { refreshes += 1; } };
    startJevQuotaWarmer({ initialDelayMs: 1, intervalMs: 5, deps });
    const deadline = Date.now() + 2_000;
    while (refreshes < 3 && Date.now() < deadline) await Bun.sleep(5);
    expect(refreshes).toBeGreaterThanOrEqual(3);
    stopJevQuotaWarmer();
    const settled = refreshes;
    await Bun.sleep(30);
    // At most the flight already running when stop landed finishes; nothing reschedules.
    expect(refreshes - settled).toBeLessThanOrEqual(1);
  });

  test("a stop and start while a tick is in flight keeps the warmer ticking", async () => {
    let refreshes = 0;
    let release: () => void = () => {};
    let blocking = true;
    const deps = {
      loadConfig: () => ({ combos: { auto: levelCombo } }),
      refresh: () => {
        refreshes += 1;
        if (!blocking) return Promise.resolve();
        return new Promise<void>(resolve => { release = resolve; });
      },
    };
    // A flight from the previous generation is still running when the warmer restarts.
    const stale = runJevQuotaWarmerTickForTests(deps);
    await Bun.sleep(0);
    startJevQuotaWarmer({ initialDelayMs: 1, intervalMs: 5, deps });
    stopJevQuotaWarmer();
    startJevQuotaWarmer({ initialDelayMs: 1, intervalMs: 5, deps });
    // The restarted timer fires and joins the stale flight, clearing its own timer.
    await Bun.sleep(20);
    blocking = false;
    release();
    await stale;
    const deadline = Date.now() + 2_000;
    while (refreshes < 3 && Date.now() < deadline) await Bun.sleep(5);
    expect(refreshes).toBeGreaterThanOrEqual(3);
    expect(isJevQuotaWarmerRunning()).toBeTrue();
  });

  test("costs the server one import-free module and stays off the request path", () => {
    expect(resolvedImportEdges("src/combos/jev-quota-warmer.ts").filter(edge => !edge.dynamic)).toEqual([]);
    const isWarmer = (path: string) => path.endsWith("/src/combos/jev-quota-warmer.ts");
    // The composition root does reach it, which proves the walker sees the edge at all.
    expect(firstLoadTimePathTo("src/server/index.ts", isWarmer)?.join(" -> ")).toContain("src/server/background-lifecycle.ts");
    for (const core of ["src/router.ts", "src/server/lifecycle.ts", "src/server/responses/core.ts"]) {
      expect(firstLoadTimePathTo(core, isWarmer)).toBeNull();
    }
  });
});
