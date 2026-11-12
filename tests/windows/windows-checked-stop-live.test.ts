/**
 * The live adapters of the checked Windows stop (#7771): parsing of the capped schtasks and
 * sc.exe answers, the ARM64 strict gate on the terminate, the whole-millisecond timeouts, the
 * Part B port sampler and listener identity, and the stopper-ancestry check. Hermetic: no
 * command is spawned and no FFI is loaded.
 */
import { describe, expect, test } from "bun:test";

import {
  classifyScStop,
  classifyTaskEnd,
  identifyWindowsStopListener,
  liveWindowsStopCommandRunner,
  parseScQueryState,
  parseTaskCsvState,
  sampleWindowsStopPort,
  stopperUnderHomeWrapper,
  wholeTimeoutMs,
  windowsStopSnapshot,
  windowsStopTerminate,
  winswStatusFromScState,
  WINDOWS_ARM64_BOUNDED_TERMINATE_ENABLED,
} from "../../src/service/windows-checked-stop-live";
import type { WindowsProcessNativeApi } from "../../src/service/windows-process-native";
import { PATHS, entry, launcher, loop, proxy, supervisedTree } from "../helpers/windows-checked-stop-fixtures";

const result = (status: number | null, stdout = "", stderr = "", timedOut = false) => ({ status, stdout, stderr, timedOut });

describe("ARM64 strict variant (050, 060 'ARM64 decision for PR2')", () => {
  test("ships strict: the bounded PowerShell fallback is disabled", () => {
    expect(WINDOWS_ARM64_BOUNDED_TERMINATE_ENABLED).toBe(false);
  });

  test("without the native primitive the terminate is unavailable and the fallback is never called", async () => {
    let fallbackCalls = 0;
    const terminate = async () => { fallbackCalls++; return { status: "terminated" as const, exited: true }; };
    // ARM64 has no native API; an x64 whose DLL load failed is the same case.
    expect(await windowsStopTerminate(30, 5_100, 3_000, { native: () => null, terminate })).toEqual({ status: "unavailable" });
    expect(fallbackCalls).toBe(0);
  });

  test("with the native primitive the checked terminate runs", async () => {
    const calls: unknown[] = [];
    const native = {} as WindowsProcessNativeApi;
    const terminate = async (pid: number, start: number, options: { timeoutMs: number }) => {
      calls.push([pid, start, options.timeoutMs]);
      return { status: "terminated" as const, exited: true };
    };
    expect(await windowsStopTerminate(30, 5_100, 2_500, { native: () => native, terminate }))
      .toEqual({ status: "terminated", exited: true });
    expect(calls).toEqual([[30, 5_100, 2_500]]);
  });
});

describe("whole-millisecond timeouts (execFile reads 0 as unlimited)", () => {
  test("a fraction is floored and a value below 1 ms spawns nothing", async () => {
    expect(wholeTimeoutMs(1999.9)).toBe(1999);
    expect(wholeTimeoutMs(0.9)).toBeNull();
    expect(wholeTimeoutMs(0)).toBeNull();
    expect(wholeTimeoutMs(-5)).toBeNull();
    // The runner answers a sub-millisecond cap as timed out without resolving any program.
    expect(await liveWindowsStopCommandRunner("sc", ["query", "x"], 0.4)).toEqual(result(null, "", "", true));
    // The snapshot reads nothing (unreadable) rather than running with no timeout.
    expect(await windowsStopSnapshot(0.7)).toBeNull();
  });
});

describe("capped command answers", () => {
  test("schtasks /end", () => {
    expect(classifyTaskEnd(result(0))).toBe("ended");
    expect(classifyTaskEnd(result(1, "", "ERROR: There is no running instance of the task."))).toBe("not-running");
    expect(classifyTaskEnd(result(1, "", "ERROR: Access is denied."))).toBe("denied");
    expect(classifyTaskEnd(result(1, "", "ERROR: something else"))).toBe("failed");
    expect(classifyTaskEnd(result(null, "", "", true))).toBe("failed");
  });

  test("schtasks CSV state reads English values and leaves a localized word unknown", () => {
    expect(parseTaskCsvState('"\\opencodex-proxy","N/A","Running"')).toBe("running");
    expect(parseTaskCsvState('"\\opencodex-proxy","N/A","Ready"')).toBe("not-running");
    expect(parseTaskCsvState('"\\opencodex-proxy","N/A","Wird ausgeführt"')).toBe("unknown");
    expect(parseTaskCsvState('"\\Tools\\opencodex-proxy","N/A","Running"')).toBe("unknown");
  });

  test("sc.exe query and stop", () => {
    expect(parseScQueryState(result(1060, "[SC] EnumQueryServicesStatus:OpenService FAILED 1060:"))).toBe("nonexistent");
    expect(parseScQueryState(result(0, "        STATE              : 4  RUNNING"))).toBe("running");
    expect(parseScQueryState(result(0, "        STATE              : 1  STOPPED"))).toBe("stopped");
    expect(parseScQueryState(result(0, "        STATE              : 3  STOP_PENDING"))).toBe("pending");
    expect(parseScQueryState(result(5, "[SC] OpenService FAILED 5:"))).toBe("unknown");
    expect(winswStatusFromScState("pending")).toBe("started");
    expect(winswStatusFromScState("unknown")).toBe("unknown");
    expect(classifyScStop(result(0))).toBe("sent");
    expect(classifyScStop(result(1062, "[SC] ControlService FAILED 1062:"))).toBe("sent");
    expect(classifyScStop(result(5, "[SC] OpenService FAILED 5:"))).toBe("denied");
    expect(classifyScStop(result(null, "", "", true))).toBe("failed");
  });
});

describe("Part B port sampler and listener identity", () => {
  test("free, listening, unreadable, and an exited owner's row is cleared", () => {
    expect(sampleWindowsStopPort(10100, { scan: () => ({ ok: true, pids: [] }) })).toEqual({ state: "free" });
    expect(sampleWindowsStopPort(10100, { scan: () => ({ ok: false }) })).toEqual({ state: "unknown" });
    expect(sampleWindowsStopPort(10100, { scan: () => ({ ok: true, pids: [77] }), alive: () => true }))
      .toEqual({ state: "listening", ownerPid: 77 });
    const drops: number[] = [];
    expect(sampleWindowsStopPort(10100, { scan: () => ({ ok: true, pids: [77] }), alive: () => false, drop: port => drops.push(port) }))
      .toEqual({ state: "listening", ownerPid: 77 });
    expect(drops).toEqual([10100]);
    // The stopping process's own socket is not a listener on the stopped port.
    expect(sampleWindowsStopPort(10100, { scan: () => ({ ok: true, pids: [5] }), selfPid: 5 })).toEqual({ state: "free" });
  });

  test("ours, foreign, exited, unknown", () => {
    expect(identifyWindowsStopListener(42, { alive: () => true, identity: () => "match" })).toBe("ours");
    expect(identifyWindowsStopListener(42, { alive: () => true, identity: () => "mismatch" })).toBe("foreign");
    // Unreadable is not foreign (#7771): a probe that cannot answer must not let the caller
    // conclude that another program holds the port.
    expect(identifyWindowsStopListener(42, { alive: () => true, identity: () => "unverifiable" })).toBe("unknown");
    expect(identifyWindowsStopListener(42, { alive: () => false, identity: () => "match" })).toBe("exited");
    expect(identifyWindowsStopListener(null)).toBe("unknown");
    // A throwing probe is unreadable too, never foreign.
    expect(identifyWindowsStopListener(42, {
      alive: () => true,
      identity: () => { throw new Error("denied"); },
    })).toBe("unknown");
  });
});

describe("who may run Part A: the stopper's ancestry", () => {
  test("a stopper under this home's wrapper is detected; one under a plain shell is not", () => {
    const tree = supervisedTree();
    // ocx launched as a child of the looping cmd.exe (or of the proxy it supervises).
    expect(stopperUnderHomeWrapper([...tree, entry(70, 30, "ocx.exe", "ocx stop", 6_000)], PATHS, 70)).toBe(true);
    expect(stopperUnderHomeWrapper([...tree, entry(71, 42, "bun.exe", "bun worker", 6_000)], PATHS, 71)).toBe(true);
    // ocx launched from a terminal.
    const shell = [launcher(), loop(), proxy(), entry(60, 1, "pwsh.exe", "pwsh", 100), entry(61, 60, "ocx.exe", "ocx stop", 6_000)];
    expect(stopperUnderHomeWrapper(shell, PATHS, 61)).toBe(false);
  });
});
