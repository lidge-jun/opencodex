import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { repairService, type RepairServiceDeps } from "../../src/service/repair";
import { buildWindowsTaskXml } from "../../src/service/windows-taskxml";
import { snapshotWindowsSchedulerAssets } from "../../src/service/windows-ops";
import { windowsLauncherVbsPath, windowsServiceScriptPath, windowsTaskXmlPath } from "../../src/service/state";
import * as disconnectedCleanup from "../../src/service/disconnected-client-restart";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const sid = "S-1-5-21-111-222-333-1001", launcher = "C:\\fixture\\launcher.vbs";
const healthy = buildWindowsTaskXml("fixture.cmd", launcher, undefined, sid);

async function scenario(run: (deps: RepairServiceDeps, effects: string[]) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "ocx-scheduler-cleanup-"));
  const effects: string[] = [];
  const deps: RepairServiceDeps = {
    platform: "win32", verb: "restart", configDir: () => root,
    inspectSupervision: () => ({ kind: "none" }),
    diagnose: () => ({ supported: true, installed: true, enabled: true, running: true, viable: true,
      startable: true, stale: false, conflict: false, backend: "scheduler", summary: "fixture" }),
    readOwnership: () => ({ kind: "none", revision: 0 }), assertEnv: () => {}, assertAuth: () => {},
    selectRuntime: () => ({ path: process.execPath, source: "override", overrideEnv: "OPENCODEX_BUN_PATH" }),
    assertRuntimeWritable: () => {}, launcherPathDiagnostic: () => null,
    readSchedulerXml: () => healthy, resolveExpectedUserId: () => sid, schedulerLauncher: launcher,
    prepareDisconnectedClientRestart: async () => {},
    stopScheduler: () => { effects.push("stop"); }, killServiceWrappers: () => { effects.push("wrappers"); },
    stopTrackedProxy: async () => { effects.push("tracked"); },
    schedulerProxyStillLive: async () => { effects.push("verify-stopped"); return null; },
    writeSchedulerAssets: () => { effects.push("assets"); }, startScheduler: () => { effects.push("start"); },
    writeSchedulerState: () => { effects.push("state"); },
    reregisterScheduler: async () => { throw new Error("unexpected reregister"); }, settleSchedulerRead: () => {},
  };
  try { await run(deps, effects); } finally { removeTreeWithRetry(root); }
}

test("scheduler restart without a disconnected client cleans and verifies wrappers before replacement", async () => {
  await scenario(async (deps, effects) => {
    await repairService(deps);
    expect(effects).toEqual(["stop", "wrappers", "tracked", "verify-stopped", "assets", "start", "state"]);
  });
});

test("a Home or connected Child proxy that survives schtasks /end is stopped by its tracked pid, and restart completes", async () => {
  await scenario(async (deps, effects) => {
    let trackedStopped = false;
    deps.stopTrackedProxy = async () => { effects.push("tracked"); trackedStopped = true; };
    deps.schedulerProxyStillLive = async () => { effects.push("verify-stopped"); return trackedStopped ? null : { port: 10100 }; };
    await repairService(deps);
    expect(effects).toEqual(["stop", "wrappers", "tracked", "verify-stopped", "assets", "start", "state"]);
  });
});

test("disconnected scheduler callback shares one guarded wrapper cleanup with ordinary restart", async () => {
  await scenario(async (deps, effects) => {
    deps.prepareDisconnectedClientRestart = undefined;
    const cleanup = spyOn(disconnectedCleanup, "prepareDisconnectedClientServiceRestart").mockImplementation(async callbacks => {
      await callbacks.stopManager();
      effects.push("client-exited");
    });
    try {
      await repairService(deps);
      expect(effects).toEqual(["stop", "wrappers", "client-exited", "tracked", "verify-stopped", "assets", "start", "state"]);
    } finally { cleanup.mockRestore(); }
  });
});

test("surviving scheduler proxy refuses replacement after owned wrapper cleanup", async () => {
  await scenario(async (deps, effects) => {
    deps.schedulerProxyStillLive = async () => ({ port: 10100 });
    await expect(repairService(deps)).rejects.toThrow("still running");
    expect(effects).toEqual(["stop", "wrappers", "tracked"]);
  });
});

test.each(["ownership", "registration"])("scheduler %s change during stop preserves wrappers and replacement", async mode => {
  await scenario(async (deps, effects) => {
    let changed = false;
    deps.readOwnership = () => ({ kind: "none", revision: changed && mode === "ownership" ? 1 : 0 });
    deps.readSchedulerXml = () => changed && mode === "registration" ? "<Task/>" : healthy;
    deps.stopScheduler = () => { effects.push("stop"); changed = true; };
    await expect(repairService(deps)).rejects.toThrow();
    expect(effects).toEqual(["stop"]);
  });
});

test("wrapper cleanup failure refuses scheduler replacement", async () => {
  await scenario(async (deps, effects) => {
    deps.killServiceWrappers = () => { throw new Error("wrapper cleanup refused"); };
    await expect(repairService(deps)).rejects.toThrow("wrapper cleanup refused");
    expect(effects).toEqual(["stop"]);
  });
});

test("unrecognized scheduler registration refuses before wrapper cleanup", async () => {
  await scenario(async (deps, effects) => {
    deps.readSchedulerXml = () => '<Task><Actions><Exec><Command>foreign.exe</Command></Exec></Actions></Task>';
    await expect(repairService(deps)).rejects.toThrow("not a recognized legacy");
    expect(effects).toEqual([]);
  });
});

test("ownership changing during awaited stop verification refuses replacement", async () => {
  await scenario(async (deps, effects) => {
    let revision = 0;
    deps.readOwnership = () => ({ kind: "none", revision });
    deps.schedulerProxyStillLive = async () => { revision++; return null; };
    await expect(repairService(deps)).rejects.toThrow("ownership changed");
    expect(effects).toEqual(["stop", "wrappers", "tracked"]);
  });
});

test("a failed asset rewrite after the stop puts the old assets back and restarts the verified registration", async () => {
  await scenario(async (deps, effects) => {
    deps.snapshotSchedulerAssets = () => { effects.push("snapshot"); return () => { effects.push("restore-assets"); }; };
    deps.writeSchedulerAssets = () => { effects.push("assets"); throw Object.assign(new Error("fixture read-only asset"), { code: "EACCES" }); };
    await expect(repairService(deps)).rejects.toThrow("fixture read-only asset");
    expect(effects).toEqual(["stop", "wrappers", "tracked", "verify-stopped", "snapshot", "assets", "restore-assets", "start"]);
  });
});

test("a registration that changed after the failed asset rewrite is preserved and not started", async () => {
  await scenario(async (deps, effects) => {
    let changed = false;
    deps.readSchedulerXml = () => changed ? "<Task/>" : healthy;
    deps.snapshotSchedulerAssets = () => () => { effects.push("restore-assets"); };
    deps.writeSchedulerAssets = () => { changed = true; throw new Error("fixture read-only asset"); };
    const failure = await repairService(deps).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map(error => (error as Error).message).join("\n")).toContain("fixture read-only asset");
    expect(effects).toEqual(["stop", "wrappers", "tracked", "verify-stopped", "restore-assets"]);
  });
});

test("the asset snapshot restores changed bytes and removes an asset that did not exist", () => {
  // Pin this test's own config directory: the assets live there.
  const previousHome = process.env.OPENCODEX_HOME;
  const configHome = mkdtempSync(join(tmpdir(), "ocx-scheduler-assets-"));
  process.env.OPENCODEX_HOME = configHome;
  const script = windowsServiceScriptPath(), vbs = windowsLauncherVbsPath(), xml = windowsTaskXmlPath();
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, "@echo old\r\n", "utf8");
  writeFileSync(vbs, "\uFEFFold vbs", "utf16le");
  try {
    const restore = snapshotWindowsSchedulerAssets();
    writeFileSync(script, "@echo new\r\n", "utf8");
    writeFileSync(xml, "\uFEFF<Task/>", "utf16le");
    restore();
    expect(readFileSync(script, "utf8")).toBe("@echo old\r\n");
    expect(readFileSync(vbs, "utf16le")).toBe("\uFEFFold vbs");
    expect(existsSync(xml)).toBe(false);
  } finally {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(configHome);
  }
});

