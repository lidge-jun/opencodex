/**
 * Caller-level wiring of the checked Windows stop (#7771, 030 "Where it sits"): the
 * /api/stop route, ocx service stop / uninstall, the guarded (consent) path with its
 * bound-stray state, and the evidence snapshot the guarded bind must use. Hermetic: Part A and
 * Part B are answered by fixtures or run against injected deps; nothing reaches the machine.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { inspectGuardedTarget, resetOcxWindowsStopForTests, stopGuardedManager } from "../../src/cli/stop-windows-checked";
import { runGuardedManagerStep, type GuardedStopSnapshot } from "../../src/cli/stop-approval";
import { ROUTE_PART_A_CAP_MS, ROUTE_STRAY_SWEEP_CAP_MS, routeServiceStop } from "../../src/server/stop-service-route";
import { completeWindowsServiceStopReceipt, windowsServiceRemovalStop as removalStop, windowsServiceStopBeforeRestore as stopBeforeRestore } from "../../src/service/cli-windows-stop";
import { inspectGuardedManagerTarget, type GuardedManagerTarget } from "../../src/service/guarded-manager-target";
import type { WindowsCheckedStopDeps } from "../../src/service/windows-checked-stop";
import type { WindowsProcessWatch } from "../../src/service/windows-process-native";

const fixtureTarget = { pid: 4321, endpoint: { hostname: "127.0.0.1", port: 10100 } };
const windowsServiceStopBeforeRestore: typeof stopBeforeRestore = io => stopBeforeRestore({ resolveTarget: async () => fixtureTarget, ...io });
const windowsServiceRemovalStop: typeof removalStop = io => removalStop({ resolveTarget: async () => fixtureTarget, ...io });
import type { WindowsStopProcessEntry } from "../../src/service/windows-process-evidence";
import { runWindowsServiceStopPartA, serviceStopOutcomeFromWindows, setStopDeadlineMs, setWindowsServiceStopHooksForTests } from "../../src/service/windows-service-stop";
import { CMD, PATHS, SCHEDULE_PID, VBS, entry, launcher, loop, proxy, scheduleHost } from "../helpers/windows-checked-stop-fixtures";
import { ALL_PART_A_FAILURES, partAResult, partBResult } from "../helpers/windows-stop-caller-fixtures";

afterEach(() => {
  setWindowsServiceStopHooksForTests(null);
  setStopDeadlineMs(null);
  resetOcxWindowsStopForTests(null);
});

const RECORD = { partA: "stopped" as const, manager: { scheduler: true, winsw: false }, wrappers: [{ pid: 30, startTime: 5_100 }] };
const url = (nonce = "a".repeat(32)) => new URL("http://127.0.0.1:10100/api/stop?deferSharedTeardown=1&teardownNonce=" + nonce);

describe("/api/stop service stop on Windows", () => {
  const route = (holdsReceipt: boolean, io: Parameters<typeof routeServiceStop>[2] = {}) => {
    const stops: unknown[] = [];
    const run = routeServiceStop(url(), holdsReceipt, {
      platform: "win32", assertEnvironment: () => {}, winswRegistered: () => false,
      stop: async request => { stops.push(request); return "stopped"; },
      ...io,
    });
    return { run, stops };
  };

  test("a receipt whose Part A record names the registered manager skips Part A", async () => {
    const { run, stops } = route(true, { readRecord: () => RECORD, registration: async () => ({ scheduler: "present", winsw: "nonexistent" }) });
    expect(await run).toBe("stopped");
    expect(stops).toEqual([]);
  });

  test("a receipt without the record, or naming another manager, re-runs Part A capped at 6 s", async () => {
    for (const io of [
      { readRecord: () => null },
      { readRecord: () => RECORD, registration: async () => ({ scheduler: "absent" as const, winsw: "nonexistent" as const }) },
      { readRecord: () => RECORD, registration: async () => ({ scheduler: "unknown" as const, winsw: "nonexistent" as const }) },
    ]) {
      const { run, stops } = route(true, io);
      await run;
      expect(stops).toEqual([{ capMs: ROUTE_PART_A_CAP_MS, allowUnderOwnWrapper: true }]);
    }
    expect(ROUTE_PART_A_CAP_MS).toBe(6_000);
  });

  test("no receipt: WinSW keeps today's in-process stop; otherwise the 4 s stray sweep", async () => {
    let winsw = 0;
    const native = route(false, { winswRegistered: () => true, stopWinsw: () => { winsw++; } });
    expect(await native.run).toBe("stopped");
    expect(native.stops).toEqual([]);
    expect(winsw).toBe(1);
    expect(await route(false, { winswRegistered: () => true, stopWinsw: () => { throw new Error("x"); } }).run).toBe("failed");
    const stray = route(false);
    await stray.run;
    expect(stray.stops).toEqual([{ capMs: ROUTE_STRAY_SWEEP_CAP_MS, allowUnderOwnWrapper: true }]);
    expect(ROUTE_STRAY_SWEEP_CAP_MS).toBe(4_000);
  });

  test("off Windows the route keeps today's service stop", async () => {
    const { run, stops } = route(true, { platform: "darwin", readRecord: () => RECORD });
    await run;
    expect(stops).toEqual([{}]);
  });

  test("a capped Part A that overruns answers service_state_unknown's outcome without waiting for it", async () => {
    setWindowsServiceStopHooksForTests({ partA: () => new Promise(() => {}) });
    const started = performance.now();
    const result = await runWindowsServiceStopPartA({ capMs: 30, allowUnderOwnWrapper: true });
    expect(performance.now() - started).toBeLessThan(500);
    expect(serviceStopOutcomeFromWindows(result)).toBe("state-unknown");
  });
});

describe("ocx service stop on Windows", () => {
  test("a discovered orphan's endpoint is used for both receipt and stop", async () => {
    setWindowsServiceStopHooksForTests({ partA: async () => partAResult("stopped"), partB: async () => partBResult("freed") });
    const endpoint = { hostname: "127.0.0.1", port: 12001 };
    let claimed: unknown;
    let stopped: unknown;
    const result = await windowsServiceStopBeforeRestore({
      ownsSharedTeardown: () => true,
      resolveTarget: async () => ({ pid: 4321, endpoint }),
      claim: (address) => { claimed = address; return { nonce: "n" } as never; },
      stopTracked: async io => { stopped = io?.target; return "stopped"; },
    });
    expect(result.ok).toBe(true);
    expect(claimed).toEqual(endpoint);
    expect(stopped).toEqual({ pid: 4321, endpoint });
  });

  test("no resolved target claims no receipt", async () => {
    setWindowsServiceStopHooksForTests({ partA: async () => partAResult("stopped"), partB: async () => partBResult("freed") });
    let claimed = false;
    let target: unknown = "unset";
    const result = await windowsServiceStopBeforeRestore({ resolveTarget: async () => null,
      ownsSharedTeardown: () => true, claim: () => { claimed = true; return { nonce: "n" } as never; },
      stopTracked: async io => { target = io?.target; return "none"; } });
    expect(result.ok).toBe(true);
    expect(claimed).toBe(false);
    expect(target).toBeNull();
  });
  test("a Part A other than stopped/absent refuses before the receipt and the child stop", async () => {
    for (const outcome of ALL_PART_A_FAILURES) {
      const steps: string[] = [];
      setWindowsServiceStopHooksForTests({ partA: async () => partAResult(outcome) });
      const result = await windowsServiceStopBeforeRestore({
        ownsSharedTeardown: () => true,
        claim: () => { steps.push("claim"); return { nonce: "n" } as never; },
        stopTracked: async () => { steps.push("child"); return "stopped"; },
      });
      expect(result.ok).toBe(false);
      expect(steps).toEqual([]);
    }
  });

  test("claims the receipt before the deferred child stop, and completes it only after Part B and the restore", async () => {
    const steps: string[] = [];
    let claimed: unknown;
    setWindowsServiceStopHooksForTests({
      partA: async () => { steps.push("partA"); return partAResult("stopped"); },
      partB: async () => { steps.push("partB"); return partBResult("freed"); },
    });
    const result = await windowsServiceStopBeforeRestore({
      ownsSharedTeardown: () => true,
      claim: (_endpoint, _source, _owner, _handover, partA) => { steps.push("claim"); claimed = partA; return { nonce: "n1" } as never; },
      stopTracked: async io => { steps.push("child:" + io?.deferSharedTeardownNonce + ":" + io?.skipPortWait); return "stopped"; },
    });
    expect(steps).toEqual(["partA", "claim", "child:n1:true", "partB"]);
    expect(claimed).toEqual(RECORD);
    expect(result).toEqual({ ok: true, nonce: "n1" });
    const cleared: string[] = [];
    completeWindowsServiceStopReceipt(result.nonce, nonce => { cleared.push(nonce); return true; });
    expect(cleared).toEqual(["n1"]);
  });

  test("a claim failure while this home owns the teardown sends no undeferred child stop", async () => {
    const steps: string[] = [];
    setWindowsServiceStopHooksForTests({ partA: async () => partAResult("stopped") });
    const result = await windowsServiceStopBeforeRestore({
      ownsSharedTeardown: () => true,
      claim: () => { throw new Error("disk full"); },
      stopTracked: async () => { steps.push("child"); return "stopped"; },
    });
    expect(result.ok).toBe(false);
    expect(steps).toEqual([]);
  });

  test("the not-owned teardown path is unchanged: no receipt, an ordinary child stop", async () => {
    const children: unknown[] = [];
    setWindowsServiceStopHooksForTests({ partA: async () => partAResult("stopped"), partB: async () => partBResult("freed") });
    const result = await windowsServiceStopBeforeRestore({
      ownsSharedTeardown: () => false,
      claim: () => { throw new Error("must not claim"); },
      stopTracked: async io => { children.push(io); return "stopped"; },
    });
    expect(result).toEqual({ ok: true });
    // #7771: the stop also names the admitted discovery cap, so the helper cannot spend 7 s
    // of a budget whose 3 s for this step was already proven at admission.
    expect(children).toEqual([{ target: fixtureTarget, skipPortWait: true, orphanDiscoveryCapMs: 3_000 }]);
  });

  test("Part B failure keeps the receipt (no restore); a foreign listener does not fail the stop", async () => {
    for (const [outcome, ok] of [["survived", false], ["unknown", false], ["unconfirmed", false], ["port-held-by-foreign", true]] as const) {
      setWindowsServiceStopHooksForTests({ partA: async () => partAResult("stopped"), partB: async () => partBResult(outcome) });
      const result = await windowsServiceStopBeforeRestore({
        ownsSharedTeardown: () => true, claim: () => ({ nonce: "n2" }) as never, stopTracked: async () => "stopped",
      });
      expect(result.ok).toBe(ok);
    }
  });

  test("absent refuses an unknown endpoint and keeps the receipt", async () => {
    setWindowsServiceStopHooksForTests({ partA: async () => partAResult("absent") });
    const result = await windowsServiceStopBeforeRestore({
      ownsSharedTeardown: () => true, claim: () => ({ nonce: "kept" }) as never,
      stopTracked: async () => "none",
      endpoints: () => [{ hostname: "127.0.0.1", port: 10100 }], endpointLiveness: async () => "unknown",
    });
    expect(result.ok).toBe(false);
  });

  test("absent checks endpoints instead of Part B", async () => {
    let partB = 0;
    setWindowsServiceStopHooksForTests({ partA: async () => partAResult("absent"), partB: async () => { partB++; return partBResult("freed"); } });
    const live = await windowsServiceStopBeforeRestore({
      ownsSharedTeardown: () => false, stopTracked: async () => "none", endpoints: () => [{ hostname: "127.0.0.1", port: 10100 }], endpointLiveness: async () => "live",
    });
    expect(live.ok).toBe(false);
    expect(partB).toBe(0);
  });
});

describe("ocx service uninstall / remove on Windows", () => {
  test("refuses before deleting the task unless Part A stopped (or found nothing) and Part B freed the port", async () => {
    for (const outcome of ALL_PART_A_FAILURES) {
      let child = 0;
      setWindowsServiceStopHooksForTests({ partA: async () => partAResult(outcome) });
      expect((await windowsServiceRemovalStop({ stopTracked: async () => { child++; return "stopped"; } })).ok).toBe(false);
      expect(child).toBe(0);
    }
    for (const [outcome, ok] of [["freed", true], ["port-held-by-foreign", true], ["survived", false], ["unknown", false]] as const) {
      setWindowsServiceStopHooksForTests({ partA: async () => partAResult("stopped"), partB: async () => partBResult(outcome) });
      expect((await windowsServiceRemovalStop({ stopTracked: async () => "stopped" })).ok).toBe(ok);
    }
  });

  test("an absent Part A asks the endpoint itself: only a definitive down permits removal", async () => {
    // Part A "absent" only says no manager is registered. `findLiveProxy` can return null
    // when its discovery cap runs out while the endpoint is live, so removal must ask the
    // endpoint itself before deleting the task — and a probe that could not answer
    // (timeout, transport failure) is not the answer "nothing is serving". Only the
    // tri-state "dead" admits removal; "live" and "unknown" refuse and keep the receipt.
    for (const [answer, ok] of [["dead", true], ["live", false], ["unknown", false]] as const) {
      setWindowsServiceStopHooksForTests({ partA: async () => partAResult("absent") });
      const probed: { port: number }[] = [];
      const result = await windowsServiceRemovalStop({
        ownsSharedTeardown: () => false,
        stopTracked: async () => "none",
        endpointLiveness: async endpoint => { probed.push(endpoint); return answer; },
      });
      expect(result.ok).toBe(ok);
      expect(probed.length).toBe(1);
      expect(probed[0]!.port).toBeGreaterThan(0);
    }
  });

  test("an absent Part A proves EVERY candidate endpoint dead, not just the receipt's", async () => {
    // #7771 round 9: with Part A absent only the receipt endpoint was probed. A stale runtime
    // record naming a closed port then "proved" removal while the configured port had a live
    // listener, and the task was deleted under it. The candidate set is the one `ocx uninstall`
    // proves (`endpointsToProve(readRuntimePort(), loadConfig())`), and every candidate has to
    // answer definitively dead.
    setWindowsServiceStopHooksForTests({ partA: async () => partAResult("absent") });
    const probed: { hostname: string; port: number }[] = [];
    const result = await windowsServiceRemovalStop({
      ownsSharedTeardown: () => false,
      stopTracked: async () => "none",
      endpoints: () => [{ hostname: "127.0.0.1", port: 10999 }, { hostname: "127.0.0.1", port: 10100 }],
      endpointLiveness: async endpoint => {
        probed.push(endpoint);
        return endpoint.port === 10999 ? "dead" : "live";
      },
    });
    expect(result.ok).toBe(false);
    expect(probed.map(e => e.port)).toEqual([10999, 10100]);

    // One unreadable candidate refuses too, and nothing is deleted.
    probed.length = 0;
    const unknown = await windowsServiceRemovalStop({
      ownsSharedTeardown: () => false,
      stopTracked: async () => "none",
      endpoints: () => [{ hostname: "127.0.0.1", port: 10999 }, { hostname: "127.0.0.1", port: 10100 }],
      endpointLiveness: async endpoint => { probed.push(endpoint); return endpoint.port === 10999 ? "dead" : "unknown"; },
    });
    expect(unknown.ok).toBe(false);
    expect(probed).toHaveLength(2);

    // Every candidate dead is the only proof.
    const dead = await windowsServiceRemovalStop({
      ownsSharedTeardown: () => false,
      stopTracked: async () => "none",
      endpoints: () => [{ hostname: "127.0.0.1", port: 10999 }, { hostname: "127.0.0.1", port: 10100 }],
      endpointLiveness: async () => "dead",
    });
    expect(dead.ok).toBe(true);
  });

  test("an unreadable absent-Part-A probe refuses and keeps the receipt", async () => {
    // The old branch read `proxyStillLiveAfterStop`'s null — its answer for a timed-out or
    // failed probe — as success and deleted the task, and a claimed receipt was reported
    // as discharged by the caller.
    setWindowsServiceStopHooksForTests({ partA: async () => partAResult("absent") });
    let claimed = 0;
    let probed = 0;
    const result = await windowsServiceRemovalStop({
      ownsSharedTeardown: () => true,
      claim: () => { claimed++; return { nonce: "r3" } as never; },
      stopTracked: async () => "none",
      endpointLiveness: async () => { probed++; throw new Error("probe timed out"); },
    });
    expect(claimed).toBe(1);
    // The endpoint is what has to answer; a survivor probe's null never stood in for it.
    expect(probed).toBe(1);
    expect(result).toEqual({ ok: false });
  });

  test("claims a receipt carrying the Part A record before the POST, so the route does not answer 409", async () => {
    // Deleting the registration leaves the scheduler task's receipt-less POST answering
    // respawnable_service, which fails the uninstall. `ocx service stop` already claims;
    // removal has to do the same, and keep the receipt until the restore succeeds.
    const steps: string[] = [];
    let claimed: unknown;
    setWindowsServiceStopHooksForTests({
      partA: async () => { steps.push("partA"); return partAResult("stopped"); },
      partB: async () => { steps.push("partB"); return partBResult("freed"); },
    });
    const result = await windowsServiceRemovalStop({
      ownsSharedTeardown: () => true,
      claim: (_endpoint, _source, _owner, _handover, partA) => { steps.push("claim"); claimed = partA; return { nonce: "r1" } as never; },
      stopTracked: async io => { steps.push("child:" + io?.deferSharedTeardownNonce + ":" + io?.skipPortWait); return "stopped"; },
    });
    expect(steps).toEqual(["partA", "claim", "child:r1:true", "partB"]);
    expect(claimed).toEqual(RECORD);
    expect(result).toEqual({ ok: true, nonce: "r1" });
    // Keep until the restore runs: only the caller's completion clears it.
    const cleared: string[] = [];
    completeWindowsServiceStopReceipt(result.nonce, nonce => { cleared.push(nonce); return true; });
    expect(cleared).toEqual(["r1"]);
  });

  test("a claim failure sends no undeferred child stop", async () => {
    const steps: string[] = [];
    setWindowsServiceStopHooksForTests({ partA: async () => partAResult("stopped") });
    const result = await windowsServiceRemovalStop({
      ownsSharedTeardown: () => true,
      claim: () => { throw new Error("disk full"); },
      stopTracked: async () => { steps.push("child"); return "stopped"; },
    });
    expect(result.ok).toBe(false);
    expect(steps).toEqual([]);
  });

  test("a failed Part B keeps the receipt for recovery", async () => {
    const steps: string[] = [];
    setWindowsServiceStopHooksForTests({ partA: async () => partAResult("stopped"), partB: async () => partBResult("survived") });
    const result = await windowsServiceRemovalStop({
      ownsSharedTeardown: () => true, claim: () => ({ nonce: "r2" }) as never,
      stopTracked: async io => { steps.push("child:" + io?.deferSharedTeardownNonce); return "stopped"; },
    });
    expect(result).toEqual({ ok: false });
    expect(steps).toEqual(["child:r2"]);
  });

  test("the not-owned teardown path is unchanged: no receipt, an ordinary child stop", async () => {
    const children: unknown[] = [];
    setWindowsServiceStopHooksForTests({ partA: async () => partAResult("stopped"), partB: async () => partBResult("freed") });
    const result = await windowsServiceRemovalStop({
      ownsSharedTeardown: () => false,
      claim: () => { throw new Error("must not claim"); },
      stopTracked: async io => { children.push(io); return "stopped"; },
    });
    expect(result).toEqual({ ok: true });
    // #7771: the stop also names the admitted discovery cap, so the helper cannot spend 7 s
    // of a budget whose 3 s for this step was already proven at admission.
    expect(children).toEqual([{ target: fixtureTarget, skipPortWait: true, orphanDiscoveryCapMs: 3_000 }]);
  });
});

describe("guarded (consent) path", () => {
  const strayManager: Extract<GuardedManagerTarget, { kind: "bound-stray" }> = {
    kind: "bound-stray", pid: 42, backend: "scheduler", childNeedsSeparateStop: true,
    wrappers: [{ pid: 30, startTime: 5_100 }, { pid: 20, startTime: 5_000 }],
  };
  const snapshot = (manager: GuardedStopSnapshot["manager"]): GuardedStopSnapshot => ({
    approval: { pid: 42, port: 10100, hostname: "127.0.0.1", configHome: "/h", cliVersion: "2.0.0", compatibilityToken: "a".repeat(64) },
    manager,
  });

  test("order: the wrappers end before signalApproved; the approved PID still gets its graceful signal; Part B after settle", async () => {
    const order: string[] = [];
    const step = await runGuardedManagerStep(snapshot(strayManager), {
      revalidateManager: async () => { order.push("revalidate"); return strayManager; },
      stopManager: async () => { order.push("partA"); return "stopped"; },
      signalApproved: async () => { order.push("signal"); return false; },
      settle: async () => { order.push("settle"); return true; },
      confirmFreed: async () => { order.push("partB"); return true; },
      managerState: async () => { order.push("state"); return "inactive"; },
    });
    expect(order).toEqual(["revalidate", "partA", "signal", "settle", "partB", "state"]);
    expect(step.effect).toBe("stopped");
  });

  test("Part A not stopped is manager-still-active and the approved PID is never signalled (a refusal is never forced)", async () => {
    for (const service of ["failed", "state-unknown"] as const) {
      const order: string[] = [];
      const step = await runGuardedManagerStep(snapshot(strayManager), {
        revalidateManager: () => strayManager,
        stopManager: async () => service,
        signalApproved: async () => { order.push("signal"); return true; },
        settle: async () => { order.push("settle"); return true; },
        confirmFreed: async () => { order.push("partB"); return true; },
        managerState: async () => "inactive",
      });
      expect(step.effect).toBe("manager-still-active");
      expect(order).toEqual([]);
    }
    // A graceful signal that is refused (409) fails the step without settle or Part B.
    const order: string[] = [];
    const refused = await runGuardedManagerStep(snapshot(strayManager), {
      revalidateManager: () => strayManager, stopManager: async () => "stopped",
      signalApproved: async () => { throw new Error("409"); },
      settle: async () => { order.push("settle"); return true; },
      confirmFreed: async () => { order.push("partB"); return true; },
      managerState: async () => "inactive",
    });
    expect(refused.effect).toBe("failed");
    expect(order).toEqual([]);
  });

  test("Part B failure is manager-still-active; an absent manager runs neither Part A nor Part B", async () => {
    const failed = await runGuardedManagerStep(snapshot(strayManager), {
      revalidateManager: () => strayManager, stopManager: async () => "stopped", signalApproved: async () => false,
      settle: async () => true, confirmFreed: async () => false, managerState: async () => "inactive",
    });
    expect(failed.effect).toBe("manager-still-active");
    const order: string[] = [];
    const absent = await runGuardedManagerStep(snapshot({ kind: "absent" }), {
      revalidateManager: () => ({ kind: "absent" }), stopManager: async () => { order.push("partA"); return "stopped"; },
      signalApproved: async () => false, settle: async () => true,
      confirmFreed: async () => { order.push("partB"); return true; }, managerState: async () => "inactive",
    });
    expect(absent.effect).toBe("stopped");
    expect(order).toEqual([]);
  });

  test("revalidation compares the bound wrapper set; an unbindable survivor carries its reason", async () => {
    const io = (current: GuardedManagerTarget) => ({
      revalidateManager: () => current, stopManager: async () => "stopped" as const, signalApproved: async () => false,
      settle: async () => true, managerState: async () => "inactive" as const,
    });
    const changed = await runGuardedManagerStep(snapshot(strayManager), io({ ...strayManager, wrappers: [{ pid: 30, startTime: 9_999 }, { pid: 20, startTime: 5_000 }] }));
    expect(changed.effect).toBe("approval-changed");
    const reordered = await runGuardedManagerStep(snapshot(strayManager), io({ ...strayManager, wrappers: [...strayManager.wrappers].reverse() }));
    expect(reordered.effect).toBe("stopped");
    const unbound = await runGuardedManagerStep(snapshot(strayManager), io({ kind: "unknown", reason: "x", stopReason: "unbound-wrapper" }));
    expect(unbound).toMatchObject({ effect: "approval-changed", stopReason: "unbound-wrapper" });
  });
});

describe("guarded inspection: the binding rule decides bound-stray", () => {
  const inspect = (processes: WindowsStopProcessEntry[] | Omit<WindowsStopProcessEntry, "startTime">[]) =>
    inspectGuardedManagerTarget(42, 10100, {
      platform: "win32", verifyPid: pid => pid,
      scheduler: () => ({ status: "present" }), winsw: () => "nonexistent",
      win: {
        winProcs: () => processes as WindowsStopProcessEntry[], winTaskState: () => "not-running",
        // #7771: a not-running task promotes its survivors only after the definition is read
        // and recognised as this installation's.
        winTaskXml: () => "<Task>xml</Task>", winRegistrationOurs: () => true,
        winSchedulePid: () => SCHEDULE_PID, winScriptPath: () => CMD, winLauncherPath: () => VBS,
      },
    });
  // The task is registered but not running; its launcher and loop survive with the child.
  const tree = () => [scheduleHost, launcher(), loop(), proxy()];

  test("surviving wrappers bound by the rule are bound-stray with their pid + creation time", () => {
    expect(inspect(tree())).toEqual({
      kind: "bound-stray", pid: 42, backend: "scheduler", childNeedsSeparateStop: true,
      wrappers: [{ pid: 30, startTime: 5_100 }, { pid: 20, startTime: 5_000 }],
    });
  });

  test("a CIM-only table (no creation times) cannot bind: unknown / evidence-unreadable", () => {
    const cimOnly = tree().map(({ startTime: _startTime, ...rest }) => rest);
    expect(inspect(cimOnly)).toMatchObject({ kind: "unknown", stopReason: "evidence-unreadable" });
  });

  test("the same bindable survivors stay unknown when the not-running registration is not provably ours", () => {
    // #7771: this tree binds to bound-stray when the definition is ours (test above). A
    // same-named foreign task, or a definition that cannot be read, must not turn this
    // home's surviving wrappers into terminable ones.
    const withDefinition = (win: { winTaskXml?: () => string; winRegistrationOurs?: () => boolean }) =>
      inspectGuardedManagerTarget(42, 10100, {
        platform: "win32", verifyPid: pid => pid,
        scheduler: () => ({ status: "present" }), winsw: () => "nonexistent",
        win: {
          winProcs: () => tree(), winTaskState: () => "not-running",
          winTaskXml: () => "<Task>xml</Task>", winRegistrationOurs: () => true,
          winSchedulePid: () => SCHEDULE_PID, winScriptPath: () => CMD, winLauncherPath: () => VBS,
          ...win,
        },
      });
    expect(withDefinition({}).kind).toBe("bound-stray");
    expect(withDefinition({ winRegistrationOurs: () => false }).kind).toBe("unknown");
    expect(withDefinition({ winTaskXml: () => { throw new Error("access denied"); } }))
      .toMatchObject({ kind: "unknown", stopReason: "evidence-unreadable" });
  });

  test("a hand-started launcher under a live shell stays unknown / unbound-wrapper", () => {
    const shell = entry(60, 1, "pwsh.exe", "pwsh", 100);
    // The task's own wrappers bind; a second launcher started by hand from a live shell is not
    // an ancestor of the approved child, its parent is neither the Schedule host nor gone, and
    // its loop descends only from it, so neither may be ended.
    const handStarted = [...tree(), shell, launcher(50, 60, 7_000), loop(51, 50, 7_100)];
    const target = inspect(handStarted);
    expect(target.kind).toBe("unknown");
    expect(target).toMatchObject({ stopReason: "unbound-wrapper" });
  });
});

describe("the guarded bind uses the evidence snapshot (native creation times), never the CIM-only list", () => {
  // On x64 the evidence snapshot carries the native creation time, which is exactly what the
  // handle terminate compares. The CIM-only time differs below the millisecond, and a terminate
  // checked against it answers "reused": Part A would then treat a live wrapper as exited.
  const NATIVE = { 20: 5_000, 30: 5_100 } as Record<number, number>;
  const evidence = (): WindowsStopProcessEntry[] => [scheduleHost, launcher(20, SCHEDULE_PID, NATIVE[20]), loop(30, 20, NATIVE[30]), proxy()];
  const cimOnly = (): WindowsStopProcessEntry[] => [scheduleHost, launcher(20, SCHEDULE_PID, NATIVE[20]! - 1), loop(30, 20, NATIVE[30]! - 1), proxy()];

  function machine() {
    const terminated: number[] = [];
    const reused: number[] = [];
    const enumerations: string[] = [];
    const dead = new Set<number>();
    const deps: WindowsCheckedStopDeps = {
      canonicalPaths: PATHS, childPid: 42, selfPid: 1,
      probeScheduler: () => ({ status: "present" }), probeWinsw: () => "nonexistent",
      // What a CIM-only enumeration would return; the guarded bind must not use it.
      enumerate: () => { enumerations.push("cim"); return cimOnly(); },
      scheduleServicePid: () => SCHEDULE_PID, endTask: () => "not-running", taskState: () => "not-running",
      winswStop: () => "sent", winswState: () => "stopped", proxyAlive: () => false,
      openWatch: (pid): WindowsProcessWatch => ({ status: "open", exited: () => dead.has(pid), close() {} }),
      terminate: (pid, startTime) => {
        if (NATIVE[pid] !== startTime) { reused.push(pid); return { status: "reused" }; }
        terminated.push(pid); dead.add(pid); return { status: "terminated", exited: true };
      },
    };
    return { deps, terminated, reused, enumerations };
  }

  test("inspectGuardedTarget reads the evidence snapshot once and stopGuardedManager binds on it", async () => {
    resetOcxWindowsStopForTests("win32");
    setStopDeadlineMs(Math.ceil(performance.now()) + 120_000);
    const fake = machine();
    setWindowsServiceStopHooksForTests({ snapshot: async () => evidence(), schedulePid: async () => SCHEDULE_PID, liveDeps: () => fake.deps });
    const target = await inspectGuardedTarget(42, 10100, (pid, port, deps) => inspectGuardedManagerTarget(pid, port, {
      ...deps, platform: "win32", verifyPid: p => p, scheduler: () => ({ status: "present" }), winsw: () => "nonexistent",
      win: {
        ...deps?.win, winTaskState: () => "not-running", winScriptPath: () => CMD, winLauncherPath: () => VBS,
        winTaskXml: () => "<Task>xml</Task>", winRegistrationOurs: () => true,
      },
    }));
    expect(target.kind).toBe("bound-stray");
    const outcome = await stopGuardedManager({ approvedPort: 10100, receiptNonce: () => undefined, inheritedReceipts: 0 });
    expect(outcome).toBe("stopped");
    expect(fake.enumerations).toEqual([]);
    expect(fake.reused).toEqual([]);
    expect(fake.terminated).toEqual([30, 20]);
  });

  test("the hazard it prevents: binding on the CIM-only list ends nothing yet reports stopped", async () => {
    const fake = machine();
    setWindowsServiceStopHooksForTests({ liveDeps: () => fake.deps });
    const result = await runWindowsServiceStopPartA();
    expect(fake.enumerations).toEqual(["cim"]);
    expect(fake.terminated).toEqual([]);
    expect(fake.reused).toEqual([30, 20]);
    expect(result.outcome).toBe("stopped");
  });
});
