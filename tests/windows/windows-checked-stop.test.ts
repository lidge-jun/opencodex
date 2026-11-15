// Part A of the checked Windows stop (#7771, 030 "Steps" and "Time budget"). Hermetic:
// every probe, command, watch and terminate is injected; nothing reaches the machine.
import { describe, expect, test } from "bun:test";

import type { WinswStatus } from "../../src/lib/winsw";
import {
  guardedStopWindowsServiceChecked,
  stopWindowsServiceChecked,
  WindowsCheckedStopRefusedError,
  type WindowsCheckedStopDeps,
  type WindowsWinswScmState,
} from "../../src/service/windows-checked-stop";
import type { WindowsProcessWatch, WindowsTerminateResult } from "../../src/service/windows-process-native";
import type { WindowsStopProcessEntry } from "../../src/service/windows-process-evidence";
import {
  DEFAULT_WINSW_STOP_TIMEOUT_MS,
  windowsPartBWindowMs,
  windowsStopWorstCase,
} from "../../src/service/windows-stop-budget";
import {
  PATHS, SCHEDULE_PID, entry, launcher, loop, scheduleHost, supervisedTree, virtualClock,
} from "../helpers/windows-checked-stop-fixtures";

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

interface Harness {
  deps: WindowsCheckedStopDeps;
  calls: string[];
  alive: Set<number>;
  clock: ReturnType<typeof virtualClock>;
}

function harness(overrides: Partial<WindowsCheckedStopDeps> = {}, snapshot: WindowsStopProcessEntry[] = supervisedTree()): Harness {
  const calls: string[] = [];
  const alive = new Set(snapshot.map(process => process.pid));
  const clock = virtualClock(1_000);
  const watch = (pid: number): WindowsProcessWatch => alive.has(pid)
    ? { status: "open", exited: () => !alive.has(pid), close: () => calls.push("close:" + pid) }
    : { status: "gone" };
  const deps: WindowsCheckedStopDeps = {
    clock: clock.clock,
    canonicalPaths: PATHS,
    childPid: 42,
    selfPid: 1,
    probeScheduler: () => { calls.push("probe-scheduler"); return { status: "present" }; },
    probeWinsw: () => { calls.push("probe-winsw"); return "nonexistent"; },
    enumerate: () => { calls.push("enumerate"); return snapshot; },
    scheduleServicePid: () => SCHEDULE_PID,
    endTask: () => { calls.push("end"); return "ended"; },
    taskState: () => "not-running",
    winswStop: () => { calls.push("winsw-stop"); return "sent"; },
    winswState: () => "stopped",
    proxyAlive: () => false,
    openWatch: pid => watch(pid),
    terminate: (pid): WindowsTerminateResult => {
      calls.push("terminate:" + pid);
      alive.delete(pid);
      return { status: "terminated" };
    },
    ...overrides,
  };
  return { deps, calls, alive, clock };
}

const mutations = (calls: string[]) => calls.filter(call => call === "end" || call === "winsw-stop" || call.startsWith("terminate:"));

describe("checked Windows stop, part A", () => {
  test("/end leaves the loop alive: the wrappers are terminated deepest first and the child is left alone", async () => {
    const h = harness();
    const result = await stopWindowsServiceChecked(h.deps);
    expect(result.outcome).toBe("stopped");
    expect(result.reason).toBeNull();
    expect(mutations(h.calls)).toEqual(["end", "terminate:30", "terminate:20"]);
    expect(h.calls).not.toContain("terminate:42");
    expect(h.alive.has(42)).toBe(true);
    expect(result.bound.map(wrapper => [wrapper.pid, wrapper.startTime])).toEqual([[30, 5_100], [20, 5_000]]);
    expect(result.terminated).toEqual([30, 20]);
    expect(result.changed).toBe(true);
    // Every bind-time handle is closed.
    expect(h.calls.filter(call => call.startsWith("close:")).sort()).toEqual(["close:20", "close:30"]);
  });

  test("a PID reused between bind and terminate is left untouched", async () => {
    const h = harness();
    h.deps.terminate = pid => {
      h.calls.push("terminate:" + pid);
      if (pid === 30) return { status: "reused" };
      h.alive.delete(pid);
      return { status: "terminated" };
    };
    // The bound cmd.exe is gone; PID 30 now names a different process, still running.
    h.deps.openWatch = (pid): WindowsProcessWatch => ({
      status: "open", exited: () => pid === 30 ? false : !h.alive.has(pid), close: () => undefined,
    });
    const result = await stopWindowsServiceChecked(h.deps);
    expect(result.terminated).toEqual([20]);
    expect(h.alive.has(30)).toBe(true);
    expect(result.outcome).toBe("stopped");
  });

  test("access denied on /end is denied and nothing is terminated", async () => {
    const h = harness({ endTask: () => "denied" });
    const result = await stopWindowsServiceChecked(h.deps);
    expect(result).toMatchObject({ outcome: "denied", reason: "access-denied" });
    expect(h.calls.filter(call => call.startsWith("terminate:"))).toEqual([]);
  });

  test("access denied on a terminate stops every further kill", async () => {
    const h = harness();
    h.deps.terminate = pid => { h.calls.push("terminate:" + pid); return { status: "denied" }; };
    const result = await stopWindowsServiceChecked(h.deps);
    expect(result).toMatchObject({ outcome: "denied", reason: "access-denied" });
    expect(h.calls.filter(call => call.startsWith("terminate:"))).toEqual(["terminate:30"]);
  });

  test("an unreadable candidate under the bound manager is unknown and nothing changes", async () => {
    const hidden = entry(35, 20, "cmd.exe", null, 5_300);
    const h = harness({}, [...supervisedTree(), hidden]);
    const result = await stopWindowsServiceChecked(h.deps);
    expect(result).toMatchObject({ outcome: "unknown", reason: "evidence-unreadable", changed: false });
    expect(mutations(h.calls)).toEqual([]);
  });

  test("an unreadable creation time on a wrapper is unknown and nothing changes", async () => {
    const h = harness({}, [scheduleHost, launcher(), loop(30, 20, null), entry(42, 30, "bun.exe", "bun", 5_200)]);
    const result = await stopWindowsServiceChecked(h.deps);
    expect(result).toMatchObject({ outcome: "unknown", reason: "evidence-unreadable", changed: false });
    expect(mutations(h.calls)).toEqual([]);
  });

  test("an unreadable process list under a registered task is unknown, never absent", async () => {
    const h = harness({ enumerate: () => null });
    const result = await stopWindowsServiceChecked(h.deps);
    expect(result).toMatchObject({ outcome: "unknown", reason: "evidence-unreadable", changed: false });
    expect(mutations(h.calls)).toEqual([]);
  });

  test("a wrapper with an unreadable parent PID under a registered task is unknown, never unbound", async () => {
    const h = harness({ childPid: null }, [scheduleHost, { ...launcher(), parentPid: null }, loop()]);
    const result = await stopWindowsServiceChecked(h.deps);
    expect(result).toMatchObject({ outcome: "unknown", reason: "evidence-unreadable", changed: false });
    expect(mutations(h.calls)).toEqual([]);
  });

  test("a denied exit watch at bind is denied before the task is ended", async () => {
    const h = harness();
    const open = h.deps.openWatch;
    h.deps.openWatch = (pid, start) => (pid === 30 ? { status: "denied" } : open(pid, start));
    const result = await stopWindowsServiceChecked(h.deps);
    expect(result).toMatchObject({ outcome: "denied", reason: "access-denied", changed: false });
    expect(mutations(h.calls)).toEqual([]);
  });

  test("a terminate that overruns its cap ends part A as unknown with no further terminate", async () => {
    const h = harness();
    h.deps.terminate = pid => { h.calls.push("terminate:" + pid); return never(); };
    const result = await stopWindowsServiceChecked(h.deps);
    expect(result).toMatchObject({ outcome: "unknown", reason: "evidence-unreadable", changed: true });
    expect(mutations(h.calls)).toEqual(["end", "terminate:30"]);
  });

  test("an unreadable task state after the stop is unknown, never stopped", async () => {
    const unreadable = harness({ taskState: () => "unknown" });
    expect(await stopWindowsServiceChecked(unreadable.deps))
      .toMatchObject({ outcome: "unknown", reason: "evidence-unreadable" });
    const failed = harness({ taskState: () => { throw new Error("schtasks failed"); } });
    expect(await stopWindowsServiceChecked(failed.deps))
      .toMatchObject({ outcome: "unknown", reason: "evidence-unreadable" });
  });

  test("an unreadable WinSW state after the stop is unknown, never stopped", async () => {
    const finalState = (last: () => WindowsWinswScmState | Promise<WindowsWinswScmState>) => {
      let reads = 0;
      // The SCM poll sees stopped; the one manager-state read after the wait cannot tell.
      return () => (reads++ === 0 ? "stopped" : last());
    };
    for (const last of [() => "unknown" as const, () => never<WindowsWinswScmState>()]) {
      const h = harness({
        probeScheduler: () => ({ status: "absent" }),
        probeWinsw: () => "started" as WinswStatus,
        winswState: finalState(last),
      });
      expect(await stopWindowsServiceChecked(h.deps))
        .toMatchObject({ outcome: "unknown", reason: "evidence-unreadable" });
    }
  });

  test("a stray wrapper with the task not running is bound through the Schedule host and ended", async () => {
    const h = harness({ childPid: null }, [scheduleHost, launcher(), loop()]);
    const result = await stopWindowsServiceChecked(h.deps);
    expect(result.outcome).toBe("stopped");
    expect(mutations(h.calls)).toEqual(["end", "terminate:30", "terminate:20"]);
  });

  test("an orphan is ended while the task is registered and left alone once it is not", async () => {
    const orphans = [launcher(20, 777), loop()];
    const registered = harness({ childPid: null }, orphans);
    expect((await stopWindowsServiceChecked(registered.deps)).outcome).toBe("stopped");
    expect(registered.calls).toContain("terminate:20");

    const deleted = harness({ childPid: null, probeScheduler: () => ({ status: "absent" }) }, orphans);
    const result = await stopWindowsServiceChecked(deleted.deps);
    expect(result).toMatchObject({ outcome: "survived", reason: "unbound-wrapper", changed: false });
    expect(result.unbound.sort()).toEqual([20, 30]);
    expect(mutations(deleted.calls)).toEqual([]);
  });

  test("a hand-started launcher that fails lineage is not terminated: survived, unbound-wrapper", async () => {
    const shell = entry(500, 4, "explorer.exe", "explorer.exe", 2_000);
    const tree = [...supervisedTree(), shell, launcher(60, 500, 7_000), loop(61, 60, 7_100)];
    const h = harness({}, tree);
    const result = await stopWindowsServiceChecked(h.deps);
    expect(result).toMatchObject({ outcome: "survived", reason: "unbound-wrapper" });
    expect(h.calls).not.toContain("terminate:60");
    expect(h.calls).not.toContain("terminate:61");
    expect(result.unbound.sort()).toEqual([60, 61]);
  });

  // Without a native API (ARM64, or no FFI) every watch answers "unavailable". The wrappers are
  // still bound and terminated, but nothing proves they exited, so the stop is unknown, never stopped.
  test("unavailable exit watches still terminate the bound wrappers and end as unknown", async () => {
    const h = harness({ openWatch: () => ({ status: "unavailable" }) });
    const result = await stopWindowsServiceChecked(h.deps);
    expect(result).toMatchObject({ outcome: "unknown", reason: "evidence-unreadable", changed: true });
    expect(mutations(h.calls)).toEqual(["end", "terminate:30", "terminate:20"]);
    expect(result.terminated).toEqual([30, 20]);
  });

  // The answer slice 2's strict ARM64 adapter returns: never counted as an exit.
  test("a terminate that answers unavailable is unknown and nothing further is terminated", async () => {
    const h = harness({ terminate: (pid): WindowsTerminateResult => { h.calls.push("terminate:" + pid); return { status: "unavailable" }; } });
    const result = await stopWindowsServiceChecked(h.deps);
    expect(result).toMatchObject({ outcome: "unknown", reason: "evidence-unreadable", changed: true });
    expect(mutations(h.calls)).toEqual(["end", "terminate:30"]);
    expect(result.terminated).toEqual([]);
  });

  test("an unbound wrapper whose exit cannot be watched still counts as running", async () => {
    const shell = entry(500, 4, "explorer.exe", "explorer.exe", 2_000);
    const tree = [...supervisedTree(), shell, launcher(60, 500, 7_000), loop(61, 60, 7_100)];
    const base = harness({}, tree);
    const open = base.deps.openWatch;
    base.deps.openWatch = (pid, start) => (pid === 60 || pid === 61 ? { status: "unavailable" } : open(pid, start));
    expect(await stopWindowsServiceChecked(base.deps)).toMatchObject({ outcome: "survived", reason: "unbound-wrapper" });

    // A wrapper of this home with no creation time is unreadable evidence: unknown, nothing changed.
    const unwatched = harness({}, [...supervisedTree(), shell, { ...launcher(60, 500, 7_000), startTime: null }]);
    const result = await stopWindowsServiceChecked(unwatched.deps);
    expect(result).toMatchObject({ outcome: "unknown", reason: "evidence-unreadable", changed: false });
    expect(mutations(unwatched.calls)).toEqual([]);
  });

  test("a bound wrapper that outlives its terminate is survived", async () => {
    const h = harness();
    h.deps.terminate = pid => { h.calls.push("terminate:" + pid); return { status: "terminated" }; };
    const result = await stopWindowsServiceChecked(h.deps);
    expect(result).toMatchObject({ outcome: "survived", reason: null });
    // The wait is capped: 3 s of virtual time, then the verdict.
    expect(h.clock.now - 1_000).toBeLessThanOrEqual(3_000 + 100);
  });

  test("a task still running after the stop is survived", async () => {
    const h = harness({ taskState: () => "running" });
    expect((await stopWindowsServiceChecked(h.deps)).outcome).toBe("survived");
  });

  test("WinSW: a non-waiting stop, then survived when the proxy is still alive", async () => {
    const h = harness({
      probeScheduler: () => ({ status: "absent" }),
      probeWinsw: () => "started" as WinswStatus,
      proxyAlive: () => true,
    });
    const result = await stopWindowsServiceChecked(h.deps);
    expect(result.outcome).toBe("survived");
    expect(mutations(h.calls)).toEqual(["winsw-stop", "terminate:30", "terminate:20"]);
    expect(h.calls).toContain("enumerate");
  });

  test("WinSW: an SCM state that never reports stopped is unknown after <stoptimeout> + 2 s", async () => {
    const states: WindowsWinswScmState[] = [];
    const h = harness({
      probeScheduler: () => ({ status: "absent" }),
      probeWinsw: () => "started" as WinswStatus,
      winswState: () => { states.push("pending"); return "pending"; },
    });
    const result = await stopWindowsServiceChecked(h.deps);
    expect(result).toMatchObject({ outcome: "unknown", reason: "evidence-unreadable", changed: true });
    const elapsed = h.clock.now - 1_000;
    expect(elapsed).toBeGreaterThanOrEqual(DEFAULT_WINSW_STOP_TIMEOUT_MS + 2_000);
    expect(elapsed).toBeLessThanOrEqual(DEFAULT_WINSW_STOP_TIMEOUT_MS + 2_000 + 250);
    expect(states.length).toBeGreaterThan(1);
  });

  test("a registration probe that never answers is unknown and changes nothing", async () => {
    const h = harness({ probeScheduler: () => never() });
    const result = await stopWindowsServiceChecked(h.deps);
    expect(result).toMatchObject({ outcome: "unknown", reason: "evidence-unreadable", changed: false });
    expect(result.registration.scheduler).toBe("unknown");
    expect(mutations(h.calls)).toEqual([]);
  });

  test("an unreadable schtasks answer stays unknown and never becomes absent", async () => {
    const h = harness({ probeScheduler: () => ({ status: "unknown", detail: "query failed" }) });
    expect((await stopWindowsServiceChecked(h.deps)).outcome).toBe("unknown");
  });

  test("/end that overruns its cap is unknown and nothing is terminated", async () => {
    const h = harness({ endTask: () => { h.calls.push("end"); return never(); } });
    const result = await stopWindowsServiceChecked(h.deps);
    expect(result).toMatchObject({ outcome: "unknown", changed: true });
    expect(h.calls.filter(call => call.startsWith("terminate:"))).toEqual([]);
  });

  test("a dependency that blocks past its cap is an overrun even though it answered", async () => {
    const h = harness();
    h.deps.endTask = () => { h.clock.advance(2_500); return "ended"; };
    const result = await stopWindowsServiceChecked(h.deps);
    expect(result.outcome).toBe("unknown");
    expect(h.calls.filter(call => call.startsWith("terminate:"))).toEqual([]);
  });

  test("admission refuses before anything changes when the worst case does not fit", async () => {
    const budget = { orphanDiscovery: false };
    const guardedMinimum = windowsStopWorstCase({
      managers: { scheduler: true, winsw: false, stray: false }, enumerationReused: true, orphanDiscovery: false,
    }).totalMs;
    const refused = harness();
    const result = await stopWindowsServiceChecked(refused.deps, {
      bindSnapshot: supervisedTree(),
      admission: { deadlineAt: refused.clock.now + guardedMinimum - 1, budget },
    });
    expect(result).toMatchObject({ outcome: "unverified-budget", reason: "unverified-budget", changed: false });
    expect(result.budget).toEqual({ requiredMs: guardedMinimum, remainingMs: guardedMinimum - 1 });
    expect(mutations(refused.calls)).toEqual([]);
    expect(refused.calls).not.toContain("enumerate");

    const admitted = harness();
    const ok = await stopWindowsServiceChecked(admitted.deps, {
      bindSnapshot: supervisedTree(),
      admission: { deadlineAt: admitted.clock.now + guardedMinimum, budget },
    });
    expect(ok.outcome).toBe("stopped");
    expect(admitted.calls).not.toContain("enumerate");
  });

  test("nothing registered is absent and is never refused for budget", async () => {
    const nothing = harness({ probeScheduler: () => ({ status: "absent" }) }, [scheduleHost, entry(42, 10, "bun.exe", "bun", 5_200)]);
    const result = await stopWindowsServiceChecked(nothing.deps, {
      admission: { deadlineAt: 0, budget: { orphanDiscovery: true } },
    });
    expect(result).toMatchObject({ outcome: "absent", changed: false });

    const unreadable = harness({ probeScheduler: () => ({ status: "absent" }), enumerate: () => null });
    expect((await stopWindowsServiceChecked(unreadable.deps)).outcome).toBe("absent");
  });

  test("a stray wrapper of a deleted task is bound through the Schedule host and swept", async () => {
    const h = harness({ childPid: null, probeScheduler: () => ({ status: "absent" }) }, [scheduleHost, launcher(), loop()]);
    const result = await stopWindowsServiceChecked(h.deps);
    expect(result.outcome).toBe("stopped");
    expect(mutations(h.calls)).toEqual(["terminate:30", "terminate:20"]);
  });

  test("with nothing registered, an unreadable stray candidate is unknown, never absent", async () => {
    const h = harness({ childPid: null, probeScheduler: () => ({ status: "absent" }) }, [scheduleHost, launcher(20, SCHEDULE_PID, null)]);
    const result = await stopWindowsServiceChecked(h.deps);
    expect(result).toMatchObject({ outcome: "unknown", reason: "evidence-unreadable", changed: false });
    expect(mutations(h.calls)).toEqual([]);
  });

  test("the updater's authorizer refuses at entry before any probe", async () => {
    const h = harness();
    const refusal = new Error("supervision blocked");
    const error = await guardedStopWindowsServiceChecked(() => { throw refusal; }, h.deps).catch(caught => caught);
    expect(error).toBeInstanceOf(WindowsCheckedStopRefusedError);
    expect((error as WindowsCheckedStopRefusedError).cause).toBe(refusal);
    expect((error as WindowsCheckedStopRefusedError).partial.changed).toBe(false);
    expect(h.calls).toEqual([]);
  });

  test("the updater's authorizer runs again before each terminate and its refusal ends the stop", async () => {
    const h = harness();
    let checks = 0;
    const error = await guardedStopWindowsServiceChecked(() => {
      checks += 1;
      // Entry, before /end, before terminate:30, before terminate:20.
      if (checks === 4) throw new Error("respawned runtime");
    }, h.deps).catch(caught => caught);
    expect(error).toBeInstanceOf(WindowsCheckedStopRefusedError);
    expect((error as WindowsCheckedStopRefusedError).partial.terminated).toEqual([30]);
    expect(h.calls.filter(call => call.startsWith("terminate:"))).toEqual(["terminate:30"]);
  });
});

describe("the updater's authorizer guards each manager stop", () => {
  test("a refusal right before /end sends no /end and changes nothing", async () => {
    const h = harness();
    let checks = 0;
    const error = await guardedStopWindowsServiceChecked(() => {
      checks += 1;
      if (checks === 2) throw new Error("service home changed");
    }, h.deps).catch(caught => caught);
    expect(error).toBeInstanceOf(WindowsCheckedStopRefusedError);
    expect((error as WindowsCheckedStopRefusedError).partial.changed).toBe(false);
    expect(mutations(h.calls)).toEqual([]);
  });

  test("a refusal right before the WinSW stop sends no stop and changes nothing", async () => {
    const h = harness({ probeScheduler: () => ({ status: "absent" }), probeWinsw: () => "started" as WinswStatus });
    let checks = 0;
    const error = await guardedStopWindowsServiceChecked(() => {
      checks += 1;
      if (checks === 2) throw new Error("service home changed");
    }, h.deps).catch(caught => caught);
    expect(error).toBeInstanceOf(WindowsCheckedStopRefusedError);
    expect((error as WindowsCheckedStopRefusedError).partial.changed).toBe(false);
    expect(mutations(h.calls)).toEqual([]);
  });
});

describe("checked Windows stop budget", () => {
  test("admission minimums with default settings", () => {
    // The closing sample and WinSW's wrapper enumeration and termination are included.
    expect(windowsStopWorstCase({
      managers: { scheduler: true, winsw: false, stray: false }, enumerationReused: true, orphanDiscovery: false,
    }).totalMs).toBe(48_500);
    expect(windowsStopWorstCase({
      managers: { scheduler: true, winsw: false, stray: false }, enumerationReused: false, orphanDiscovery: true,
    }).totalMs).toBe(56_500);
    expect(windowsStopWorstCase({
      managers: { scheduler: false, winsw: true, stray: false }, enumerationReused: false, orphanDiscovery: true,
    }).totalMs).toBe(50_500);
  });

  test("receipts, a longer shutdown and a longer WinSW stop timeout grow the worst case", () => {
    const base = { managers: { scheduler: true, winsw: false, stray: false }, enumerationReused: true, orphanDiscovery: false };
    expect(windowsStopWorstCase({ ...base, inheritedReceipts: 2 }).totalMs).toBe(48_500 + 6_000);
    expect(windowsStopWorstCase({ ...base, shutdownTimeoutMs: 10_000 }).totalMs).toBe(48_500 + 5_000);
    expect(windowsStopWorstCase({
      managers: { scheduler: false, winsw: true, stray: false }, enumerationReused: false, orphanDiscovery: false,
      winswStopTimeoutMs: 30_000,
    }).rows.find(row => row.step === "part-a")!.ms).toBe(43_000);
    expect(windowsStopWorstCase({ ...base, partB: false }).rows.map(row => row.step)).not.toContain("part-b");
  });

  test("part B's window is min(12 s, remaining minus its tail and the reserve), never under 6 s", () => {
    expect(windowsPartBWindowMs(60_000)).toBe(12_000);
    expect(windowsPartBWindowMs(20_000)).toBe(11_500);
    expect(windowsPartBWindowMs(10_000)).toBe(6_000);
  });
});
