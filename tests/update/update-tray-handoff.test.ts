import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { handoffWindowsTrayForUpdate, planWindowsTrayUpdate, windowsTrayStopConfirmed } from "../../src/update/tray-update-plan.mjs";
import { helperPath, repoRoot } from "../helpers/repo-root";
import { createTempHome } from "../helpers/temp-home";

describe("Windows tray update handoff contract", () => {
  test("preserves an installed, running tray across replacement", () => {
    expect(planWindowsTrayUpdate({ installed: true, running: true })).toEqual({
      installed: true,
      running: true,
      stopBeforeReplacement: true,
      restoreOnFailure: true,
      refreshAfterReplacement: true,
      installArgs: ["tray", "install"],
    });
  });

  test("refreshes an installed, idle tray without starting it", () => {
    expect(planWindowsTrayUpdate({ installed: true, running: false })).toMatchObject({
      stopBeforeReplacement: false,
      restoreOnFailure: false,
      refreshAfterReplacement: true,
      installArgs: ["tray", "install", "--no-start"],
    });
  });

  test("does nothing for an absent tray and fails closed on incomplete stop", () => {
    expect(planWindowsTrayUpdate({ installed: false, running: false })).toMatchObject({
      stopBeforeReplacement: false,
      restoreOnFailure: false,
      refreshAfterReplacement: false,
    });
    expect(windowsTrayStopConfirmed(0, false)).toBe(true);
    expect(windowsTrayStopConfirmed(1, false)).toBe(false);
    expect(windowsTrayStopConfirmed(0, true)).toBe(false);
  });

  test("restores a previously running tray when stop throws or remains live", () => {
    const calls: string[] = [];
    expect(() => handoffWindowsTrayForUpdate({ installed: true, running: true }, {
      stop: () => { calls.push("stop-throw"); throw new Error("registry status failed"); },
      start: () => { calls.push("restore-after-throw"); },
    })).toThrow("registry status failed");
    expect(calls).toEqual(["stop-throw", "restore-after-throw"]);

    expect(() => handoffWindowsTrayForUpdate({ installed: true, running: true }, {
      stop: () => ({ exitStatus: 0, running: true }),
      start: () => { calls.push("restore-still-live"); },
    })).toThrow("still reports running");
    expect(calls).toContain("restore-still-live");
  });

  test("all three updater lanes consume the same tested plan", () => {
    const root = repoRoot();
    for (const path of ["src/update/index.ts", "src/update/job.ts", "bin/ocx.mjs"]) {
      const source = readFileSync(join(root, path), "utf8");
      expect(source).toContain("planWindowsTrayUpdate");
      if (path === "src/update/job.ts") {
        expect(source).toContain('import { defaultWorkerTrayHandoff } from "./job-update-tray";');
        expect(source).toContain("(io.trayHandoffFn ?? defaultWorkerTrayHandoff)(plan => {");
        const handoff = readFileSync(join(root, "src/update/job-update-tray.ts"), "utf8");
        expect(handoff).toContain('import { handoffWindowsTrayForUpdate, planWindowsTrayUpdate } from "./tray-update-plan.mjs";');
        expect(handoff).toContain("return handoffWindowsTrayForUpdate(status, {");
      } else {
        expect(source).toContain("handoffWindowsTrayForUpdate");
      }
      expect(source).toContain("installArgs");
    }
  });
});

function defaultWorker(scenario: string) {
  const box = createTempHome("ocx-default-worker-tray-");
  try {
    mkdirSync(box.codexHome);
    const child = Bun.spawnSync([process.execPath, helperPath("update-worker-tray-child.ts"), box.root, scenario],
      { env: { ...process.env }, stdout: "pipe", stderr: "pipe", timeout: 12_000 });
    const log = child.stdout.toString() + child.stderr.toString();
    expect(child.exitCode, log).toBe(0);
    const receipt = child.stdout.toString().split("\n").find(line => line.startsWith("TRAY_WORKER_PROBE:"));
    expect(receipt, log).toBeDefined();
    return JSON.parse(receipt!.slice("TRAY_WORKER_PROBE:".length)) as {
      calls: string[]; commands: string[][]; replacements: number; status: string; restarted: boolean; error?: string;
    };
  } finally { box.remove(); }
}

test("default Windows worker recovers its stopped tray after status and first start both fail", () => {
  const result = defaultWorker("running-status-start-fail");
  expect(result.calls).toEqual(["status", "stop", "status", "native-start"]);
  expect(result.commands).toEqual([["tray", "start"]]);
  expect(result.replacements).toBe(0);
  expect(result).toMatchObject({ status: "failed", restarted: false });
  expect(result.error).toContain("Could not stop the Windows tray");
}, 15_000);

test("default Windows worker preserves the handoff failure if launcher cleanup also fails", () => {
  const result = defaultWorker("running-cleanup-fail");
  expect(result.commands).toEqual([["tray", "start"]]);
  expect(result.replacements).toBe(0);
  expect(result.status).toBe("failed");
  expect(result.error).toContain("Could not stop the Windows tray");
}, 15_000);

for (const scenario of ["running-success", "idle", "absent"]) test(`default Windows worker behavior for ${scenario}`, () => {
  const result = defaultWorker(scenario);
  expect(result.calls).toEqual(scenario === "running-success" ? ["status", "stop", "status"] : ["status"]);
  expect(result.commands).toEqual(scenario === "running-success" ? [["tray", "install"]]
    : scenario === "idle" ? [["tray", "install", "--no-start"]] : []);
  expect(result.replacements).toBe(1);
  expect(result.status).toBe("succeeded");
}, 15_000);

test("default Windows worker with no initial tray evidence performs no cleanup or replacement", () => {
  const result = defaultWorker("initial-status-fail");
  expect(result.calls).toEqual(["status"]);
  expect(result.commands).toEqual([]);
  expect(result.replacements).toBe(0);
  expect(result.status).toBe("failed");
}, 15_000);
