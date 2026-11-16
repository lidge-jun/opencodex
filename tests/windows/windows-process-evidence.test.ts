// Process evidence for the checked Windows stop (#7771): creation times, the Schedule
// service PID, the checked terminate and the exit watch. Hermetic everywhere except the
// cases gated on real Windows, which exercise the owner snapshot and x64 FFI on our own child.
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { resolveTrustedWindowsPowerShellExe, resolveTrustedWindowsSystemDirectory } from "../../src/lib/windows-elevation";
import {
  decodeServiceStatusProcess,
  fileTimeToEpochMs,
  setWindowsProcessNativeForTests,
  setWindowsProcessPlatformForTests,
  windowsProcessNative,
  type WindowsProcessNativeApi,
} from "../../src/service/windows-process-native";
import {
  WINDOWS_PROCESS_SNAPSHOT_SCRIPT,
  openWindowsProcessWatch,
  overlayNativeCreationTimes,
  parseFallbackTerminateOutput,
  parseScQueryexPid,
  parseWindowsProcessSnapshot,
  readScheduleServicePid,
  terminateWindowsProcessBound,
  windowsFallbackTerminateScript,
  windowsProcessSnapshot,
  type WindowsEvidenceCommand,
} from "../../src/service/windows-process-evidence";

afterEach(() => {
  setWindowsProcessNativeForTests(undefined);
  setWindowsProcessPlatformForTests(null);
});

const fakeNative = (overrides: Partial<WindowsProcessNativeApi> = {}): WindowsProcessNativeApi => ({
  creationTime: () => null,
  terminate: () => ({ status: "unavailable" }),
  openWatch: () => ({ status: "unavailable" }),
  scheduleServicePid: () => null,
  ...overrides,
});

const SNAPSHOT_JSON = JSON.stringify([
  { ProcessId: 20, ParentProcessId: 900, Name: "wscript.exe", CommandLine: "wscript.exe x.vbs", CreationDate: "2026-11-12T01:02:03.1234567Z" },
  { ProcessId: 4, ParentProcessId: 0, Name: "System", CommandLine: null, CreationDate: null },
]);

describe("Windows process evidence: pure decoding", () => {
  test("FILETIME converts to epoch ms by truncation; zero is unreadable", () => {
    expect(fileTimeToEpochMs(116_444_736_000_000_000n + 12_345_678n)).toBe(1_234);
    expect(fileTimeToEpochMs(0n)).toBeNull();
    expect(fileTimeToEpochMs(116_444_736_000_000_000n)).toBeNull();
  });

  test("SERVICE_STATUS_PROCESS yields the PID only while the service runs", () => {
    const buffer = new Uint8Array(36);
    const view = new DataView(buffer.buffer);
    view.setUint32(4, 4, true);
    view.setUint32(28, 1_234, true);
    expect(decodeServiceStatusProcess(buffer)).toBe(1_234);
    view.setUint32(4, 1, true);
    expect(decodeServiceStatusProcess(buffer)).toBeNull();
    expect(decodeServiceStatusProcess(new Uint8Array(20))).toBeNull();
  });

  test("the snapshot carries ISO creation times as epoch ms; malformed output is unread", () => {
    expect(parseWindowsProcessSnapshot(SNAPSHOT_JSON)).toEqual([
      { pid: 20, parentPid: 900, name: "wscript.exe", commandLine: "wscript.exe x.vbs", startTime: Date.parse("2026-11-12T01:02:03.123Z"), foreignOwner: null },
      { pid: 4, parentPid: null, name: "System", commandLine: null, startTime: null, foreignOwner: null },
    ]);
    expect(parseWindowsProcessSnapshot(JSON.stringify({ ProcessId: 7, ParentProcessId: 1, Name: "a", CommandLine: "a", CreationDate: "x" })))
      .toEqual([{ pid: 7, parentPid: 1, name: "a", commandLine: "a", startTime: null, foreignOwner: null }]);
    expect(parseWindowsProcessSnapshot("")).toEqual([]);
    expect(parseWindowsProcessSnapshot("{not json")).toBeNull();
  });

  test("only stable, successful SID evidence proves a foreign owner; service accounts remain candidates", () => {
    const current = "S-1-5-21-100-200-300-1001";
    const foreign = "S-1-5-21-100-200-300-1002";
    const created = "2026-11-12T01:02:03.1234567Z";
    const row = {
      ProcessId: 20, ParentProcessId: 900, Name: "cmd.exe", CommandLine: "cmd.exe", CreationDate: created,
      CurrentUserSid: current, Owner: { Sid: foreign, ReturnValue: 0, CreationDate: created },
    };
    const parse = (value: unknown) => parseWindowsProcessSnapshot(JSON.stringify(value))![0]!;
    expect(parse(row).foreignOwner).toBe(true);
    expect(parse({ ...row, Owner: { ...row.Owner, Sid: current.toLowerCase() } }).foreignOwner).toBe(false);
    expect(parse({ ...row, Owner: { ...row.Owner, Sid: "S-1-12-1-100-200-300-400" } }).foreignOwner).toBe(true);
    expect(parse({ ...row, CurrentUserSid: "S-1-12-1-100-200-300-400" }).foreignOwner).toBe(true);
    for (const owner of ["S-1-5-18", "S-1-5-19", "S-1-5-20", "S-1-5-80-1-2-3-4-5", "S-1-5-82-1-2-3-4-5", "S-1-99-1"]) {
      expect(parse({ ...row, Owner: { ...row.Owner, Sid: owner } }).foreignOwner).toBeNull();
    }
    for (const invalid of [null, "", "not-a-sid", "S-1-", "S-1-5-21-100-200-300-4294967296", "S-1-5-" + "1".repeat(257)]) {
      expect(parse({ ...row, CurrentUserSid: invalid }).foreignOwner).toBeNull();
      expect(parse({ ...row, Owner: { ...row.Owner, Sid: invalid } }).foreignOwner).toBeNull();
    }
    for (const invalid of [undefined, null, 2, "0"]) {
      expect(parse({ ...row, Owner: { ...row.Owner, ReturnValue: invalid } }).foreignOwner).toBeNull();
    }
    for (const changed of [undefined, null, "2026-11-12T01:02:03.1234568Z"]) {
      expect(parse({ ...row, Owner: { ...row.Owner, CreationDate: changed } }).foreignOwner).toBeNull();
    }
    expect(parse({ ...row, CreationDate: null }).foreignOwner).toBeNull();
    expect(parse({ ...row, Owner: null, foreignOwner: true }).foreignOwner).toBeNull();
    expect(JSON.stringify(parse(row))).not.toContain(current);
    expect(JSON.stringify(parse(row))).not.toContain(foreign);

    const known = parse(row);
    expect(overlayNativeCreationTimes([known], () => known.startTime!)[0]!.foreignOwner).toBe(true);
    expect(overlayNativeCreationTimes([known], () => known.startTime! + 2_000)[0])
      .toMatchObject({ startTime: null, foreignOwner: null });
    expect(overlayNativeCreationTimes([known], () => null)[0]!.foreignOwner).toBeNull();
  });

  test("a native creation time replaces CIM's only when both agree to the millisecond", () => {
    const rows = parseWindowsProcessSnapshot(SNAPSHOT_JSON)!;
    const cim = rows[0]!.startTime!;
    expect(overlayNativeCreationTimes(rows, () => cim + 1)[0]!.startTime).toBe(cim + 1);
    // A PID reused between the CIM query and the native read: the identities disagree.
    expect(overlayNativeCreationTimes(rows, () => cim + 2_000)[0]!.startTime).toBeNull();
    expect(overlayNativeCreationTimes(rows, () => null)[0]!.startTime).toBeNull();
    expect(overlayNativeCreationTimes(rows, () => { throw new Error("ffi"); })[0]!.startTime).toBeNull();
  });

  test("sc.exe queryex yields the PID only for a RUNNING service", () => {
    const running = "SERVICE_NAME: Schedule\r\n        TYPE               : 30  WIN32\r\n        STATE              : 4  RUNNING\r\n"
      + "        PID                : 1488\r\n        FLAGS              :\r\n";
    expect(parseScQueryexPid(running)).toBe(1_488);
    expect(parseScQueryexPid(running.replace(": 4  RUNNING", ": 1  STOPPED"))).toBeNull();
    expect(parseScQueryexPid(running.replace(": 1488", ": 0"))).toBeNull();
    expect(parseScQueryexPid("garbage")).toBeNull();
  });

  test("the ARM64 terminate script compares StartTime and kills the same Process object", () => {
    const script = windowsFallbackTerminateScript(4_242, 1_794_445_323_123, 1_000);
    expect(script).toContain("Get-Process -Id 4242");
    expect(script).toContain("FromUnixTimeMilliseconds(1794445323123)");
    expect(script).toContain("-gt 1000) { 'reused'");
    expect(script.indexOf("$p.Kill()")).toBeGreaterThan(script.indexOf("'reused'"));
    expect(script).toContain("$p.WaitForExit(1000)");
    expect(() => windowsFallbackTerminateScript(1.5, 1, 1)).toThrow();
    expect(() => windowsFallbackTerminateScript(-1, 1, 1)).toThrow();
    expect(parseFallbackTerminateOutput("terminated-exited\r\n")).toEqual({ status: "terminated", exited: true });
    expect(parseFallbackTerminateOutput("terminated")).toEqual({ status: "terminated", exited: false });
    expect(parseFallbackTerminateOutput("noise\nreused\n")).toEqual({ status: "reused" });
    expect(parseFallbackTerminateOutput("denied")).toEqual({ status: "denied" });
    expect(parseFallbackTerminateOutput("gone")).toEqual({ status: "gone" });
    expect(parseFallbackTerminateOutput("")).toEqual({ status: "unavailable" });
    expect(parseFallbackTerminateOutput("Killed")).toEqual({ status: "unavailable" });
  });
});

describe("Windows process evidence: facades", () => {
  test("a simulated platform reaches neither the kernel nor a spawn", async () => {
    setWindowsProcessPlatformForTests("win32");
    expect(windowsProcessNative()).toBeNull();
    expect(await windowsProcessSnapshot({ timeoutMs: 5_000 })).toBeNull();
    expect(await readScheduleServicePid({ timeoutMs: 2_000 })).toBeNull();
    expect(await terminateWindowsProcessBound(20, 5_000, { timeoutMs: 1_000 })).toEqual({ status: "unavailable" });
    expect(openWindowsProcessWatch(20, 5_000)).toEqual({ status: "unavailable" });
  });

  test("the snapshot runs one capped CIM query and overlays native creation times", async () => {
    setWindowsProcessPlatformForTests("win32");
    const cim = Date.parse("2026-11-12T01:02:03.123Z");
    setWindowsProcessNativeForTests(fakeNative({ creationTime: pid => (pid === 20 ? cim : null) }));
    const commands: WindowsEvidenceCommand[] = [];
    const snapshot = await windowsProcessSnapshot({
      timeoutMs: 5_000,
      run: async command => { commands.push(command); return SNAPSHOT_JSON; },
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ program: "powershell", timeoutMs: 5_000 });
    expect(commands[0]!.args.at(-1)).toBe(WINDOWS_PROCESS_SNAPSHOT_SCRIPT);
    // Owner queries only cover potential candidates, and re-read identity AFTER the SID.
    expect(WINDOWS_PROCESS_SNAPSHOT_SCRIPT).toContain("-like '*opencodex-service*'");
    expect(WINDOWS_PROCESS_SNAPSHOT_SCRIPT.indexOf("Get-CimInstance -InputObject $_"))
      .toBeGreaterThan(WINDOWS_PROCESS_SNAPSHOT_SCRIPT.indexOf("-MethodName GetOwnerSid"));
    expect(snapshot?.map(row => [row.pid, row.startTime])).toEqual([[20, cim], [4, null]]);
    expect(await windowsProcessSnapshot({ timeoutMs: 5_000, run: async () => { throw new Error("timeout"); } })).toBeNull();
  });

  test("the Schedule PID prefers the SCM read and falls back to sc.exe queryex", async () => {
    setWindowsProcessPlatformForTests("win32");
    setWindowsProcessNativeForTests(fakeNative({ scheduleServicePid: () => 1_234 }));
    expect(await readScheduleServicePid({ timeoutMs: 2_000 })).toBe(1_234);
    setWindowsProcessNativeForTests(null);
    const commands: WindowsEvidenceCommand[] = [];
    const pid = await readScheduleServicePid({
      timeoutMs: 2_000,
      run: async command => { commands.push(command); return "STATE : 4 RUNNING\nPID : 77\n"; },
    });
    expect(pid).toBe(77);
    expect(commands).toEqual([{ program: "sc", args: ["queryex", "Schedule"], timeoutMs: 2_000, maxBufferBytes: 64 * 1024 }]);
    expect(await readScheduleServicePid({ timeoutMs: 2_000, run: async () => { throw new Error("1060"); } })).toBeNull();
  });

  test("terminate prefers the handle primitive and otherwise runs the bounded fallback script", async () => {
    setWindowsProcessPlatformForTests("win32");
    const seen: Array<[number, number]> = [];
    setWindowsProcessNativeForTests(fakeNative({ terminate: (pid, start) => { seen.push([pid, start]); return { status: "reused" }; } }));
    expect(await terminateWindowsProcessBound(20, 5_000, { timeoutMs: 3_000 })).toEqual({ status: "reused" });
    expect(seen).toEqual([[20, 5_000]]);

    setWindowsProcessNativeForTests(null);
    const scripts: string[] = [];
    const result = await terminateWindowsProcessBound(20, 5_000, {
      timeoutMs: 3_000,
      run: async command => { scripts.push(command.args.at(-1)!); return "terminated-exited\n"; },
    });
    expect(result).toEqual({ status: "terminated", exited: true });
    expect(scripts[0]).toContain("Get-Process -Id 20");
    expect(await terminateWindowsProcessBound(20, 5_000, { timeoutMs: 3_000, run: async () => { throw new Error("x"); } }))
      .toEqual({ status: "unavailable" });
  });

  test("a fractional deadline-derived timeout reaches the fallback as whole milliseconds", async () => {
    setWindowsProcessPlatformForTests("win32");
    setWindowsProcessNativeForTests(null);
    const commands: WindowsEvidenceCommand[] = [];
    const run = async (command: WindowsEvidenceCommand) => { commands.push(command); return "terminated\n"; };
    expect(await terminateWindowsProcessBound(20, 5_000, { timeoutMs: 1_250.5, run }))
      .toEqual({ status: "terminated", exited: false });
    expect(commands.map(command => command.timeoutMs)).toEqual([1_250]);
    expect(commands[0]!.args.at(-1)).toContain("$p.WaitForExit(750)");
    // Under 1 ms floors to 0, which execFile reads as "no timeout": nothing is spawned.
    expect(await terminateWindowsProcessBound(20, 5_000, { timeoutMs: 0.5, run })).toEqual({ status: "unavailable" });
    expect(commands).toHaveLength(1);
  });
});

const liveX64 = process.platform !== "win32" || process.arch !== "x64";

for (const expired of [false, true]) test.skipIf(process.platform !== "win32")("owner enrichment retains every row (expired=" + expired + ")", async () => {
  const script = WINDOWS_PROCESS_SNAPSHOT_SCRIPT.replace(
    "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value", "'S-1-5-21-100-200-300-1001'",
  ).replace("[Diagnostics.Stopwatch]::StartNew()", expired ? "[pscustomobject]@{ ElapsedMilliseconds = 1500 }" : "[Diagnostics.Stopwatch]::StartNew()");
  const prelude = [
    "$script:ownerReads = 0; $script:refreshReads = 0;",
    "function Get-CimInstance { param($ClassName, $InputObject, $ErrorAction, $OperationTimeoutSec)",
    "  if ($InputObject) { $script:refreshReads++; return $InputObject };",
    "  1..40 | ForEach-Object { [pscustomobject]@{ ProcessId = $_; ParentProcessId = 900; Name = 'cmd.exe';",
    "    CommandLine = 'cmd.exe'; CreationDate = [datetime]'2026-11-12T01:02:03Z' } } };",
    "function Invoke-CimMethod { param($InputObject, $MethodName, $ErrorAction, $OperationTimeoutSec)",
    "  $script:ownerReads++; @{ Sid = $currentSid; ReturnValue = 0 } };",
    "$rows = & { " + script + " };",
    "[pscustomobject]@{ Snapshot = $rows; OwnerReads = $script:ownerReads; RefreshReads = $script:refreshReads } | ConvertTo-Json -Compress",
  ].join(" ");
  const child = Bun.spawn([resolveTrustedWindowsPowerShellExe(), "-NoProfile", "-NonInteractive", "-Command", prelude], {
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 5_000,
  });
  const [output, errors, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(errors).toBe("");
  expect(exitCode).toBe(0);
  const result = JSON.parse(output);
  const rows = parseWindowsProcessSnapshot(result.Snapshot)!;
  expect(rows).toHaveLength(40);
  if (expired) expect(result.OwnerReads).toBe(0);
  else expect(result.OwnerReads).toBeGreaterThan(0);
  expect(result.OwnerReads).toBeLessThanOrEqual(32);
  expect(result.RefreshReads).toBe(result.OwnerReads);
  expect(rows.slice(0, result.OwnerReads).every(row => row.foreignOwner === false)).toBe(true);
  expect(rows.slice(result.OwnerReads).every(row => row.foreignOwner === null)).toBe(true);
}, 10_000);

test.skipIf(process.platform !== "win32")("the live capped snapshot reads and refreshes a wrapper child's owner", async () => {
  // /d disables AutoRun. `rem` does no work; /k and an open stdin keep this owned child
  // alive for the real CIM owner query, refresh, parser, and optional native overlay.
  const marker = "opencodex-service-owner-snapshot-test";
  const child = Bun.spawn([join(resolveTrustedWindowsSystemDirectory(), "cmd.exe"), "/d", "/q", "/k", "rem", marker], {
    stdio: ["pipe", "ignore", "ignore"], windowsHide: true,
  });
  try {
    // Scope the real CIM input to our child: enrichment is intentionally bounded, so a
    // busy machine's unrelated wrappers may use up a full snapshot's optional budget.
    const snapshot = await windowsProcessSnapshot({ timeoutMs: 5_000, run: async command => {
      const args = command.args.map(arg => arg.replace("Get-CimInstance Win32_Process |",
        "Get-CimInstance Win32_Process -Filter 'ProcessId = " + child.pid + "' |"));
      const helper = Bun.spawn([resolveTrustedWindowsPowerShellExe(), ...args], {
        stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: command.timeoutMs,
      });
      const [output, errors, code] = await Promise.all([
        new Response(helper.stdout).text(), new Response(helper.stderr).text(), helper.exited,
      ]);
      if (code !== 0 || errors) throw new Error("child-scoped snapshot failed");
      return output;
    } });
    expect(snapshot).not.toBeNull();
    const wrapper = snapshot!.find(row => row.pid === child.pid);
    expect(wrapper).toBeDefined();
    expect(wrapper!.name?.toLowerCase()).toBe("cmd.exe");
    expect(wrapper!.parentPid).toBe(process.pid);
    expect(wrapper!.commandLine).toContain(marker);
    expect(typeof wrapper!.startTime).toBe("number");
    // false requires successful, matching owner/creation evidence; unknown is not enough.
    expect(wrapper!.foreignOwner).toBe(false);
    expect(child.exitCode).toBeNull();
  } finally {
    child.kill();
    await child.exited;
  }
}, 10_000);

describe("Windows process evidence: live x64 primitive", () => {
  test.skipIf(liveX64)("reads a child's creation time, refuses a mismatched identity and ends the bound one", async () => {
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      stdio: ["ignore", "ignore", "ignore"], windowsHide: true,
    });
    let created: number | null = null;
    try {
      const native = windowsProcessNative();
      expect(native).not.toBeNull();
      created = native!.creationTime(child.pid);
      expect(typeof created).toBe("number");
      expect(Math.abs(created! - Date.now())).toBeLessThan(60_000);

      expect(native!.terminate(child.pid, created! - 5_000)).toEqual({ status: "reused" });
      const watch = native!.openWatch(child.pid, created!);
      expect(watch.status).toBe("open");
      if (watch.status !== "open") return;
      try {
        expect(watch.exited()).toBe(false);
        expect(native!.terminate(child.pid, created!)).toEqual({ status: "terminated" });
        await child.exited;
        expect(watch.exited()).toBe(true);
      } finally {
        watch.close();
      }
    } finally {
      child.kill();
      await child.exited;
    }
    // Exited: a zombie still held open reads as exited, a released PID fails to open
    // (ERROR_INVALID_PARAMETER), and a PID already reused by another process is refused.
    expect(["gone", "reused"]).toContain(windowsProcessNative()!.terminate(child.pid, created!).status);
  });

  test.skipIf(liveX64)("reads the Task Scheduler service PID from the SCM", () => {
    const pid = windowsProcessNative()!.scheduleServicePid();
    expect(pid === null || (Number.isSafeInteger(pid) && pid > 0)).toBe(true);
  });
});
