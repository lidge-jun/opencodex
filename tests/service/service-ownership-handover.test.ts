/**
 * Who may hand the runtime back, and what refuses to take it.
 *
 * The maintainer decision behind this: the user's npm service registration is KEPT, never
 * deleted. So the recorded owner is the only thing standing between a takeover the user
 * consented to and the next `ocx service repair` — which runs incidentally, from a tray
 * helper, from `ocx update`, from a doctor suggestion — re-enabling and restarting the npm
 * launcher without saying a word about it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";
import { foreignServiceOwnerRefusal, repairService, unknownServiceOwnerRefusal } from "../../src/service/repair";
import type { ServiceDiagnostic } from "../../src/service/diagnostics";
import type { ServiceOwnershipResolution } from "../../src/service/state";
import { assertNoDesktopSupervision, createSupervisionLatch, desktopServiceCommandRefusal, desktopServiceRefusal, type DesktopSupervision } from "../../src/service/desktop-command-guard";
import { installFreshWindowsSchedulerSafely, installServiceSafely, prepareServiceInstall, type FreshWindowsSchedulerInstallDeps } from "../../src/service/orchestration";
import { buildWindowsTaskXml } from "../../src/service/windows-taskxml";

const INSTALLED: ServiceDiagnostic = {
  supported: true, installed: true, enabled: true, running: true, viable: true,
  startable: true, stale: false, conflict: false, backend: "launchd", summary: "installed",
};

const DESKTOP_CLAIM = { owner: "desktop", installId: "app-install-a", consentGeneration: 2 } as const;
const DESKTOP: ServiceOwnershipResolution = { kind: "owned", ownership: DESKTOP_CLAIM, revision: 4 };
const UNKNOWN: ServiceOwnershipResolution = { kind: "unknown", reason: "a service state path could not be read (EACCES)" };

describe("repair under an owner that is not this CLI", () => {
  test("refuses before it asserts, writes, stops or starts anything", async () => {
    const touched: string[] = [];
    await expect(repairService({
      inspectSupervision: () => ({ kind: "none" }),
      platform: "darwin",
      diagnose: () => INSTALLED,
      readOwnership: () => DESKTOP,
      assertEnv: () => { touched.push("assertEnv"); },
      assertAuth: () => { touched.push("assertAuth"); },
      repairLaunchd: () => { touched.push("repairLaunchd"); },
      restartLaunchd: () => { touched.push("restartLaunchd"); },
    })).rejects.toThrow(/desktop app owns the runtime/);
    // A repair that has already rewritten the assets has changed the thing it was
    // supposed to leave alone, so the gate has to sit in front of every seam.
    expect(touched).toEqual([]);
  });

  test("restart refuses on the same terms", async () => {
    await expect(repairService({
      inspectSupervision: () => ({ kind: "none" }),
      platform: "darwin",
      verb: "restart",
      diagnose: () => INSTALLED,
      readOwnership: () => DESKTOP,
      repairLaunchd: () => { throw new Error("must not run"); },
      restartLaunchd: () => { throw new Error("must not run"); },
    })).rejects.toThrow(/desktop app owns the runtime/);
  });

  /**
   * Collapsing "I could not read the claim" into "there is no claim" is how a permissions
   * error reactivates a consented takeover. Only true absence may mean nobody owns it.
   */
  test("an unreadable or contradictory record refuses too, rather than reading as CLI-owned", async () => {
    const touched: string[] = [];
    await expect(repairService({
      inspectSupervision: () => ({ kind: "none" }),
      platform: "darwin",
      diagnose: () => INSTALLED,
      readOwnership: () => UNKNOWN,
      assertEnv: () => { touched.push("assertEnv"); },
      repairLaunchd: () => { touched.push("repairLaunchd"); },
    })).rejects.toThrow(/could not be determined/);
    expect(touched).toEqual([]);
  });

  test("both refusals name the untouched registration and the way back", () => {
    const foreign = foreignServiceOwnerRefusal(DESKTOP_CLAIM);
    expect(foreign).toContain("app-install-a");
    expect(foreign).toContain("consent generation 2");
    expect(foreign).toContain("not re-enabled, not rewritten and not restarted");
    expect(foreign).toContain("ocx service install");

    const unknown = unknownServiceOwnerRefusal("a service state path could not be read (EACCES)");
    expect(unknown).toContain("EACCES");
    expect(unknown).toContain("ocx service install");
    // Both take the verb, so `start` does not report itself as a repair.
    expect(foreignServiceOwnerRefusal(DESKTOP_CLAIM, "start")).toContain("Background service start stopped");
    expect(unknownServiceOwnerRefusal("nothing parsed", "start")).toContain("Background service start stopped");
  });

  test("a CLI owner repairs normally, and so does a record with no claim at all", async () => {
    const resolutions: ServiceOwnershipResolution[] = [
      { kind: "none", revision: 0 },
      { kind: "owned", ownership: { owner: "cli", installId: "npm-install", consentGeneration: 4 }, revision: 8 },
    ];
    for (const resolution of resolutions) {
      let repaired = false;
      await repairService({
        inspectSupervision: () => ({ kind: "none" }),
        launcherPathDiagnostic: () => null,
        platform: "darwin",
        diagnose: () => INSTALLED,
        readOwnership: () => resolution,
        assertEnv: () => {},
        assertAuth: () => {},
        repairLaunchd: () => { repaired = true; },
      });
      expect(repaired).toBe(true);
    }
  });

  test("an uninstalled service still reports that first", async () => {
    await expect(repairService({
      inspectSupervision: () => ({ kind: "none" }),
      platform: "darwin",
      diagnose: () => ({ ...INSTALLED, installed: false }),
      readOwnership: () => DESKTOP,
    })).rejects.toThrow(/not installed/);
  });
});

const SUPERVISION: DesktopSupervision = {
  kind: "desktop", runtimePid: 4242, supervisorPid: 4200,
  app: "/Applications/OpenCodex.app/Contents/MacOS/opencodex-desktop",
  proxy: "/Applications/OpenCodex.app/Contents/MacOS/ocx",
};
const SEEN_UNKNOWN: DesktopSupervision = { kind: "unknown", reason: "probe-timeout", desktopSeen: true };
const PASS_THROUGH: DesktopSupervision[] = [
  { kind: "none" }, { kind: "unsupported" },
  { kind: "unknown", reason: "probe-timeout", desktopSeen: false },
];
const REFUSAL = "OpenCodex Desktop supervises the running proxy (pid 4242, /Applications/OpenCodex.app/Contents/MacOS/opencodex-desktop). "
  + "Quit OpenCodex, then rerun 'ocx service install' to move startup management to this CLI.";

function freshWindowsDeps(touched: string[], inspect: () => DesktopSupervision): FreshWindowsSchedulerInstallDeps {
  return {
    inspectSupervision: inspect,
    stageRegistrationXml: () => { touched.push("stage"); return "injected-stage.xml"; },
    register: async () => { touched.push("register"); },
    recordOwnership: () => { touched.push("ownership"); return true; },
    prepare: async () => { touched.push("prepare"); },
    removeNativeService: () => { touched.push("removeNative"); },
    publishAssets: () => { touched.push("assets"); },
    verifyBeforeRun: () => { touched.push("verify"); },
    runTask: () => { touched.push("run"); },
    writeState: () => { touched.push("state"); },
    rollbackTask: async () => { touched.push("rollback"); return null; },
    removeStagedXml: () => { touched.push("removeStage"); },
  };
}

describe("live Desktop service command guards", () => {
  test("live Desktop supervision refuses every activating service verb before CLI mutation", () => {
    for (const evidence of [SUPERVISION, SEEN_UNKNOWN]) {
      for (const command of ["install", "repair", "start", "restart"]) {
        let probes = 0;
        const touched: string[] = [];
        const refusal = desktopServiceCommandRefusal(command, () => { probes++; return evidence; });
        if (refusal === null) touched.push(command);
        expect(refusal).toBe(desktopServiceRefusal(evidence, true));
        if (evidence.kind === "desktop") expect(refusal).toBe(REFUSAL);
        expect(probes).toBe(1);
        expect(touched).toEqual([]);
      }
    }
    const cli = readFileSync(repoPath("src", "service", "cli.ts"), "utf8");
    const preflight = cli.indexOf("desktopServiceCommandRefusal(preliminary.sub");
    expect(preflight).toBeGreaterThan(0);
    expect(preflight).toBeLessThan(cli.indexOf("await withWindowsServiceMutationLock(execute)"));
    const dispatch = cli.indexOf("desktopServiceCommandRefusal(command");
    expect(dispatch).toBeGreaterThan(cli.indexOf("const { parsed, command } = plan;"));
    expect(dispatch).toBeLessThan(cli.indexOf("assertServiceEnvironmentMatchesInstall();"));
    for (const from of [preflight, dispatch]) {
      const block = cli.slice(from, cli.indexOf("\n    }", from) + 6);
      expect(block).toContain("process.exitCode = 1;");
      expect(block).toContain("return;");
    }
    expect(cli.match(/const supervisionLatch = createSupervisionLatch\(\)/g)).toHaveLength(1);
    expect(cli).toContain("repairService({ verb, supervisionLatch })");
    expect(cli).toContain("installFreshWindowsSchedulerSafely({ supervisionLatch })");
    expect(cli).toContain("installServiceSafely(backend, ops.install, { supervisionLatch })");
  });

  test("deactivating and identity service verbs do not probe Desktop supervision", () => {
    for (const command of ["stop", "status", "uninstall", "remove", "claim"]) {
      expect(desktopServiceCommandRefusal(command, () => { throw new Error("must not probe"); })).toBeNull();
    }
  });

  test("repair and restart refuse live supervision even without a durable claim", async () => {
    for (const evidence of [SUPERVISION, SEEN_UNKNOWN]) {
      for (const verb of ["repair", "restart"] as const) {
        for (const [platform, backend] of [["darwin", "launchd"], ["linux", "systemd"], ["win32", "native"], ["win32", "scheduler"]] as const) {
          const touched: string[] = [];
          const mutate = () => { touched.push("mutation"); };
          await expect(repairService({
            inspectSupervision: () => evidence, verb, platform,
            diagnose: () => { touched.push("diagnose"); return { ...INSTALLED, backend }; },
            readOwnership: () => { touched.push("ownership"); return { kind: "none", revision: 0 }; },
            assertEnv: mutate, assertAuth: mutate, repairLaunchd: mutate, restartLaunchd: mutate,
            repairSystemd: mutate, repairNative: mutate, writeNativeState: mutate,
            writeSchedulerAssets: mutate, writeSchedulerState: mutate, stopScheduler: mutate, startScheduler: mutate,
          })).rejects.toThrow(desktopServiceRefusal(evidence, true)!);
          expect(touched).toEqual([]);
        }
      }
    }
  });

  test("safe install stops before cleanup and installation under live Desktop supervision", async () => {
    for (const evidence of [SUPERVISION, SEEN_UNKNOWN]) {
      const touched: string[] = [];
      const deps = {
        inspectSupervision: () => evidence,
        diagnose: () => { touched.push("diagnose"); return INSTALLED; },
        managerOps: () => { touched.push("manager"); return { status: () => "running", stop: () => { touched.push("stop"); } }; },
        stopTrackedProxy: async () => { touched.push("tracked"); },
      };
      await expect(prepareServiceInstall("scheduler", deps)).rejects.toThrow(desktopServiceRefusal(evidence, true)!);
      await expect(installServiceSafely("scheduler", () => { touched.push("install"); }, deps)).rejects.toThrow(desktopServiceRefusal(evidence, true)!);
      expect(touched).toEqual([]);
    }
  });

  test("fresh Windows install refuses before registration XML staging", async () => {
    for (const evidence of [SUPERVISION, SEEN_UNKNOWN]) {
      const touched: string[] = [];
      await expect(installFreshWindowsSchedulerSafely(freshWindowsDeps(touched, () => evidence)))
        .rejects.toThrow(desktopServiceRefusal(evidence, true)!);
      expect(touched).toEqual([]);
    }
  });

  test("unknown unsupported and absent supervision retain service preparation and repair", async () => {
    for (const evidence of PASS_THROUGH) {
      for (const command of ["install", "repair", "start", "restart"]) {
        expect(desktopServiceCommandRefusal(command, () => evidence)).toBeNull();
      }
      const touched: string[] = [];
      await installServiceSafely("scheduler", () => { touched.push("install"); }, {
        inspectSupervision: () => evidence, platform: "darwin", diagnose: () => INSTALLED,
        managerOps: () => ({
          status: () => { touched.push("status"); return "running"; },
          stop: () => { touched.push("stop"); },
        }),
        stopTrackedProxy: async () => { touched.push("tracked"); },
      });
      expect(touched).toEqual(["status", "stop", "tracked", "install"]);
      for (const ownership of [
        { kind: "none", revision: 0 },
        { kind: "owned", ownership: { owner: "cli", installId: "npm-install", consentGeneration: 4 }, revision: 8 },
      ] as const) {
        for (const verb of ["repair", "restart"] as const) {
          const repairs: string[] = [];
          await repairService({
            inspectSupervision: () => evidence, platform: "darwin", verb,
            diagnose: () => INSTALLED, readOwnership: () => ownership,
            assertEnv: () => {}, assertAuth: () => {}, launcherPathDiagnostic: () => null,
            repairLaunchd: () => { repairs.push("repair"); return { reloaded: false }; },
            restartLaunchd: () => { repairs.push("restart"); },
          });
          expect(repairs).toEqual(verb === "restart" ? ["repair", "restart"] : ["repair"]);
        }
      }
      const windows: string[] = [];
      await installFreshWindowsSchedulerSafely(freshWindowsDeps(windows, () => evidence));
      expect(windows).toEqual(["stage", "register", "removeStage", "ownership", "prepare", "removeNative", "assets", "verify", "run", "state"]);
    }
  });

  test("a fresh Windows install rechecks supervision after registration before cleanup", async () => {
    for (const blocked of [SUPERVISION, SEEN_UNKNOWN]) {
      const touched: string[] = [];
      let reads = 0;
      const deps = freshWindowsDeps(touched, () => reads++ === 0 ? { kind: "none" } : blocked);
      delete deps.prepare; // Exercise the production preparation closure without reaching real cleanup.
      await expect(installFreshWindowsSchedulerSafely(deps)).rejects.toThrow(desktopServiceRefusal(blocked, true)!);
      expect(reads).toBe(2);
      expect(touched).toEqual(["stage", "register", "rollback", "removeStage"]);
    }
  });

  test("service operations retain a prior Desktop veto until a positive none observation", async () => {
    for (const inconclusive of [PASS_THROUGH[1]!, PASS_THROUGH[2]!]) {
      const latch = createSupervisionLatch();
      expect(latch.observe(SUPERVISION)).toBe(true);
      const touched: string[] = [];
      await expect(repairService({
        supervisionLatch: latch, inspectSupervision: () => inconclusive,
        diagnose: () => { touched.push("diagnose"); return INSTALLED; },
      })).rejects.toThrow("OpenCodex Desktop supervises");
      await expect(installServiceSafely("scheduler", () => { touched.push("install"); }, {
        supervisionLatch: latch, inspectSupervision: () => inconclusive,
        diagnose: () => { touched.push("diagnose"); return INSTALLED; },
      })).rejects.toThrow("OpenCodex Desktop supervises");
      await expect(installFreshWindowsSchedulerSafely({
        ...freshWindowsDeps(touched, () => inconclusive), supervisionLatch: latch,
      })).rejects.toThrow("OpenCodex Desktop supervises");
      expect(desktopServiceCommandRefusal("start", () => inconclusive, latch)).not.toBeNull();
      expect(touched).toEqual([]);
      expect(() => assertNoDesktopSupervision(() => ({ kind: "none" }), latch)).not.toThrow();
      expect(desktopServiceCommandRefusal("restart", () => inconclusive, latch)).toBeNull();
      await repairService({
        supervisionLatch: latch, inspectSupervision: () => inconclusive, platform: "darwin",
        diagnose: () => INSTALLED, readOwnership: () => ({ kind: "none", revision: 0 }),
        assertEnv: () => {}, assertAuth: () => {}, launcherPathDiagnostic: () => null,
        repairLaunchd: () => { touched.push("repair"); },
      });
      expect(touched).toEqual(["repair"]);
    }
  });

  test("safe install checks fresh supervision after asynchronous cleanup", async () => {
    for (const blocked of [SUPERVISION, SEEN_UNKNOWN]) {
      let reads = 0;
      let current: DesktopSupervision = { kind: "none" };
      const touched: string[] = [];
      await expect(installServiceSafely("scheduler", () => { touched.push("install"); }, {
        inspectSupervision: () => { reads++; return current; },
        platform: "darwin", diagnose: () => INSTALLED,
        managerOps: () => ({ status: () => null, stop: () => { touched.push("stop"); } }),
        stopTrackedProxy: async () => { touched.push("tracked"); current = blocked; },
      })).rejects.toThrow(desktopServiceRefusal(blocked, true)!);
      expect(reads).toBe(3);
      expect(touched).toEqual(["tracked"]);
    }
  });

  test("fresh Windows install rechecks after preparation and registration verification", async () => {
    for (const boundary of ["prepare", "verify"] as const) {
      for (const blocked of [SUPERVISION, SEEN_UNKNOWN]) {
        const touched: string[] = [];
        let current: DesktopSupervision = { kind: "none" };
        const deps = freshWindowsDeps(touched, () => current);
        if (boundary === "prepare") deps.prepare = async () => { touched.push("prepare"); current = blocked; };
        else deps.verifyBeforeRun = () => { touched.push("verify"); current = blocked; };
        await expect(installFreshWindowsSchedulerSafely(deps)).rejects.toThrow(desktopServiceRefusal(blocked, true)!);
        expect(touched).toEqual(boundary === "prepare"
          ? ["stage", "register", "removeStage", "ownership", "prepare", "rollback"]
          : ["stage", "register", "removeStage", "ownership", "prepare", "removeNative", "assets", "verify", "rollback"]);
      }
    }
  });

  test("native Windows repair checks fresh supervision before publishing install state", async () => {
    for (const blocked of [SUPERVISION, SEEN_UNKNOWN]) {
      const touched: string[] = [];
      let current: DesktopSupervision = { kind: "none" };
      await expect(repairService({
        inspectSupervision: () => current, platform: "win32",
        diagnose: () => ({ ...INSTALLED, backend: "native" }),
        readOwnership: () => ({ kind: "none", revision: 0 }),
        assertEnv: () => {}, assertAuth: () => {}, launcherPathDiagnostic: () => null,
        repairNative: async () => { touched.push("native"); current = blocked; },
        writeNativeState: () => { touched.push("state"); },
      })).rejects.toThrow(desktopServiceRefusal(blocked, true)!);
      expect(touched).toEqual(["native"]);
    }
  });

  test("scheduler repair checks supervision before normal and recovery starts or restoration", async () => {
    const sid = "S-1-5-21-111-222-333-1001";
    const launcher = "C:\\fixture\\launcher.vbs";
    const healthy = buildWindowsTaskXml("injected.cmd", launcher, undefined, sid);
    const stale = healthy.replace(/<SessionStateChangeTrigger>[\s\S]*?<\/SessionStateChangeTrigger>\s*/gi, "");
    for (const boundary of ["start", "recovery-start", "recovery-restore"] as const) {
      for (const blocked of [SUPERVISION, SEEN_UNKNOWN]) {
        const touched: string[] = [];
        let current: DesktopSupervision = { kind: "none" };
        let failedRefresh = false;
        let reads = 0;
        let error: unknown;
        try {
          await repairService({
            inspectSupervision: () => current, platform: "win32",
            diagnose: () => ({ ...INSTALLED, backend: "scheduler" }),
            readOwnership: () => ({ kind: "none", revision: 0 }),
            assertEnv: () => {}, assertAuth: () => {}, launcherPathDiagnostic: () => null,
            resolveExpectedUserId: () => sid, schedulerLauncher: launcher,
            stopScheduler: () => { touched.push("stop"); },
            writeSchedulerAssets: () => { touched.push("assets"); },
            readSchedulerXml: () => {
              reads++;
              if (boundary === "start") { if (reads > 1) current = blocked; return healthy; }
              return failedRefresh && boundary === "recovery-restore" ? "" : stale;
            },
            reregisterScheduler: async () => {
              touched.push("refresh"); failedRefresh = true; current = blocked;
              throw new Error("injected refresh failure");
            },
            probeScheduler: () => ({ status: "absent" }),
            restoreSchedulerIfAbsent: async () => { touched.push("restore"); },
            settleSchedulerRead: () => { throw new Error("must not wait"); },
            startScheduler: () => { touched.push("start"); },
            writeSchedulerState: () => { touched.push("state"); },
          });
        } catch (caught) { error = caught; }
        expect(error).toBeInstanceOf(Error);
        const refusals = error instanceof AggregateError ? error.errors : [error];
        expect(refusals.some(cause => cause instanceof Error && cause.message === desktopServiceRefusal(blocked, true))).toBe(true);
        expect(touched).toEqual(boundary === "start" ? ["stop", "assets"] : ["stop", "assets", "refresh"]);
      }
    }
  });
});

describe("which service verbs are gated", () => {
  const cli = readFileSync(repoPath("src", "service", "cli.ts"), "utf8");
  const between = (from: string, to: string): string => cli.slice(cli.indexOf(from), cli.indexOf(to));
  const installCase = between("case \"install\":", "case \"start\":");
  const startCase = between("case \"start\":", "case \"stop\"");

  /**
   * Releasing first meant a cancelled UAC prompt, a failed registration or an aborted
   * cleanup left the retained npm registration looking CLI-owned, so the next incidental
   * repair would reactivate it.
   */
  test("install releases the marker only after the registration succeeded", () => {
    expect(installCase).toContain("releaseServiceOwner(ownershipBeforeInstall");
    expect(installCase.indexOf("installServiceSafely")).toBeLessThan(installCase.indexOf("releaseServiceOwner(ownershipBeforeInstall"));
    // The failure branch leaves before the release.
    expect(installCase.indexOf("Service install cleanup failed")).toBeLessThan(installCase.indexOf("releaseServiceOwner(ownershipBeforeInstall"));
  });

  test("start refuses on the same terms, because it activates the registration", () => {
    expect(startCase).toContain("resolveServiceOwnership()");
    expect(startCase).toContain("foreignServiceOwnerRefusal");
    expect(startCase).toContain("unknownServiceOwnerRefusal");
    // Reported, not thrown: the Windows tray drives this through a caller that does not catch.
    expect(startCase).toContain("process.exitCode = 1;");
  });

  test("stop and uninstall stay ungated, and nothing else releases the marker", () => {
    const deactivating = cli.slice(cli.indexOf("case \"stop\""));
    expect(deactivating).not.toContain("resolveServiceOwnership");
    expect(deactivating).not.toContain("releaseServiceOwner");
    expect(startCase).not.toContain("releaseServiceOwner");
    expect(readFileSync(repoPath("src", "service", "repair.ts"), "utf8")).not.toContain("releaseServiceOwner");
  });
});
