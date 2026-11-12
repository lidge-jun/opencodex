import { describe, expect, test } from "bun:test";
import { installServiceSafely, prepareServiceInstall } from "../../src/service";
import { partAResult, partBResult } from "../helpers/windows-stop-caller-fixtures";

// #7771: on Windows, install and backend switch stop the old installation through the checked
// stop. Part A ends the managers and the bound wrappers (or refuses with nothing replaced),
// the tracked proxy stops next, and Part B must find the port free before anything is
// published or started.
describe("service install preparation wrapper cleanup", () => {
  test("install preparation ends the respawning wrapper (Part A) before the tracked proxy stop", async () => {
    // The defect: schtasks /end ends the task instance but the detached cmd :loop wrapper
    // survives and respawns its child seconds later, landing after the one-shot tracked-proxy
    // kill and holding the install port. Model the respawner: while it lives, a stopped proxy
    // comes back.
    const calls: string[] = [];
    let wrapperAlive = true;
    let respawned = false;
    await prepareServiceInstall("scheduler", {
      platform: "win32",
      windowsPartA: async () => { calls.push("partA"); wrapperAlive = false; return partAResult("stopped"); },
      windowsPartB: async () => { calls.push("partB"); return partBResult("freed"); },
      stopTrackedProxy: async () => {
        calls.push("stop:standalone");
        if (wrapperAlive) respawned = true;
      },
    });
    expect(calls).toEqual(["partA", "stop:standalone", "partB"]);
    expect(respawned).toBe(false);
  });

  test("a stray wrapper of a deleted task that cannot be bound refuses instead of being killed by path", async () => {
    // With nothing registered an orphaned wrapper is never bound (unbound-wrapper): the install
    // stops and names the manual step rather than replacing assets under a live loop.
    const calls: string[] = [];
    await expect(prepareServiceInstall("scheduler", {
      platform: "win32",
      windowsPartA: async () => partAResult("survived", { reason: "unbound-wrapper", registration: { scheduler: "absent", winsw: "nonexistent" } }),
      stopTrackedProxy: async () => { calls.push("stop:standalone"); },
    })).rejects.toThrow(/could not be proven stopped \(survived\)[\s\S]*could not be tied to the service/);
    expect(calls).toEqual([]);
  });

  test("a manager that refuses to stop aborts install preparation before anything else", async () => {
    const calls: string[] = [];
    await expect(prepareServiceInstall("scheduler", {
      platform: "win32",
      windowsPartA: async () => { calls.push("partA"); return partAResult("denied"); },
      windowsPartB: async () => { calls.push("partB"); return partBResult("freed"); },
      stopTrackedProxy: async () => { calls.push("stop:standalone"); },
    })).rejects.toThrow("could not be proven stopped (denied)");
    expect(calls).toEqual(["partA"]);
  });

  test("install and backend switch stop when another program holds the port, naming it", async () => {
    for (const backend of ["scheduler", "native"] as const) {
      let installed = false;
      await expect(installServiceSafely(backend, () => { installed = true; }, {
        platform: "win32",
        windowsPartA: async () => partAResult("stopped"),
        windowsPartB: async () => partBResult("port-held-by-foreign"),
        stopTrackedProxy: async () => {},
      })).rejects.toThrow(/nothing was published or started\. Another program \(PID 777\) holds port 10100/);
      expect(installed).toBe(false);
    }
    await expect(prepareServiceInstall("scheduler", {
      platform: "win32", windowsPartA: async () => partAResult("stopped"),
      windowsPartB: async () => partBResult("survived"), stopTrackedProxy: async () => {},
    })).rejects.toThrow("nothing was published or started");
  });

  test("Part B checks the stopped proxy's runtime port, resolved before the tracked cleanup", async () => {
    // The defect: `windowsServiceStopPort()` was resolved AFTER the tracked cleanup removed
    // the runtime record, so it fell through to the wrapper's port (10100) and Part B
    // confirmed the wrong port while the proxy's own 12000 was never checked.
    const calls: string[] = [];
    let runtimePort: number | null = 12000;
    const ports: number[] = [];
    await prepareServiceInstall("scheduler", {
      platform: "win32",
      windowsStopPort: () => {
        calls.push("port");
        // The runtime record is what makes this the stopped proxy's port; the wrapper's
        // 10100 is only a fallback once that record is gone.
        return runtimePort ?? 10100;
      },
      windowsPartA: async () => { calls.push("partA"); return partAResult("stopped"); },
      stopTrackedProxy: async () => { calls.push("stop:standalone"); runtimePort = null; },
      windowsPartB: async request => { calls.push("partB"); ports.push(request.port); return partBResult("freed"); },
    });
    expect(calls).toEqual(["port", "partA", "stop:standalone", "partB"]);
    expect(ports).toEqual([12000]);
  });

  test("nothing registered: no Part B and no hold", async () => {
    const calls: string[] = [];
    await prepareServiceInstall("scheduler", {
      platform: "win32",
      windowsPartA: async () => { calls.push("partA"); return partAResult("absent"); },
      windowsPartB: async () => { calls.push("partB"); return partBResult("freed"); },
      stopTrackedProxy: async () => { calls.push("stop:standalone"); },
    });
    expect(calls).toEqual(["partA", "stop:standalone"]);
  });

  test("non-Windows install preparation never reaches the checked Windows stop", async () => {
    let partA = 0;
    await prepareServiceInstall("scheduler", {
      platform: "linux",
      managerOps: () => ({ status: () => "present", stop: () => {} }),
      windowsPartA: async () => { partA++; return partAResult("stopped"); },
      stopTrackedProxy: async () => {},
    });
    expect(partA).toBe(0);
  });

  test("live Desktop supervision refuses install preparation before the checked stop", async () => {
    // The pre-mutation supervision refusal stays ahead of every cleanup step: a desktop-owned
    // runtime keeps its respawner until the operator quits Desktop and retries.
    const calls: string[] = [];
    await expect(prepareServiceInstall("scheduler", {
      platform: "win32",
      inspectSupervision: () => ({ kind: "desktop", runtimePid: 4242, supervisorPid: 4200, app: "opencodex-desktop", proxy: "ocx" }),
      windowsPartA: async () => { calls.push("partA"); return partAResult("stopped"); },
      stopTrackedProxy: async () => { calls.push("stop:standalone"); },
    })).rejects.toThrow(/OpenCodex Desktop supervises the running proxy/);
    expect(calls).toEqual([]);
  });
});
