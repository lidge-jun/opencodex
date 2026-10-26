import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retainNativeMainOwner } from "../../src/codex/native-main-owner";
import { flushConfigDirHardening } from "../../src/config/paths";
import {
  defaultFixtureTeardownDeps,
  drainAndRemoveFixtureRoots,
  type FixtureTeardownDeps,
  type FixtureTeardownPlan,
} from "../helpers/fixture-teardown";
import { removeTreeWithRetry } from "../helpers/remove-tree";

function harness(overrides: Partial<FixtureTeardownDeps> = {}) {
  const calls: string[] = [];
  const deps: FixtureTeardownDeps = {
    settleProducers: async () => { calls.push("producers"); },
    settleConfigFlights: async root => { calls.push(`flight:${root}`); },
    closeHistory: () => { calls.push("history"); },
    drainAcl: async root => { calls.push(`acl:${root}`); },
    openLocks: () => [],
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

  test("an owner still open under a root keeps only that root and names it", async () => {
    const h = harness({ openLocks: root => (root === "A" ? ["A/codex"] : []) });
    await expect(drainAndRemoveFixtureRoots(h.plan, h.deps)).rejects.toThrow("native-main owner still open for A/codex");
    expect(h.calls).not.toContain("remove:A");
    expect(h.calls).toContain("remove:B");
    expect(h.calls.filter(call => call === "restore")).toHaveLength(1);
  });

  test("the default lock probe sees a held owner below the root until its release closes", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-teardown-lock-"));
    const codexHome = join(root, "codex");
    const sibling = `${root}-sibling`;
    mkdirSync(codexHome);
    const owner = retainNativeMainOwner(
      { codexHome, homeId: `teardown-lock-${process.pid}` } as never,
      { hardenPath: async () => {} },
    );
    try {
      await new Promise<void>(held => owner.subscribe(snapshot => { if (snapshot.status === "held") held(); }));
      expect(defaultFixtureTeardownDeps.openLocks(root)).toEqual([codexHome]);
      expect(defaultFixtureTeardownDeps.openLocks(codexHome)).toEqual([codexHome]);
      expect(defaultFixtureTeardownDeps.openLocks(sibling)).toEqual([]);
      await owner.release();
      expect(defaultFixtureTeardownDeps.openLocks(root)).toEqual([]);
    } finally {
      await owner.release();
      removeTreeWithRetry(root);
    }
  });

  test("an owner paused mid-acquisition keeps its root until preparation and release finish", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-teardown-acquire-"));
    const codexHome = join(root, "codex");
    mkdirSync(codexHome);
    let entered!: () => void, resume!: () => void;
    const hardening = new Promise<void>(done => { entered = done; });
    const resumed = new Promise<void>(done => { resume = done; });
    const owner = retainNativeMainOwner(
      { codexHome, homeId: `teardown-acquire-${process.pid}` } as never,
      { hardenPath: async () => { entered(); await resumed; } },
    );
    const removed: string[] = [];
    const plan = (): FixtureTeardownPlan => ({ roots: [{ path: root, remove: path => { removed.push(path); removeTreeWithRetry(path); } }], restoreEnvironment: () => {} });
    try {
      // The descriptor and SQLite handle exist only in locals while the hardener runs.
      await hardening;
      expect(owner.snapshot().status).toBe("acquiring");
      await expect(drainAndRemoveFixtureRoots(plan())).rejects.toThrow(`native-main owner still open for ${codexHome}`);
      expect(removed).toEqual([]);

      const released = owner.release();
      // Still closing: the release waits for the paused acquisition.
      await expect(drainAndRemoveFixtureRoots(plan())).rejects.toThrow("native-main owner still open");
      expect(removed).toEqual([]);

      resume();
      await released;
      expect(defaultFixtureTeardownDeps.openLocks(root)).toEqual([]);
      await drainAndRemoveFixtureRoots(plan());
      expect(removed).toEqual([root]);
    } finally {
      resume();
      await owner.release();
      if (removed.length === 0) removeTreeWithRetry(root);
    }
  });
});
