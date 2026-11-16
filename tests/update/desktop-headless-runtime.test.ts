import { describe, expect, test } from "bun:test";
import { classifyMsiExit, msiexecArguments, runMsiInstall } from "../../src/desktop-update/msi";
import { isInstalledImage, MOVED_IMAGE_PATTERN, movedImageName, sameWindowsPath, settleRuntime, type RuntimeReplaceDeps } from "../../src/desktop-update/runtime";
import { parseDrainResult } from "../../src/desktop-update/drain";
import type { AcquireTimers } from "../../src/desktop-update/acquire";
import type { LiveProxy } from "../../src/server/proxy-liveness";

const EXE = "C:\\Program Files\\OpenCodex\\ocx.exe";

describe("Windows Installer execution", () => {
  test("runs msiexec with fixed arguments and waits for its real exit code", async () => {
    const calls: Array<[string, readonly string[]]> = [];
    let finish!: (code: number) => void;
    const work = runMsiInstall({ msiexec: "C:\\Windows\\System32\\msiexec.exe", msiPath: "C:\\t\\a.msi", logPath: "C:\\t\\msiexec.log", timeoutMs: 900_000 }, {
      spawn: (file, args) => { calls.push([file, args]); return { exited: new Promise(resolve => { finish = resolve; }) }; },
      timers: { schedule: () => () => {} },
    });
    expect(calls).toEqual([["C:\\Windows\\System32\\msiexec.exe", ["/i", "C:\\t\\a.msi", "/qn", "/norestart", "/l*v", "C:\\t\\msiexec.log"]]]);
    finish(3010);
    expect(await work).toEqual({ kind: "installed-reboot-required", code: 3010 });
    expect(msiexecArguments("a", "b")).not.toContain("/passive");
  });

  test("exit codes map to installed, reboot, busy, cancelled or failed", () => {
    expect(classifyMsiExit(0).kind).toBe("installed");
    expect(classifyMsiExit(3010).kind).toBe("installed-reboot-required");
    expect(classifyMsiExit(1641).kind).toBe("installed-reboot-required");
    expect(classifyMsiExit(1618).kind).toBe("busy");
    expect(classifyMsiExit(1602).kind).toBe("cancelled");
    for (const code of [1603, 1625, 1925, null]) expect(classifyMsiExit(code).kind).toBe("failed");
  });

  test("an installer past its deadline is uncertain and is not killed", async () => {
    let fire!: () => void;
    const timers: AcquireTimers = { schedule: (_ms, f) => { fire = f; return () => {}; } };
    let killed = false;
    const work = runMsiInstall({ msiexec: "m", msiPath: "a", logPath: "l", timeoutMs: 5 }, {
      spawn: () => ({ exited: new Promise(() => {}), kill: () => { killed = true; } }) as never, timers,
    });
    fire();
    expect(await work).toEqual({ kind: "uncertain", code: null });
    expect(killed).toBe(false);
  });

  test("a spawn failure is a failure, never an install", async () => {
    expect(await runMsiInstall({ msiexec: "m", msiPath: "a", logPath: "l", timeoutMs: 5 }, {
      spawn: () => { throw new Error("ENOENT"); }, timers: { schedule: () => () => {} },
    })).toEqual({ kind: "failed", code: null });
  });
});

function live(pid: number | null, version: string | undefined, extra: Partial<LiveProxy> = {}): LiveProxy {
  return { pid, port: 10100, hostname: "127.0.0.1", source: "runtime", ...(version ? { version } : {}), ...extra };
}

/** A runtime that answers from a script; each findLive consumes the next answer. */
function runtime(answers: Array<LiveProxy | null>, options: { image?: string | null; restart?: "accepted" | "uncertain" | "refused" | "client-desktop" | "client-service"; supervisor?: string | null; drain?: boolean; service?: boolean } = {}) {
  let clock = 0;
  const restarts: Array<[number, string]> = [];
  let drains = 0;
  let services = 0;
  const deps: RuntimeReplaceDeps = {
    findLive: async () => (answers.length > 1 ? answers.shift()! : answers[0] ?? null),
    runtimeImage: () => (options.image === undefined ? EXE.toLowerCase().replaceAll("\\", "/") : options.image),
    requestRestart: async (target, version) => {
      restarts.push([target.pid, version]);
      if (options.restart === "refused") return { accepted: false, uncertain: false, error: new Error("restart_supervised_service-unproven") };
      if (options.restart === "client-service") return { accepted: false, uncertain: false, error: new Error("restart_supervised_service") };
      if (options.restart === "client-desktop") return { accepted: false, uncertain: false, error: new Error("restart_supervised_desktop") };
      if (options.restart === "uncertain") return { accepted: false, uncertain: true, error: new Error("restart_request_outcome_unknown") };
      return { accepted: true };
    },
    desktopSupervisor: () => (options.supervisor === undefined ? "C:\\Program Files\\OpenCodex\\opencodex-desktop.exe" : options.supervisor),
    drainRuntime: async () => { drains++; return options.drain === false ? { ok: false, detail: "failed/stop-failed exit 1" } : { ok: true }; },
    restartService: async () => { services++; return options.service === false ? { ok: false, detail: "exit 1: the previous runtime is still serving" } : { ok: true }; },
    now: () => clock,
    wait: async ms => { clock += ms; },
  };
  return { deps, restarts, drains: () => drains, services: () => services, elapsed: () => clock };
}

describe("runtime replacement after install", () => {
  const input = { installedExe: EXE, targetVersion: "2.100.3", deadlineAt: 2_000, wasRunning: true };

  test("a runtime already on the target is left alone", async () => {
    const r = runtime([live(7, "2.100.3")]);
    expect(await settleRuntime(input, r.deps)).toMatchObject({ kind: "serving-target", replaced: false });
    expect(r.restarts).toEqual([]);
  });

  test("an old runtime from this installation restarts into the installed version", async () => {
    const r = runtime([live(7, "2.99.0"), live(7, "2.99.0"), null, live(8, "2.100.3")]);
    const outcome = await settleRuntime(input, r.deps);
    expect(outcome).toMatchObject({ kind: "serving-target", replaced: true, live: { pid: 8, version: "2.100.3" } });
    expect(r.restarts).toEqual([[7, "2.100.3"]]);
  });

  test("the old pid answering the target version is not proof of replacement", async () => {
    const r = runtime([live(7, "2.99.0"), live(7, "2.100.3")]);
    expect(await settleRuntime(input, r.deps)).toMatchObject({ kind: "stale", reason: "replacement-timeout" });
    expect(r.elapsed()).toBe(2_000);
  });

  test("an uncertain request is observed, never sent twice", async () => {
    const r = runtime([live(7, "2.99.0"), live(9, "2.100.3")], { restart: "uncertain" });
    expect(await settleRuntime(input, r.deps)).toMatchObject({ kind: "serving-target", replaced: true });
    expect(r.restarts).toHaveLength(1);
  });

  test("a runtime from another installation is reported and never stopped", async () => {
    const r = runtime([live(7, "2.99.0")], { image: "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\bun\\bin\\bun.exe" });
    expect(await settleRuntime(input, r.deps)).toMatchObject({ kind: "stale", reason: "foreign-image", detail: expect.stringContaining("bun.exe") });
    expect(r.restarts).toEqual([]);
    const unreadable = runtime([live(7, "2.99.0")], { image: null });
    expect(await settleRuntime(input, unreadable.deps)).toMatchObject({ kind: "stale", reason: "foreign-image" });
    expect(unreadable.restarts).toEqual([]);
  });

  test("unattested, unknown-version and newer runtimes are left running", async () => {
    for (const [answer, reason] of [
      [live(7, "2.99.0", { source: "config" }), "unattested"],
      [live(null, "2.99.0"), "unattested"],
      [live(7, undefined), "unknown-version"],
      [live(7, "2.101.0"), "runtime-newer"],
    ] as const) {
      const r = runtime([answer]);
      expect(await settleRuntime(input, r.deps)).toMatchObject({ kind: "stale", reason });
      expect(r.restarts).toEqual([]);
    }
  });

  test("a refused restart is reported with its code", async () => {
    const r = runtime([live(7, "2.99.0")], { restart: "refused" });
    expect(await settleRuntime(input, r.deps)).toMatchObject({ kind: "stale", reason: "restart-refused", detail: "restart_supervised_service-unproven" });
  });

  test("no runtime before the install means none is started", async () => {
    const r = runtime([null]);
    expect(await settleRuntime({ ...input, wasRunning: false }, r.deps)).toEqual({ kind: "not-running" });
    expect(r.elapsed()).toBe(0);
  });

  test("a runtime that vanished during the install must come back on the target", async () => {
    const back = runtime([null, null, live(8, "2.100.3")]);
    expect(await settleRuntime(input, back.deps)).toMatchObject({ kind: "serving-target", replaced: true });
    const gone = runtime([null]);
    expect(await settleRuntime(input, gone.deps)).toMatchObject({ kind: "stale", reason: "replacement-timeout", live: null });
  });

  test("Windows image paths compare without case or separator differences", () => {
    expect(sameWindowsPath("C:/Program Files/OpenCodex/OCX.EXE", EXE)).toBe(true);
    expect(sameWindowsPath("D:\\OpenCodex\\ocx.exe", EXE)).toBe(false);
  });
});

describe("Desktop-owned client runtime", () => {
  const input = { installedExe: EXE, targetVersion: "2.100.3", deadlineAt: 2_000, wasRunning: true };

  test("a refused client restart under this installation's app is drained for the app to restart", async () => {
    const r = runtime([live(7, "2.99.0", { role: "client" }), live(7, "2.99.0"), null, live(9, "2.100.3")], { restart: "client-desktop" });
    expect(await settleRuntime(input, r.deps)).toMatchObject({ kind: "serving-target", replaced: true, live: { pid: 9 } });
    expect(r.drains()).toBe(1);
  });

  test("no drain without proof that this installation's app supervises that pid", async () => {
    for (const supervisor of [null, "D:\\\\Other\\\\opencodex-desktop.exe"]) {
      const r = runtime([live(7, "2.99.0", { role: "client" })], { restart: "client-desktop", supervisor });
      expect(await settleRuntime(input, r.deps)).toMatchObject({ kind: "stale", reason: "restart-refused", detail: "restart_supervised_desktop" });
      expect(r.drains()).toBe(0);
    }
    // A service-owned refusal is never turned into a stop.
    const service = runtime([live(7, "2.99.0", { role: "client" })], { restart: "refused" });
    expect(await settleRuntime(input, service.deps)).toMatchObject({ kind: "stale", reason: "restart-refused" });
    expect(service.drains()).toBe(0);
  });

  test("an unconfirmed drain is reported, not observed as success", async () => {
    const r = runtime([live(7, "2.99.0", { role: "client" })], { restart: "client-desktop", drain: false });
    expect(await settleRuntime(input, r.deps)).toMatchObject({ kind: "stale", reason: "drain-failed", detail: "failed/stop-failed exit 1" });
    expect(r.elapsed()).toBe(0);
  });

  test("the drain result is accepted only when the stop document and exit code agree", () => {
    const doc = (fields: Record<string, unknown>) => JSON.stringify({ schema: "ocx-stop/1", ok: true, outcome: "stopped", exitCode: 0, runtimeDown: true, proxy: "stopped", message: "Stopped.", ...fields });
    expect(parseDrainResult(`noise\n${doc({})}\n`, 0)).toEqual({ ok: true });
    expect(parseDrainResult(doc({ proxy: "stopped-orphan" }), 0)).toEqual({ ok: true });
    expect(parseDrainResult(doc({ ok: false, outcome: "history-incomplete", exitCode: 79 }), 79)).toEqual({ ok: true });
    for (const [stdout, code] of [
      [doc({}), 1],
      [doc({ runtimeDown: false }), 0],
      [doc({ outcome: "failed", ok: false, exitCode: 1, proxy: "stop-failed" }), 1],
      [doc({ outcome: "approval-changed" }), 0],
      [doc({ schema: "ocx-stop/2" }), 0],
      [doc({ outcome: "history-incomplete", exitCode: 79, ok: false, proxy: "respawned" }), 79],
      ["not json", 0],
    ] as const) expect(parseDrainResult(stdout, code).ok).toBe(false);
  });
});

test("a previous image moved aside in the installation still counts as this installation", () => {
  expect(isInstalledImage("C:\\Program Files\\OpenCodex\\ocx.exe.4242-1794790000000.update-old", EXE)).toBe(true);
  expect(isInstalledImage("C:\\Program Files\\OpenCodex\\ocx.exe.bak", EXE)).toBe(false);
  expect(isInstalledImage("C:\\Other\\ocx.exe.4242-1.update-old", EXE)).toBe(false);
  expect(movedImageName(42, 7)).toMatch(MOVED_IMAGE_PATTERN);
});

describe("service-owned client runtime", () => {
  const input = { installedExe: EXE, targetVersion: "2.100.3", deadlineAt: 2_000, wasRunning: true };

  test("a client kept by its service is restarted through the installed ocx service restart", async () => {
    const r = runtime([live(7, "2.100.0", { role: "client" }), live(7, "2.100.0"), live(11, "2.100.3")], { restart: "client-service" });
    expect(await settleRuntime(input, r.deps)).toMatchObject({ kind: "serving-target", replaced: true, live: { pid: 11 } });
    expect([r.services(), r.drains()]).toEqual([1, 0]);
  });

  test("a service restart that does not confirm is reported, not observed as success", async () => {
    const r = runtime([live(7, "2.100.0", { role: "client" })], { restart: "client-service", service: false });
    expect(await settleRuntime(input, r.deps)).toMatchObject({ kind: "stale", reason: "service-restart-failed", detail: expect.stringContaining("still serving") });
    expect(r.elapsed()).toBe(0);
  });

  test("an unproven service owner is never restarted or stopped", async () => {
    const r = runtime([live(7, "2.100.0", { role: "client" })], { restart: "refused" });
    expect(await settleRuntime(input, r.deps)).toMatchObject({ kind: "stale", reason: "restart-refused" });
    expect([r.services(), r.drains()]).toEqual([0, 0]);
  });
});
