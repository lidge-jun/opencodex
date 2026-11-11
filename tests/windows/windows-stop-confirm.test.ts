// Part B of the checked Windows stop (#7771, 030 "Part B"): the port stays free for the
// hold, the final enumeration finds no wrapper of this home, and a listener is classified.
import { describe, expect, test } from "bun:test";

import type { WindowsStopProcessEntry } from "../../src/service/windows-process-evidence";
import {
  confirmWindowsStopFreed,
  resolveWindowsStopPort,
  type WindowsListenerIdentity,
  type WindowsPortSample,
  type WindowsStopConfirmDeps,
} from "../../src/service/windows-stop-confirm";
import { CMD, PATHS, entry, launcher, scheduleHost, virtualClock } from "../helpers/windows-checked-stop-fixtures";

const quiet = (): WindowsStopProcessEntry[] => [scheduleHost, entry(70, 4, "explorer.exe", "explorer.exe", 1_000)];

function confirmDeps(options: {
  sample?: (elapsed: number) => WindowsPortSample;
  identity?: WindowsListenerIdentity;
  processes?: WindowsStopProcessEntry[] | null;
  remainingMs?: number;
} = {}) {
  const clock = virtualClock(10_000);
  const calls: string[] = [];
  const deps: WindowsStopConfirmDeps = {
    clock: clock.clock,
    port: 10_100,
    remainingMs: options.remainingMs ?? 30_000,
    canonicalPaths: PATHS,
    selfPid: 1,
    samplePort: () => (options.sample ?? (() => ({ state: "free" })))(clock.now - 10_000),
    identifyListener: (_port, ownerPid) => { calls.push("identify:" + ownerPid); return options.identity ?? "unknown"; },
    enumerate: () => { calls.push("enumerate@" + (clock.now - 10_000)); return options.processes === undefined ? quiet() : options.processes; },
  };
  return { deps, clock, calls };
}

describe("checked Windows stop, part B", () => {
  test("a port that stays free for the hold with no wrapper left is freed", async () => {
    const { deps, clock, calls } = confirmDeps();
    const result = await confirmWindowsStopFreed(deps);
    expect(result).toMatchObject({ outcome: "freed", portHeldByForeign: false, reason: null, port: 10_100 });
    // The hold is 6 s between sample starts; the final enumeration runs after it.
    expect(calls).toEqual(["enumerate@6000"]);
    expect(clock.now - 10_000).toBeLessThanOrEqual(result.windowMs);
  });

  test("a wrapper relaunched after bind is caught by the final enumeration even with the port free", async () => {
    const { deps } = confirmDeps({ processes: [...quiet(), launcher(90, 4, 12_000)] });
    const result = await confirmWindowsStopFreed(deps);
    expect(result).toMatchObject({ outcome: "survived", lateWrappers: [90] });
  });

  test("this installation answering on the port again is survived", async () => {
    const { deps, calls } = confirmDeps({
      sample: elapsed => (elapsed < 3_000 ? { state: "free" } : { state: "listening", ownerPid: 4_242 }),
      identity: "ours",
    });
    const result = await confirmWindowsStopFreed(deps);
    expect(result).toMatchObject({ outcome: "survived", listener: { ownerPid: 4_242, identity: "ours" } });
    expect(calls).toContain("identify:4242");
  });

  test("a foreign listener after our processes are gone is portHeldByForeign", async () => {
    const { deps } = confirmDeps({ sample: () => ({ state: "listening", ownerPid: 777 }), identity: "foreign" });
    const result = await confirmWindowsStopFreed(deps);
    expect(result).toMatchObject({ outcome: "port-held-by-foreign", portHeldByForeign: true });
  });

  test("a listener whose owner has exited is not foreign", async () => {
    const { deps } = confirmDeps({ sample: () => ({ state: "listening", ownerPid: 555 }), identity: "exited" });
    const result = await confirmWindowsStopFreed(deps);
    expect(result).toMatchObject({ outcome: "unconfirmed", portHeldByForeign: false, listener: { identity: "exited" } });
  });

  test("an unreadable final enumeration is not success, even with the port free", async () => {
    const { deps } = confirmDeps({ processes: null });
    expect(await confirmWindowsStopFreed(deps)).toMatchObject({ outcome: "unknown", reason: "evidence-unreadable" });
  });

  test("a final enumeration that overruns its cap is not success", async () => {
    const { deps } = confirmDeps();
    deps.enumerate = () => new Promise(() => undefined);
    expect((await confirmWindowsStopFreed(deps)).outcome).toBe("unknown");
  });

  test("a process with this home's path and an unreadable image name is unknown, never freed or foreign", async () => {
    const unnamed = entry(91, 4, null, 'cmd.exe /c "' + CMD + '"', 12_000);
    const free = confirmDeps({ processes: [...quiet(), unnamed] });
    expect(await confirmWindowsStopFreed(free.deps))
      .toMatchObject({ outcome: "unknown", reason: "evidence-unreadable", lateWrappers: [] });
    const held = confirmDeps({
      processes: [...quiet(), unnamed], sample: () => ({ state: "listening", ownerPid: 777 }), identity: "foreign",
    });
    expect(await confirmWindowsStopFreed(held.deps))
      .toMatchObject({ outcome: "unknown", portHeldByForeign: false, reason: "evidence-unreadable" });
  });

  test("a slow port release reports failure instead of overrunning the window", async () => {
    const { deps, clock } = confirmDeps({
      remainingMs: 14_500,
      sample: elapsed => (elapsed < 2_000 ? { state: "listening", ownerPid: 4_242 } : { state: "free" }),
      identity: "ours",
    });
    const result = await confirmWindowsStopFreed(deps);
    expect(result.windowMs).toBe(6_000);
    expect(result.outcome).toBe("unconfirmed");
    expect(clock.now - 10_000).toBeLessThanOrEqual(6_000 + 500 + 5_000);
  });

  test("the port comes from the runtime record, then the wrapper script, then the config", () => {
    expect(resolveWindowsStopPort({ runtimePort: () => 10_200, wrapperPort: () => 10_300, configuredPort: () => 10_100 }))
      .toEqual({ port: 10_200, source: "runtime" });
    expect(resolveWindowsStopPort({ runtimePort: () => null, wrapperPort: () => 10_300, configuredPort: () => 10_100 }))
      .toEqual({ port: 10_300, source: "wrapper" });
    expect(resolveWindowsStopPort({
      runtimePort: () => { throw new Error("unreadable"); }, wrapperPort: () => 0, configuredPort: () => 10_100,
    })).toEqual({ port: 10_100, source: "config" });
  });
});
