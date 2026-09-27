import { describe, expect, test } from "bun:test";
import type { PackageTreeObservation } from "../../src/lib/package-tree-integrity";
import { createPackageTreeRetargetWatch, type LauncherTarget } from "../../src/lib/package-tree-retarget";
import { createPackageTreeIntegrityGuardForServer } from "../../src/server/index/package-tree-guard";

const RUNNING = "/mise/installs/opencodex/2.65.0/pkg";
const NEXT = "/mise/installs/opencodex/2.66.0/pkg";
const OTHER = "/mise/installs/opencodex/2.67.0/pkg";
const manifest = (inode: bigint): PackageTreeObservation => ({ device: 1n, inode, contentTimeNs: 1n, size: 1n });
const target = (root: string, inode = 1n): LauncherTarget => ({ root, manifest: manifest(inode) });

/**
 * Manual clock and scheduler. Only `tick()` advances anything, so every case proves detection
 * comes from the watch's own timer and never from a health or API request.
 */
function harness(initial: LauncherTarget | null = target(RUNNING), runningRoot = RUNNING) {
  let clock = 0;
  let pending: { callback: () => void; at: number } | null = null;
  let current = initial;
  let restarts = 0;
  let refuse = 0;
  const watch = createPackageTreeRetargetWatch(runningRoot, () => current, () => {
    if (refuse > 0) {
      refuse -= 1;
      throw new Error("admission refused");
    }
    restarts += 1;
  }, {
    pollIntervalMs: 1_000,
    settleMs: 3_000,
    now: () => clock,
    schedule: (callback, delayMs) => {
      const entry = { callback, at: clock + delayMs };
      pending = entry;
      return () => { if (pending === entry) pending = null; };
    },
    readVersion: root => (root === NEXT ? "2.66.0" : root === OTHER ? "2.67.0" : undefined),
  });
  return {
    watch,
    set: (next: LauncherTarget | null) => { current = next; },
    refuseNext: (count: number) => { refuse = count; },
    restarts: () => restarts,
    polling: () => pending !== null,
    tick: (times = 1) => {
      for (let i = 0; i < times; i += 1) {
        const entry = pending;
        if (!entry) return;
        pending = null;
        clock = entry.at;
        entry.callback();
      }
    },
  };
}

describe("package-tree retarget watch", () => {
  test("an idle service restarts once the launcher's new target has held for the settle interval", () => {
    const h = harness();
    h.tick(2);
    h.set(target(NEXT));
    h.tick(); // first sighting at t=3s
    h.tick(2); // t=5s: held 2s
    expect(h.restarts()).toBe(0);
    h.tick(); // t=6s: held 3s
    expect(h.restarts()).toBe(1);
    expect(h.polling()).toBe(false);
  });

  test("a launcher that keeps resolving to the running package never restarts", () => {
    const h = harness();
    h.tick(20);
    expect(h.restarts()).toBe(0);
    expect(h.polling()).toBe(true);
  });

  test("retargeting again during the wait restarts the full settle interval", () => {
    const h = harness();
    h.set(target(NEXT));
    h.tick(3);
    h.set(target(OTHER));
    h.tick(3);
    expect(h.restarts()).toBe(0);
    h.tick();
    expect(h.restarts()).toBe(1);
    expect(h.watch.settledVersion()).toBe("2.67.0");
  });

  test("a manifest change inside the same target root restarts the wait", () => {
    const h = harness();
    h.set(target(NEXT, 1n));
    h.tick(3);
    h.set(target(NEXT, 2n)); // the install rewrote package.json after the root appeared
    h.tick(3);
    expect(h.restarts()).toBe(0);
    h.tick();
    expect(h.restarts()).toBe(1);
  });

  test("reverting to the running package during the wait cancels the restart", () => {
    const h = harness();
    h.set(target(NEXT));
    h.tick(2);
    h.set(target(RUNNING));
    h.tick(10);
    expect(h.restarts()).toBe(0);
    expect(h.watch.settledVersion()).toBeUndefined();
  });

  test("a target that briefly cannot be resolved needs a fresh full interval after it recovers", () => {
    const h = harness();
    h.set(target(NEXT));
    h.tick(3);
    h.set(null);
    h.tick();
    h.set(target(NEXT));
    h.tick(3);
    expect(h.restarts()).toBe(0);
    h.tick();
    expect(h.restarts()).toBe(1);
  });

  test("a refused restart is asked again only after another full interval", () => {
    const h = harness();
    h.refuseNext(1);
    h.set(target(NEXT));
    h.tick(4); // refused at t=4s
    expect(h.restarts()).toBe(0);
    h.tick(2);
    expect(h.restarts()).toBe(0);
    h.tick();
    expect(h.restarts()).toBe(1);
  });

  test("the replacement process booted from the new target does not restart again", () => {
    const h = harness(target(NEXT), NEXT);
    h.tick(20);
    expect(h.restarts()).toBe(0);
  });

  test("settledVersion reports the settled target only while it still resolves identically", () => {
    const h = harness();
    expect(h.watch.settledVersion()).toBeUndefined();
    h.set(target(NEXT));
    h.tick(3);
    expect(h.watch.settledVersion()).toBeUndefined();
    h.tick();
    expect(h.watch.settledVersion()).toBe("2.66.0");
    h.set(target(NEXT, 9n));
    expect(h.watch.settledVersion()).toBeUndefined();
  });

  test("dispose stops polling and invalidates a pending restart", () => {
    const h = harness();
    h.set(target(NEXT));
    h.tick(3);
    h.watch.dispose();
    expect(h.polling()).toBe(false);
    h.tick(5);
    expect(h.restarts()).toBe(0);
  });
});

describe("server package-tree guard with a launcher plan", () => {
  function serverGuard(serviceChild: boolean, owned: boolean) {
    let current: LauncherTarget | null = target(RUNNING);
    let pending: (() => void) | null = null;
    const accepted: string[] = [];
    let busy = 0;
    const guard = createPackageTreeIntegrityGuardForServer({
      packageTreeInstaller: "mise",
      observePackageTree: () => manifest(1n),
      packageTreeLauncherTarget: { runningRoot: RUNNING, resolveTarget: () => current },
      packageTreeRetargetOptions: {
        pollIntervalMs: 1,
        settleMs: 0,
        schedule: callback => { pending = callback; return () => { pending = null; }; },
        readVersion: root => (root === NEXT ? "2.66.0" : undefined),
      },
      acceptSystemRestart: (() => {
        accepted.push("restart");
        if (busy > 0) { busy--; return { accepted: true, alreadyDraining: true, activeTurnCount: 0, drainTimeoutMs: 0 }; }
        return { accepted: true, alreadyDraining: false, activeTurnCount: 0, drainTimeoutMs: 0 };
      }) as never,
    }, () => owned, () => serviceChild);
    const tick = () => { const run = pending; pending = null; run?.(); };
    return {
      guard, accepted, tick, busyFor: (n: number) => { busy = n; },
      retarget: (next: LauncherTarget | null) => { current = next; },
    };
  }

  test("a mise upgrade restarts through the shared handler without fencing requests", () => {
    const s = serverGuard(true, true);
    s.retarget(target(NEXT));
    s.tick();
    s.tick();
    expect(s.accepted).toEqual(["restart"]);
    expect(s.guard.status()).toEqual({ ok: true });
    expect(s.guard.installedVersion?.()).toBe("2.66.0");
    s.guard.dispose();
  });

  test("a busy restart admission is asked again instead of stopping the watch", () => {
    const s = serverGuard(true, true);
    s.busyFor(1);
    s.retarget(target(NEXT));
    for (let i = 0; i < 6; i++) s.tick();
    // The first admission was busy (another drain held the gate); the watch asks again.
    expect(s.accepted).toEqual(["restart", "restart"]);
    s.guard.dispose();
  });

  test("a service child that no longer owns its home refuses and keeps waiting", () => {
    const s = serverGuard(true, false);
    s.retarget(target(NEXT));
    s.tick();
    s.tick();
    expect(s.accepted).toEqual([]);
    s.guard.dispose();
  });

  test("null plan keeps the fence-only behavior", () => {
    const guard = createPackageTreeIntegrityGuardForServer({
      packageTreeInstaller: "mise",
      observePackageTree: () => manifest(1n),
      packageTreeLauncherTarget: null,
    }, () => true, () => true);
    expect(guard.status()).toEqual({ ok: true });
    expect(guard.installedVersion?.()).toBeUndefined();
    guard.dispose();
  });
});
