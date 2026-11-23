/**
 * The live adapters of the checked Windows stop (#7771): parsing of the capped schtasks and
 * sc.exe answers, the ARM64 strict gate on the terminate, the whole-millisecond timeouts, the
 * Part B port sampler and listener identity, and the stopper-ancestry check. Hermetic: no
 * command is spawned and no FFI is loaded.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyScStop,
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
} from "../../src/service/windows-checked-stop-live";
import { windowsProcessNative, type WindowsProcessNativeApi } from "../../src/service/windows-process-native";
import { windowsLauncherVbsPath } from "../../src/service/state";
import { WINDOWS_TASK_INSTANCE_STOP_SCRIPT } from "../../src/service/windows-task-instance-stop";
import { buildWindowsTaskXml, windowsTaskRegistrationHealthy } from "../../src/service/windows-taskxml";
import { resolveTrustedWindowsPowerShellExe } from "../../src/lib/windows-elevation";
import { winswExePath } from "../../src/lib/winsw";
import { PATHS, entry, launcher, loop, proxy, supervisedTree } from "../helpers/windows-checked-stop-fixtures";

const result = (status: number | null, stdout = "", stderr = "", timedOut = false) => ({ status, stdout, stderr, timedOut });

describe("ARM64 strict variant (050, 060 'ARM64 decision for PR2')", () => {
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

  test("the test-home guard refuses the mutating PowerShell exchange before starting it", async () => {
    const result = await liveWindowsStopCommandRunner("powershell", [], 2_000, () => {
      throw new Error("the helper must never be started");
    });
    expect(result.stderr).toContain("refusing a machine-global service mutation");
  });
});

describe("capped command answers", () => {
  test("an owned disabled task can prove it is idle without qualifying as a healthy installation", async () => {
    const sid = "S-1-5-21-100-200-300-1001";
    const launcher = windowsLauncherVbsPath();
    const xml = buildWindowsTaskXml(undefined, launcher, undefined, sid)
      .replace('<Principal id="Author">', '<Principal id="Author"><UserId>' + sid + '</UserId>');
    const disabled = xml.replace("    <Enabled>true</Enabled>\n    <Hidden>", "    <Enabled>false</Enabled>\n    <Hidden>");
    expect(windowsTaskRegistrationHealthy(xml, undefined, launcher, sid)).toBe(true);
    expect(windowsTaskRegistrationHealthy(disabled, undefined, launcher, sid)).toBe(false);

    const endTaskFor = (taskXml: string) => windowsCheckedStopLiveDeps({ run: async (_program, _args, _timeout, authorizeProof) => {
      const proof = Buffer.from(JSON.stringify({ xml: taskXml, sid })).toString("base64");
      const approved = await authorizeProof?.(proof);
      return result(0, proof + "\n" + (approved ? "not-running" : "unverified-registration"));
    } }).endTask(2_000);

    expect(await endTaskFor(disabled)).toBe("not-running");
    expect(await endTaskFor(disabled.replace(`<Principal id="Author"><UserId>${sid}</UserId>`,
      '<Principal id="Author"><UserId>S-1-5-21-100-200-300-1002</UserId>'))).toBe("unverified-registration");
    expect(await endTaskFor(disabled.replace(/(<Arguments>.*?)<\/Arguments>/, "$1 extra</Arguments>")))
      .toBe("unverified-registration");
  });

  test.each(["Queued", "已排队", "PowerShell"])("final task state is active when a replacement is queued (%s)", async status => {
    const programs: string[] = [];
    const deps = windowsCheckedStopLiveDeps({ run: async program => {
      programs.push(program);
      if (program === "powershell") return result(0, "Queued\r\n");
      const word = status === "PowerShell" ? "Wird ausgeführt" : status;
      return result(0, `"\\opencodex-proxy","N/A","${word}"\r\n`);
    } });
    expect(await deps.taskState(1_000)).toBe("running");
    expect(programs).toEqual(status === "PowerShell" ? ["schtasks", "powershell"] : ["schtasks"]);
  });

  test("the #3064 launcher survives the task stop proof round trip", async () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const sid = "S-1-5-21-100-200-300-1001";
    try {
      process.env.OPENCODEX_HOME = join(previousHome ?? tmpdir(), "김병준");
      const launcher = windowsLauncherVbsPath();
      const xml = buildWindowsTaskXml(undefined, launcher, undefined, sid)
        .replace('<Principal id="Author">', '<Principal id="Author"><UserId>' + sid + '</UserId>');
      // The console export loses information before the decoder sees it (#3064).
      const lossyXml = xml.replaceAll("김병준", "???");
      let reportedXml = xml;
      const programs: string[] = [];
      const deps = windowsCheckedStopLiveDeps({
        run: async (program, args, _timeout, authorizeProof) => {
          programs.push(program);
          if (args.includes("/xml")) return result(0, lossyXml);
          const proof = Buffer.from(JSON.stringify({ xml: reportedXml, sid }), "utf8").toString("base64");
          return await authorizeProof?.(proof) ? result(0, proof + "\nended") : result(0, "unverified-registration");
        },
      });
      expect(await deps.endTask(2_000)).toBe("ended");
      expect(programs).toEqual(["powershell"]);
      reportedXml = lossyXml;
      expect(await deps.endTask(2_000)).toBe("unverified-registration");
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
    }
  });

  test("a task stop never falls back to a name-based end when instance proof fails", async () => {
    const sid = "S-1-5-21-100-200-300-1001";
    const xml = buildWindowsTaskXml(undefined, windowsLauncherVbsPath(), undefined, sid)
      .replace('<Principal id="Author">', '<Principal id="Author"><UserId>' + sid + '</UserId>');
    const programs: string[] = [];
    const deps = windowsCheckedStopLiveDeps({
      run: async (program, args) => {
        programs.push(program + " " + args[0]);
        if (args.includes("/xml")) return result(0, xml);
        if (args[0] === "/end") return result(0);
        return result(0, "unverified-registration");
      },
    });
    expect(await deps.endTask(2_000)).toBe("unverified-registration");
    expect(programs).toEqual(["powershell -NoProfile"]);
  });

  test("schtasks CSV state reads English values and leaves a localized word unknown", () => {
    expect(parseTaskCsvState('"\\opencodex-proxy","N/A","Running"')).toBe("running");
    expect(parseTaskCsvState('"\\opencodex-proxy","N/A","Ready"')).toBe("not-running");
    expect(parseTaskCsvState('"\\opencodex-proxy","N/A","Wird ausgeführt"')).toBe("unknown");
    expect(parseTaskCsvState('"\\Tools\\opencodex-proxy","N/A","Running"')).toBe("unknown");
  });

  test("schtasks CSV state reads the zh-CN and ko-KR status words (#8863)", () => {
    // System32\zh-CN\schtasks.exe.mui: Running, Ready, Disabled, Queued.
    expect(parseTaskCsvState('"\\opencodex-proxy","N/A","正在运行"')).toBe("running");
    expect(parseTaskCsvState('"\\opencodex-proxy","2026/11/17 9:00:00","就绪"')).toBe("not-running");
    expect(parseTaskCsvState('"\\opencodex-proxy","N/A","已禁用"')).toBe("not-running");
    // System32\ko-KR\schtasks.exe.mui: Running, Ready, Queued (534), Disabled (535).
    expect(parseTaskCsvState('"\\opencodex-proxy","N/A","실행 중"')).toBe("running");
    expect(parseTaskCsvState('"\\opencodex-proxy","N/A","준비"')).toBe("not-running");
    expect(parseTaskCsvState('"\\opencodex-proxy","N/A","대기"')).toBe("running");
    expect(parseTaskCsvState('"\\opencodex-proxy","N/A","사용 안 함"')).toBe("not-running");
    // Another task path still does not count, whatever the word.
    expect(parseTaskCsvState('"\\Tools\\opencodex-proxy","N/A","正在运行"')).toBe("unknown");
  });

  test("a zh-CN task state is read from the CSV without starting PowerShell (#8863)", async () => {
    const programs: string[] = [];
    const deps = windowsCheckedStopLiveDeps({
      run: async (program, args) => {
        programs.push(program + " " + args[0]);
        if (program === "powershell") throw new Error("PowerShell cannot start inside the 1 s manager-state cap");
        return result(0, '"\\opencodex-proxy","N/A","正在运行"\r\n');
      },
    });
    expect(await deps.taskState(1_000)).toBe("running");
    expect(programs).toEqual(["schtasks /query"]);
  });

  test.each([
    ["準備完了", "not-running"],
    ["無効", "not-running"],
    ["実行中", "running"],
    ["キューに登録済み", "running"],
  ])("ja-JP task state %s is read from the CSV without starting PowerShell", async (status, expected) => {
    const deps = windowsCheckedStopLiveDeps({
      run: async (program, args) => {
        expect(program).toBe("schtasks");
        expect(args).toEqual(["/query", "/tn", "opencodex-proxy", "/fo", "CSV", "/nh"]);
        return result(0, `"\\opencodex-proxy","N/A","${status}"\r\n`);
      },
    });
    expect(await deps.taskState(1_000)).toBe(expected);
  });

  test("the helper must finish successfully and receive proof approval before reporting success", async () => {
    const sid = "S-1-5-21-100-200-300-1001";
    const xml = buildWindowsTaskXml(undefined, windowsLauncherVbsPath(), undefined, sid)
      .replace('<Principal id="Author">', '<Principal id="Author"><UserId>' + sid + '</UserId>');
    const proof = Buffer.from(JSON.stringify({ xml, sid }), "utf8").toString("base64");
    let open = true;
    let approved = false;
    const deps = (answer: ReturnType<typeof result>, line = proof, closeGate = false) => windowsCheckedStopLiveDeps({
      gate: () => open,
      run: async (_program, _args, _timeout, authorizeProof) => {
        if (closeGate) open = false;
        approved = (await authorizeProof?.(line)) ?? false;
        return answer;
      },
    });
    expect(await deps(result(0, proof + "\nnot-running")).endTask(2_000)).toBe("not-running");
    expect(approved).toBe(true);
    expect(await deps(result(0, "ended"), "invalid").endTask(2_000)).toBe("failed");
    expect(approved).toBe(false);
    expect(await deps(result(0, "ended", "", true)).endTask(2_000)).toBe("failed");
    expect(await deps(result(0, "denied")).endTask(2_000)).toBe("denied");
    expect(await deps(result(0, "unverified-registration"), proof, true).endTask(2_000)).toBe("unverified-registration");
    expect(approved).toBe(false);
  });

  test("an authorizer that spends the helper deadline cannot approve dispatch", async () => {
    const sid = "S-1-5-21-100-200-300-1001";
    const xml = buildWindowsTaskXml(undefined, windowsLauncherVbsPath(), undefined, sid)
      .replace('<Principal id="Author">', '<Principal id="Author"><UserId>' + sid + '</UserId>');
    const proof = Buffer.from(JSON.stringify({ xml, sid })).toString("base64");
    let elapsed = 0;
    const now = spyOn(performance, "now").mockImplementation(() => elapsed);
    try {
      const deps = windowsCheckedStopLiveDeps({ run: async (_program, _args, _timeout, authorizeProof) => {
        const approved = await authorizeProof?.(proof);
        return result(0, proof + "\n" + (approved ? "ended" : "unverified-registration"));
      } });
      const verdict = await deps.endTask(2_000, async () => {
        await Promise.resolve();
        elapsed = 2_000;
      });
      expect(verdict).toBe("unverified-registration");
      expect(elapsed).toBe(2_000);
    } finally {
      now.mockRestore();
    }
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

const portablePowerShell = Bun.which("pwsh");

describe("the bounded Scheduler registration query", () => {
  test("a direct hit avoids PowerShell; only a completed, exact fallback answer is accepted", async () => {
    const directHit = result(0, '"\\opencodex-proxy","N/A","Disabled"');
    const missing = result(1, "", "지정된 파일을 찾을 수 없습니다.");
    for (const [direct, fallback, expected] of [
      [directHit, null, "present"],
      [{ ...result(2), windowsExitCode: 0x80070002 }, null, "absent"],
      [{ ...result(-2147024894), windowsExitCode: 0x80070002 }, null, "absent"],
      [{ ...result(1), windowsExitCode: 0x80070002 }, null, "unknown"],
      [{ ...result(2), windowsExitCode: 0x80041302 }, null, "unknown"],
      [{ ...result(5), windowsExitCode: 0x80070005 }, null, "unknown"],
      [{ ...result(null), windowsExitCode: 0x80070002 }, null, "unknown"],
      [result(2), result(0, "unknown"), "unknown"],
      [result(1, "", "", true), null, "unknown"],
      [missing, result(0, "absent\r\n"), "absent"],
      [missing, result(0, "present"), "present"],
      [missing, result(0, "unknown"), "unknown"],
      [missing, result(0, "noise\nabsent"), "unknown"],
      [missing, result(1, "absent"), "unknown"],
      [missing, result(null, "absent", "", true), "unknown"],
    ] as const) {
      const calls: string[] = [];
      const deps = windowsCheckedStopLiveDeps({ run: async (program, args, timeout) => {
        calls.push(program);
        if (program === "schtasks") {
          expect(args).toEqual(["/query", "/tn", "\\opencodex-proxy", "/fo", "CSV", "/nh", "/hresult"]);
          return direct;
        }
        expect(timeout).toBeGreaterThan(0);
        expect(timeout).toBeLessThanOrEqual(2_000);
        return fallback!;
      } });
      expect((await deps.probeScheduler(2_000)).status).toBe(expected);
      expect(calls).toEqual(fallback ? ["schtasks", "powershell"] : ["schtasks"]);
    }
  });

  test.skipIf(process.platform !== "win32" || process.arch !== "x64")("the child handle preserves distinct HRESULTs with the same low byte", async () => {
    const native = windowsProcessNative();
    expect(native?.captureChildExitCode).toBeFunction();
    for (const code of [0x80070002, 0x80041302]) {
      const child = Bun.spawn([resolveTrustedWindowsPowerShellExe(), "-NoProfile", "-NonInteractive", "-Command",
        `[Environment]::Exit(${code | 0})`], { stdout: "ignore", stderr: "ignore", windowsHide: true, timeout: SPAWN_BUDGET_MS });
      const readExitCode = native!.captureChildExitCode!(child.pid);
      await child.exited;
      expect(readExitCode?.()).toBe(code);
    }
  }, 2 * SPAWN_BUDGET_MS + 1_000);

  test("the fallback uses only the remaining time and a late answer is unknown", async () => {
    let now = 100;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    try {
      const deps = windowsCheckedStopLiveDeps({ run: async (program, _args, timeout) => {
        if (program === "schtasks") { now += 750; return result(1); }
        expect(timeout).toBe(1_250);
        now += timeout;
        return result(0, "absent");
      } });
      expect((await deps.probeScheduler(2_000)).status).toBe("unknown");
    } finally { clock.mockRestore(); }
  });

  test.skipIf(process.platform !== "win32" && !portablePowerShell)("only a missing task in an accessible root is absent", async () => {
    let script = "";
    await windowsCheckedStopLiveDeps({ run: async (program, args) => {
      if (program === "schtasks") return result(1);
      script = args.at(-1)!;
      return result(0, "unknown");
    } }).probeScheduler(2_000);
    const activation = "[Activator]::CreateInstance([type]::GetTypeFromProgID('Schedule.Service', $true))";
    expect(script).toContain(activation);
    const fixture = String.raw`
class SchedulerFixture {
  [void] Connect() { if ($global:scenario -eq 'connect') { throw [IO.FileNotFoundException]::new() } }
  [object] GetFolder([string] $path) {
    if ($path -cne '\' -or $global:scenario -eq 'folder') { throw [IO.FileNotFoundException]::new() }
    return $this
  }
  [object] GetTask([string] $name) {
    if ($name -cne 'opencodex-proxy') { throw 'wrong name' }
    if ($global:scenario -eq 'missing') { throw [Runtime.InteropServices.COMException]::new('missing', -2147024894) }
    if ($global:scenario -eq 'denied') { throw [UnauthorizedAccessException]::new() }
    if ($global:scenario -eq 'empty') { return $null }
    return $this
  }
}`;
    const command = fixture + "\nforeach ($global:scenario in 'found','missing','denied','connect','folder','empty') { & {\n"
      + script.replace(activation, "[SchedulerFixture]::new()") + "\n} }";
    const powershell = process.platform === "win32" ? resolveTrustedWindowsPowerShellExe() : portablePowerShell!;
    const child = Bun.spawn([powershell, "-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(command, "utf16le").toString("base64")], { stdout: "pipe", stderr: "pipe", windowsHide: true, timeout: SPAWN_BUDGET_MS });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, err, lines: out.trim().split(/\r?\n/) }).toEqual({ code: 0, err: "", lines: ["present", "absent", "unknown", "unknown", "unknown", "unknown"] });
  }, SPAWN_BUDGET_MS + 1_000);
});

test.skipIf(process.platform !== "win32" && !portablePowerShell)("the PowerShell helper stops captured instances only after every proof succeeds", async () => {
  const powershell = process.platform === "win32" ? resolveTrustedWindowsPowerShellExe() : portablePowerShell!;
  const fixture = String.raw`
$script:scenario = $args[0]
$script:sid = 'S-1-5-21-100-200-300-1001'
$script:taskReads = 0
$script:elapsed = 0
function Start-FixtureClock {
  $clock = [pscustomobject]@{ Started = $script:elapsed }
  $clock | Add-Member ScriptProperty ElapsedMilliseconds { $script:elapsed - $this.Started }
  $clock
}
function Read-FixtureApproval {
  if ($script:scenario -eq 'late-approval') { $script:elapsed = 2000 }
  [Console]::ReadLine()
}
$script:stopped = [Collections.Generic.List[int]]::new()
function New-Instance($enginePid) {
  $obj = [pscustomobject]@{ EnginePID = $enginePid; State = 4; InstanceGuid = [Guid]::NewGuid(); Reads = 0 }
  $obj | Add-Member ScriptMethod Refresh {
    $this.Reads++
    if ($script:scenario -eq 'engine-changed' -and $this.Reads -eq 2) { $this.EnginePID++ }
    if ($script:scenario -eq 'deadline-before-first' -and $this.Reads -eq 2) { $script:elapsed = 2000 }
  }
  $obj | Add-Member ScriptMethod Stop {
    $script:stopped.Add($this.EnginePID)
    if ($script:scenario -eq 'deadline-between-stops') { $script:elapsed = 2000 }
  }
  return $obj
}
$instances = [pscustomobject]@{ Rows = @((New-Instance 42), (New-Instance 43)) }
$instances | Add-Member ScriptProperty Count { $this.Rows.Count }
$instances | Add-Member ScriptMethod Item { param($index) $this.Rows[$index - 1] }
$script:task = [pscustomobject]@{ Xml = 'original'; State = 4; Instances = $instances }
if ($script:scenario -in @('hidden', 'idle', 'idle-state-deadline')) { $instances.Rows = @() }
if ($script:scenario -eq 'idle') { $script:task.State = 3 }
if ($script:scenario -eq 'idle-state-deadline') {
  $script:task | Add-Member -Force ScriptProperty State {
    if ($script:taskReads -eq 2) { $script:elapsed = 2000 }
    3
  }
}
$script:task | Add-Member ScriptMethod GetInstances { param($flags) $this.Instances }
$script:folder = [pscustomobject]@{}
$script:folder | Add-Member ScriptMethod GetTask {
  param($taskName)
  if ($taskName -cne 'opencodex-proxy') { throw 'wrong task' }
  $script:taskReads++
  if ($script:scenario -eq 'replaced' -and $script:taskReads -eq 2) {
    return [pscustomobject]@{ Xml = 'replacement'; State = 4 }
  }
  $script:task
}
function New-Object {
  param($ComObject)
  if ($ComObject -ne 'FixtureScheduler') { throw 'wrong COM service' }
  $obj = [pscustomobject]@{}
  $obj | Add-Member ScriptMethod Connect {}
  $obj | Add-Member ScriptMethod GetFolder { param($path) if ($path -cne '\') { throw 'wrong folder' }; $script:folder }
  $obj
}
function Get-CimInstance {
  param($ClassName, $Filter, $InputObject, $OperationTimeoutSec)
  if ($InputObject) {
    if ($script:scenario -eq 'pid-reused') { return @{ CreationDate = 2 } }
    return $InputObject
  }
  return @{ CreationDate = 1; Pid = [int]($Filter -replace '^ProcessId = ', '') }
}
function Invoke-CimMethod {
  param($InputObject, $MethodName, $OperationTimeoutSec)
  if ($MethodName -ne 'GetOwnerSid') { throw 'wrong method' }
  $owner = if ($script:scenario -eq 'foreign' -and $InputObject.Pid -eq 43) { $script:sid + '1' } else { $script:sid }
  @{ ReturnValue = 0; Sid = $owner }
}
`;
  const helper = WINDOWS_TASK_INSTANCE_STOP_SCRIPT
    .replace("[Diagnostics.Stopwatch]::StartNew()", "Start-FixtureClock")
    .replace("[Console]::ReadLine()", "Read-FixtureApproval")
    .replace(/^\s*Import-Module .*'CimCmdlets\.psd1'.*$/m, "")
    .replaceAll("CimCmdlets\\", "")
    .replace("Microsoft.PowerShell.Utility\\New-Object -ComObject Schedule.Service", "New-Object -ComObject FixtureScheduler")
    .replace("[Security.Principal.WindowsIdentity]::GetCurrent()",
      "([pscustomobject]@{ User = @{ Value = $script:sid }; Name = 'HOST\\test' })");
  expect(helper).toContain("$service = New-Object -ComObject FixtureScheduler");
  expect(helper).not.toContain("Schedule.Service");
  // All launches share one 60 s window (each capped at the spawn budget), so a hang fails here
  // with the active scenario named, inside the 120 s Linux batch deadline.
  const deadline = Date.now() + 60_000;
  for (const [scenario, status, stopped] of [
    ["verified", "ended", "42,43"],
    ["replaced", "unverified-registration", ""],
    ["foreign", "unverified-registration", ""],
    ["pid-reused", "unverified-registration", ""],
    ["engine-changed", "unverified-registration", ""],
    ["rejected", "unverified-registration", ""],
    ["hidden", "unverified-registration", ""],
    ["idle", "not-running", ""],
    ["idle-state-deadline", "failed", ""],
    ["late-approval", "failed", ""],
    ["deadline-before-first", "failed", ""],
    ["deadline-between-stops", "failed", "42"],
  ]) {
    // Production runs the helper alone, which silences progress before its first module use. The fixture
    // runs first here and its Add-Member/[pscustomobject] calls autoload Microsoft.PowerShell.Utility, which
    // writes a "Preparing modules for first use" CLIXML progress record to stderr on a cold runner.
    const script = "$ProgressPreference = 'SilentlyContinue'; $args = @('" + scenario + "'); " + fixture + "\n& {\n" + helper + "\n}\n'Stopped=' + ($script:stopped -join ',')";
    const child = Bun.spawn([powershell, "-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64")], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      timeout: Math.max(1_000, Math.min(SPAWN_BUDGET_MS, deadline - Date.now())),
    });
    child.stdin.write(scenario === "rejected" ? "\n" : "stop-before 2000\n");
    child.stdin.end();
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ scenario, stderr, code, output: stdout.trim().split(/\r?\n/).slice(-2) })
      .toEqual({ scenario, stderr: "", code: 0, output: [status, "Stopped=" + stopped] });
  }
}, 65_000);

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
