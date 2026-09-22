import { afterEach, describe, expect, test } from "bun:test";
import type { PackageTreeObservation } from "../../src/lib/package-tree-integrity";
import { createPackageTreeIntegrityGuardForServer } from "../../src/server/index/package-tree-guard";
import { acceptSystemRestart, noteExplicitShutdownRequested, setSystemRestartIoForTests } from "../../src/server/management/system-restart";

const original: PackageTreeObservation = {
  device: 1n, inode: 1n, contentTimeNs: 1n, size: 1n,
};
const replacement: PackageTreeObservation = { ...original, inode: 2n };

afterEach(() => setSystemRestartIoForTests());

describe("automatic package-tree restart ownership", () => {
  function setup(owned: () => boolean, onDrain: () => void = () => {}) {
    const calls: string[] = [];
    let observed = original;
    let scheduled: (() => void | Promise<void>) | undefined;
    setSystemRestartIoForTests({
      isShutdownDraining: () => false,
      getActiveTurnCount: () => 0,
      beginShutdownDrain: () => { calls.push("fence"); return true; },
      schedule: callback => { scheduled = callback; },
      scheduleDeadline: () => () => {},
      drainAndShutdown: async () => { calls.push("drain"); onDrain(); },
      isSupervisedServiceChild: () => true,
      stopListener: () => { calls.push("stop-listener"); },
      spawnStart: () => { calls.push("spawn"); },
      exitProcess: () => { calls.push("exit"); },
    });
    const guard = createPackageTreeIntegrityGuardForServer({
      packageTreeInstaller: "npm",
      observePackageTree: () => observed,
      packageTreeIntegrityOptions: { replacedRestartDelayMs: 0 },
    }, owned, () => true);
    return {
      guard, calls,
      replace: async () => {
        observed = replacement;
        expect(guard.status()).toEqual({ ok: false, reason: "package_tree_replaced" });
        await Promise.resolve();
      },
      runScheduled: async () => {
        if (!scheduled) throw new Error("restart was not scheduled");
        await scheduled();
      },
      wasScheduled: () => scheduled !== undefined,
    };
  }

  test("server disposal vetoes its accepted callback before drain or handoff", async () => {
    const fixture = setup(() => true);
    await fixture.replace();
    expect(fixture.wasScheduled()).toBe(true);
    fixture.guard.dispose(); // server.stop() calls this before closing the listener
    await fixture.runScheduled();
    expect(fixture.calls).toEqual(["fence"]);
  });

  test("an explicit shutdown during the automatic drain vetoes the handoff", async () => {
    const fixture = setup(() => true, () => noteExplicitShutdownRequested());
    await fixture.replace();
    await fixture.runScheduled();
    expect(fixture.calls).toEqual(["fence", "drain"]);
    fixture.guard.dispose();
  });

  test("an explicit shutdown does not change a manually requested restart", async () => {
    const fixture = setup(() => true, () => noteExplicitShutdownRequested());
    expect(acceptSystemRestart().alreadyDraining).toBe(false);
    await fixture.runScheduled();
    expect(fixture.calls).toEqual(["fence", "drain", "exit"]);
    fixture.guard.dispose();
  });

  test("disposing the guard does not veto a restart accepted by another caller", async () => {
    const fixture = setup(() => true);
    expect(acceptSystemRestart().alreadyDraining).toBe(false);
    await fixture.replace();
    fixture.guard.dispose();
    await fixture.runScheduled();
    expect(fixture.calls).toEqual(["fence", "drain", "exit"]);
  });

  test("foreign service home at admission keeps the 503 fence without accepting restart", async () => {
    const fixture = setup(() => false);
    await fixture.replace();
    expect(fixture.wasScheduled()).toBe(false);
    expect(fixture.guard.status()).toEqual({ ok: false, reason: "package_tree_replaced" });
    expect(fixture.calls).toEqual([]);
    fixture.guard.dispose();
  });

  test("service home changing after acceptance vetoes drain and handoff", async () => {
    let owned = true;
    const fixture = setup(() => owned);
    await fixture.replace();
    expect(fixture.wasScheduled()).toBe(true);
    owned = false;
    await fixture.runScheduled();
    expect(fixture.guard.status()).toEqual({ ok: false, reason: "package_tree_replaced" });
    expect(fixture.calls).toEqual(["fence"]);
    fixture.guard.dispose();
  });

  test("service home changing during drain vetoes the terminal handoff", async () => {
    let owned = true;
    const fixture = setup(() => owned, () => { owned = false; });
    await fixture.replace();
    await fixture.runScheduled();
    expect(fixture.calls).toEqual(["fence", "drain"]);
    fixture.guard.dispose();
  });
});
