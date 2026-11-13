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
  windowsCheckedStopLiveDeps,
  WINDOWS_ARM64_BOUNDED_TERMINATE_ENABLED,
} from "../../src/service/windows-checked-stop-live";
import type { WindowsProcessNativeApi } from "../../src/service/windows-process-native";
import { winswExePath } from "../../src/lib/winsw";
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
  test("free, listening, unreadable, and an exited owner's row is cleared", async () => {
    expect(await sampleWindowsStopPort(10100, 400, { scan: () => ({ ok: true, pids: [] }) })).toEqual({ state: "free" });
    expect(await sampleWindowsStopPort(10100, 400, { scan: () => ({ ok: false }) })).toEqual({ state: "unknown" });
    expect(await sampleWindowsStopPort(10100, 400, { scan: () => ({ ok: true, pids: [77] }), alive: () => true }))
      .toEqual({ state: "listening", ownerPid: 77 });
    const drops: Array<[number, readonly number[]]> = [];
    expect(await sampleWindowsStopPort(10100, 400, { scan: () => ({ ok: true, pids: [77] }), alive: () => false, drop: (port, pids) => drops.push([port, pids]) }))
      .toEqual({ state: "listening", ownerPid: 77 });
    // Only the exited owner's rows may be cleared: a program that took the port between
    // scans owns its own rows, and resetting them would break a connection this stop does
    // not own.
    expect(drops).toEqual([[10100, [77]]]);
    // The stopping process's own socket is not a listener on the stopped port.
    expect(await sampleWindowsStopPort(10100, 400, { scan: () => ({ ok: true, pids: [5] }), selfPid: 5 })).toEqual({ state: "free" });
  });

  test("the sample honors its timeout: an unfinished scan is unknown, never a hung part", async () => {
    const seen: number[] = [];
    const started = Date.now();
    // The scan never answers; the sample must give up on the timeout.
    const sample = await sampleWindowsStopPort(10100, 60, {
      scan: (_port, timeoutMs) => {
        seen.push(timeoutMs);
        return new Promise(() => undefined);
      },
    });
    expect(sample).toEqual({ state: "unknown" });
    expect(seen).toEqual([60]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("a sub-millisecond timeout samples nothing: execFile reads 0 as unlimited", async () => {
    let scans = 0;
    expect(await sampleWindowsStopPort(10100, 0.4, { scan: () => { scans++; return { ok: true, pids: [] }; } }))
      .toEqual({ state: "unknown" });
    expect(await sampleWindowsStopPort(10100, 0, { scan: () => { scans++; return { ok: true, pids: [] }; } }))
      .toEqual({ state: "unknown" });
    expect(scans).toBe(0);
  });

  test("the scan sees a floored whole-millisecond budget", async () => {
    let seen = -1;
    expect(await sampleWindowsStopPort(10100, 499.9, {
      scan: (_port, timeoutMs) => { seen = timeoutMs; return { ok: true, pids: [] }; },
    })).toEqual({ state: "free" });
    expect(seen).toBe(499);
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

describe("WinSW ownership before Part A stops it (#7771 follow-up)", () => {
  // `sc stop opencodex-proxy-native` names a fixed ID. A registration that runs another
  // installation's WinSW executable must never be stopped by this home's Part A.
  const qc = (binaryPathName: string) => result(0, [
    "SERVICE_NAME: opencodex-proxy-native",
    "        TYPE               : 10  WIN32_OWN_PROCESS",
    "        BINARY_PATH_NAME   : " + binaryPathName,
  ].join("\r\n"));

  const probe = (answers: { query: ReturnType<typeof result>; qc?: ReturnType<typeof result> }) =>
    windowsCheckedStopLiveDeps({
      run: async program => {
        if (program !== "sc") throw new Error("unexpected program " + program);
        return answers.query;
      },
      scQcRun: async () => answers.qc ?? result(1),
    }).probeWinsw(2_000);

  test("a service registered against another installation is not this home's manager", async () => {
    const foreign = "C:\\Users\\other\\.opencodex\\winsw\\opencodex-proxy-native.exe";
    expect(await probe({ query: result(0, "        STATE              : 4  RUNNING"), qc: qc(foreign) }))
      .toBe("nonexistent");
  });

  test("this home's registered executable is the manager Part A may stop", async () => {
    expect(await probe({ query: result(0, "        STATE              : 4  RUNNING"), qc: qc(`"${winswExePath()}"`) }))
      .toBe("started");
  });

  test("an unreadable registration fails closed instead of claiming or stopping it", async () => {
    expect(await probe({ query: result(0, "        STATE              : 4  RUNNING"), qc: result(5, "", "Access is denied.") }))
      .toBe("unknown");
    expect(await probe({ query: result(0, "        STATE              : 4  RUNNING") })).toBe("unknown");
  });

  test("the ownership read gets only the time the state query left of one cap", async () => {
    const running = result(0, "        STATE              : 4  RUNNING");
    let qcTimeout = -1;
    const status = await windowsCheckedStopLiveDeps({
      run: async () => { await Bun.sleep(120); return running; },
      scQcRun: async timeoutMs => { qcTimeout = timeoutMs; return qc(`"${winswExePath()}"`); },
    }).probeWinsw(400);
    expect(status).toBe("started");
    expect(qcTimeout).toBeGreaterThan(0);
    expect(qcTimeout).toBeLessThanOrEqual(400 - 100);
    // A state query that spent the whole cap leaves nothing: unknown, and no ownership read.
    let qcCalls = 0;
    const spent = await windowsCheckedStopLiveDeps({
      run: async () => { await Bun.sleep(60); return running; },
      scQcRun: async () => { qcCalls++; return qc(`"${winswExePath()}"`); },
    }).probeWinsw(40);
    expect(spent).toBe("unknown");
    expect(qcCalls).toBe(0);
  });

  test("a service that does not exist needs no ownership read", async () => {
    let qcCalls = 0;
    const status = await windowsCheckedStopLiveDeps({
      run: async () => result(1060, "[SC] EnumQueryServicesStatus:OpenService FAILED 1060:"),
      scQcRun: async () => { qcCalls++; return result(0); },
    }).probeWinsw(2_000);
    expect(status).toBe("nonexistent");
    expect(qcCalls).toBe(0);
  });
});
