import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  OCX_ELEVATED_CREATE_FAILED,
  OCX_ELEVATED_PROTOCOL_CODES,
  OCX_ELEVATED_PROTOCOL_FAILED,
  OCX_ELEVATED_RUN_FAILED_ROLLBACK_FAILED,
  OCX_ELEVATED_RUN_FAILED_ROLLED_BACK,
  OCX_ELEVATED_SUCCESS,
  OCX_ELEVATED_UAC_CANCELLED,
  WindowsElevationError,
  buildElevatedSchtasksCreateAndRunScript,
  classifyElevatedSchedulerExitCode,
  raceWithTimeout,
  runElevatedSchtasksCreateAndRun,
  runWindowsElevated,
  runWindowsElevatedScheduledTaskRegistration,
  setWindowsElevationSpawnForTests,
  setTrustedWindowsElevationExecutablesForTests,
  startElevatedSchtasksCreateAndRun,
  startPowerShellCommand,
} from "../src/lib/windows-elevation";
import {
  evaluateSchedulerInstallRestartReconciliation,
  finalizeWindowsSchedulerServiceRegistration,
  schedulerVerificationMaySettle,
  setFinalizeWindowsSchedulerHooksForTests,
} from "../src/service";
import type { WindowsSchedulerInstallVerification } from "../src/service";

/** Linux CI fakes win32 without a real System32; keep elevation paths production-shaped. */
const FAKE_TRUSTED_ELEVATION_EXES = {
  powershell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  schtasks: "C:\\Windows\\System32\\schtasks.exe",
} as const;

describe("runWindowsElevated spawn contract", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "win32" });
    setTrustedWindowsElevationExecutablesForTests(FAKE_TRUSTED_ELEVATION_EXES);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    setTrustedWindowsElevationExecutablesForTests(null);
    setWindowsElevationSpawnForTests(null);
  });

  function fakeChild(opts: {
    code?: number | null;
    signal?: NodeJS.Signals | null;
    stderr?: string;
    stdout?: string;
    emitError?: NodeJS.ErrnoException;
    hang?: boolean;
  }) {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter & { setEncoding?: (enc: string) => void };
      stderr: EventEmitter & { setEncoding?: (enc: string) => void };
      kill: ReturnType<typeof mock>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = () => undefined;
    child.stderr.setEncoding = () => undefined;
    child.kill = mock(() => true);
    setWindowsElevationSpawnForTests((() => {
      queueMicrotask(() => {
        if (opts.emitError) {
          child.emit("error", opts.emitError);
          return;
        }
        if (opts.hang) return;
        if (opts.stdout) child.stdout.emit("data", opts.stdout);
        if (opts.stderr) child.stderr.emit("data", opts.stderr);
        child.emit("close", "code" in opts ? opts.code! : 0, opts.signal ?? null);
      });
      return child as never;
    }) as never);
    return child;
  }

  test("an armed test cannot launch the live Windows elevation boundary", async () => {
    // The probe is deliberately inert: if the guard regresses, it can only start an
    // non-RunAs PowerShell executing a fixed exit 0, never UAC or Task Scheduler mutation.
    const execution = startPowerShellCommand("exit 0");
    expect(execution.launcherPid).toBeNull();
    await expect(execution.completion).rejects.toThrow(
      "Refusing to launch a live Windows elevation process from an armed test process",
    );
  });

  test("returns exit code 0", async () => {
    fakeChild({ code: 0 });
    await expect(runWindowsElevated("schtasks.exe", ["/query"])).resolves.toBe(0);
  });

  test("PowerShell script treats a missing ExitCode as protocol failure", async () => {
    let commandScript = "";
    setWindowsElevationSpawnForTests(((
      _cmd: string,
      args: ReadonlyArray<string>,
    ) => {
      commandScript = String(args[args.length - 1] ?? "");
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter & { setEncoding?: (enc: string) => void };
        stderr: EventEmitter & { setEncoding?: (enc: string) => void };
        kill: ReturnType<typeof mock>;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdout.setEncoding = () => undefined;
      child.stderr.setEncoding = () => undefined;
      child.kill = mock(() => true);
      queueMicrotask(() => child.emit("close", 0, null));
      return child as never;
    }) as never);

    await runWindowsElevated("schtasks.exe", ["/create"]);
    expect(commandScript).toContain(`if ($null -eq $p.ExitCode) { exit ${OCX_ELEVATED_PROTOCOL_FAILED} }`);
    expect(commandScript).toContain("$null = $p.Handle;");
    expect(commandScript).not.toContain("$p.Handleif");
    expect(commandScript).toMatch(/\$null = \$p\.Handle;\s*if \(\$null -eq \$p\.ExitCode\)/);
  });

  test("returns non-zero exit codes from completed elevated processes", async () => {
    fakeChild({ code: 1, stderr: "failed" });
    await expect(runWindowsElevated("schtasks.exe", ["/create"])).resolves.toBe(1);
  });

  test("keeps scheduled-task elevation arguments in one Start-Process statement", async () => {
    let commandScript = "";
    setWindowsElevationSpawnForTests(((
      _cmd: string,
      args: ReadonlyArray<string>,
    ) => {
      commandScript = String(args[args.length - 1] ?? "");
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter & { setEncoding?: (enc: string) => void };
        stderr: EventEmitter & { setEncoding?: (enc: string) => void };
        kill: ReturnType<typeof mock>;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdout.setEncoding = () => undefined;
      child.stderr.setEncoding = () => undefined;
      child.kill = mock(() => true);
      queueMicrotask(() => child.emit("close", 0, null));
      return child as never;
    }) as never);

    await expect(runWindowsElevatedScheduledTaskRegistration(
      "opencodex-proxy",
      "<Task />",
    )).resolves.toBe(0);

    const startProcessIndex = commandScript.indexOf("Start-Process");
    const filePathIndex = commandScript.indexOf(" -FilePath ");
    const argumentListIndex = commandScript.indexOf(" -ArgumentList ");
    const verbIndex = commandScript.indexOf(" -Verb RunAs ");
    const waitIndex = commandScript.indexOf(" -Wait");
    const firstTerminator = commandScript.indexOf(";");

    expect(startProcessIndex).toBeGreaterThanOrEqual(0);
    expect(filePathIndex).toBeGreaterThan(startProcessIndex);
    expect(argumentListIndex).toBeGreaterThan(filePathIndex);
    expect(verbIndex).toBeGreaterThan(argumentListIndex);
    expect(waitIndex).toBeGreaterThan(verbIndex);
    expect(firstTerminator).toBeGreaterThan(waitIndex);
    expect(commandScript.match(/Start-Process/g)).toHaveLength(1);
    expect(commandScript).not.toMatch(/powershell\.exe';\s+-ArgumentList/i);
    expect(commandScript).not.toMatch(/-ArgumentList\s+'[^']*';\s+-Verb RunAs/);
  });

  test("scheduled-task registration embeds immutable XML bytes instead of a file path", async () => {
    let commandScript = "";
    setWindowsElevationSpawnForTests(((
      _cmd: string,
      args: ReadonlyArray<string>,
    ) => {
      commandScript = String(args[args.length - 1] ?? "");
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter & { setEncoding?: (enc: string) => void };
        stderr: EventEmitter & { setEncoding?: (enc: string) => void };
        kill: ReturnType<typeof mock>;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdout.setEncoding = () => undefined;
      child.stderr.setEncoding = () => undefined;
      child.kill = mock(() => true);
      queueMicrotask(() => child.emit("close", 0, null));
      return child as never;
    }) as never);

    const xml = "<Task><Description>fixed-definition</Description></Task>";
    await expect(runWindowsElevatedScheduledTaskRegistration("opencodex-proxy", xml)).resolves.toBe(0);
    const match = /-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(commandScript);
    expect(match).not.toBeNull();
    const elevatedScript = Buffer.from(match![1]!, "base64").toString("utf16le");
    expect(elevatedScript).toContain(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules\\ScheduledTasks\\ScheduledTasks.psd1",
    );
    expect(elevatedScript).toContain("Microsoft.PowerShell.Core\\Import-Module");
    expect(elevatedScript).toContain("$module.ExportedCommands['Register-ScheduledTask']");
    expect(elevatedScript).toContain(
      "Trusted ScheduledTasks module does not export Register-ScheduledTask.",
    );
    expect(elevatedScript).toContain("& $registerTask -TaskName $taskName -Xml $xml -ErrorAction Stop");
    expect(elevatedScript).not.toContain("-Xml $xml -Force");
    expect(elevatedScript.match(/\bRegister-ScheduledTask\b/g)).toHaveLength(2);
    expect(elevatedScript).toContain(Buffer.from(xml, "utf16le").toString("base64"));
    expect(commandScript).not.toContain("/xml");
    expect(commandScript).not.toContain("task.xml");

    const predecessor = "<Task><Description>captured-predecessor</Description></Task>";
    await expect(
      runWindowsElevatedScheduledTaskRegistration("opencodex-proxy", xml, true, predecessor),
    ).resolves.toBe(0);
    const replaceMatch = /-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(commandScript);
    expect(replaceMatch).not.toBeNull();
    const replaceScript = Buffer.from(replaceMatch![1]!, "base64").toString("utf16le");
    expect(replaceScript).toContain("& $registerTask -TaskName $taskName -Xml $xml -Force");
    expect(replaceScript).toContain(Buffer.from(predecessor, "utf16le").toString("base64"));
    expect(replaceScript).toContain("$currentXml = & $schtasks /query /tn $taskName /xml");
    expect(replaceScript).toContain("Task Scheduler replacement precondition changed.");
  });

  test("maps exit 1223 to cancelled", async () => {
    fakeChild({ code: OCX_ELEVATED_UAC_CANCELLED });
    await expect(runWindowsElevated("schtasks.exe", ["/create"])).rejects.toMatchObject({
      name: "WindowsElevationError",
      reason: "cancelled",
    });
  });

  test("maps PowerShell cancellation text to cancelled", async () => {
    fakeChild({ code: 1, stderr: "Start-Process : The operation was canceled by the user." });
    try {
      await runWindowsElevated("schtasks.exe", ["/create"]);
      throw new Error("expected cancellation");
    } catch (error) {
      expect(error).toBeInstanceOf(WindowsElevationError);
      expect((error as WindowsElevationError).reason).toBe("cancelled");
      expect((error as Error).message).toContain("UAC prompt was cancelled");
    }
  });

  test("does not treat UAC-cancel text as cancelled when exit code is 0", async () => {
    fakeChild({ code: 0, stderr: "Start-Process : The operation was canceled by the user." });
    await expect(runWindowsElevated("schtasks.exe", ["/create"])).resolves.toBe(0);
  });

  test("maps ENOENT launch failure", async () => {
    fakeChild({ emitError: Object.assign(new Error("spawn powershell ENOENT"), { code: "ENOENT" }) });
    await expect(runWindowsElevated("schtasks.exe", ["/create"])).rejects.toMatchObject({
      reason: "launch-failed",
    });
  });

  test("maps signal termination", async () => {
    fakeChild({ code: null, signal: "SIGTERM" });
    await expect(runWindowsElevated("schtasks.exe", ["/create"])).rejects.toMatchObject({
      reason: "terminated",
    });
  });

  test("request timeout does not kill the launcher; late close still settles once", async () => {
    const child = fakeChild({ hang: true });
    const started = startPowerShellCommand("Start-Process -Verb RunAs");
    const raced = await raceWithTimeout(started.completion, 30);
    expect(raced.status).toBe("timed-out");
    expect(child.kill).not.toHaveBeenCalled();

    let late: { exitCode: number } | null = null;
    const lateWait = started.completion.then(value => { late = value; });
    child.emit("close", OCX_ELEVATED_SUCCESS, null);
    await lateWait;
    expect(late).toEqual({ exitCode: OCX_ELEVATED_SUCCESS, stdout: "", stderr: "" });
    child.emit("close", 1, null); // second close must not double-settle
    await Promise.resolve();
    expect(late?.exitCode).toBe(OCX_ELEVATED_SUCCESS);
  });

  test("launcher error before elevation settles as launch-failed without hang", async () => {
    fakeChild({ emitError: Object.assign(new Error("spawn failed"), { code: "EACCES" }) });
    const started = startPowerShellCommand("Start-Process -Verb RunAs");
    await expect(started.completion).rejects.toMatchObject({ reason: "launch-failed" });
  });

  test("bounds captured stdout and stderr", async () => {
    const huge = "x".repeat(300_000);
    fakeChild({ code: 1, stdout: huge, stderr: huge });
    await expect(runWindowsElevated("schtasks.exe", ["/create"])).resolves.toBe(1);
  });

  test("startElevatedSchtasksCreateAndRun exposes completion after request race timeout", async () => {
    const child = fakeChild({ hang: true });
    const started = startElevatedSchtasksCreateAndRun(
      "schtasks.exe",
      ["/create", "/tn", "opencodex-proxy", "/f"],
      ["/run", "/tn", "opencodex-proxy"],
      ["/delete", "/tn", "opencodex-proxy", "/f"],
    );
    const raced = await raceWithTimeout(started.completion, 20);
    expect(raced.status).toBe("timed-out");
    expect(child.kill).not.toHaveBeenCalled();
    child.emit("close", OCX_ELEVATED_CREATE_FAILED, null);
    await expect(started.completion).resolves.toMatchObject({
      outcome: "create-failed",
      exitCode: OCX_ELEVATED_CREATE_FAILED,
    });
  });

  test("rejects on non-Windows platforms", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    await expect(runWindowsElevated("schtasks.exe", ["/create"])).rejects.toMatchObject({
      reason: "launch-failed",
    });
  });
});

describe("elevated scheduler protocol codes", () => {
  test("reserved codes are unique and exclude UAC cancellation", () => {
    const set = new Set<number>(OCX_ELEVATED_PROTOCOL_CODES);
    expect(set.size).toBe(OCX_ELEVATED_PROTOCOL_CODES.length);
    expect(set.has(OCX_ELEVATED_UAC_CANCELLED)).toBe(false);
    expect(classifyElevatedSchedulerExitCode(OCX_ELEVATED_SUCCESS)).toBe("success");
    expect(classifyElevatedSchedulerExitCode(OCX_ELEVATED_CREATE_FAILED)).toBe("create-failed");
    expect(classifyElevatedSchedulerExitCode(OCX_ELEVATED_RUN_FAILED_ROLLED_BACK)).toBe("run-failed-rolled-back");
    expect(classifyElevatedSchedulerExitCode(OCX_ELEVATED_RUN_FAILED_ROLLBACK_FAILED)).toBe("run-failed-rollback-failed");
    expect(classifyElevatedSchedulerExitCode(OCX_ELEVATED_PROTOCOL_FAILED)).toBe("protocol-failed");
    expect(classifyElevatedSchedulerExitCode(1)).toBe("protocol-failed");
    expect(classifyElevatedSchedulerExitCode(-1)).toBe("protocol-failed");
    expect(classifyElevatedSchedulerExitCode(99999)).toBe("protocol-failed");
    expect(classifyElevatedSchedulerExitCode(OCX_ELEVATED_UAC_CANCELLED)).toBe("protocol-failed");
  });
});

describe("one-UAC create/run/rollback elevated script", () => {
  test("embeds create, run, and delete rollback without a second RunAs or temp file writes", () => {
    const script = buildElevatedSchtasksCreateAndRunScript(
      "C:\\Windows\\System32\\schtasks.exe",
      ["/create", "/tn", "opencodex-proxy", "/xml", "C:\\Users\\Jane Doe\\task.xml", "/f"],
      ["/run", "/tn", "opencodex-proxy"],
      ["/delete", "/tn", "opencodex-proxy", "/f"],
    );
    expect(script).toContain("Invoke-OcxSchtasks");
    expect(script).toContain(`exit ${OCX_ELEVATED_CREATE_FAILED}`);
    expect(script).toContain(`exit ${OCX_ELEVATED_SUCCESS}`);
    expect(script).toContain(`exit ${OCX_ELEVATED_RUN_FAILED_ROLLED_BACK}`);
    expect(script).toContain(`exit ${OCX_ELEVATED_RUN_FAILED_ROLLBACK_FAILED}`);
    expect(script).toContain('"C:\\Users\\Jane Doe\\task.xml"');
    expect(script).not.toContain("-Verb RunAs");
    expect(script).not.toMatch(/Set-Content|Out-File|Add-Content|New-Item/i);
    expect(script).not.toMatch(/TEMP|tmpdir|ocx-elev/i);
  });
});

describe("finalizeWindowsSchedulerServiceRegistration", () => {
  const originalPlatform = process.platform;
  let elevateLaunches = 0;
  let writeCount = 0;
  let parentRollbackLaunches = 0;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "win32" });
    setTrustedWindowsElevationExecutablesForTests(FAKE_TRUSTED_ELEVATION_EXES);
    elevateLaunches = 0;
    writeCount = 0;
    parentRollbackLaunches = 0;
    setFinalizeWindowsSchedulerHooksForTests(null);
    setWindowsElevationSpawnForTests(null);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    setTrustedWindowsElevationExecutablesForTests(null);
    setFinalizeWindowsSchedulerHooksForTests(null);
    setWindowsElevationSpawnForTests(null);
  });

  function okVerify() {
    return {
      taskInstalled: true,
      registrationHealthy: true,
      registrationInvalid: false,
      assetsHealthy: true,
      nativeServiceAbsent: true,
      nativeStatusUnknown: false,
      conflict: false,
      ok: true,
      detail: "ok",
    };
  }

  function mockParentRollbackSpawn() {
    setWindowsElevationSpawnForTests((() => {
      parentRollbackLaunches += 1;
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter & { setEncoding?: (enc: string) => void };
        stderr: EventEmitter & { setEncoding?: (enc: string) => void };
        kill: ReturnType<typeof mock>;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdout.setEncoding = () => undefined;
      child.stderr.setEncoding = () => undefined;
      child.kill = mock(() => true);
      queueMicrotask(() => child.emit("close", 0, null));
      return child as never;
    }) as never);
  }

  test("successful create+run uses exactly one elevated launcher and writes install state", async () => {
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: async () => {
        elevateLaunches += 1;
        return { outcome: "success", exitCode: OCX_ELEVATED_SUCCESS, stdout: "", stderr: "" };
      },
      verify: okVerify,
      writeInstallState: () => { writeCount += 1; },
    });

    const result = await finalizeWindowsSchedulerServiceRegistration("C:\\Users\\x\\.opencodex\\opencodex-service.cmd");
    expect(result).toEqual({ kind: "done" });
    expect(elevateLaunches).toBe(1);
    expect(writeCount).toBe(1);
    expect(parentRollbackLaunches).toBe(0);
  });

  test("create failure does not write install state or parent-rollback", async () => {
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: async () => {
        elevateLaunches += 1;
        return { outcome: "create-failed", exitCode: OCX_ELEVATED_CREATE_FAILED, stdout: "", stderr: "" };
      },
      writeInstallState: () => { writeCount += 1; },
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toThrow(/\/create failed/);
    expect(elevateLaunches).toBe(1);
    expect(writeCount).toBe(0);
  });

  test("run failure with in-process rollback does not write install state or launch a second UAC", async () => {
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: async () => {
        elevateLaunches += 1;
        return {
          outcome: "run-failed-rolled-back",
          exitCode: OCX_ELEVATED_RUN_FAILED_ROLLED_BACK,
          stdout: "",
          stderr: "",
        };
      },
      writeInstallState: () => { writeCount += 1; },
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toThrow(/rolled the task back/);
    expect(elevateLaunches).toBe(1);
    expect(writeCount).toBe(0);
    expect(parentRollbackLaunches).toBe(0);
  });

  test("run failure with in-process rollback failure reports partial install", async () => {
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: async () => {
        elevateLaunches += 1;
        return {
          outcome: "run-failed-rollback-failed",
          exitCode: OCX_ELEVATED_RUN_FAILED_ROLLBACK_FAILED,
          stdout: "",
          stderr: "",
        };
      },
      writeInstallState: () => { writeCount += 1; },
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toThrow(/partial Task Scheduler/);
    expect(elevateLaunches).toBe(1);
    expect(writeCount).toBe(0);
  });

  test("UAC cancellation during create+run does not write install state", async () => {
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: async () => {
        elevateLaunches += 1;
        throw new WindowsElevationError(
          "cancelled",
          "Windows administrator approval was required, but the UAC prompt was cancelled or denied.",
        );
      },
      writeInstallState: () => { writeCount += 1; },
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toMatchObject({ reason: "cancelled" });
    expect(elevateLaunches).toBe(1);
    expect(writeCount).toBe(0);
  });

  test("request timeout returns indeterminate, keeps observing, and reconciles late success", async () => {
    let resolveCompletion!: (value: {
      outcome: "success";
      exitCode: number;
      stdout: string;
      stderr: string;
    }) => void;
    const completion = new Promise<{
      outcome: "success";
      exitCode: number;
      stdout: string;
      stderr: string;
    }>(resolve => { resolveCompletion = resolve; });

    setFinalizeWindowsSchedulerHooksForTests({
      startElevateCreateAndRun: () => {
        elevateLaunches += 1;
        return { completion, launcherPid: 4242 };
      },
      verify: okVerify,
      writeInstallState: () => { writeCount += 1; },
      requestTimeoutMs: 25,
    });

    const result = await finalizeWindowsSchedulerServiceRegistration(
      "C:\\Users\\x\\.opencodex\\opencodex-service.cmd",
    );
    expect(result.kind).toBe("indeterminate");
    expect(writeCount).toBe(0);

    resolveCompletion({
      outcome: "success",
      exitCode: OCX_ELEVATED_SUCCESS,
      stdout: "",
      stderr: "",
    });
    if (result.kind !== "indeterminate") throw new Error("expected indeterminate");
    await expect(result.reconciliation).resolves.toBe("released");
    expect(writeCount).toBe(1);
    expect(elevateLaunches).toBe(1);
  });

  test("late create-failed after timeout does not write install state and releases", async () => {
    let resolveCompletion!: (value: {
      outcome: "create-failed";
      exitCode: number;
      stdout: string;
      stderr: string;
    }) => void;
    const completion = new Promise<{
      outcome: "create-failed";
      exitCode: number;
      stdout: string;
      stderr: string;
    }>(resolve => { resolveCompletion = resolve; });

    setFinalizeWindowsSchedulerHooksForTests({
      startElevateCreateAndRun: () => {
        elevateLaunches += 1;
        return { completion, launcherPid: 1 };
      },
      writeInstallState: () => { writeCount += 1; },
      taskInstalled: () => false,
      requestTimeoutMs: 20,
    });

    const result = await finalizeWindowsSchedulerServiceRegistration();
    expect(result.kind).toBe("indeterminate");
    resolveCompletion({
      outcome: "create-failed",
      exitCode: OCX_ELEVATED_CREATE_FAILED,
      stdout: "",
      stderr: "",
    });
    if (result.kind !== "indeterminate") throw new Error("expected indeterminate");
    await expect(result.reconciliation).resolves.toBe("released");
    expect(writeCount).toBe(0);
  });

  test("late run-failed-rolled-back after timeout releases without writing state", async () => {
    let resolveCompletion!: (value: {
      outcome: "run-failed-rolled-back";
      exitCode: number;
      stdout: string;
      stderr: string;
    }) => void;
    const completion = new Promise<{
      outcome: "run-failed-rolled-back";
      exitCode: number;
      stdout: string;
      stderr: string;
    }>(resolve => { resolveCompletion = resolve; });

    setFinalizeWindowsSchedulerHooksForTests({
      startElevateCreateAndRun: () => ({ completion, launcherPid: 1 }),
      writeInstallState: () => { writeCount += 1; },
      requestTimeoutMs: 20,
    });

    const result = await finalizeWindowsSchedulerServiceRegistration();
    resolveCompletion({
      outcome: "run-failed-rolled-back",
      exitCode: OCX_ELEVATED_RUN_FAILED_ROLLED_BACK,
      stdout: "",
      stderr: "",
    });
    if (result.kind !== "indeterminate") throw new Error("expected indeterminate");
    await expect(result.reconciliation).resolves.toBe("released");
    expect(writeCount).toBe(0);
  });

  test("late run-failed-rollback-failed after timeout blocks further installs", async () => {
    let resolveCompletion!: (value: {
      outcome: "run-failed-rollback-failed";
      exitCode: number;
      stdout: string;
      stderr: string;
    }) => void;
    const completion = new Promise<{
      outcome: "run-failed-rollback-failed";
      exitCode: number;
      stdout: string;
      stderr: string;
    }>(resolve => { resolveCompletion = resolve; });

    setFinalizeWindowsSchedulerHooksForTests({
      startElevateCreateAndRun: () => ({ completion, launcherPid: 1 }),
      writeInstallState: () => { writeCount += 1; },
      requestTimeoutMs: 20,
    });

    const result = await finalizeWindowsSchedulerServiceRegistration();
    resolveCompletion({
      outcome: "run-failed-rollback-failed",
      exitCode: OCX_ELEVATED_RUN_FAILED_ROLLBACK_FAILED,
      stdout: "",
      stderr: "",
    });
    if (result.kind !== "indeterminate") throw new Error("expected indeterminate");
    await expect(result.reconciliation).resolves.toBe("blocked-partial");
    expect(writeCount).toBe(0);
  });

  test("late protocol-failed with unknown task probe stays blocked-partial and never writes state", async () => {
    let resolveCompletion!: (value: {
      outcome: "protocol-failed";
      exitCode: number;
      stdout: string;
      stderr: string;
    }) => void;
    const completion = new Promise<{
      outcome: "protocol-failed";
      exitCode: number;
      stdout: string;
      stderr: string;
    }>(resolve => { resolveCompletion = resolve; });

    setFinalizeWindowsSchedulerHooksForTests({
      startElevateCreateAndRun: () => ({ completion, launcherPid: 1 }),
      writeInstallState: () => { writeCount += 1; },
      probeTask: () => ({ status: "unknown", detail: "Access is denied…" }),
      requestTimeoutMs: 20,
    });

    const result = await finalizeWindowsSchedulerServiceRegistration();
    expect(result.kind).toBe("indeterminate");
    resolveCompletion({
      outcome: "protocol-failed",
      exitCode: OCX_ELEVATED_PROTOCOL_FAILED,
      stdout: "",
      stderr: "",
    });
    if (result.kind !== "indeterminate") throw new Error("expected indeterminate");
    await expect(result.reconciliation).resolves.toBe("blocked-partial");
    expect(writeCount).toBe(0);
  });

  test("stale attempt ownership prevents late write", async () => {
    let resolveCompletion!: (value: {
      outcome: "success";
      exitCode: number;
      stdout: string;
      stderr: string;
    }) => void;
    const completion = new Promise<{
      outcome: "success";
      exitCode: number;
      stdout: string;
      stderr: string;
    }>(resolve => { resolveCompletion = resolve; });
    const owned = new Set<string>(["attempt-a"]);

    setFinalizeWindowsSchedulerHooksForTests({
      startElevateCreateAndRun: () => ({ completion, launcherPid: 1 }),
      verify: okVerify,
      writeInstallState: () => { writeCount += 1; },
      stillOwnsAttempt: id => owned.has(id),
      requestTimeoutMs: 20,
    });

    const result = await finalizeWindowsSchedulerServiceRegistration(
      undefined,
      { attemptId: "attempt-a" },
    );
    expect(result.kind).toBe("indeterminate");
    owned.delete("attempt-a");
    resolveCompletion({
      outcome: "success",
      exitCode: OCX_ELEVATED_SUCCESS,
      stdout: "",
      stderr: "",
    });
    if (result.kind !== "indeterminate") throw new Error("expected indeterminate");
    await expect(result.reconciliation).resolves.toBe("released");
    expect(writeCount).toBe(0);
  });

  test("launch failure during create+run does not write install state", async () => {
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: async () => {
        elevateLaunches += 1;
        throw new WindowsElevationError("launch-failed", "Windows PowerShell was not found for elevation.");
      },
      writeInstallState: () => { writeCount += 1; },
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toMatchObject({ reason: "launch-failed" });
    expect(writeCount).toBe(0);
  });

  test("signal termination during create+run surfaces reconciliation detail", async () => {
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: async () => {
        elevateLaunches += 1;
        throw new WindowsElevationError("terminated", "Windows elevation terminated by SIGTERM.");
      },
      writeInstallState: () => { writeCount += 1; },
      taskInstalled: () => false,
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toThrow(/unknown result/);
    expect(writeCount).toBe(0);
  });

  test("signal termination with leftover task reports cleanup guidance", async () => {
    mockParentRollbackSpawn();
    let calls = 0;
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: async () => {
        elevateLaunches += 1;
        throw new WindowsElevationError("terminated", "Windows elevation terminated by SIGTERM.");
      },
      writeInstallState: () => { writeCount += 1; },
      taskInstalled: () => {
        calls += 1;
        return calls === 1;
      },
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toThrow(/unknown result|Cleanup/);
    expect(writeCount).toBe(0);
    expect(parentRollbackLaunches).toBe(1);
  });

  test("protocol-failed with no task present reconciles without inventing a phase", async () => {
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: async () => {
        elevateLaunches += 1;
        return { outcome: "protocol-failed", exitCode: 99, stdout: "", stderr: "" };
      },
      writeInstallState: () => { writeCount += 1; },
      taskInstalled: () => false,
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toThrow(/unknown result/);
    expect(writeCount).toBe(0);
  });

  test("protocol-failed with task present attempts parent cleanup and does not write state", async () => {
    mockParentRollbackSpawn();
    let calls = 0;
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: async () => {
        elevateLaunches += 1;
        return { outcome: "protocol-failed", exitCode: OCX_ELEVATED_PROTOCOL_FAILED, stdout: "", stderr: "" };
      },
      writeInstallState: () => { writeCount += 1; },
      taskInstalled: () => {
        calls += 1;
        return calls === 1; // present before cleanup, absent after
      },
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toThrow(/unknown result/);
    expect(elevateLaunches).toBe(1);
    expect(parentRollbackLaunches).toBe(1);
    expect(writeCount).toBe(0);
  });

  test("verification conflict rolls back and does not write install state", async () => {
    mockParentRollbackSpawn();
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: async () => {
        elevateLaunches += 1;
        return { outcome: "success", exitCode: OCX_ELEVATED_SUCCESS, stdout: "", stderr: "" };
      },
      verify: () => ({
        taskInstalled: true,
        registrationHealthy: true,
        registrationInvalid: false,
        assetsHealthy: true,
        nativeServiceAbsent: false,
        nativeStatusUnknown: false,
        conflict: true,
        ok: false,
        detail: "CONFLICT: Task Scheduler and native WinSW are both present.",
      }),
      writeInstallState: () => { writeCount += 1; },
      taskInstalled: () => false,
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toThrow(/CONFLICT/);
    expect(elevateLaunches).toBe(1);
    expect(writeCount).toBe(0);
    expect(parentRollbackLaunches).toBe(1);
  });

  test("unknown WinSW status fails closed without claiming conflict and without rollback", async () => {
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: async () => {
        elevateLaunches += 1;
        return { outcome: "success", exitCode: OCX_ELEVATED_SUCCESS, stdout: "", stderr: "" };
      },
      verify: () => ({
        taskInstalled: true,
        registrationHealthy: true,
        registrationInvalid: false,
        assetsHealthy: true,
        nativeServiceAbsent: false,
        nativeStatusUnknown: true,
        conflict: false,
        ok: false,
        detail: "The Task Scheduler task was created, but OpenCodex could not verify that the native WinSW service is absent.",
      }),
      writeInstallState: () => { writeCount += 1; },
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toThrow(/could not verify/);
    expect(elevateLaunches).toBe(1);
    expect(writeCount).toBe(0);
    expect(parentRollbackLaunches).toBe(0);
  });

  // --- Post-create settle (#868) -------------------------------------------------
  //
  // Task Scheduler's non-elevated view can lag an elevated /create, so a one-shot
  // verification rolls back a task that is merely not visible yet. These cases pin
  // both halves: the lagging view must settle, and every fail-closed state must
  // still fail closed without spending a single delay.

  function absentVerify(): WindowsSchedulerInstallVerification {
    return {
      taskInstalled: false,
      registrationHealthy: false,
      registrationInvalid: false,
      assetsHealthy: true,
      nativeServiceAbsent: true,
      nativeStatusUnknown: false,
      conflict: false,
      ok: false,
      detail: "Task Scheduler task is not installed.",
    };
  }

  // Transient lag: the task is visible but its XML has not been published yet.
  function unhealthyVerify(): WindowsSchedulerInstallVerification {
    return {
      taskInstalled: true,
      registrationHealthy: false,
      registrationInvalid: false,
      assetsHealthy: true,
      nativeServiceAbsent: true,
      nativeStatusUnknown: false,
      conflict: false,
      ok: false,
      detail: "Task Scheduler registration is present but unhealthy.",
    };
  }

  // Permanent invalidity: the XML IS published and violates the contract.
  function invalidVerify(): WindowsSchedulerInstallVerification {
    return {
      taskInstalled: true,
      registrationHealthy: false,
      registrationInvalid: true,
      assetsHealthy: true,
      nativeServiceAbsent: true,
      nativeStatusUnknown: false,
      conflict: false,
      ok: false,
      detail: "Task Scheduler registration is present but unhealthy.",
    };
  }

  function succeedingElevation() {
    return async () => {
      elevateLaunches += 1;
      return { outcome: "success" as const, exitCode: OCX_ELEVATED_SUCCESS, stdout: "", stderr: "" };
    };
  }

  test("a lagging scheduler view settles into a healthy install instead of rolling back", async () => {
    mockParentRollbackSpawn();
    const delays: number[] = [];
    const sequence = [absentVerify(), unhealthyVerify(), okVerify()];
    let probes = 0;
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: succeedingElevation(),
      verify: () => sequence[probes++] ?? okVerify(),
      settleDelay: async ms => { delays.push(ms); },
      writeInstallState: () => { writeCount += 1; },
    });

    const result = await finalizeWindowsSchedulerServiceRegistration();
    expect(result).toEqual({ kind: "done" });
    expect(probes).toBe(3);
    expect(delays).toEqual([50, 150]);
    expect(writeCount).toBe(1);
    expect(parentRollbackLaunches).toBe(0);
  });

  test("a persistently unhealthy registration exhausts the bounded budget and then rolls back", async () => {
    mockParentRollbackSpawn();
    const delays: number[] = [];
    let probes = 0;
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: succeedingElevation(),
      verify: () => { probes += 1; return unhealthyVerify(); },
      settleDelay: async ms => { delays.push(ms); },
      writeInstallState: () => { writeCount += 1; },
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toThrow(/present but unhealthy/);
    expect(probes).toBe(5);
    expect(delays).toEqual([50, 150, 300, 600]);
    expect(writeCount).toBe(0);
    expect(parentRollbackLaunches).toBe(1);
  });

  test("a published-but-invalid registration rolls back immediately with zero delays", async () => {
    mockParentRollbackSpawn();
    const delays: number[] = [];
    let probes = 0;
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: succeedingElevation(),
      verify: () => { probes += 1; return invalidVerify(); },
      settleDelay: async ms => { delays.push(ms); },
      writeInstallState: () => { writeCount += 1; },
    });

    // Permanent invalidity: ONE probe, no settle delay, rollback right away —
    // waiting can never repair published-but-violating XML.
    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toThrow(/present but unhealthy/);
    expect(probes).toBe(1);
    expect(delays).toEqual([]);
    expect(writeCount).toBe(0);
    expect(parentRollbackLaunches).toBe(1);
  });

  test("a proven conflict is never retried into success", async () => {
    mockParentRollbackSpawn();
    const delays: number[] = [];
    let probes = 0;
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: succeedingElevation(),
      verify: () => {
        probes += 1;
        return {
          taskInstalled: true,
          registrationHealthy: true,
          registrationInvalid: false,
          assetsHealthy: true,
          nativeServiceAbsent: false,
          nativeStatusUnknown: false,
          conflict: true,
          ok: false,
          detail: "CONFLICT: Task Scheduler and native WinSW are both present.",
        };
      },
      settleDelay: async ms => { delays.push(ms); },
      writeInstallState: () => { writeCount += 1; },
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toThrow(/CONFLICT/);
    expect(probes).toBe(1);
    expect(delays).toEqual([]);
    expect(writeCount).toBe(0);
    expect(parentRollbackLaunches).toBe(1);
  });

  test("missing assets fail immediately — waiting does not create files", async () => {
    mockParentRollbackSpawn();
    const delays: number[] = [];
    let probes = 0;
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: succeedingElevation(),
      verify: () => {
        probes += 1;
        return {
          taskInstalled: true,
          registrationHealthy: true,
          registrationInvalid: false,
          assetsHealthy: false,
          nativeServiceAbsent: true,
          nativeStatusUnknown: false,
          conflict: false,
          ok: false,
          detail: "Required scheduler service assets are missing.",
        };
      },
      settleDelay: async ms => { delays.push(ms); },
      writeInstallState: () => { writeCount += 1; },
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toThrow(/assets are missing/);
    expect(probes).toBe(1);
    expect(delays).toEqual([]);
    expect(writeCount).toBe(0);
    expect(parentRollbackLaunches).toBe(1);
  });

  test("a proven-present WinSW service blocks retry even before the task becomes visible", async () => {
    // conflict only turns true once the task itself is visible, so an invisible task
    // beside a running WinSW is `conflict: false, nativeServiceAbsent: false`. A
    // predicate that only checked `!conflict` would happily retry this.
    mockParentRollbackSpawn();
    const delays: number[] = [];
    let probes = 0;
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: succeedingElevation(),
      verify: () => {
        probes += 1;
        return {
          taskInstalled: false,
          registrationHealthy: false,
          registrationInvalid: false,
          assetsHealthy: true,
          nativeServiceAbsent: false,
          nativeStatusUnknown: false,
          conflict: false,
          ok: false,
          detail: "Task Scheduler task is not installed.",
        };
      },
      settleDelay: async ms => { delays.push(ms); },
      writeInstallState: () => { writeCount += 1; },
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toThrow(/not installed/);
    expect(probes).toBe(1);
    expect(delays).toEqual([]);
    expect(writeCount).toBe(0);
    expect(parentRollbackLaunches).toBe(1);
  });

  test("unknown WinSW status is unproven, not transient, and still preserves the task", async () => {
    mockParentRollbackSpawn();
    const delays: number[] = [];
    let probes = 0;
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: succeedingElevation(),
      verify: () => {
        probes += 1;
        return {
          taskInstalled: true,
          registrationHealthy: true,
          registrationInvalid: false,
          assetsHealthy: true,
          nativeServiceAbsent: false,
          nativeStatusUnknown: true,
          conflict: false,
          ok: false,
          detail: "The Task Scheduler task was created, but OpenCodex could not verify that the native WinSW service is absent.",
        };
      },
      settleDelay: async ms => { delays.push(ms); },
      writeInstallState: () => { writeCount += 1; },
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toThrow(/could not verify/);
    expect(probes).toBe(1);
    expect(delays).toEqual([]);
    expect(writeCount).toBe(0);
    expect(parentRollbackLaunches).toBe(0);
  });

  test("the settle predicate refuses every unproven state on its own terms", () => {
    // The end-to-end unknown-SCM test above cannot isolate this: its fixture has
    // taskInstalled and registrationHealthy both true, so the FINAL clause is
    // already false and deleting an earlier guard leaves it green. Exercising the
    // predicate directly with a transient-looking tail (invisible task) is what
    // proves each guard carries its own weight.
    const transientTail: WindowsSchedulerInstallVerification = {
      taskInstalled: false,
      registrationHealthy: false,
      registrationInvalid: false,
      assetsHealthy: true,
      nativeServiceAbsent: true,
      nativeStatusUnknown: false,
      conflict: false,
      ok: false,
      detail: "Task Scheduler task is not installed.",
    };

    // Baseline: a scheduler view that has genuinely not caught up may settle.
    expect(schedulerVerificationMaySettle(transientTail)).toBe(true);

    // Each of these is unproven or permanent, and must refuse even though the
    // transient tail below it still looks retryable.
    expect(schedulerVerificationMaySettle({ ...transientTail, ok: true })).toBe(false);
    expect(schedulerVerificationMaySettle({ ...transientTail, conflict: true })).toBe(false);
    expect(schedulerVerificationMaySettle({ ...transientTail, assetsHealthy: false })).toBe(false);
    expect(schedulerVerificationMaySettle({ ...transientTail, nativeServiceAbsent: false })).toBe(false);
    expect(schedulerVerificationMaySettle({ ...transientTail, registrationInvalid: true })).toBe(false);

    // And a fully healthy-but-not-ok view has nothing left to wait for.
    expect(schedulerVerificationMaySettle({
      ...transientTail,
      taskInstalled: true,
      registrationHealthy: true,
    })).toBe(false);
  });

  test("ownership lost during a settle delay stops without rollback or state write", async () => {
    mockParentRollbackSpawn();
    let owned = true;
    let probes = 0;
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: succeedingElevation(),
      verify: () => { probes += 1; return absentVerify(); },
      settleDelay: async () => { owned = false; },
      stillOwnsAttempt: () => owned,
      writeInstallState: () => { writeCount += 1; },
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).resolves.toEqual({ kind: "done" });
    expect(probes).toBe(1);
    expect(writeCount).toBe(0);
    expect(parentRollbackLaunches).toBe(0);
  });

  test("ownership lost around a non-retryable failure skips rollback too", async () => {
    // The settle loop never awaits for a non-retryable verdict, so this is the only
    // path that reaches the pre-rollback ownership fence: a stale attempt must not
    // delete a task that a newer attempt now owns.
    mockParentRollbackSpawn();
    let owned = true;
    let probes = 0;
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: succeedingElevation(),
      verify: () => {
        probes += 1;
        owned = false;
        return unhealthyVerify();
      },
      settleDelay: async () => { throw new Error("must not settle a non-retryable verdict"); },
      stillOwnsAttempt: () => owned,
      writeInstallState: () => { writeCount += 1; },
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).resolves.toEqual({ kind: "done" });
    expect(probes).toBe(1);
    expect(writeCount).toBe(0);
    expect(parentRollbackLaunches).toBe(0);
  });

  test("runElevatedSchtasksCreateAndRun launches PowerShell once and classifies protocol exit", async () => {
    let launches = 0;
    setWindowsElevationSpawnForTests((() => {
      launches += 1;
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter & { setEncoding?: (enc: string) => void };
        stderr: EventEmitter & { setEncoding?: (enc: string) => void };
        kill: ReturnType<typeof mock>;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdout.setEncoding = () => undefined;
      child.stderr.setEncoding = () => undefined;
      child.kill = mock(() => true);
      queueMicrotask(() => child.emit("close", OCX_ELEVATED_SUCCESS, null));
      return child as never;
    }) as never);

    const result = await runElevatedSchtasksCreateAndRun(
      "schtasks.exe",
      ["/create", "/tn", "opencodex-proxy", "/f"],
      ["/run", "/tn", "opencodex-proxy"],
      ["/delete", "/tn", "opencodex-proxy", "/f"],
    );
    expect(launches).toBe(1);
    expect(result.outcome).toBe("success");
    expect(result.exitCode).toBe(OCX_ELEVATED_SUCCESS);
  });
});

describe("evaluateSchedulerInstallRestartReconciliation", () => {
  test("reports orphan task when scheduler task exists without install state", () => {
    expect(evaluateSchedulerInstallRestartReconciliation({
      taskInstalled: true,
      registrationHealthy: true,
      registrationInvalid: false,
      assetsHealthy: true,
      nativeStatus: "nonexistent",
      installStateBackend: null,
    }).status).toBe("orphan-task");
  });

  test("reports stale install state when task is absent", () => {
    expect(evaluateSchedulerInstallRestartReconciliation({
      taskInstalled: false,
      registrationHealthy: false,
      registrationInvalid: false,
      assetsHealthy: true,
      nativeStatus: "nonexistent",
      installStateBackend: "scheduler",
    }).status).toBe("stale-install-state");
  });

  test("reports conflict when task and WinSW are both present", () => {
    expect(evaluateSchedulerInstallRestartReconciliation({
      taskInstalled: true,
      registrationHealthy: true,
      registrationInvalid: false,
      assetsHealthy: true,
      nativeStatus: "stopped",
      installStateBackend: "scheduler",
    }).status).toBe("conflict");
  });

  test("reports healthy for verified scheduler-only install", () => {
    expect(evaluateSchedulerInstallRestartReconciliation({
      taskInstalled: true,
      registrationHealthy: true,
      registrationInvalid: false,
      assetsHealthy: true,
      nativeStatus: "nonexistent",
      installStateBackend: "scheduler",
    }).status).toBe("healthy");
  });

  test("reports unverified when WinSW status is unknown", () => {
    expect(evaluateSchedulerInstallRestartReconciliation({
      taskInstalled: true,
      registrationHealthy: true,
      registrationInvalid: false,
      assetsHealthy: true,
      nativeStatus: "unknown",
      installStateBackend: "scheduler",
    }).status).toBe("unverified");
  });

  test("reports unhealthy for bad XML or missing assets", () => {
    expect(evaluateSchedulerInstallRestartReconciliation({
      taskInstalled: true,
      registrationHealthy: false,
      registrationInvalid: false,
      assetsHealthy: true,
      nativeStatus: "nonexistent",
      installStateBackend: "scheduler",
    }).status).toBe("unhealthy");
    expect(evaluateSchedulerInstallRestartReconciliation({
      taskInstalled: true,
      registrationHealthy: true,
      registrationInvalid: false,
      assetsHealthy: false,
      nativeStatus: "nonexistent",
      installStateBackend: "scheduler",
    }).status).toBe("unhealthy");
  });
});
