// Process evidence for the checked Windows stop (#7771): creation times, the Schedule
// service PID, the checked terminate and the exit watch. Hermetic everywhere except the
// cases gated on real Windows, which exercise the owner snapshot and x64 FFI on our own child.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";
import { observeClientStopOwner, readClientStopProcessStart } from "../../src/client/stop-teardown-owner";
import { resolveWindowsCurrentSid } from "../../src/codex/windows-current-sid";

import { resolveTrustedWindowsPowerShellExe, resolveTrustedWindowsSystemDirectory } from "../../src/lib/windows-elevation";
import { windowsLauncherVbsPath } from "../../src/service/state";
import {
  decodeServiceStatusProcess,
  fileTimeToEpochMs,
  setWindowsProcessNativeForTests,
  setWindowsProcessPlatformForTests,
  windowsProcessNative,
  type WindowsProcessNativeApi,
} from "../../src/service/windows-process-native";
import {
  SNAPSHOT_OWNER_RESERVE_MS,
  windowsProcessSnapshotScript,
  openWindowsProcessWatch,
  overlayNativeCreationTimes,
  parseScQueryexPid,
  parseWindowsProcessSnapshot,
  readScheduleServicePid,
  terminateWindowsProcessBound,
  windowsProcessSnapshot,
  type WindowsEvidenceCommand,
} from "../../src/service/windows-process-evidence";

afterEach(() => {
  setWindowsProcessNativeForTests(undefined);
  setWindowsProcessPlatformForTests(null);
});

const fakeNative = (overrides: Partial<WindowsProcessNativeApi> = {}): WindowsProcessNativeApi => ({
  creationTime: () => null,
  sameUserIdentity: () => null,
  terminate: () => ({ status: "unavailable" }),
  openWatch: () => ({ status: "unavailable" }),
  scheduleServicePid: () => null,
  ...overrides,
});

test("Link stop reads the Windows start identity and owner argv once, and refuses unreadable evidence", async () => {
  const ticks = 639_275_653_231_234_560n;
  const reads: [number, boolean | undefined][] = [];
  let identity: { ticks: bigint; commandLine?: string } | null = { ticks, commandLine: "ocx.exe stop --json" };
  setWindowsProcessPlatformForTests("win32");
  setWindowsProcessNativeForTests(fakeNative({ sameUserIdentity: (pid, withCommandLine) => {
    reads.push([pid, withCommandLine]);
    return identity;
  } }));
  expect(readClientStopProcessStart(process.pid)).toBe(`win32:${ticks}`);
  expect(reads).toEqual([[process.pid, undefined]]);

  const child = Bun.spawn([process.execPath, "-e", "await Bun.stdin.text()"], { stdin: "pipe" });
  try {
    const owner = { pid: child.pid, startTime: `win32:${ticks}`, nonce: "1".repeat(32) };
    expect(observeClientStopOwner(owner)).toBe("active");
    expect(reads.slice(1)).toEqual([[child.pid, true]]);
    identity = { ticks };
    expect(observeClientStopOwner(owner)).toBe("unverified");
    identity = { ticks: ticks + 10n };
    expect(observeClientStopOwner(owner)).toBe("confirmed-stale");
    identity = null;
    expect(observeClientStopOwner(owner)).toBe("unverified");
    expect(readClientStopProcessStart(child.pid)).toBeUndefined();
  } finally {
    child.stdin.end();
    await child.exited;
  }
});

const SNAPSHOT_JSON = JSON.stringify([
  { ProcessId: 20, ParentProcessId: 900, Name: "wscript.exe", CommandLine: "wscript.exe x.vbs", CreationDate: "2026-11-12T01:02:03.1234567Z" },
  { ProcessId: 4, ParentProcessId: 0, Name: "System", CommandLine: null, CreationDate: null },
]);

describe("snapshot native wrapper owner proof", () => {
  const created = "2026-11-12T01:02:03.1234560Z";
  const ms = Date.parse(created);
  const ticks = 621_355_968_000_000_000n + BigInt(ms) * 10_000n + 4_560n;
  const sid = "S-1-5-21-100-200-300-1002";
  const row = (pid: number) => ({ ProcessId: pid, ParentProcessId: 7, Name: "wscript.exe",
    CommandLine: `wscript.exe "${windowsLauncherVbsPath()}"`, CurrentUserSid: sid, Owner: null, CreationDate: created });
  const snapshot = (rows: object[], timeoutMs = 5_000) =>
    windowsProcessSnapshot({ timeoutMs, run: async () => JSON.stringify(rows) });

  test("proves only an eligible wrapper with a missing CIM owner and the same live incarnation", async () => {
    setWindowsProcessPlatformForTests("win32");
    const calls: number[] = [];
    setWindowsProcessNativeForTests(fakeNative({
      creationTime: pid => pid === 19 ? ms + 1 : ms,
      sameUserIdentity: (pid, _withCommandLine, expectedSid) => {
        calls.push(pid);
        if (expectedSid !== sid && expectedSid !== "S-1-12-1-100-200-300-400") return null;
        if (pid === 12) return { ticks: ticks + 10n }; // Same epoch ms, different CIM microsecond.
        if (pid === 13) throw new Error("unavailable");
        if (pid === 14) return null;
        return { ticks };
      },
    }));
    const output = await snapshot([
      row(10), { ...row(11), CurrentUserSid: "S-1-12-1-100-200-300-400" },
      row(12), row(13), row(14),
      { ...row(15), CurrentUserSid: "S-1-5-18" }, { ...row(16), CurrentUserSid: "S-1-5-21-100-200-300-4294967296" },
      { ...row(17), CommandLine: row(17).CommandLine.replace('vbs"', 'vbs.bak"') }, { ...row(18), Name: "unrelated.exe" },
      row(19), { ...row(20), CreationDate: "invalid" }, { ...row(21), CreationDate: created.replace("4560", "457") },
      { ...row(22), Owner: { Sid: "S-1-5-21-100-200-300-1003", ReturnValue: 0, CreationDate: created } },
      { ...row(23), Owner: { Sid: sid, ReturnValue: 2, CreationDate: created } },
      { ...row(24), Owner: { Sid: sid, ReturnValue: 0, CreationDate: created.replace("4560", "4570") } },
      row(0), row(0x1_0000_0000),
    ]);
    expect(output?.filter(entry => entry.foreignOwner === false).map(entry => entry.pid)).toEqual([10, 11]);
    expect(output?.filter(entry => entry.foreignOwner === true).map(entry => entry.pid)).toEqual([22]);
    expect(calls).toEqual([10, 11, 12, 13, 14]);
    expect(JSON.stringify(output)).not.toContain(sid);
  });

  test("bounds optional native reads and leaves unread owners unknown", async () => {
    setWindowsProcessPlatformForTests("win32");
    let calls = 0;
    setWindowsProcessNativeForTests(fakeNative({ creationTime: () => ms, sameUserIdentity: () => { calls++; return { ticks }; } }));
    const rows = Array.from({ length: 34 }, (_, i) => row(i + 100));
    const bounded = await snapshot(rows);
    expect(calls).toBe(32);
    expect(bounded).toHaveLength(34);
    expect(bounded?.slice(32).every(entry => entry.foreignOwner === null)).toBe(true);
    const expired = await snapshot([row(201)], 0);
    expect(calls).toBe(32);
    expect(expired?.[0]?.foreignOwner).toBeNull();
    setWindowsProcessNativeForTests(null);
    expect((await snapshot([row(202)]))?.[0]?.foreignOwner).toBeNull();
  });

  test("discards proof that returns after the original snapshot deadline", async () => {
    setWindowsProcessPlatformForTests("win32");
    let now = 0, reads = 0;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    try {
      setWindowsProcessNativeForTests(fakeNative({ creationTime: () => ms, sameUserIdentity: () => {
        reads++;
        now = 100;
        return { ticks };
      } }));
      const entries = await snapshot([row(10), row(11)], 100);
      expect(reads).toBe(1);
      expect(entries?.map(entry => entry.foreignOwner)).toEqual([null, null]);
    } finally {
      clock.mockRestore();
    }
  });
});

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

  test("only stable, successful SID evidence proves a foreign owner; service accounts remain unverified", () => {
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

});

describe("Windows process evidence: facades", () => {
  test("ARM64 without a native handle cannot terminate using only a PID and timestamp", async () => {
    setWindowsProcessPlatformForTests("win32");
    setWindowsProcessNativeForTests(null);
    const commands: WindowsEvidenceCommand[] = [];
    const result = await terminateWindowsProcessBound(20, 5_000, {
      timeoutMs: 3_000,
      run: async command => {
        commands.push(command);
        return "terminated-exited";
      },
    });
    expect(commands).toEqual([]);
    expect(result).toEqual({ status: "unavailable" });
  });

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
    const script = windowsProcessSnapshotScript(5_000);
    expect(commands[0]!.args.at(-1)).toBe(script);
    // Owner queries only cover potential candidates, and re-read identity AFTER the SID.
    expect(script).toContain("-like '*opencodex-service*'");
    expect(script.indexOf("Get-CimInstance -InputObject $process"))
      .toBeGreaterThan(script.indexOf("-MethodName GetOwnerSid"));
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

  test("terminate uses the native handle primitive when available", async () => {
    setWindowsProcessPlatformForTests("win32");
    const seen: Array<[number, number]> = [];
    setWindowsProcessNativeForTests(fakeNative({ terminate: (pid, start) => { seen.push([pid, start]); return { status: "reused" }; } }));
    expect(await terminateWindowsProcessBound(20, 5_000, { timeoutMs: 3_000 })).toEqual({ status: "reused" });
    expect(seen).toEqual([[20, 5_000]]);
  });
});

const liveX64 = process.platform !== "win32" || process.arch !== "x64";

const portablePowerShell = Bun.which("pwsh");

// The budgets run in one test that shares one 60 s window: a slow first PowerShell start may use
// most of it, but a hang still fails inside the 120 s Linux batch deadline, naming the active budget.
// "cap-reached" is the hosted-runner regression: the loop's own 1.5 s budget is fresh, but the
// helper has already used the snapshot cap's owner window, so no owner read may start.
// "cap-during-owner" passes the cap's owner cutoff while the first owner read is in flight, so its
// refresh read must not start either.
test.skipIf(process.platform !== "win32" && !portablePowerShell)("owner enrichment prioritizes this home and retains every row", async () => {
  const deadline = Date.now() + 60_000;
  for (const budget of ["available", "expired", "expires-during-owner", "cap-reached", "cap-during-owner"] as const) {
    try { await ownerEnrichmentCase(budget, deadline); }
    catch (error) { throw new Error("budget=" + budget + ": " + (error instanceof Error ? error.message : String(error)), { cause: error }); }
  }
}, 65_000);

async function ownerEnrichmentCase(budget: "available" | "expired" | "expires-during-owner" | "cap-reached" | "cap-during-owner", deadline: number): Promise<void> {
  const powershell = process.platform === "win32" ? resolveTrustedWindowsPowerShellExe() : portablePowerShell!;
  const launcher = Buffer.from(windowsLauncherVbsPath(), "utf8").toString("base64");
  // A cap equal to the reserve puts the owner cutoff at the helper's own start.
  const script = windowsProcessSnapshotScript(budget === "cap-reached" ? SNAPSHOT_OWNER_RESERVE_MS : 60_000).replace(
    "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value", "'S-1-5-21-100-200-300-1001'",
  ).replace("[Diagnostics.Stopwatch]::StartNew()", "[pscustomobject]@{ ElapsedMilliseconds = " + (budget === "expired" ? 1500 : 0) + " }");
  const prelude = [
    "$script:ownerReads = 0; $script:refreshReads = 0;",
    "function Get-CimInstance { param($ClassName, $InputObject, $ErrorAction, $OperationTimeoutSec)",
    "  if ($InputObject) { $script:refreshReads++; return $InputObject };",
    "  1..40 | ForEach-Object { [pscustomobject]@{ ProcessId = $_; ParentProcessId = 900; Name = 'cmd.exe';",
    "    CommandLine = if ($_ -eq 40) { 'wscript.exe \"' + [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + launcher + "')) + '\"' } else { 'cmd.exe' };",
    "    CreationDate = [datetime]'2026-11-12T01:02:03Z' } } };",
    "function Invoke-CimMethod { param($InputObject, $MethodName, $ErrorAction, $OperationTimeoutSec)",
    "  $script:ownerReads++; " + (budget === "expires-during-owner" ? "$ownerBudget.Clock.ElapsedMilliseconds = 1500; " : "")
      + (budget === "cap-during-owner" ? "$ownerBudget.Until = [DateTime]::UtcNow.AddMinutes(-1); " : "")
      + "@{ Sid = $currentSid; ReturnValue = 0 } };",
    "$rows = & { " + script + " };",
    "[pscustomobject]@{ Snapshot = $rows; OwnerReads = $script:ownerReads; RefreshReads = $script:refreshReads } | ConvertTo-Json -Compress",
  ].join(" ");
  const child = Bun.spawn([powershell, "-NoProfile", "-NonInteractive", "-Command", prelude], {
    // A cold PowerShell start is the proof here; on a loaded Linux runner it outlasted 5 s (exit 143).
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    timeout: Math.max(1_000, Math.min(SPAWN_BUDGET_MS, deadline - Date.now())),
  });
  const [output, errors, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(errors).toBe("");
  expect(exitCode).toBe(0);
  const result = JSON.parse(output);
  const rows = parseWindowsProcessSnapshot(result.Snapshot)!;
  expect(rows).toHaveLength(40);
  expect(rows.map(row => row.pid)).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
  expect(result.OwnerReads).toBe(budget === "available" ? 32 : budget === "expires-during-owner" || budget === "cap-during-owner" ? 1 : 0);
  const refreshed = budget === "available" ? 32 : 0;
  expect(result.RefreshReads).toBe(refreshed);
  expect(rows[39]!.foreignOwner).toBe(budget === "available" ? false : null);
  const ordinaryRefreshed = Math.max(0, refreshed - 1);
  expect(rows.slice(0, ordinaryRefreshed).every(row => row.foreignOwner === false)).toBe(true);
  expect(rows.slice(ordinaryRefreshed, 39).every(row => row.foreignOwner === null)).toBe(true);
}

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
      const args = command.args.map(arg => arg.replace("Get-CimInstance Win32_Process -ErrorAction Stop",
        "Get-CimInstance Win32_Process -Filter 'ProcessId = " + child.pid + "' -ErrorAction Stop"));
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
  test.skipIf(liveX64)("matches an expected user SID on the current process handle", () => {
    const current = resolveWindowsCurrentSid(() => { throw new Error("native current SID unavailable"); });
    const other = current === "S-1-5-21-1-2-3-4" ? "S-1-5-21-1-2-3-5" : "S-1-5-21-1-2-3-4";
    const native = windowsProcessNative();
    expect(native).not.toBeNull();
    const identity = native!.sameUserIdentity(process.pid);
    expect(typeof identity?.ticks).toBe("bigint");
    expect(native!.sameUserIdentity(process.pid, false, current)?.ticks).toBe(identity!.ticks);
    expect(native!.sameUserIdentity(process.pid, false, other)).toBeNull();
  });

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
      const identity = native!.sameUserIdentity(child.pid, true);
      expect(identity?.commandLine).toContain("setInterval");
      expect(readClientStopProcessStart(child.pid)).toBe(`win32:${identity!.ticks}`);
      expect(Number((identity!.ticks - 621_355_968_000_000_000n) / 10_000n)).toBe(created!);
      expect(native!.terminate(child.pid, identity!.ticks - 10n)).toEqual({ status: "reused" });

      expect(native!.terminate(child.pid, created! - 5_000)).toEqual({ status: "reused" });
      const watch = native!.openWatch(child.pid, created!);
      expect(watch.status).toBe("open");
      if (watch.status !== "open") return;
      try {
        expect(watch.exited()).toBe(false);
        expect(native!.terminate(child.pid, identity!.ticks)).toEqual({ status: "terminated" });
        await child.exited;
        expect(watch.exited()).toBe(true);
        expect(native!.sameUserIdentity(child.pid)).toBeNull();
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
