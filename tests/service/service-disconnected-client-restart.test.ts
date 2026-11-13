import { expect, spyOn, test } from "bun:test";
import { repairService } from "../../src/service/repair";
import type { ServiceDiagnostic } from "../../src/service/diagnostics";
import { prepareDisconnectedClientServiceRestart } from "../../src/service/disconnected-client-restart";
import * as processState from "../../src/config/process-state";

const installed: ServiceDiagnostic = {
  supported: true, installed: true, enabled: true, running: true, viable: true,
  startable: true, stale: false, conflict: false, backend: "launchd", summary: "fixture",
};

test("explicit service restart settles a disconnected client before starting its replacement", async () => {
  const calls: string[] = [];
  const deps = {
    platform: "darwin" as const, verb: "restart" as const,
    inspectSupervision: () => ({ kind: "none" as const }),
    diagnose: () => installed, readOwnership: () => ({ kind: "none" as const, revision: 0 }),
    assertEnv: () => {}, assertAuth: () => {},
    selectRuntime: () => ({ bunPath: process.execPath, source: "fixture" } as never),
    assertRuntimeWritable: () => {}, launcherPathDiagnostic: () => null,
    prepareDisconnectedClientRestart: async () => { calls.push("settle-client"); },
    repairLaunchd: () => { calls.push("start-standalone"); return { reloaded: true }; },
  };
  await repairService(deps);
  expect(calls).toEqual(["settle-client", "start-standalone"]);
});

test("a Desktop ownership refusal precedes disconnected-client cleanup", async () => {
  let touched = false;
  const deps = {
    platform: "darwin" as const, verb: "restart" as const,
    inspectSupervision: () => ({ kind: "none" as const }), diagnose: () => installed,
    readOwnership: () => ({ kind: "owned" as const, revision: 1,
      ownership: { owner: "desktop" as const, installId: "fixture", consentGeneration: 1 } }),
    prepareDisconnectedClientRestart: async () => { touched = true; },
  };
  await expect(repairService(deps)).rejects.toThrow("desktop app owns the runtime");
  expect(touched).toBe(false);
});

test("a surviving detached client exits before standalone can start", async () => {
  const calls: string[] = [];
  let running = true;
  await prepareDisconnectedClientServiceRestart({
    disconnected: () => true, findLive: async () => ({ pid: 42, role: "client" }),
    verify: pid => pid, alive: () => running,
    beforeStop: () => { calls.push("verify-owner"); },
    stopManager: () => { calls.push("stop-manager"); },
    stop: async pid => { expect(pid).toBe(42); calls.push("stop-client"); running = false; },
  });
  expect(calls).toEqual(["verify-owner", "stop-manager", "verify-owner", "stop-client"]);
  expect(running).toBe(false);
});

test.each(["connected", "standalone", "foreign", "pending"])("%s runtime is never killed and the restart goes ahead as before", async mode => {
  const calls: string[] = [];
  const invoke = () => prepareDisconnectedClientServiceRestart({
    disconnected: () => {
      if (mode === "pending") throw new Error("client_disconnect_pending");
      return mode !== "connected";
    },
    findLive: async () => ({ pid: 42, role: mode === "standalone" ? "standalone" : "client" }),
    // The connected and standalone cases must prove the early exclusions are what stop the cleanup:
    // verification has to succeed there, or either check could be removed without failing. A
    // foreign runtime is the case identity verification is supposed to reject.
    verify: () => mode === "foreign" ? null : 42, alive: () => true,
    stopManager: () => { calls.push("manager"); }, stop: async () => { calls.push("kill"); },
  });
  // A proxy this home cannot prove is its own, and an interrupted disconnect, are not this
  // cleanup's case: it touches nothing and lets the restart proceed as it did before.
  await invoke();
  expect(calls).toEqual([]);
});

test("a reconnected client after the manager stop is preserved", async () => {
  let disconnected = true, killed = false;
  await expect(prepareDisconnectedClientServiceRestart({
    disconnected: () => disconnected, findLive: async () => ({ pid: 42, role: "client" }),
    verify: pid => pid, alive: () => true,
    stopManager: () => { disconnected = false; }, stop: async () => { killed = true; },
  })).rejects.toThrow("Client connection changed");
  expect(killed).toBe(false);
});

test("a stop that leaves the client alive refuses a replacement", async () => {
  await expect(prepareDisconnectedClientServiceRestart({
    disconnected: () => true, findLive: async () => ({ pid: 42, role: "client" }),
    verify: pid => pid, alive: () => true, stopManager: () => {}, stop: async () => {},
  })).rejects.toThrow("did not exit");
});

test("default identity verification leaves a PID absent from this home's runtime record alone", async () => {
  let touched = false;
  const read = spyOn(processState, "readRuntimePort").mockReturnValue(null);
  try {
    await prepareDisconnectedClientServiceRestart({
      disconnected: () => true, findLive: async () => ({ pid: 42, role: "client" }),
      alive: () => true, stopManager: () => { touched = true; }, stop: async () => { touched = true; },
    });
    expect(read).toHaveBeenCalledWith();
    expect(touched).toBe(false);
  } finally { read.mockRestore(); }
});

test.each([true, false])("runtime record deletion independently verifies the surviving PID (verified: %s)", async verified => {
  let record = true, running = true;
  const calls: string[] = [];
  const read = spyOn(processState, "readRuntimePort").mockImplementation(() => record ? { pid: 42, port: 10100 } : null);
  const identity = spyOn(processState, "verifyPidIdentity").mockImplementation(pid => {
    calls.push(`verify-${record ? "before" : "after"}`);
    return record || verified ? pid : null;
  });
  try {
    const invoke = () => prepareDisconnectedClientServiceRestart({
      disconnected: () => true, findLive: async () => ({ pid: 42, role: "client" }),
      alive: () => running, stopManager: () => { record = false; calls.push("manager"); },
      stop: async () => { calls.push("stop-pid"); running = false; },
    });
    if (verified) {
      await invoke();
      expect(calls).toEqual(["verify-before", "manager", "verify-after", "stop-pid"]);
    } else {
      await expect(invoke()).rejects.toThrow("ownership is unverified");
      expect(calls).toEqual(["verify-before", "manager", "verify-after"]);
    }
  } finally { read.mockRestore(); identity.mockRestore(); }
});

test("a changed runtime record preserves the surviving PID", async () => {
  let record = 42, stopped = false;
  const read = spyOn(processState, "readRuntimePort").mockImplementation(() => ({ pid: record, port: 10100 }));
  const identity = spyOn(processState, "verifyPidIdentity").mockImplementation(pid => pid);
  try {
    await expect(prepareDisconnectedClientServiceRestart({
      disconnected: () => true, findLive: async () => ({ pid: 42, role: "client" }), alive: () => true,
      stopManager: () => { record = 99; }, stop: async () => { stopped = true; },
    })).rejects.toThrow("ownership is unverified");
    expect(stopped).toBe(false);
  } finally { read.mockRestore(); identity.mockRestore(); }
});
