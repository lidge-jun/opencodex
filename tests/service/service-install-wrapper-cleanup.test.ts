import { describe, expect, test } from "bun:test";
import { installServiceSafely, prepareServiceInstall } from "../../src/service";
import { partAResult, partBResult } from "../helpers/windows-stop-caller-fixtures";

// #7771: on Windows, install and backend switch stop the old installation through the checked
// stop. Part A ends the managers and the bound wrappers (or refuses with nothing replaced),
// the tracked proxy stops next, and Part B must find the port free before anything is
// published or started.
describe("service install preparation wrapper cleanup", () => {
  test("install claims the discovered orphan endpoint and carries it to the stop", async () => {
    const endpoint = { hostname: "127.0.0.1", port: 12001 };
    let claimed: unknown;
    let target: unknown;
    let port = 0;
    await prepareServiceInstall("scheduler", {
      platform: "win32", windowsStopPort: () => 10100,
      windowsPartA: async () => partAResult("stopped"),
      resolveTarget: async () => ({ pid: 42, endpoint }),
      claimTeardown: value => { claimed = value; return { nonce: "n" }; },
      stopTrackedProxy: async io => { target = io?.target; },
      windowsPartB: async request => { port = request.port; return partBResult("freed"); },
    });
    expect(claimed).toEqual(endpoint);
    expect(target).toEqual({ pid: 42, endpoint });
    expect(port).toBe(12001);
  });
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
      resolveTarget: async () => ({ pid: 42, endpoint: { hostname: "127.0.0.1", port: 12000 } }),
      claimTeardown: () => ({ nonce: "fixture" }),
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
      installEndpoints: () => [{ hostname: "127.0.0.1", port: 10100 }],
      endpointLiveness: async () => "dead",
      stopTrackedProxy: async () => { calls.push("stop:standalone"); },
    });
    expect(calls).toEqual(["partA", "stop:standalone"]);
  });

  test("a stopped Part A claims a receipt before the tracked stop and forwards its nonce", async () => {
    // #7771 round 9: Part A leaves the scheduler task registered, so the tracked stop's
    // /api/stop answers 409 respawnable_service without a receipt. stopProxy then throws and
    // the install aborts while the old proxy keeps serving. The install claims the receipt
    // with Part A's record before the stop, exactly as `ocx service stop` does.
    const calls: string[] = [];
    const claimed: Array<{ endpoint: { hostname: string; port: number }; partA: unknown }> = [];
    const stopIo: Array<{ deferSharedTeardownNonce?: string }> = [];
    const cleared: string[] = [];
    let installed = false;
    await installServiceSafely("scheduler", () => { calls.push("install"); installed = true; }, {
      platform: "win32",
      windowsPartA: async () => { calls.push("partA"); return partAResult("stopped"); },
      windowsPartB: async () => { calls.push("partB"); return partBResult("freed"); },
      windowsStopPort: () => 12000,
      resolveTarget: async () => ({ pid: 42, endpoint: { hostname: "127.0.0.1", port: 12000 } }),
      claimTeardown: (endpoint, _source, _pid, _handover, partA) => {
        calls.push("claim");
        claimed.push({ endpoint, partA });
        return { nonce: "nonce-1" };
      },
      clearTeardown: nonce => { calls.push("clear"); cleared.push(nonce); return true; },
      stopTrackedProxy: async io => { calls.push("stop:standalone"); stopIo.push(io ?? {}); },
    });
    expect(installed).toBe(true);
    expect(calls).toEqual(["partA", "claim", "stop:standalone", "partB", "install", "clear"]);
    expect(claimed).toEqual([{
      endpoint: { hostname: "127.0.0.1", port: 12000 },
      partA: { partA: "stopped", manager: { scheduler: true, winsw: false }, wrappers: [{ pid: 30, startTime: 5_100 }] },
    }]);
    expect(stopIo).toEqual([{ target: { pid: 42, endpoint: { hostname: "127.0.0.1", port: 12000 } }, deferSharedTeardownNonce: "nonce-1", skipPortWait: true, orphanDiscoveryCapMs: expect.any(Number) }]);
    // The install replaces the proxy, so shared config stays pointed at OpenCodex and the
    // obligation is discharged only once the new service is installed and started.
    expect(cleared).toEqual(["nonce-1"]);
  });

  test("an install that fails after the stop keeps the receipt for the next stop", async () => {
    const cleared: string[] = [];
    await expect(installServiceSafely("scheduler", () => { throw new Error("install failed"); }, {
      platform: "win32",
      windowsPartA: async () => partAResult("stopped"),
      windowsPartB: async () => partBResult("freed"),
      windowsStopPort: () => 12000,
      resolveTarget: async () => ({ pid: 42, endpoint: { hostname: "127.0.0.1", port: 12000 } }),
      claimTeardown: () => ({ nonce: "nonce-2" }),
      clearTeardown: nonce => { cleared.push(nonce); return true; },
      stopTrackedProxy: async () => {},
    })).rejects.toThrow("install failed");
    expect(cleared).toEqual([]);
  });

  test("a receipt that cannot be claimed refuses before the tracked stop", async () => {
    const calls: string[] = [];
    await expect(prepareServiceInstall("scheduler", {
      platform: "win32",
      windowsPartA: async () => { calls.push("partA"); return partAResult("stopped"); },
      windowsStopPort: () => 12000,
      resolveTarget: async () => ({ pid: 42, endpoint: { hostname: "127.0.0.1", port: 12000 } }),
      claimTeardown: () => { throw new Error("disk full"); },
      stopTrackedProxy: async () => { calls.push("stop:standalone"); },
    })).rejects.toThrow(/deferred-teardown receipt could not be recorded[\s\S]*disk full/);
    expect(calls).toEqual(["partA"]);
  });

  test("an absent manager still proves every endpoint down before the install callback", async () => {
    // #7771 round 9: with Part A absent, Part B is skipped and the tracked stop can return
    // "none" after its orphan-discovery cap while an unresponsive proxy still holds the port.
    // The install must not publish assets over it.
    const calls: string[] = [];
    let installed = false;
    await expect(installServiceSafely("scheduler", () => { installed = true; }, {
      platform: "win32",
      windowsPartA: async () => { calls.push("partA"); return partAResult("absent"); },
      windowsStopPort: () => 12000,
      installEndpoints: () => [{ hostname: "127.0.0.1", port: 12000 }, { hostname: "127.0.0.1", port: 10100 }],
      endpointLiveness: async endpoint => (endpoint.port === 10100 ? "live" : "dead"),
      stopTrackedProxy: async () => { calls.push("stop:standalone"); },
    })).rejects.toThrow(/port 10100/);
    expect(installed).toBe(false);
    expect(calls).toEqual(["partA", "stop:standalone"]);
  });

  test("an absent manager with an unreadable endpoint refuses too", async () => {
    let installed = false;
    await expect(installServiceSafely("scheduler", () => { installed = true; }, {
      platform: "win32",
      windowsPartA: async () => partAResult("absent"),
      windowsStopPort: () => 12000,
      installEndpoints: () => [{ hostname: "127.0.0.1", port: 12000 }],
      endpointLiveness: async () => "unknown",
      stopTrackedProxy: async () => {},
    })).rejects.toThrow(/could not be confirmed down/);
    expect(installed).toBe(false);
  });

  test("an absent manager with every endpoint dead proceeds without a receipt", async () => {
    const calls: string[] = [];
    let installed = false;
    await installServiceSafely("scheduler", () => { installed = true; }, {
      platform: "win32",
      windowsPartA: async () => partAResult("absent"),
      windowsStopPort: () => 12000,
      installEndpoints: () => [{ hostname: "127.0.0.1", port: 12000 }],
      endpointLiveness: async () => "dead",
      resolveTarget: async () => null,
      claimTeardown: () => { calls.push("claim"); return { nonce: "unused" }; },
      stopTrackedProxy: async () => { calls.push("stop:standalone"); },
    });
    expect(installed).toBe(true);
    expect(calls).toEqual(["stop:standalone"]);
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
