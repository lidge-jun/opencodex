import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopStopNotice, duplicateRuntimeMessage } from "../../src/cli/desktop-runtime-guidance";
import { deriveStartupHealth } from "../../src/codex/autostart-health";
import { assertNoDesktopSupervision, desktopServiceCommandRefusal } from "../../src/service/desktop-command-guard";
import { desktopStartupOwnership, diagnoseDesktopStartup, diagnoseWindowsDesktopStartup } from "../../src/service/desktop-startup";
import {
  createSupervisionLatch, inspectDesktopSupervision, windowsPowerShellPath, windowsProcessPair,
  windowsSystemDirectoryFromSharedObjects,
  type DesktopSupervisionDeps, type WindowsProcessRow,
} from "../../src/service/desktop-supervision.mjs";
import type { ServiceOwnershipResolution } from "../../src/service/state";
import { planUpdateRuntimeHandling } from "../../src/update/runtime-ownership.mjs";

// Every Windows fact is injected, so these cases run on any host (#6853).
const APP = "C:\\Program Files\\OpenCodex\\opencodex-desktop.exe";
const PROXY = "C:\\Program Files\\OpenCodex\\ocx.exe";
const DESKTOP = { kind: "desktop", runtimePid: 100, supervisorPid: 200, app: APP, proxy: PROXY };

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const state = {
    child: { pid: 100, parent: 200, exe: PROXY, session: 1, created: "638950000000000002" } as WindowsProcessRow | null,
    parent: { pid: 200, parent: 4, exe: APP, session: 1, created: "638950000000000001" } as WindowsProcessRow | null,
    pidFile: 100 as number | null, portPid: 100 as number | null,
    reads: 0, timeouts: [] as number[], secondChild: null as Partial<WindowsProcessRow> | null,
    clock: 0, readCostMs: 0,
  };
  const deps = {
    platform: "win32" as const,
    readPid: () => state.pidFile,
    readRuntimePortPid: () => state.portPid,
    now: () => state.clock,
    windowsProcesses: (pid: number, options: { onExecutable?: (path: string) => void; timeoutMs?: number }) => {
      state.reads++;
      state.timeouts.push(options.timeoutMs ?? -1);
      state.clock += state.readCostMs;
      expect(pid).toBe(100);
      if (typeof state.parent?.exe === "string") options.onExecutable?.(state.parent.exe);
      const child = state.child && state.reads > 1 && state.secondChild ? { ...state.child, ...state.secondChild } : state.child;
      return { child: child && { ...child }, parent: state.parent && { ...state.parent } };
    },
  } satisfies DesktopSupervisionDeps;
  return { state, deps };
}

test("matching runtime records, sibling ocx.exe, one session and an older parent prove Desktop", () => {
  const f = fixture();
  expect(inspectDesktopSupervision(f.deps)).toEqual(DESKTOP);
  expect(f.state.reads).toBe(2);
  expect(f.state.timeouts.every(timeout => timeout > 0 && timeout <= 3_000)).toBe(true);
  // Windows paths compare case-insensitively and accept forward slashes.
  f.state.child = { ...f.state.child!, exe: "c:/program files/opencodex/OCX.EXE" };
  expect(inspectDesktopSupervision(f.deps)).toMatchObject({ kind: "desktop", runtimePid: 100, supervisorPid: 200 });
});

test("a readable parent that is not Desktop is positive none and clears a latch", () => {
  const f = fixture();
  f.state.parent = { ...f.state.parent!, exe: "C:\\Windows\\explorer.exe" };
  const evidence = inspectDesktopSupervision(f.deps);
  expect(evidence).toEqual({ kind: "none" });
  const latch = createSupervisionLatch();
  latch.observe({ ...DESKTOP, kind: "desktop" });
  expect(latch.observe(evidence)).toBe(false);
});

test("a non-Desktop process holding a reused parent PID is not positive none", () => {
  for (const created of ["638950000000000002", "638950000000000009"]) {
    const f = fixture();
    f.state.parent = { ...f.state.parent!, exe: "C:\\Windows\\explorer.exe", created };
    const evidence = inspectDesktopSupervision(f.deps);
    expect(evidence).toEqual({ kind: "unknown", reason: "creation-order", desktopSeen: false });
    const latch = createSupervisionLatch();
    latch.observe({ ...DESKTOP, kind: "desktop" });
    expect(latch.observe(evidence)).toBe(true);
  }
});

test("a Desktop parent with the wrong sibling, session or creation order stays unknown and keeps its veto", () => {
  const cases: [Partial<WindowsProcessRow>, Partial<WindowsProcessRow>, string][] = [
    [{ exe: "C:\\Users\\me\\AppData\\Roaming\\npm\\ocx.exe" }, {}, "proxy-mismatch"],
    [{ exe: "C:\\Program Files\\OpenCodex\\bin\\ocx.exe" }, {}, "proxy-mismatch"],
    [{ session: 2 }, {}, "session-mismatch"],
    [{ created: "638950000000000001" }, {}, "creation-order"],
    [{ created: "638950000000000000" }, {}, "creation-order"],
    // Ticks beyond 2^53 still compare exactly.
    [{ created: "9007199254740993" }, { created: "9007199254740993" }, "creation-order"],
  ];
  for (const [child, parent, reason] of cases) {
    const f = fixture();
    f.state.child = { ...f.state.child!, ...child };
    f.state.parent = { ...f.state.parent!, ...parent };
    const evidence = inspectDesktopSupervision(f.deps);
    expect(evidence).toEqual({ kind: "unknown", reason, desktopSeen: true });
    expect(createSupervisionLatch().observe(evidence)).toBe(true);
  }
});

test("both runtime records must name the runtime; missing processes are not proven absence", () => {
  for (const [pidFile, portPid, reason] of [[null, 100, "pid-record-missing"], [100, null, "pid-record-missing"], [100, 101, "pid-mismatch"]] as const) {
    const f = fixture();
    f.state.pidFile = pidFile; f.state.portPid = portPid;
    expect(inspectDesktopSupervision(f.deps)).toEqual({ kind: "unknown", reason, desktopSeen: false });
  }
  const absent = fixture(); absent.state.pidFile = null; absent.state.portPid = null;
  const missing = inspectDesktopSupervision(absent.deps);
  expect(missing).toEqual({ kind: "unknown", reason: "pid-record-missing", desktopSeen: false });
  expect(absent.state.reads).toBe(0);
  // Records vanishing while Desktop runs must not clear an earlier veto.
  const latch = createSupervisionLatch();
  latch.observe({ ...DESKTOP, kind: "desktop" });
  expect(latch.observe(missing)).toBe(true);
  const target = fixture();
  expect(inspectDesktopSupervision({ ...target.deps, targetPid: 101 })).toEqual({ kind: "unknown", reason: "pid-mismatch", desktopSeen: false });
  const missingChild = fixture(); missingChild.state.child = null;
  expect(inspectDesktopSupervision(missingChild.deps)).toMatchObject({ kind: "unknown", reason: "process-missing" });
  const missingParent = fixture(); missingParent.state.parent = null;
  expect(inspectDesktopSupervision(missingParent.deps)).toEqual({ kind: "unknown", reason: "parent-missing", desktopSeen: false });
  const wrongParent = fixture(); wrongParent.state.parent = { ...wrongParent.state.parent!, pid: 201 };
  expect(inspectDesktopSupervision(wrongParent.deps)).toEqual({ kind: "unknown", reason: "probe-failed", desktopSeen: true });
});

test("only drive-absolute images are evidence: relative, UNC, device and rooted forms prove nothing", () => {
  const unqualified = [
    "opencodex-desktop.exe", "OpenCodex\\opencodex-desktop.exe", "C:opencodex-desktop.exe",
    "\\OpenCodex\\opencodex-desktop.exe", "\\\\server\\share\\opencodex-desktop.exe",
    "\\\\?\\C:\\OpenCodex\\opencodex-desktop.exe", "\\\\.\\C:\\OpenCodex\\opencodex-desktop.exe",
  ];
  for (const exe of unqualified) {
    const f = fixture();
    f.state.parent = { ...f.state.parent!, exe };
    f.state.child = { ...f.state.child!, exe: exe.replace("opencodex-desktop.exe", "ocx.exe") };
    expect(inspectDesktopSupervision(f.deps)).toEqual({ kind: "unknown", reason: "image-unqualified", desktopSeen: true });
  }
  for (const exe of ["", null, "explorer.exe"]) {
    const f = fixture();
    f.state.parent = { ...f.state.parent!, exe };
    // Never positive none from an unproven image.
    expect(inspectDesktopSupervision(f.deps)).toEqual({ kind: "unknown", reason: "image-unqualified", desktopSeen: false });
  }
  const child = fixture(); child.state.child = { ...child.state.child!, exe: null };
  expect(inspectDesktopSupervision(child.deps)).toEqual({ kind: "unknown", reason: "image-unqualified", desktopSeen: true });
});

test("a changed second snapshot and a thrown reader stay unknown", () => {
  const changed = fixture(); changed.state.secondChild = { created: "638950000000000003" };
  expect(inspectDesktopSupervision(changed.deps)).toEqual({ kind: "unknown", reason: "snapshot-changed", desktopSeen: true });
  const thrown = fixture();
  expect(inspectDesktopSupervision({ ...thrown.deps, windowsProcesses: () => { throw new Error("C:\\Users\\secret"); } }))
    .toEqual({ kind: "unknown", reason: "probe-failed", desktopSeen: false });
});

test("one inspection shares a 6 s budget: slow successful reads pass, an exhausted budget is unknown", () => {
  const slow = fixture(); slow.state.readCostMs = 2_500;
  expect(inspectDesktopSupervision(slow.deps)).toEqual(DESKTOP);
  expect(slow.state.timeouts).toEqual([3_000, 3_000]);
  const tight = fixture(); tight.state.readCostMs = 4_500;
  // 1.5 s remain: the second read is bounded by the budget rather than the per-read cap.
  expect(inspectDesktopSupervision(tight.deps)).toEqual(DESKTOP);
  expect(tight.state.timeouts).toEqual([3_000, 1_500]);
  const exhausted = fixture(); exhausted.state.readCostMs = 5_900;
  expect(inspectDesktopSupervision(exhausted.deps)).toEqual({ kind: "unknown", reason: "probe-timeout", desktopSeen: true });
  expect(exhausted.state.reads).toBe(1);
});

test("the default reader uses a trusted system directory, disables autoloading and sanitizes its environment", () => {
  const calls: { command: string; args: string[]; timeout?: number; env?: NodeJS.ProcessEnv }[] = [];
  const output = JSON.stringify({
    child: { pid: "100", parent: "200", exe: PROXY, session: "1", created: "638950000000000002" },
    parent: { pid: "200", parent: "4", exe: APP, session: "1", created: "638950000000000001" },
  });
  const run = (command: string, args: string[], timeout?: number, env?: NodeJS.ProcessEnv) => {
    calls.push({ command, args, timeout, env }); return output;
  };
  expect(windowsProcessPair(100, run, { resolveSystemDirectory: () => "D:\\Win\\System32", timeoutMs: 1_234 })).toEqual({
    child: { pid: 100, parent: 200, exe: PROXY, session: 1, created: "638950000000000002" },
    parent: { pid: 200, parent: 4, exe: APP, session: 1, created: "638950000000000001" },
  });
  expect(calls[0]!.command).toBe("D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  expect(calls[0]!.args.slice(0, 4)).toEqual(["-NoProfile", "-NoLogo", "-NonInteractive", "-Command"]);
  expect(calls[0]!.args[4]).toContain("-Filter 'ProcessId=100'");
  expect(calls[0]!.args[4]).toContain("$PSModuleAutoLoadingPreference='None'");
  // Utility must load before CimCmdlets: CimCmdlets' own import calls Set-Alias and autoload is off.
  expect(calls[0]!.args[4]!.indexOf("Microsoft.PowerShell.Utility.psd1"))
    .toBeLessThan(calls[0]!.args[4]!.indexOf("CimCmdlets.psd1"));
  expect(calls[0]!.args[4]).toContain("CimCmdlets\\Get-CimInstance");
  expect(calls[0]!.env).toEqual({
    SystemRoot: "D:\\Win", WINDIR: "D:\\Win", PATH: "D:\\Win\\System32", PATHEXT: ".COM;.EXE;.BAT;.CMD",
  });
  expect(calls[0]!.timeout).toBe(1_234);
  expect(windowsPowerShellPath(() => "C:\\Windows\\System32"))
    .toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  for (const pid of [0, -1, 1.5, Number.NaN]) expect(() => windowsProcessPair(pid, run)).toThrow("invalid pid");
  expect(calls).toHaveLength(1);
});

test("through the default reader, a Desktop image with malformed evidence keeps desktopSeen; unreadable output does not", () => {
  const base = { platform: "win32" as const, readPid: () => 100, readRuntimePortPid: () => 100,
    resolveWindowsSystemDirectory: () => "C:\\Windows\\System32" };
  const malformed = JSON.stringify({
    child: { pid: "100", parent: "200", exe: PROXY, session: "1", created: "638950000000000002" },
    parent: { pid: "200", parent: "4", exe: APP, session: "1", created: "not-ticks" },
  });
  const evidence = inspectDesktopSupervision({ ...base, run: () => malformed });
  expect(evidence).toEqual({ kind: "unknown", reason: "probe-failed", desktopSeen: true });
  expect(createSupervisionLatch().observe(evidence)).toBe(true);
  expect(planUpdateRuntimeHandling({ ownership: null, serviceInstalled: false, supervision: evidence }).mayReplacePackage).toBe(false);
  expect(inspectDesktopSupervision({ ...base, run: () => "not json" })).toEqual({ kind: "unknown", reason: "probe-failed", desktopSeen: false });
});

test("service, start, stop and update consumers apply Desktop evidence on Windows", () => {
  const f = fixture();
  const inspect = (deps?: DesktopSupervisionDeps) => inspectDesktopSupervision({ ...f.deps, ...deps });
  for (const command of ["install", "repair", "start", "restart"]) {
    expect(desktopServiceCommandRefusal(command, inspect)).toContain(`OpenCodex Desktop supervises the running proxy (pid 100, ${APP})`);
  }
  expect(desktopServiceCommandRefusal("status", inspect)).toBeNull();
  expect(() => assertNoDesktopSupervision(inspect)).toThrow("OpenCodex Desktop supervises the running proxy");
  expect(duplicateRuntimeMessage(100, 10100, inspect)).toContain(`OpenCodex Desktop supervises the running proxy (pid 100, ${APP}, port 10100)`);
  expect(desktopStopNotice(inspect())).toContain("OpenCodex Desktop may start this proxy again");
  const plan = planUpdateRuntimeHandling({ ownership: null, serviceInstalled: false, supervision: inspect() });
  expect(plan).toMatchObject({ mayReplacePackage: false, mayStopRuntime: false, mayRestoreService: false });
  f.state.parent = { ...f.state.parent!, exe: "C:\\Windows\\explorer.exe" };
  expect(desktopServiceCommandRefusal("install", inspect)).toBeNull();
  expect(planUpdateRuntimeHandling({ ownership: null, serviceInstalled: false, supervision: inspect() }).mayReplacePackage).toBe(true);
});

function startupFixture(owner: ServiceOwnershipResolution, installId: string | null = "installation-a") {
  const f = fixture();
  const ownerState = { owner, reads: 0, changeAfter: Infinity };
  const deps = {
    ...f.deps,
    ownership: (): ServiceOwnershipResolution => (++ownerState.reads > ownerState.changeAfter ? { kind: "none", revision: 9 } : ownerState.owner),
    readWindowsInstallId: () => installId,
  };
  return { ...f, deps, ownerState };
}

const OWNED: ServiceOwnershipResolution = { kind: "owned", revision: 1,
  ownership: { owner: "desktop", installId: "installation-a", consentGeneration: 1 } };

const healthBase = {
  routingKind: "opencodex-local" as const, platform: "win32" as const,
  autostartEnabled: true, serviceInstalled: false, serviceViable: false,
  serviceEnabled: false, serviceRunning: false, serviceStale: false,
  serviceConflict: false, serviceSupported: true, shimInstalled: false, shimHealthy: false,
};

test("an unowned Windows Desktop supervisor is named, never credited as login protection, and drops service advice", () => {
  const f = startupFixture({ kind: "none", revision: 0 });
  const desktop = diagnoseDesktopStartup(f.deps);
  expect(desktop).toEqual({ owned: false, loginEnabled: false, running: true, viable: false,
    supervisor: { supervisorPid: 200, runtimePid: 100, app: APP } });
  const health = deriveStartupHealth({ ...healthBase, desktop });
  expect(health.protection).not.toBe("desktop");
  expect(health.recommendedCommand).toBeNull();
  const none = startupFixture({ kind: "none", revision: 0 });
  none.state.parent = { ...none.state.parent!, exe: "C:\\Windows\\explorer.exe" };
  expect(diagnoseDesktopStartup(none.deps)).toBeUndefined();
});

test("a durable Windows Desktop claim reports running and its supervisor only for its own install and a stable live chain", () => {
  expect(diagnoseWindowsDesktopStartup(startupFixture(OWNED).deps)).toEqual({ owned: true, loginEnabled: false, running: true,
    viable: false, supervisor: { supervisorPid: 200, runtimePid: 100, app: APP } });
  const claimOnly = { owned: true, loginEnabled: false, running: false, viable: false };
  const otherInstall = startupFixture(OWNED, "installation-b");
  expect(diagnoseWindowsDesktopStartup(otherInstall.deps)).toEqual(claimOnly);
  expect(otherInstall.state.reads).toBe(0);
  expect(diagnoseWindowsDesktopStartup(startupFixture(OWNED, null).deps)).toEqual(claimOnly);
  const notDesktop = startupFixture(OWNED);
  notDesktop.state.child = { ...notDesktop.state.child!, session: 7 };
  expect(diagnoseWindowsDesktopStartup(notDesktop.deps)).toEqual(claimOnly);
  const released = startupFixture(OWNED); released.ownerState.changeAfter = 1;
  expect(diagnoseWindowsDesktopStartup(released.deps)).toEqual(claimOnly);
  const cli = startupFixture({ kind: "owned", revision: 1, ownership: { owner: "cli", installId: "x", consentGeneration: 1 } });
  expect(diagnoseWindowsDesktopStartup(cli.deps)).toBeUndefined();
  expect(diagnoseWindowsDesktopStartup({ ...startupFixture(OWNED).deps, platform: "darwin" })).toBeUndefined();
});

test("the Windows install id is read from the roaming app config directory", () => {
  const appData = mkdtempSync(join(tmpdir(), "ocx-win-appdata-"));
  roots.push(appData);
  const f = startupFixture(OWNED);
  const { readWindowsInstallId: _ignored, ...deps } = f.deps;
  // A non-drive APPDATA is never trusted, so a POSIX temp directory reads as unverified.
  expect(diagnoseWindowsDesktopStartup({ ...deps, env: { APPDATA: appData } })).toMatchObject({ running: false });
  if (process.platform === "win32") {
    mkdirSync(join(appData, "com.opencodex.desktop"), { recursive: true });
    writeFileSync(join(appData, "com.opencodex.desktop", "install-id"), "installation-a\n");
    expect(diagnoseWindowsDesktopStartup({ ...deps, env: { APPDATA: appData } })).toMatchObject({ running: true });
  }
});

test("the ownership-only Windows projection runs no process probe", () => {
  const f = startupFixture(OWNED);
  expect(desktopStartupOwnership(f.deps)).toEqual({ owned: true, loginEnabled: false, running: false, viable: false });
  expect(f.state.reads).toBe(0);
});

test("the Node sharedObjects resolver rejects duplicates, malformed, truncated and disagreeing enumerations", () => {
  const dir = "C:\\Windows\\System32";
  const good = ["C:\\Windows\\System32\\KERNEL32.DLL", "c:\\windows\\system32\\ntdll.dll", "C:\\ocx\\node.exe"];
  // A consistent same-parent enumeration (mixed case, mixed separators) resolves.
  expect(windowsSystemDirectoryFromSharedObjects(good).toLowerCase()).toBe(dir.toLowerCase());
  expect(windowsSystemDirectoryFromSharedObjects(["C:/Windows/System32/kernel32.dll", "C:\\Windows\\System32\\ntdll.dll"]).toLowerCase())
    .toBe(dir.toLowerCase());
  // Environment tampering cannot steer this resolver — it never reads process.env.
  const saved = process.env.SystemRoot;
  try {
    process.env.SystemRoot = "D:\\Evil";
    expect(windowsSystemDirectoryFromSharedObjects(good).toLowerCase()).toBe(dir.toLowerCase());
  } finally {
    if (saved === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = saved;
  }
  // An unavailable report is the bounded unknown residual, not a success.
  for (const loaded of [undefined, null, 42, "C:\\Windows\\System32"]) {
    expect(() => windowsSystemDirectoryFromSharedObjects(loaded)).toThrow("trusted Windows resolver unavailable");
  }
  // Same-directory duplicate namesakes — contradictions are rejected.
  expect(() => windowsSystemDirectoryFromSharedObjects([...good, "C:\\Windows\\System32\\kernel32.dll"]))
    .toThrow("trusted Windows resolver unavailable");
  expect(() => windowsSystemDirectoryFromSharedObjects([...good, "D:\\x\\kernel32.dll"]))
    .toThrow("trusted Windows resolver unavailable");
  // Malformed namesakes (bare name, UNC, rooted, drive-relative) must not hide behind the format filter.
  for (const namesake of ["kernel32.dll", "\\\\evil\\share\\kernel32.dll", "\\System32\\kernel32.dll", "C:kernel32.dll"]) {
    expect(() => windowsSystemDirectoryFromSharedObjects([...good, namesake])).toThrow("trusted Windows resolver unavailable");
  }
  // A namesake at or over the enumeration buffer limit may be truncated — reject rather than trust.
  expect(() => windowsSystemDirectoryFromSharedObjects([...good, "D:\\" + "x".repeat(300) + "\\kernel32.dll"]))
    .toThrow("trusted Windows resolver unavailable");
  // kernel32 and ntdll must share one parent directory.
  expect(() => windowsSystemDirectoryFromSharedObjects(["C:\\Windows\\System32\\kernel32.dll", "D:\\Other\\ntdll.dll"]))
    .toThrow("trusted Windows resolver unavailable");
  // An incomplete enumeration (missing ntdll) cannot prove a directory.
  expect(() => windowsSystemDirectoryFromSharedObjects(["C:\\Windows\\System32\\kernel32.dll"]))
    .toThrow("trusted Windows resolver unavailable");
});

test("the Node sharedObjects resolver drives the real probe path and fails closed when it rejects", () => {
  const output = JSON.stringify({
    child: { pid: "100", parent: "200", exe: PROXY, session: "1", created: "638950000000000002" },
    parent: { pid: "200", parent: "4", exe: APP, session: "1", created: "638950000000000001" },
  });
  const calls: { command: string; args: string[]; timeout?: number; env?: NodeJS.ProcessEnv }[] = [];
  const run = (command: string, args: string[], timeout?: number, env?: NodeJS.ProcessEnv) => {
    calls.push({ command, args, timeout, env }); return output;
  };
  // Positive: a consistent Node enumeration supplies the system directory for the real
  // windowsProcessPair path — PowerShell runs at the derived location, not from env or PATH.
  const loaded = ["C:\\Windows\\System32\\kernel32.dll", "c:\\windows\\system32\\ntdll.dll", "C:\\Program Files\\nodejs\\node.exe"];
  const deps = {
    platform: "win32" as const, readPid: () => 100, readRuntimePortPid: () => 100,
    resolveWindowsSystemDirectory: () => windowsSystemDirectoryFromSharedObjects(loaded), run,
  } satisfies DesktopSupervisionDeps;
  expect(inspectDesktopSupervision(deps)).toEqual({ kind: "desktop", runtimePid: 100, supervisorPid: 200, app: APP, proxy: PROXY });
  expect(calls.length).toBe(2); // two agreeing snapshots, one bounded probe each
  for (const call of calls) {
    expect(call.command).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(call.env?.PATH).toBe("C:\\Windows\\System32");
  }
  // Negative: a rejecting enumeration never reaches PowerShell — the result is the
  // bounded probe-failed unknown, never proven absence, and plain unknown stays nonblocking.
  const refused = ["kernel32.dll"]; // malformed namesake — no drive-qualified path
  const spy: typeof run = (command, args, timeout, env) => { calls.push({ command, args, timeout, env }); return output; };
  const before = calls.length;
  const evidence = inspectDesktopSupervision({ ...deps,
    resolveWindowsSystemDirectory: () => windowsSystemDirectoryFromSharedObjects(refused), run: spy });
  expect(evidence).toEqual({ kind: "unknown", reason: "probe-failed", desktopSeen: false });
  expect(calls).toHaveLength(before);
  expect(createSupervisionLatch().observe(evidence)).toBe(false);
  expect(planUpdateRuntimeHandling({ ownership: null, serviceInstalled: false, supervision: evidence }).mayReplacePackage).toBe(true);
  // A throwing resolver fails identically at the pair level: execute is never invoked.
  expect(() => windowsProcessPair(100, spy, { resolveSystemDirectory: () => { throw new Error("trusted Windows resolver unavailable"); } }))
    .toThrow("trusted Windows resolver unavailable");
  expect(calls).toHaveLength(before);
});

