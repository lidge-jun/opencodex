import { describe, expect, test } from "bun:test";
import { flushConfigDirHardening } from "../../src/config/paths";
import {
  defaultFixtureTeardownDeps,
  drainAndRemoveFixtureRoots,
  type FixtureTeardownDeps,
  type FixtureTeardownPlan,
} from "../helpers/fixture-teardown";

function harness(overrides: Partial<FixtureTeardownDeps> = {}) {
  const calls: string[] = [];
  const deps: FixtureTeardownDeps = {
    settleProducers: async () => { calls.push("producers"); },
    settleConfigFlights: async root => { calls.push(`flight:${root}`); },
    closeHistory: () => { calls.push("history"); },
    drainAcl: async root => { calls.push(`acl:${root}`); },
    remove: root => { calls.push(`remove:${root}`); },
    ...overrides,
  };
  const plan: FixtureTeardownPlan = {
    roots: [{ path: "A" }, { path: "B" }],
    restoreEnvironment: () => { calls.push("restore"); },
  };
  return { calls, deps, plan };
}

describe("fixture removal ownership", () => {
  test("held ACL flight keeps its root until drain settles", async () => {
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(done => { release = done; });
    const entry = new Promise<void>(done => { entered = done; });
    const h = harness({ drainAcl: async root => { if (root === "A") { entered(); await held; } } });
    const work = drainAndRemoveFixtureRoots(h.plan, h.deps);
    try {
      await entry;
      expect(h.calls).not.toContain("remove:A");
      release(); await work;
      expect(h.calls).toContain("remove:A");
    } finally { release(); await work; }
  });

  test("orders producers, both flights, history, both ACL drains and both removals", async () => {
    const h = harness();
    await drainAndRemoveFixtureRoots(h.plan, h.deps);
    expect(h.calls).toEqual(["producers", "flight:A", "flight:B", "history", "acl:A", "acl:B", "remove:A", "remove:B", "restore"]);
  });

  test("history owner closes before any root is removed", async () => {
    const h = harness({ remove: root => {
      expect(h.calls).toContain("history");
      h.calls.push(`remove:${root}`);
    } });
    await drainAndRemoveFixtureRoots(h.plan, h.deps);
    expect(h.calls).toContain("remove:B");
  });

  test("failed config drain preserves its root, removes the other and restores environment", async () => {
    const error = new Error("config drain failed");
    const h = harness({ settleConfigFlights: async root => { if (root === "A") throw error; } });
    await expect(drainAndRemoveFixtureRoots(h.plan, h.deps)).rejects.toBe(error);
    expect(h.calls).not.toContain("remove:A");
    expect(h.calls).toContain("remove:B");
    expect(h.calls.filter(call => call === "restore")).toHaveLength(1);
  });

  test("removal failure still attempts later roots, restores and rethrows", async () => {
    const error = new Error("removal failed");
    const h = harness({ remove: root => { h.calls.push(`remove:${root}`); if (root === "A") throw error; } });
    await expect(drainAndRemoveFixtureRoots(h.plan, h.deps)).rejects.toBe(error);
    expect(h.calls).toContain("remove:B");
    expect(h.calls.filter(call => call === "restore")).toHaveLength(1);
  });

  test("producer failure prevents all removals and restores environment", async () => {
    const error = new Error("producer failed");
    const h = harness({ settleProducers: async () => { throw error; } });
    await expect(drainAndRemoveFixtureRoots(h.plan, h.deps)).rejects.toBe(error);
    expect(h.calls.filter(call => call.startsWith("remove:"))).toEqual([]);
    expect(h.calls.filter(call => call === "restore")).toHaveLength(1);
  });

  test("history failure prevents all removals but still drains every ACL root", async () => {
    const error = new Error("history failed");
    const h = harness({ closeHistory: () => { throw error; } });
    await expect(drainAndRemoveFixtureRoots(h.plan, h.deps)).rejects.toBe(error);
    expect(h.calls).toContain("acl:A");
    expect(h.calls).toContain("acl:B");
    expect(h.calls.filter(call => call.startsWith("remove:"))).toEqual([]);
    expect(h.calls.filter(call => call === "restore")).toHaveLength(1);
  });

  test("default config step only settles flights, before the separate ACL step", () => {
    expect(defaultFixtureTeardownDeps.settleConfigFlights).toBe(flushConfigDirHardening);
  });

  test("ACL failure blocks only its root and retains the first earlier failure", async () => {
    const first = new Error("config failed"), second = new Error("ACL failed");
    const h = harness({
      settleConfigFlights: async root => { if (root === "A") throw first; },
      drainAcl: async root => { h.calls.push(`acl:${root}`); if (root === "A") throw second; },
    });
    await expect(drainAndRemoveFixtureRoots(h.plan, h.deps)).rejects.toBe(first);
    expect(h.calls).not.toContain("remove:A");
    expect(h.calls).toContain("remove:B");
    expect(h.calls).toContain("acl:B");
  });

  test("ACL failure alone preserves its root and removes the other drained root", async () => {
    const error = new Error("ACL failed");
    const h = harness({ drainAcl: async root => { h.calls.push(`acl:${root}`); if (root === "A") throw error; } });
    await expect(drainAndRemoveFixtureRoots(h.plan, h.deps)).rejects.toBe(error);
    expect(h.calls).not.toContain("remove:A");
    expect(h.calls).toContain("remove:B");
    expect(h.calls.filter(call => call === "restore")).toHaveLength(1);
  });

  test("per-root removal override runs after drains", async () => {
    const h = harness();
    h.plan.roots = [{ path: "A", remove: path => { h.calls.push(`custom:${path}`); } }];
    await drainAndRemoveFixtureRoots(h.plan, h.deps);
    expect(h.calls).toEqual(["producers", "flight:A", "history", "acl:A", "custom:A", "restore"]);
  });

  test("environment restore failure cannot mask an earlier drain failure", async () => {
    const first = new Error("producer failed"), last = new Error("restore failed");
    const h = harness({ settleProducers: async () => { throw first; } });
    h.plan.restoreEnvironment = () => { throw last; };
    await expect(drainAndRemoveFixtureRoots(h.plan, h.deps)).rejects.toBe(first);
  });
});
