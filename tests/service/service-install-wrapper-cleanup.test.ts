import { describe, expect, test } from "bun:test";
import { prepareServiceInstall } from "../../src/service";

describe("service install preparation wrapper cleanup", () => {
  test("install preparation kills surviving scheduler wrappers before the tracked proxy stop", async () => {
    // The defect: `schtasks /end` ends the task instance but the detached cmd
    // `:loop` wrapper survives and respawns its child seconds later — landing
    // after the one-shot tracked-proxy kill and holding the install port. Model
    // the respawner: while the wrapper lives, a stopped proxy comes back.
    const calls: string[] = [];
    let wrapperAlive = true;
    let respawned = false;
    await prepareServiceInstall("scheduler", {
      platform: "win32",
      diagnose: () => ({ supported: true, installed: true, enabled: true, running: true, viable: true, startable: true, stale: false, conflict: false, backend: "scheduler", summary: "test" }),
      managerOps: () => ({
        status: () => "present",
        // `schtasks /end` ends the task instance; it cannot reach the detached wrapper.
        stop: () => { calls.push("stop:scheduler"); },
      }),
      killServiceWrappers: () => { calls.push("kill:wrappers"); wrapperAlive = false; },
      stopTrackedProxy: async () => {
        calls.push("stop:standalone");
        if (wrapperAlive) respawned = true;
      },
    });
    expect(calls).toEqual(["stop:scheduler", "kill:wrappers", "stop:standalone"]);
    expect(respawned).toBe(false);
  });

  test("install preparation kills stray scheduler wrappers even when no manager stop runs", async () => {
    // A registration deleted mid-uninstall leaves no task for `schtasks /end`, but
    // the detached wrapper may still be looping: it must not respawn the old proxy
    // onto the port the fresh install is about to claim.
    let killed = false;
    const calls: string[] = [];
    await prepareServiceInstall("scheduler", {
      platform: "win32",
      diagnose: () => ({ supported: true, installed: false, enabled: false, running: false, viable: false, startable: false, stale: false, conflict: false, backend: null, summary: "test" }),
      managerOps: () => ({
        status: () => null,
        stop: () => { calls.push("stop:scheduler"); throw new Error("no task to stop"); },
      }),
      killServiceWrappers: () => { calls.push("kill:wrappers"); killed = true; },
      stopTrackedProxy: async () => { calls.push("stop:standalone"); },
    });
    expect(killed).toBe(true);
    expect(calls).toEqual(["kill:wrappers", "stop:standalone"]);
  });

  test("a manager that refuses to stop aborts install preparation before the wrapper kill", async () => {
    // Propagating the refusal is the fail-closed contract — and killing the wrapper
    // of a service whose task is still running would break that surviving service.
    const calls: string[] = [];
    await expect(prepareServiceInstall("scheduler", {
      platform: "win32",
      diagnose: () => ({ supported: true, installed: true, enabled: true, running: true, viable: true, startable: true, stale: false, conflict: false, backend: "scheduler", summary: "test" }),
      managerOps: () => ({
        status: () => "present",
        stop: () => { calls.push("stop:scheduler"); throw new Error("end refused"); },
      }),
      killServiceWrappers: () => { calls.push("kill:wrappers"); },
      stopTrackedProxy: async () => { calls.push("stop:standalone"); },
    })).rejects.toThrow("end refused");
    expect(calls).toEqual(["stop:scheduler"]);
  });

  test("non-Windows install preparation never invokes the scheduler wrapper kill", async () => {
    let killed = 0;
    await prepareServiceInstall("scheduler", {
      platform: "linux",
      managerOps: () => ({ status: () => "present", stop: () => {} }),
      killServiceWrappers: () => { killed++; },
      stopTrackedProxy: async () => {},
    });
    expect(killed).toBe(0);
  });

  test("live Desktop supervision refuses install preparation before the wrapper kill", async () => {
    // The pre-mutation supervision refusal verified here stays ahead of every
    // cleanup step: a desktop-owned runtime keeps its respawner until the
    // operator quits Desktop and retries.
    const calls: string[] = [];
    await expect(prepareServiceInstall("scheduler", {
      platform: "win32",
      inspectSupervision: () => ({ kind: "desktop", runtimePid: 4242, supervisorPid: 4200, app: "opencodex-desktop", proxy: "ocx" }),
      diagnose: () => { calls.push("diagnose"); return { supported: true, installed: true, enabled: true, running: true, viable: true, startable: true, stale: false, conflict: false, backend: "scheduler", summary: "test" }; },
      managerOps: () => { calls.push("manager"); return { status: () => "present", stop: () => {} }; },
      killServiceWrappers: () => { calls.push("kill:wrappers"); },
      stopTrackedProxy: async () => { calls.push("stop:standalone"); },
    })).rejects.toThrow(/OpenCodex Desktop supervises the running proxy/);
    expect(calls).toEqual([]);
  });
});
