import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairService, type RepairServiceDeps } from "../../src/service/repair";
import { buildWindowsTaskXml } from "../../src/service/windows-taskxml";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import * as disconnectedCleanup from "../../src/service/disconnected-client-restart";
import * as orchestration from "../../src/service/orchestration";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTreeWithRetry(root); });
const sid = "S-1-5-21-111-222-333-1001", launcher = "C:\\fixture\\launcher.vbs";
const healthy = buildWindowsTaskXml("fixture.cmd", launcher, undefined, sid);
const foreign = '<Task><Actions><Exec><Command>foreign.exe</Command></Exec></Actions></Task>';

function fixture(read: () => string) {
  const root = mkdtempSync(join(tmpdir(), "ocx-restart-registration-")); roots.push(root);
  const effects: string[] = [], observations: string[] = [];
  const deps: RepairServiceDeps = {
    platform: "win32", verb: "restart", configDir: () => root,
    inspectSupervision: () => ({kind: "none"}),
    diagnose: () => ({supported: true, installed: true, enabled: true, running: true, viable: true,
      startable: true, stale: false, conflict: false, backend: "scheduler", summary: "fixture"}),
    readOwnership: () => ({kind: "none", revision: 0}), assertEnv: () => {}, assertAuth: () => {},
    selectRuntime: () => ({path: process.execPath, source: "override", overrideEnv: "OPENCODEX_BUN_PATH"}),
    assertRuntimeWritable: () => {}, launcherPathDiagnostic: () => null,
    readSchedulerXml: () => {observations.push("read"); return read();}, resolveExpectedUserId: () => sid, schedulerLauncher: launcher,
    prepareDisconnectedClientRestart: async () => { observations.push("settle-client"); effects.push("settle-client"); },
    stopScheduler: () => {effects.push("stop");}, writeSchedulerAssets: () => {effects.push("assets");},
    killServiceWrappers: () => {}, schedulerProxyStillLive: async () => null,
    // Never reach the real home-verified proxy lookup: outside the repository Bun can skip the
    // sandbox preload, and this fixture must not stop a developer's live tracked proxy.
    stopTrackedProxy: async () => { observations.push("stop-tracked"); },
    startScheduler: () => {effects.push("start");}, writeSchedulerState: () => {effects.push("state");},
    reregisterScheduler: async () => {throw new Error("fixture must not reregister");}, settleSchedulerRead: () => {},
  };
  return {deps, effects, observations};
}

test.each(["empty", "throws", "foreign", "partial", "wrong-account"])("restart preserves %s registration before disconnected-client cleanup", async mode => {
  const f = fixture(() => {
    if (mode === "throws") throw new Error("unreadable registration");
    if (mode === "empty") return "";
    if (mode === "partial") return healthy.replace(/<Principals>[\s\S]*?<\/Principals>/, "");
    if (mode === "wrong-account") return healthy.replaceAll(sid, "S-1-5-21-999-999-999-1002");
    return foreign;
  });
  await expect(repairService(f.deps)).rejects.toThrow();
  expect(f.effects).toEqual([]);
});

test("full scheduler verification and fresh snapshot precede disconnected-client cleanup", async () => {
  const f = fixture(() => healthy);
  await repairService(f.deps);
  expect(f.observations.slice(0, 3)).toEqual(["read", "read", "settle-client"]);
  expect(f.effects).toEqual(["settle-client", "stop", "assets", "start", "state"]);
});

test.each(["changed", "unreadable"])("registration becomes %s before cleanup: no stop occurs", async mode => {
  let reads = 0;
  const f = fixture(() => ++reads === 1 ? healthy : mode === "changed" ? foreign : "");
  await expect(repairService(f.deps)).rejects.toThrow();
  expect(f.effects).toEqual([]);
});

test("ownership change during registration validation refuses before cleanup", async () => {
  let revision = 0;
  const f = fixture(() => healthy);
  f.deps.readOwnership = () => ({kind: "none", revision});
  f.deps.resolveExpectedUserId = () => {revision++; return sid;};
  await expect(repairService(f.deps)).rejects.toThrow("ownership changed");
  expect(f.effects).toEqual([]);
});

test("replacement registration after client cleanup is preserved before normal scheduler stop", async () => {
  let xml = healthy;
  const f = fixture(() => xml);
  f.deps.prepareDisconnectedClientRestart = async () => {xml = foreign;};
  await expect(repairService(f.deps)).rejects.toThrow();
  expect(f.effects).toEqual([]);
});

test.each(["registration", "ownership"])("default cleanup rechecks %s after resolving manager operations, before manager stop", async mode => {
  let xml = healthy, revision = 0;
  const f = fixture(() => xml);
  f.deps.prepareDisconnectedClientRestart = undefined;
  f.deps.readOwnership = () => ({kind: "none", revision});
  const cleanup = spyOn(disconnectedCleanup, "prepareDisconnectedClientServiceRestart").mockImplementation(async deps => {
    deps.beforeStop?.();
    await deps.stopManager();
  });
  const operations = spyOn(orchestration, "platformOps").mockImplementation(() => {
    if (mode === "registration") xml = foreign;
    else revision++;
    return {stop: () => {f.effects.push("manager-stop");}} as ReturnType<typeof orchestration.platformOps>;
  });
  try {
    await expect(repairService(f.deps)).rejects.toThrow();
    expect(operations).toHaveBeenCalledTimes(1);
    expect(f.effects).toEqual([]);
  } finally {operations.mockRestore(); cleanup.mockRestore();}
});
