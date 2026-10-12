import { afterEach, describe, expect, test } from "bun:test";
import type { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSelectedRuntimeWritable, type RuntimePreflightDeps } from "../../src/lib/bun-runtime-preflight";
import type { DurableBunRuntime } from "../../src/lib/bun-runtime";
import type { DesktopSupervision } from "../../src/service/desktop-command-guard";
import type { ServiceDiagnostic } from "../../src/service/diagnostics";
import { installFreshWindowsSchedulerSafely, installServiceSafely } from "../../src/service/orchestration";
import { repairService } from "../../src/service/repair";
import { buildWindowsTaskXml } from "../../src/service/windows-taskxml";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTreeWithRetry(root); });
const selected: DurableBunRuntime = { path: process.execPath, source: "override", overrideEnv: "OPENCODEX_BUN_PATH" };
const desktop: DesktopSupervision = {
  kind: "desktop", runtimePid: 4242, supervisorPid: 4200,
  app: "/Applications/OpenCodex.app/Contents/MacOS/opencodex-desktop",
  proxy: "/Applications/OpenCodex.app/Contents/MacOS/ocx",
};
const diagnostic: ServiceDiagnostic = {
  supported: true, installed: true, enabled: true, running: true, viable: true,
  startable: true, stale: false, conflict: false, backend: "scheduler", summary: "fixture",
};
const sid = "S-1-5-21-111-222-333-1001";
const launcher = "C:\\fixture\\launcher.vbs";
const healthyXml = buildWindowsTaskXml("injected.cmd", launcher, undefined, sid);

function fixture(supervised: boolean, passes: boolean) {
  const root = mkdtempSync(join(tmpdir(), "ocx-desktop-runtime-")); roots.push(root);
  const order: string[] = [];
  const admitted: DurableBunRuntime[] = [];
  const candidate = { ...selected };
  let spawns = 0, selections = 0;
  const admission: RuntimePreflightDeps = {
    platform: "win32", configDir: () => root,
    selectRuntime: () => { selections++; return candidate; },
    assertRuntimeWritable: (runtime, configDir, options) => {
      order.push("preflight"); admitted.push(runtime);
      assertSelectedRuntimeWritable(runtime, configDir, {
        ...options, nonce: () => "combined",
        spawnSync: ((path: string) => {
          spawns++; expect(path).toBe(selected.path);
          return { status: passes ? 0 : 1, stdout: passes ? "combined:ok" : "combined:create" };
        }) as typeof spawnSync,
      });
      candidate.path = "unprobed.exe";
    },
  };
  const inspectSupervision = (): DesktopSupervision => supervised ? desktop : { kind: "none" };
  const consume = (effect: string) => (runtime: DurableBunRuntime) => {
    order.push(effect); admitted.push(runtime);
    expect(runtime).toEqual(selected); expect(Object.isFrozen(runtime)).toBe(true);
  };
  const run = (action: string) => {
    if (action === "install") return installServiceSafely("scheduler", consume("install"), {
      ...admission, inspectSupervision,
      diagnose: () => { order.push("diagnose"); return diagnostic; },
      managerOps: () => ({ status: () => "present", stop: () => { order.push("stop"); } }),
      stopTrackedProxy: async () => { order.push("proxy"); },
    });
    if (action === "fresh install") return installFreshWindowsSchedulerSafely({
      ...admission, inspectSupervision,
      stageRegistrationXml: () => { order.push("stage"); return "fixture.xml"; },
      register: async () => { order.push("register"); }, removeStagedXml: () => { order.push("unstage"); },
      recordOwnership: () => { order.push("ownership"); return true; },
      prepare: async () => { order.push("stop"); }, removeNativeService: () => { order.push("remove"); },
      publishAssets: consume("assets"), verifyBeforeRun: () => {}, runTask: () => { order.push("start"); },
      writeState: consume("state"), rollbackTask: async () => { order.push("rollback"); return null; },
    });
    return repairService({
      ...admission, inspectSupervision,
      diagnose: () => { order.push("diagnose"); return { ...diagnostic, backend: action === "native repair" ? "native" : "scheduler" }; },
      readOwnership: () => { order.push("ownership"); return { kind: "none", revision: 0 }; },
      assertEnv: () => { order.push("env"); }, assertAuth: () => { order.push("auth"); },
      launcherPathDiagnostic: () => null,
      repairNative: consume("native"), writeNativeState: consume("state"),
      readSchedulerXml: () => healthyXml, resolveExpectedUserId: () => sid, schedulerLauncher: launcher,
      stopScheduler: () => { order.push("stop"); }, writeSchedulerAssets: consume("assets"),
      startScheduler: () => { order.push("start"); }, writeSchedulerState: consume("state"),
    });
  };
  return { run, order, admitted, spawns: () => spawns, selections: () => selections };
}

describe("Desktop supervision precedes selected-runtime service admission", () => {
  for (const action of ["install", "fresh install", "native repair", "scheduler repair"]) {
    test(`${action}: Desktop refuses before the refusing preflight can spawn`, async () => {
      const f = fixture(true, false);
      await expect(f.run(action)).rejects.toThrow("OpenCodex Desktop supervises the running proxy");
      expect(f.spawns()).toBe(0); expect(f.selections()).toBe(0); expect(f.order).toEqual([]);
    });
    test(`${action}: preflight refusal precedes stop and runtime writes`, async () => {
      const f = fixture(false, false);
      if (action === "fresh install") {
        await expect(f.run(action)).rejects.toThrow("preflight: create");
        expect(f.order).toEqual(["stage", "register", "unstage", "ownership", "preflight", "rollback"]);
      } else {
        await expect(f.run(action)).rejects.toMatchObject({ code: "OCX_RUNTIME_PREFLIGHT_FAILED", reason: "create" });
        expect(f.order).toEqual(action === "install" ? ["preflight"] : ["diagnose", "ownership", "env", "auth", "preflight"]);
      }
      expect(f.spawns()).toBe(1); expect(f.selections()).toBe(1);
    });
    test(`${action}: passing admission uses one frozen runtime through commit`, async () => {
      const f = fixture(false, true);
      await f.run(action);
      expect(f.spawns()).toBe(1); expect(f.selections()).toBe(1);
      expect(f.admitted.length).toBeGreaterThan(1);
      for (const runtime of f.admitted) { expect(runtime).toBe(f.admitted[0]); expect(runtime).toEqual(selected); }
      if (action === "fresh install") expect(f.order.indexOf("ownership")).toBeLessThan(f.order.indexOf("preflight"));
      expect(f.order.indexOf("preflight")).toBeLessThan(f.order.indexOf(action === "native repair" ? "native" : "stop"));
    });
  }
});
