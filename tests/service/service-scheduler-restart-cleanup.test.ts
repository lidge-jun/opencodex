import { expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairService, type RepairServiceDeps } from "../../src/service/repair";
import { buildWindowsTaskXml } from "../../src/service/windows-taskxml";
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
    expect(effects).toEqual(["stop", "wrappers", "verify-stopped", "assets", "start", "state"]);
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
      expect(effects).toEqual(["stop", "wrappers", "client-exited", "verify-stopped", "assets", "start", "state"]);
    } finally { cleanup.mockRestore(); }
  });
});

test("surviving scheduler proxy refuses replacement after owned wrapper cleanup", async () => {
  await scenario(async (deps, effects) => {
    deps.schedulerProxyStillLive = async () => ({ port: 10100 });
    await expect(repairService(deps)).rejects.toThrow("still running");
    expect(effects).toEqual(["stop", "wrappers"]);
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
    expect(effects).toEqual(["stop", "wrappers"]);
  });
});
