import { afterEach, describe, expect, test } from "bun:test";

import {
  cachedCurrentWindowsIdentity,
  resetWindowsPrincipalForTests,
  setWindowsPrincipalRunnerForTests,
} from "../../src/lib/windows-user-principal";
import { buildWindowsTaskXml } from "../../src/service/windows-taskxml";

import {
  inspectGuardedManagerTarget,
  observeGuardedManagerStopped,
} from "../../src/service/guarded-manager-target";
import { runGuardedManagerStep } from "../../src/cli/stop-approval";
import type { GuardedStopSnapshot } from "../../src/cli/stop-approval";
import {
  ancestorWrapperPids,
  commandLineHasPathToken,
  currentWindowsTaskUserIds,
  isDescendantOf,
  observeWindowsGuardedManagerStopped,
  unreadableAncestorWrapperPids,
  unreadableWrappersOfManager,
  wrapperProcessesAlive,
  type WindowsProcessEntry,
} from "../../src/service/windows-guarded-manager";

const HOME = "C:\\Users\\me\\.opencodex";
const VBS = HOME + "\\opencodex-service-launcher.vbs";
const CMD = HOME + "\\opencodex-service.cmd";
const WINSW_EXE = HOME + "\\winsw\\opencodex-winsw.exe";

const proc = (pid: number, parentPid: number | null, commandLine: string | null,
  name: string | null = null): WindowsProcessEntry => ({ pid, parentPid, name, commandLine });

// proxy 42 <- cmd 30 (runs the .cmd) <- wscript 20 (runs the .vbs) <- svchost 2
const SUPERVISED: WindowsProcessEntry[] = [
  proc(2, 0, "svchost.exe"),
  proc(20, 2, 'C:\\Windows\\System32\\wscript.exe /b /nologo "' + VBS + '"'),
  proc(30, 20, "C:\\Windows\\System32\\cmd.exe /c " + CMD),
  proc(42, 30, "bun C:\\pkg\\src\\cli\\index.ts start"),
];

const schedulerPresent = () => ({ status: "present" as const });
const schedulerAbsent = () => ({ status: "absent" as const });
const schedulerUnknown = () => ({ status: "unknown" as const, detail: "query failed" });
const winswAbsent = () => "nonexistent" as const;
const winswStarted = () => "started" as const;

const schedulerDeps = (overrides: Record<string, unknown> = {}, realRegistration = false) => {
  const { win, ...top } = overrides;
  return {
    platform: "win32" as const,
    verifyPid: (pid: number) => pid,
    scheduler: schedulerPresent,
    winsw: winswAbsent,
    ...top,
    win: {
      winTaskXml: () => "<Task>xml</Task>",
      ...(realRegistration ? {} : { winRegistrationOurs: () => true }),
      winTaskState: () => "running" as const,
      winProcs: () => SUPERVISED,
      winScriptPath: () => CMD,
      winLauncherPath: () => VBS,
      winWinswExePath: () => WINSW_EXE,
      ...((win ?? {}) as Record<string, unknown>),
    },
  };
};

describe("windows command-line path tokens", () => {
  test("only complete canonical path tokens match", () => {
    expect(commandLineHasPathToken(SUPERVISED[1]!.commandLine, VBS)).toBe(true);
    expect(commandLineHasPathToken(SUPERVISED[2]!.commandLine, CMD)).toBe(true);
    // case-insensitive drive/path casing
    expect(commandLineHasPathToken(SUPERVISED[2]!.commandLine, CMD.toLowerCase())).toBe(true);
    // glued suffix/prefix is not the file
    expect(commandLineHasPathToken("cmd /c " + CMD + ".bak", CMD)).toBe(false);
    expect(commandLineHasPathToken("cmd /c x" + CMD, CMD)).toBe(false);
    // the OTHER wrapper asset is not a substitute
    expect(commandLineHasPathToken(SUPERVISED[2]!.commandLine, VBS)).toBe(false);
    expect(commandLineHasPathToken(null, CMD)).toBe(false);
    expect(commandLineHasPathToken("", CMD)).toBe(false);
  });
});

describe("windows process-chain helpers", () => {
  test("isDescendantOf walks the snapshot parents", () => {
    expect(isDescendantOf(20, 42, SUPERVISED)).toBe(true);
    expect(isDescendantOf(2, 42, SUPERVISED)).toBe(true);
    expect(isDescendantOf(42, 42, SUPERVISED)).toBe(true);
    expect(isDescendantOf(99, 42, SUPERVISED)).toBe(false);
    const cycled = [proc(1, 2, "a"), proc(2, 1, "b")];
    expect(isDescendantOf(9, 1, cycled)).toBe(false);
  });

  test("ancestorWrapperPids returns matching ancestors nearest first", () => {
    expect(ancestorWrapperPids(42, SUPERVISED, [VBS, CMD])).toEqual([30, 20]);
    const orphan = [...SUPERVISED, proc(55, 2, "bun C:\\pkg\\src\\cli\\index.ts start")];
    expect(ancestorWrapperPids(55, orphan, [VBS, CMD])).toEqual([]);
  });

  test("wrapperProcessesAlive reports any surviving canonical wrapper", () => {
    expect(wrapperProcessesAlive(SUPERVISED, [VBS, CMD]).sort()).toEqual([20, 30]);
    expect(wrapperProcessesAlive([proc(9, 2, "calc.exe")], [VBS, CMD])).toEqual([]);
  });
});

describe("windows guarded manager target", () => {
  test("a running owned task binds to the wrapper ancestor", () => {
    const target = inspectGuardedManagerTarget(42, 10100, schedulerDeps());
    expect(target).toMatchObject({
      kind: "bound", pid: 42, managerPid: 30,
      backend: "scheduler", childNeedsSeparateStop: true,
    });
  });

  test("registration that is not an OpenCodex definition stays unknown", () => {
    const target = inspectGuardedManagerTarget(42, 10100,
      schedulerDeps({ win: { winRegistrationOurs: () => false } }));
    expect(target.kind).toBe("unknown");
  });

  test("a running task that does not own the approved PID stays unknown", () => {
    const foreign = [...SUPERVISED, proc(77, 2, "bun C:\\pkg\\src\\cli\\index.ts start")];
    const target = inspectGuardedManagerTarget(77, 10100,
      schedulerDeps({ win: { winProcs: () => foreign } }));
    expect(target.kind).toBe("unknown");
  });

  test("a registered but not-running task reads as absent when no wrapper survives", () => {
    const target = inspectGuardedManagerTarget(42, 10100, schedulerDeps({
      win: { winTaskState: () => "not-running" as const, winProcs: () => [proc(2, 0, "svchost.exe")] },
    }));
    expect(target).toEqual({ kind: "absent" });
  });

  test("an unreadable wrapper in the approved proxy's ancestry blocks pre-stop absence and binding", () => {
    // proxy 42 <- wscript 20 whose command line CIM could not read <- svchost 2
    const unreadable = [proc(2, 0, "svchost.exe"), proc(20, 2, null, "wscript.exe"), proc(42, 20, "bun C:\\pkg\\src\\cli\\index.ts start")];
    expect(inspectGuardedManagerTarget(42, 10100, schedulerDeps({
      win: { winTaskState: () => "not-running" as const, winProcs: () => unreadable },
    })).kind).toBe("unknown");
    expect(inspectGuardedManagerTarget(42, 10100, schedulerDeps({
      scheduler: schedulerAbsent, win: { winProcs: () => unreadable },
    })).kind).toBe("unknown");
    expect(inspectGuardedManagerTarget(42, 10100, schedulerDeps({
      scheduler: schedulerAbsent, winsw: () => "stopped" as const,
      win: { winProcs: () => unreadable },
    })).kind).toBe("unknown");
    expect(unreadableAncestorWrapperPids(42, unreadable)).toEqual([20]);
  });

  test("an unreadable cmd.exe outside the approved ancestry does not block a proven binding", () => {
    // A non-admin CIM query returns no command line for other users' and elevated processes.
    const withForeignShell = [...SUPERVISED, proc(55, 2, null, "cmd.exe"), proc(56, 2, null, "cscript.exe")];
    expect(unreadableAncestorWrapperPids(42, withForeignShell)).toEqual([]);
    expect(inspectGuardedManagerTarget(42, 10100, schedulerDeps({
      win: { winProcs: () => withForeignShell },
    })).kind).toBe("bound");
  });

  test("a stray wrapper with an inert task is still live supervision", () => {
    const strayOnly = SUPERVISED.filter(entry => entry.pid !== 42);
    const target = inspectGuardedManagerTarget(42, 10100, schedulerDeps({
      win: { winTaskState: () => "not-running" as const, winProcs: () => strayOnly },
    }));
    expect(target.kind).toBe("unknown");
  });

  test("a live wrapper ancestor with an inert task is unaccounted supervision", () => {
    // The registered task is not running, but the approved PID still hangs off
    // the wrapper chain — the detached-supervision case, not absence.
    const target = inspectGuardedManagerTarget(42, 10100, schedulerDeps({
      win: { winTaskState: () => "not-running" as const },
    }));
    expect(target.kind).toBe("unknown");
  });

  test("two registered managers stay unknown", () => {
    const target = inspectGuardedManagerTarget(42, 10100,
      schedulerDeps({ winsw: winswStarted }));
    expect(target.kind).toBe("unknown");
  });

  test("unreadable probes stay unknown", () => {
    expect(inspectGuardedManagerTarget(42, 10100,
      schedulerDeps({ scheduler: schedulerUnknown })).kind).toBe("unknown");
    expect(inspectGuardedManagerTarget(42, 10100,
      schedulerDeps({ scheduler: schedulerAbsent, winsw: () => "unknown" as const })).kind).toBe("unknown");
    expect(inspectGuardedManagerTarget(42, 10100,
      schedulerDeps({ win: { winProcs: () => null } })).kind).toBe("unknown");
    expect(inspectGuardedManagerTarget(42, 10100,
      schedulerDeps({ win: { winTaskXml: () => { throw new Error("denied"); } } })).kind).toBe("unknown");
    expect(inspectGuardedManagerTarget(42, 10100,
      schedulerDeps({ win: { winTaskState: () => "unknown" as const } })).kind).toBe("unknown");
  });

  test("an unsupervised proxy with no registration reads as absent", () => {
    const target = inspectGuardedManagerTarget(42, 10100, schedulerDeps({
      scheduler: schedulerAbsent,
      win: { winProcs: () => [proc(42, 2, "bun C:\\pkg\\src\\cli\\index.ts start"), proc(2, 0, "svchost.exe")] },
    }));
    expect(target).toEqual({ kind: "absent" });
  });

  test("a detached wrapper with no registration is not absence", () => {
    const target = inspectGuardedManagerTarget(42, 10100, schedulerDeps({
      scheduler: schedulerAbsent,
      win: { winProcs: () => SUPERVISED },
    }));
    expect(target.kind).toBe("unknown");
  });
});

describe("guarded scheduler registration identity", () => {
  const sid = "S-1-5-21-100-200-300-1001";
  const xml = buildWindowsTaskXml(CMD, VBS, undefined, sid);
  const inspect = () => inspectGuardedManagerTarget(42, 10100, schedulerDeps({
    win: {
      winTaskXml: () => xml,
      winTaskUserIds: currentWindowsTaskUserIds,
    },
  }, true));

  afterEach(() => {
    setWindowsPrincipalRunnerForTests(null);
    resetWindowsPrincipalForTests();
  });

  test("an empty identity cache resolves the current scoped task through the real validator", () => {
    let lookups = 0;
    setWindowsPrincipalRunnerForTests(() => {
      lookups++;
      return { success: true, exitCode: 0, timedOut: false,
        stdout: `${sid}\nMACHINE\\me\n` };
    });
    expect(cachedCurrentWindowsIdentity()).toBeNull();
    expect(inspect()).toMatchObject({ kind: "bound", backend: "scheduler", managerPid: 30 });
    expect(lookups).toBe(1);
  });

  test("a timed out identity lookup cannot prove the task", () => {
    setWindowsPrincipalRunnerForTests(() => ({
      success: false, exitCode: null, timedOut: true, stdout: "",
    }));
    expect(inspect().kind).toBe("unknown");
  });

  test("a different effective account cannot prove the task", () => {
    setWindowsPrincipalRunnerForTests(() => ({
      success: true, exitCode: 0, timedOut: false,
      stdout: "S-1-5-21-100-200-300-1002\nMACHINE\\other\n",
    }));
    expect(inspect().kind).toBe("unknown");
  });
});

describe("windows guarded winsw manager", () => {
  const winswDeps = (overrides: Record<string, unknown> = {}) => schedulerDeps({
    scheduler: schedulerAbsent,
    winsw: winswStarted,
    win: {
      winService: () => ({
        state: "Running", pid: 9,
        pathName: '"' + WINSW_EXE + '" --arg',
      }),
      winProcs: () => [proc(2, 0, "svchost.exe"), proc(9, 2, WINSW_EXE), proc(42, 9, "bun start")],
      ...((overrides.win ?? {}) as Record<string, unknown>),
    },
  });

  test("a started service owning the PID binds", () => {
    const target = inspectGuardedManagerTarget(42, 10100, winswDeps());
    expect(target).toMatchObject({
      kind: "bound", pid: 42, managerPid: 9,
      backend: "winsw", childNeedsSeparateStop: true,
    });
  });

  test("a foreign binary path stays unknown", () => {
    const target = inspectGuardedManagerTarget(42, 10100, winswDeps({
      win: { winService: () => ({ state: "Running", pid: 9, pathName: "C:\\other\\opencodex-winsw.exe" }) },
    }));
    expect(target.kind).toBe("unknown");
  });

  test("a service that does not own the PID stays unknown", () => {
    const target = inspectGuardedManagerTarget(42, 10100, winswDeps({
      win: { winProcs: () => [proc(2, 0, "svchost.exe"), proc(9, 2, WINSW_EXE), proc(42, 2, "bun start")] },
    }));
    expect(target.kind).toBe("unknown");
  });

  test("an unreadable WinSW service row stays unknown", () => {
    expect(inspectGuardedManagerTarget(42, 10100, winswDeps({
      win: { winService: () => null },
    })).kind).toBe("unknown");
  });
});

describe("windows post-stop manager observation", () => {
  test("registration presence alone is not activity", () => {
    expect(observeWindowsGuardedManagerStopped({
      scheduler: schedulerPresent,
      winsw: winswAbsent,
      winTaskState: () => "not-running",
      winProcs: () => [proc(2, 0, "svchost.exe")],
      winScriptPath: () => CMD,
      winLauncherPath: () => VBS,
    })).toBe("inactive");
  });

  test("a running task or surviving wrapper is still active", () => {
    const base = {
      scheduler: schedulerPresent,
      winsw: winswAbsent,
      winProcs: () => SUPERVISED,
      winScriptPath: () => CMD,
      winLauncherPath: () => VBS,
    };
    expect(observeWindowsGuardedManagerStopped({ ...base, winTaskState: () => "running" })).toBe("active");
    // The wrapper process survives even when the task already reports not running.
    expect(observeWindowsGuardedManagerStopped({ ...base, winTaskState: () => "not-running" })).toBe("active");
    // An unreadable task state is unknown — but only when nothing else proves activity.
    expect(observeWindowsGuardedManagerStopped({
      ...base, winProcs: () => [proc(2, 0, "svchost.exe")], winTaskState: () => "unknown" as const,
    })).toBe("unknown");
  });

  test("an unreadable surviving wrapper of the former manager keeps the stop unknown", () => {
    for (const name of ["wscript.exe", "cscript.exe", "CMD.EXE"]) {
      // The approved child 42 has exited, but the bound manager 20 (or a wrapper under it)
      // survives with a command line CIM could not read, and can still respawn the proxy.
      for (const processes of [
        [proc(2, 0, "svchost.exe"), proc(20, 2, null, name)],
        [proc(2, 0, "svchost.exe"), proc(20, 2, null, "wscript.exe"), proc(30, 20, null, name)],
      ]) {
        expect(observeWindowsGuardedManagerStopped({
          scheduler: schedulerPresent,
          winsw: winswAbsent,
          winTaskState: () => "not-running",
          winProcs: () => processes,
          winScriptPath: () => CMD,
          winLauncherPath: () => VBS,
          formerManagerPid: 20,
        })).toBe("unknown");
      }
    }
    // Without a tie to the former manager an unreadable shell is not evidence of a wrapper.
    expect(observeWindowsGuardedManagerStopped({
      scheduler: schedulerPresent,
      winsw: winswAbsent,
      winTaskState: () => "not-running",
      winProcs: () => [proc(2, 0, "svchost.exe"), proc(77, 2, null, "cmd.exe")],
      winScriptPath: () => CMD,
      winLauncherPath: () => VBS,
      formerManagerPid: 20,
    })).toBe("inactive");
    expect(unreadableWrappersOfManager(20, [proc(2, 0, "svchost.exe"), proc(20, 2, null, "wscript.exe"), proc(30, 20, null, "cmd.exe")])).toEqual([20, 30]);
  });

  test("a bound Windows manager's pid reaches the post-stop observation", async () => {
    const stopped = await observeGuardedManagerStopped(
      { kind: "bound", pid: 42, managerPid: 20, backend: "scheduler", childNeedsSeparateStop: true } as never,
      {
        platform: "win32",
        scheduler: schedulerPresent,
        winsw: winswAbsent,
        win: {
          winTaskState: () => "not-running",
          winProcs: () => [proc(2, 0, "svchost.exe"), proc(20, 2, null, "wscript.exe")],
          winScriptPath: () => CMD,
          winLauncherPath: () => VBS,
        },
      },
    );
    expect(stopped).toBe("unknown");
  });

  test("an unreadable surviving wrapper keeps the stopped manager unknown only when tied to it", () => {
    for (const name of ["wscript.exe", "cscript.exe", "CMD.EXE"]) {
      const processes = [proc(2, 0, "svchost.exe"), proc(20, 2, null, name)];
      expect(observeWindowsGuardedManagerStopped({
        scheduler: schedulerPresent,
        winsw: winswAbsent,
        winTaskState: () => "not-running",
        winProcs: () => processes,
        winScriptPath: () => CMD,
        winLauncherPath: () => VBS,
      })).toBe("inactive");
    }
    expect(observeWindowsGuardedManagerStopped({
      scheduler: schedulerPresent,
      winsw: winswAbsent,
      winTaskState: () => "not-running",
      winProcs: () => [proc(2, 0, "svchost.exe"), proc(20, 2, null, "calc.exe")],
    })).toBe("inactive");
  });

  test("unreadable probes stay unknown", () => {
    expect(observeWindowsGuardedManagerStopped({
      scheduler: schedulerPresent,
      winsw: winswAbsent,
      winProcs: () => null,
    })).toBe("unknown");
    expect(observeWindowsGuardedManagerStopped({
      scheduler: schedulerUnknown,
      winsw: winswAbsent,
      winProcs: () => [],
    })).toBe("unknown");
    expect(observeWindowsGuardedManagerStopped({
      scheduler: schedulerAbsent,
      winsw: () => "unknown",
      winProcs: () => [],
    })).toBe("unknown");
  });

  test("a started winsw service is still active", () => {
    expect(observeWindowsGuardedManagerStopped({
      scheduler: schedulerAbsent,
      winsw: winswStarted,
      winProcs: () => [],
    })).toBe("active");
  });

  test("observeGuardedManagerStopped delegates win32 to the runtime check", async () => {
    const stopped = await observeGuardedManagerStopped(
      { kind: "bound", pid: 42, managerPid: 30, backend: "scheduler", childNeedsSeparateStop: true },
      {
        platform: "win32",
        scheduler: schedulerPresent,
        winsw: winswAbsent,
        win: {
          winTaskState: () => "not-running" as const,
          winProcs: () => [proc(2, 0, "svchost.exe")],
          winScriptPath: () => CMD,
          winLauncherPath: () => VBS,
        },
      });
    expect(stopped).toBe("inactive");
  });
});

describe("guarded step signals a surviving approved process", () => {
  const approval = { pid: 42, port: 10100, hostname: "", configHome: "h", cliVersion: "v", compatibilityToken: "t" };
  const snapshotFor = (manager: GuardedStopSnapshot["manager"]): GuardedStopSnapshot => ({ approval, manager });

  test("scheduler bound still receives the graceful child signal after the manager stop", async () => {
    const order: string[] = [];
    const step = await runGuardedManagerStep(snapshotFor({
      kind: "bound", pid: 42, managerPid: 30, backend: "scheduler", childNeedsSeparateStop: true,
    }), {
      revalidateManager: () => ({ kind: "bound", pid: 42, managerPid: 30, backend: "scheduler", childNeedsSeparateStop: true }),
      stopManager: () => { order.push("manager"); return "stopped-respawnable"; },
      signalApproved: async () => { order.push("signal"); return true; },
      settle: async () => { order.push("settle"); return true; },
      managerState: async () => { order.push("state"); return "inactive"; },
    });
    expect(order).toEqual(["manager", "signal", "settle", "state"]);
    expect(step).toMatchObject({ effect: "stopped", handledByProxy: true });
  });

  test("failed or unknown Windows manager stop leaves the approved child untouched", async () => {
    for (const service of ["failed", "state-unknown"] as const) {
      const order: string[] = [];
      const manager = { kind: "bound" as const, pid: 42, managerPid: 30,
        backend: "scheduler" as const, childNeedsSeparateStop: true };
      const step = await runGuardedManagerStep(snapshotFor(manager), {
        revalidateManager: () => manager,
        stopManager: () => { order.push("manager"); return service; },
        signalApproved: async () => { order.push("signal"); return true; },
        settle: async () => { order.push("settle"); return true; },
        managerState: async () => { order.push("state"); return "active"; },
      });
      expect(order).toEqual(["manager"]);
      expect(step).toMatchObject({ service, effect: "manager-still-active",
        proxy: "unknown", handledByProxy: false });
    }
  });

  test("launchd bound keeps the manager-cascade contract", async () => {
    let signalled = false;
    const step = await runGuardedManagerStep(snapshotFor({
      kind: "bound", pid: 42, managerPid: 7, backend: "launchd", childNeedsSeparateStop: false,
    }), {
      revalidateManager: () => ({ kind: "bound", pid: 42, managerPid: 7, backend: "launchd", childNeedsSeparateStop: false }),
      stopManager: () => "stopped",
      signalApproved: async () => { signalled = true; return true; },
      settle: async () => true,
      managerState: async () => "inactive",
    });
    expect(signalled).toBe(false);
    expect(step.effect).toBe("stopped");
  });
});
