/**
 * Caller side of the checked Windows stop (#7771): the real Part A run through the wiring in
 * src/service/windows-service-stop.ts with every machine effect injected. Covers the ARM64
 * strict variant end to end, the own-wrapper refusal, the route's cap, admission against the
 * stop deadline, the deadline flag and variable, the receipt's Part A record and the additive
 * ocx-stop/1 fields. No schtasks, PowerShell or FFI call is made.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { approvalChanged, managerStillActive, parseStopApproval } from "../../src/cli/stop-approval";
import { summarizeStopRun, type StopRunRecord } from "../../src/cli/stop-report";
import { claimPendingTeardown, clearPendingTeardown, pendingTeardownPartA, recordPendingTeardownPartA } from "../../src/config/pending-teardown";
import type { WindowsCheckedStopDeps } from "../../src/service/windows-checked-stop";
import { windowsStopTerminate } from "../../src/service/windows-checked-stop-live";
import type { WindowsProcessWatch } from "../../src/service/windows-process-native";
import {
  runWindowsServiceStopPartA,
  setStopDeadlineMs,
  setWindowsServiceStopHooksForTests,
  UNDER_OWN_WRAPPER_DETAIL,
  windowsPartARecord,
  windowsStopAdmission,
  windowsStopRemainingMs,
  resolveStopDeadlineMs,
  parseStopDeadlineMs,
  serviceStopOutcomeFromWindows,
  windowsStopDeadlineAt,
} from "../../src/service/windows-service-stop";
import { DEFAULT_WINDOWS_STOP_DEADLINE_MS } from "../../src/service/windows-stop-budget";
import { PATHS, SCHEDULE_PID, entry, launcher, loop, supervisedTree } from "../helpers/windows-checked-stop-fixtures";
import { partAResult } from "../helpers/windows-stop-caller-fixtures";

afterEach(() => {
  setWindowsServiceStopHooksForTests(null);
  setStopDeadlineMs(null);
});

interface FakeMachine {
  deps: WindowsCheckedStopDeps;
  calls: string[];
  terminated: number[];
}

/** A registered, running task with the supervised tree; terminate kills through the watch. */
function machine(overrides: Partial<WindowsCheckedStopDeps> & { gate?: () => boolean; extra?: ReturnType<typeof entry>[] } = {}): FakeMachine {
  const calls: string[] = [];
  const terminated: number[] = [];
  const dead = new Set<number>();
  const deps: WindowsCheckedStopDeps = {
    canonicalPaths: PATHS,
    childPid: 42,
    selfPid: 1,
    probeScheduler: () => ({ status: "present" }),
    probeWinsw: () => "nonexistent",
    enumerate: () => { calls.push("enumerate"); return [...supervisedTree(), ...(overrides.extra ?? [])]; },
    scheduleServicePid: () => SCHEDULE_PID,
    endTask: () => { calls.push("end"); return overrides.gate && !overrides.gate() ? "failed" : "ended"; },
    taskState: () => "not-running",
    winswStop: () => "sent",
    winswState: () => "stopped",
    proxyAlive: () => false,
    openWatch: (pid): WindowsProcessWatch => ({ status: "open", exited: () => dead.has(pid), close() {} }),
    terminate: (pid) => { calls.push("terminate:" + pid); terminated.push(pid); dead.add(pid); return { status: "terminated", exited: true }; },
    ...overrides,
  };
  return { deps, calls, terminated };
}

describe("Part A through the caller wiring", () => {
  test("WinSW registered and stopped still checks the caller's wrapper ancestry", async () => {
    const under = entry(70, 30, "ocx.exe", "ocx stop", 6_000);
    const fake = machine({ selfPid: 70, probeScheduler: () => ({ status: "absent" }),
      probeWinsw: () => "stopped", extra: [under] });
    setWindowsServiceStopHooksForTests({ liveDeps: () => fake.deps });
    const result = await runWindowsServiceStopPartA();
    expect(result.outcome).toBe("unknown");
    expect(result.detail).toBe(UNDER_OWN_WRAPPER_DETAIL);
    expect(result.changed).toBe(false);
  });
  test("ends the bound wrappers with the live-style deps", async () => {
    const fake = machine();
    setWindowsServiceStopHooksForTests({ liveDeps: () => fake.deps });
    const result = await runWindowsServiceStopPartA();
    expect(result.outcome).toBe("stopped");
    expect(fake.terminated).toEqual([30, 20]);
  });

  test("ARM64 strict: nothing is terminated and the stop is unknown / evidence-unreadable", async () => {
    let fallback = 0;
    const fake = machine({
      // No native API: no exit watch, and the strict gate answers the terminate.
      openWatch: () => ({ status: "unavailable" }),
      terminate: (pid, start, timeoutMs) => windowsStopTerminate(pid, start, timeoutMs, {
        native: () => null,
        terminate: async () => { fallback++; return { status: "terminated", exited: true }; },
      }),
    });
    setWindowsServiceStopHooksForTests({ liveDeps: () => fake.deps });
    const result = await runWindowsServiceStopPartA();
    expect(result.outcome).toBe("unknown");
    expect(result.reason).toBe("evidence-unreadable");
    expect(result.terminated).toEqual([]);
    expect(fallback).toBe(0);
  });

  test("a stop launched under this home's wrapper refuses before /end, unless the caller is the wrapped proxy", async () => {
    const under = entry(70, 30, "ocx.exe", "ocx stop", 6_000);
    const refused = machine({ selfPid: 70, extra: [under] });
    setWindowsServiceStopHooksForTests({ liveDeps: () => refused.deps });
    const result = await runWindowsServiceStopPartA();
    expect(result.outcome).toBe("unknown");
    expect(result.detail).toBe(UNDER_OWN_WRAPPER_DETAIL);
    expect(refused.calls).toEqual(["enumerate"]);

    // The guarded path binds on the snapshot it already read: refused before any probe.
    const guarded = await runWindowsServiceStopPartA({ bindSnapshot: [...supervisedTree(), under] });
    expect(guarded.detail).toBe(UNDER_OWN_WRAPPER_DETAIL);
    expect(refused.calls).toEqual(["enumerate"]);

    const allowed = machine({ selfPid: 70, extra: [under] });
    setWindowsServiceStopHooksForTests({ liveDeps: () => allowed.deps });
    expect((await runWindowsServiceStopPartA({ allowUnderOwnWrapper: true })).outcome).toBe("stopped");
    expect(allowed.calls).toContain("end");
  });

  test("under this home's wrapper with nothing registered: unknown, never absent, and nothing is ended", async () => {
    // self 70 (ocx stop) <- cmd 30 (.cmd of this home) <- wscript 20 (.vbs of this home), with
    // no task and no WinSW service. The own-wrapper guard makes the enumeration unreadable, and
    // the stray path would otherwise read that as absent: no service registered, nothing to do.
    const tree = () => [launcher(), loop(), entry(70, 30, "ocx.exe", "ocx stop", 6_000)];
    const calls: string[] = [];
    const refused = machine({
      selfPid: 70,
      probeScheduler: () => ({ status: "absent" }),
      enumerate: () => { calls.push("enumerate"); return tree(); },
    });
    setWindowsServiceStopHooksForTests({ liveDeps: () => refused.deps });
    const result = await runWindowsServiceStopPartA();
    expect(result.outcome).toBe("unknown");
    expect(result.reason).toBe("evidence-unreadable");
    expect(result.detail).toBe(UNDER_OWN_WRAPPER_DETAIL);
    expect(result.changed).toBe(false);
    expect(result.terminated).toEqual([]);
    expect(calls).toEqual(["enumerate"]);
    expect(serviceStopOutcomeFromWindows(result)).toBe("state-unknown");
    expect(windowsPartARecord(result)).toBeNull();

    // The same machine where the refusal is allowed (the route and the updater) still sweeps.
    const allowed = machine({ selfPid: 70, probeScheduler: () => ({ status: "absent" }), enumerate: tree });
    setWindowsServiceStopHooksForTests({ liveDeps: () => allowed.deps });
    expect((await runWindowsServiceStopPartA({ allowUnderOwnWrapper: true })).outcome).not.toBe("unknown");
  });

  test("a cap overrun is unknown at once, and nothing is ended or terminated after it", async () => {
    let gate: () => boolean = () => true;
    const fake = machine({
      endTask: async () => {
        await Bun.sleep(120);
        return gate() ? "ended" : "failed";
      },
    });
    setWindowsServiceStopHooksForTests({ liveDeps: options => { gate = options.gate ?? gate; return fake.deps; } });
    const started = performance.now();
    const result = await runWindowsServiceStopPartA({ capMs: 40 });
    expect(performance.now() - started).toBeLessThan(110);
    expect(result.outcome).toBe("unknown");
    expect(result.detail).toBe("the checked stop did not finish within its cap");
    await Bun.sleep(250);
    expect(gate()).toBe(false);
    expect(fake.terminated).toEqual([]);
  });

  test("admission refuses with unverified-budget and changes nothing when the deadline cannot hold the stop", async () => {
    const fake = machine();
    setWindowsServiceStopHooksForTests({ liveDeps: () => fake.deps });
    setStopDeadlineMs(Math.ceil(performance.now()) + 20_000);
    const result = await runWindowsServiceStopPartA({ admission: windowsStopAdmission({ orphanDiscovery: true }) });
    expect(result.outcome).toBe("unverified-budget");
    expect(result.reason).toBe("unverified-budget");
    expect(result.budget?.requiredMs).toBe(56_500);
    expect(fake.calls.filter(call => call === "end" || call.startsWith("terminate"))).toEqual([]);
    // The same stop with the default 60 s from process start is admitted early in a process.
    setStopDeadlineMs(Math.ceil(performance.now()) + 60_000);
    expect((await runWindowsServiceStopPartA({ admission: windowsStopAdmission({ orphanDiscovery: true }) })).outcome).toBe("stopped");
  });
});

describe("the stop deadline", () => {
  test("--deadline-ms wins over OCX_STOP_DEADLINE_MS; empty or invalid is absent; neither is 60 s", () => {
    expect(resolveStopDeadlineMs(72_000, { OCX_STOP_DEADLINE_MS: "30000" })).toBe(72_000);
    expect(resolveStopDeadlineMs(null, { OCX_STOP_DEADLINE_MS: "30000" })).toBe(30_000);
    expect(resolveStopDeadlineMs(null, { OCX_STOP_DEADLINE_MS: "" })).toBe(DEFAULT_WINDOWS_STOP_DEADLINE_MS);
    expect(resolveStopDeadlineMs(null, { OCX_STOP_DEADLINE_MS: "-5" })).toBe(60_000);
    expect(resolveStopDeadlineMs(null, { OCX_STOP_DEADLINE_MS: "12.5" })).toBe(60_000);
    expect(resolveStopDeadlineMs(null, {})).toBe(60_000);
    expect(parseStopDeadlineMs(" 45000 ")).toBe(45_000);
    expect(parseStopDeadlineMs("0")).toBeNull();
  });

  test("ocx stop's deadline is the command-start clock value it recorded", () => {
    setStopDeadlineMs(72_000);
    expect(windowsStopDeadlineAt(0)).toBe(72_000);
    expect(windowsStopDeadlineAt(42_000)).toBe(72_000);
    // Command start, not stop phase: 30 s of the budget are already spent at t=30_000.
    expect(windowsStopRemainingMs(() => 30_000)).toBe(42_000);
  });

  test("every other caller starts its 60 s when the stop begins, not when the process did", () => {
    // installFreshWindowsSchedulerSafely reaches the stop only after registration and the UAC
    // prompt, so by then this process can be minutes old. Measuring from process start made
    // admission refuse `unverified-budget` for a stop that had its whole budget left.
    setStopDeadlineMs(null);
    const phaseStart = 600_000;
    expect(windowsStopRemainingMs(() => phaseStart)).toBe(DEFAULT_WINDOWS_STOP_DEADLINE_MS);
    // One deadline governs the whole stop: a later read inside it does not slide forward.
    expect(windowsStopDeadlineAt(phaseStart + 20_000)).toBe(phaseStart + DEFAULT_WINDOWS_STOP_DEADLINE_MS);
    expect(windowsStopRemainingMs(() => phaseStart + 20_000)).toBe(DEFAULT_WINDOWS_STOP_DEADLINE_MS - 20_000);
  });

  test("recording a new command deadline clears an armed stop phase", () => {
    setStopDeadlineMs(null);
    expect(windowsStopRemainingMs(() => 5_000)).toBe(DEFAULT_WINDOWS_STOP_DEADLINE_MS);
    setStopDeadlineMs(9_000);
    expect(windowsStopDeadlineAt(5_000)).toBe(9_000);
    // And un-setting it again re-arms at the next stop phase rather than keeping 9_000.
    setStopDeadlineMs(null);
    expect(windowsStopRemainingMs(() => 5_000)).toBe(DEFAULT_WINDOWS_STOP_DEADLINE_MS);
  });

  test("ocx stop parses --deadline-ms anywhere and keeps the approval grammar", () => {
    expect(parseStopApproval(["--deadline-ms", "72000"])).toEqual({ ok: true, json: false, approval: null, deadlineMs: 72_000 });
    expect(parseStopApproval(["--json", "--deadline-ms", "5000"])).toEqual({ ok: true, json: true, approval: null, deadlineMs: 5_000 });
    expect(parseStopApproval(["--json"])).toEqual({ ok: true, json: true, approval: null, deadlineMs: null });
    for (const bad of [["--deadline-ms"], ["--deadline-ms", "0"], ["--deadline-ms", "1e4"], ["--deadline-ms", "-1"],
      ["--deadline-ms", "5", "--deadline-ms", "6"], ["--json", "--deadline-ms", "abc"]]) {
      expect(parseStopApproval(bad).ok).toBe(false);
    }
    const token = "a".repeat(64);
    const approval = ["--json", "--expect-pid", "42", "--expect-port", "10100", "--expect-hostname", "127.0.0.1",
      "--expect-config-home", "/h", "--expect-cli-version", "2.0.0", "--expect-compatibility-token", token];
    const parsed = parseStopApproval([...approval.slice(0, 3), "--deadline-ms", "65000", ...approval.slice(3)]);
    expect(parsed.ok && parsed.approval?.pid === 42 && parsed.deadlineMs === 65_000).toBe(true);
  });
});

describe("the receipt's Part A record", () => {
  test("only stopped or absent produce a record, with the bound wrapper set", () => {
    expect(windowsPartARecord(partAResult("stopped"))).toEqual({
      partA: "stopped", manager: { scheduler: true, winsw: false }, wrappers: [{ pid: 30, startTime: 5_100 }],
    });
    expect(windowsPartARecord(partAResult("absent"))).toEqual({ partA: "absent", manager: { scheduler: false, winsw: false }, wrappers: [] });
    for (const outcome of ["survived", "denied", "unknown", "unverified-budget"] as const) {
      expect(windowsPartARecord(partAResult(outcome))).toBeNull();
    }
  });

  test("written at claim, or added by the owner afterwards; read back only when well formed", () => {
    const endpoint = { hostname: "127.0.0.1", port: 10100 };
    const record = windowsPartARecord(partAResult("stopped"))!;
    const atClaim = claimPendingTeardown(endpoint, "exact", process.pid, undefined, record);
    expect(pendingTeardownPartA(atClaim.nonce)).toEqual(record);
    const before = claimPendingTeardown(endpoint, "exact", process.pid);
    expect(pendingTeardownPartA(before.nonce)).toBeNull();
    expect(recordPendingTeardownPartA(before.nonce, record, process.pid + 1)).toBe(false);
    expect(recordPendingTeardownPartA(before.nonce, record)).toBe(true);
    expect(pendingTeardownPartA(before.nonce)).toEqual(record);
    const malformed = claimPendingTeardown(endpoint, "exact", process.pid, undefined, { partA: "stopped" } as never);
    expect(pendingTeardownPartA(malformed.nonce)).toBeNull();
    for (const nonce of [atClaim.nonce, before.nonce, malformed.nonce]) clearPendingTeardown(nonce);
  });
});

describe("ocx-stop/1 additive fields", () => {
  const record = (extra: Partial<StopRunRecord>): StopRunRecord => ({
    service: "failed", proxy: "unknown", sharedTeardown: "skipped", inheritedTeardownBlocks: false, receiptClearFailed: false, ...extra,
  });
  const signals = { failed: true, historyOnly: false, historyDeferred: false, exitCode: 1 };

  test("serviceStopReason and portHeldByForeign are omitted until set, and never null", () => {
    const plain = summarizeStopRun(record({}), signals);
    expect("serviceStopReason" in plain).toBe(false);
    expect("portHeldByForeign" in plain).toBe(false);
    const denied = summarizeStopRun(record({ serviceStopReason: "access-denied" }), signals);
    expect(denied).toMatchObject({ outcome: "failed", service: "failed", proxy: "unknown", sharedTeardown: "skipped", serviceStopReason: "access-denied" });
    const foreign = summarizeStopRun(record({ service: "stopped", proxy: "stopped", portHeldByForeign: true }),
      { failed: false, historyOnly: false, historyDeferred: false, exitCode: 0 });
    expect(foreign).toMatchObject({ outcome: "stopped", service: "stopped", portHeldByForeign: true });
    expect(summarizeStopRun(record({ portHeldByForeign: false }), signals).portHeldByForeign).toBe(false);
  });

  test("the guarded refusals carry them; no new outcome or proxy value appears", () => {
    expect(managerStillActive("failed", record({ serviceStopReason: "unverified-budget" })).summary)
      .toMatchObject({ outcome: "manager-still-active", serviceStopReason: "unverified-budget" });
    expect(approvalChanged("x", "unbound-wrapper").summary).toMatchObject({ outcome: "approval-changed", serviceStopReason: "unbound-wrapper" });
    expect("serviceStopReason" in approvalChanged("x").summary).toBe(false);
  });
});
