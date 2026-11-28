import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { read, toArrayBuffer } from "bun:ffi";
import { startWindowsCliChildWithNative } from "../../src/codex/windows-cli-child";
import { WIN64_CHILD_ABI, type WindowsChildNative } from "../../src/codex/windows-cli-child-native";
import {
  FOREGROUND_ADVISORY_ARG,
  maybeStartForegroundAdvisory,
  shouldStartForegroundAdvisory,
  startForegroundAdvisory,
  type ContainedWindowsAdvisoryChild,
  type ForegroundAdvisoryEligibility,
} from "../../src/service/foreground-advisory-process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { saveConfig } from "../../src/config";
import { selfLaunchArgv } from "../../src/lib/self-launch-argv";
import { startServer } from "../../src/server";
import { installIsolatedCodexHome } from "../helpers/isolated-codex-home";
import { BACKGROUND_WORK_TEARDOWN_TIMEOUT_MS, removeTreeAfterBackgroundWork } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";
import { describe, expect, test } from "bun:test";
import { deriveLaunchdServiceDiagnostic, foregroundStartServiceAdvisoryLines, warnForegroundStartService } from "../../src/service/diagnostics";
import type { ServiceDiagnostic } from "../../src/service/diagnostics";

const diagnostic = (overrides: Partial<ServiceDiagnostic> = {}): ServiceDiagnostic => ({
  supported: true,
  installed: true,
  enabled: false,
  running: false,
  viable: false,
  startable: true,
  stale: false,
  conflict: false,
  backend: "launchd",
  summary: "installed, not loaded (launchd; ok)",
  confirmedStopped: true,
  ...overrides,
});

describe("foregroundStartServiceAdvisoryLines", () => {
  test("advises when the managed service is installed but not serving", () => {
    const lines = foregroundStartServiceAdvisoryLines(diagnostic());
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("not loaded");
    expect(lines[0]).toContain("installed, not loaded");
    expect(lines[1]).toContain("'ocx service repair'");
  });

  test("stays silent when the service is serving", () => {
    const service = diagnostic({ running: true, enabled: true, viable: true, summary: "installed and loaded (launchd; ok)" });
    expect(foregroundStartServiceAdvisoryLines(service)).toEqual([]);
  });

  test("stays silent when no service is installed", () => {
    const service = diagnostic({ installed: false, startable: false, backend: null, summary: "not installed (launchd; ok)" });
    expect(foregroundStartServiceAdvisoryLines(service)).toEqual([]);
  });

  test("stays silent when another manager holds a conflict", () => {
    const service = diagnostic({ conflict: true, summary: "conflicting manager (launchd; ok)" });
    expect(foregroundStartServiceAdvisoryLines(service)).toEqual([]);
  });

  test("stays silent on unsupported platforms", () => {
    const service = diagnostic({ supported: false, startable: false, summary: "unsupported on freebsd" });
    expect(foregroundStartServiceAdvisoryLines(service)).toEqual([]);
  });

  test("advises on a stale registration that is not serving", () => {
    const service = diagnostic({ stale: true, startable: false, summary: "installed, but stale (launchd; baked paths moved)" });
    const lines = foregroundStartServiceAdvisoryLines(service);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("'ocx service repair'");
  });

  test("does not treat launchd unknown as stopped, whether or not paths are stale", () => {
    for (const stale of [false, true]) {
      const result = deriveLaunchdServiceDiagnostic({
        installed: true, stale, load: { state: "unknown" }, diagnostics: "fixture",
      });
      const lines = foregroundStartServiceAdvisoryLines(result).join("\n");
      expect(lines).toContain("Could not confirm");
      expect(lines).toContain("ocx status");
      expect(lines.includes("ocx service repair")).toBe(false);
    }
  });

  test("derives confirmation from verified launchd not-loaded, not summary text", () => {
    const result = deriveLaunchdServiceDiagnostic({
      installed: true, stale: false, load: { state: "not-loaded" }, diagnostics: "fixture",
    });
    expect(foregroundStartServiceAdvisoryLines({ ...result, summary: "changed wording" })).toHaveLength(2);
  });

  test("keeps status guidance across unknown and non-launchd backends without copying repair hints", () => {
    for (const backend of ["systemd", "native", "scheduler", null] as const) {
      const lines = foregroundStartServiceAdvisoryLines(diagnostic({
        backend, confirmedStopped: undefined, summary: "stale assets — run ocx service repair",
      })).join("\n");
      expect(lines).toContain("Could not confirm");
      expect(lines).toContain("ocx status");
      expect(lines.includes("ocx service repair")).toBe(false);
    }
  });

  test("probe or warning exceptions cannot escape the advisory", () => {
    const fail = (): never => { throw new Error("fixture"); };
    expect(() => warnForegroundStartService(fail, fail)).not.toThrow();
    expect(() => warnForegroundStartService(() => diagnostic(), fail)).not.toThrow();
  });
});

test("foreground advisory is wired after readiness initialization and uses the final sibling decision", () => {
  const cli = readFileSync(repoPath("src/cli/index.ts"), "utf8");
  const start = cli.slice(cli.indexOf("async function handleStart("), cli.indexOf("function detachedStartEnvironment("));
  const probe = "maybeStartForegroundAdvisory({";
  const probes = start.split(probe);
  expect(probes).toHaveLength(2);
  const beforeProbe = probes[0]!;
  expect(beforeProbe).toContain("await bindAndPublishStartOwnership(");
  expect(beforeProbe).toContain("await reconcileClientStartupBeforeReady(");
  expect(beforeProbe).toContain('console.log("Client startup work complete.")');
  expect(probes[1]!.slice(0, 240)).toContain("cleaned, shuttingDown, siblingStart, ownerLive: Boolean(owner.live), supervisedServiceChild, restartParentPid: restartParent.restartParentPid, stderrIsTTY: process.stderr?.isTTY");
});

describe("foreground advisory eligibility behavior", () => {
  const eligible: ForegroundAdvisoryEligibility = {
    cleaned: false,
    shuttingDown: false,
    siblingStart: false,
    ownerLive: false,
    supervisedServiceChild: false,
    restartParentPid: null,
    stderrIsTTY: true,
  };

  test.each([
    ["non-interactive (stderrIsTTY=false)", { stderrIsTTY: false }],
    ["non-interactive (stderrIsTTY=undefined)", { stderrIsTTY: undefined }],
    ["supervised service child", { supervisedServiceChild: true }],
    ["sibling start", { siblingStart: true }],
    ["live owner", { ownerLive: true }],
    ["restart handoff", { restartParentPid: 4242 }],
    ["shutting down", { shuttingDown: true }],
    ["already cleaned", { cleaned: true }],
  ])("never launches the probe for %s", (_label, override) => {
    let launches = 0;
    const stop = maybeStartForegroundAdvisory({ ...eligible, ...override }, () => {}, {
      launch: () => {
        launches += 1;
        return fakeProbe("console.log('[]')");
      },
    });
    expect(stop).toBeUndefined();
    expect(launches).toBe(0);
    expect(shouldStartForegroundAdvisory({ ...eligible, ...override })).toBe(false);
  });

  test("launches the probe for an eligible interactive foreground owner", async () => {
    const warnings: string[] = [];
    let child!: ChildProcess;
    let launches = 0;
    const stop = maybeStartForegroundAdvisory(eligible, line => warnings.push(line), {
      launch: () => {
        launches += 1;
        return (child = fakeProbe('console.log(JSON.stringify(["eligible advisory"]))'));
      },
    });
    expect(stop).toBeDefined();
    expect(launches).toBe(1);
    try {
      await once(child, "close");
      expect(warnings).toEqual(["eligible advisory"]);
    } finally { stop?.(); }
  });
});

test("private advisory entrypoint launches cleanly from a path containing spaces", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocx advisory spaces "));
  const home = join(dir, "ocx home");
  const entry = join(dir, "cli entry with spaces.ts");
  const cliUrl = pathToFileURL(repoPath("src/cli/index.ts")).href;
  writeFileSync(entry, `await import(${JSON.stringify(cliUrl)});\n`, "utf8");
  const argv = selfLaunchArgv([FOREGROUND_ADVISORY_ARG], { isStandaloneExecutable: false, sourceEntrypoint: entry });
  const child = spawn(process.execPath, argv, {
    env: { ...process.env, OPENCODEX_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  try {
    const [code] = await once(child, "close");
    expect(code).toBe(0);
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed as unknown[]).length).toBeLessThanOrEqual(2);
  } finally {
    await removeTreeAfterBackgroundWork(dir);
  }
}, 15_000);

describe("Windows pre-resume Job-contained advisory teardown", () => {
  async function waitUntilDead(pid: number, timeoutMs = 3_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { return true; }
      await Bun.sleep(20);
    }
    return false;
  }

  function safeKillPid(pid: number): void {
    if (pid <= 0) return;
    try { process.kill(pid, "SIGKILL"); } catch { /* process already exited */ }
  }

  function createFakeContainedWindowsChild(options: {
    outputChunks?: Buffer[];
    terminal?: boolean;
    exitCode?: number | null;
    setupFailure?: string | null;
    processHandle?: bigint;
    processSignaled?: boolean;
    onTerminateJob?: (job: bigint, code: number) => boolean | void;
    onReapUnstarted?: () => boolean;
  } = {}) {
    let eof = false;
    let terminal = options.terminal ?? false;
    let processSignaled = options.processSignaled ?? terminal;
    let exitCode = options.exitCode ?? 0;
    const queued = [...(options.outputChunks ?? [])];
    const terminatedJobs: Array<{ job: bigint; code: number }> = [];
    const closedHandles: bigint[] = [];
    let pipeDisposed = 0;
    let nativeDisposed = 0;
    let reapedUnstarted = 0;

    const child: ContainedWindowsAdvisoryChild = {
      setupFailure: options.setupFailure ?? null,
      job: 0x100n,
      process: options.processHandle ?? 0x200n,
      pipe: {
        get eof() { return eof; },
        error: false,
        pump(onBytes) {
          while (queued.length > 0) onBytes(queued.shift()!);
          if (terminal) eof = true;
        },
        async dispose() { pipeDisposed += 1; },
      },
      native: {
        k: {
          TerminateJobObject(job, code) {
            terminatedJobs.push({ job, code });
            const outcome = options.onTerminateJob?.(job, code);
            if (outcome === false) return 0;
            terminal = true;
            processSignaled = true;
            exitCode = code;
            eof = true;
            return 1;
          },
          WaitForSingleObject() {
            return processSignaled ? 0 : 258;
          },
        },
        close(handle) { closedHandles.push(handle); },
        dispose() { nativeDisposed += 1; return true; },
      },
      observe() {
        return { terminal, exitCode: terminal ? exitCode : null, unknown: false };
      },
      reapUnstarted() {
        reapedUnstarted += 1;
        const ok = options.onReapUnstarted ? options.onReapUnstarted() : true;
        if (ok) processSignaled = true;
        return ok;
      },
    };

    return {
      child,
      setTerminal(nextExitCode: number) { terminal = true; processSignaled = true; exitCode = nextExitCode; },
      state: () => ({ terminatedJobs, closedHandles, pipeDisposed, nativeDisposed, reapedUnstarted }),
    };
  }

  test("normal Windows completion publishes advisory and releases handles without TerminateJobObject", async () => {
    const warnings: string[] = [];
    const fake = createFakeContainedWindowsChild({
      outputChunks: [Buffer.from(JSON.stringify(["windows advisory"]))],
      terminal: true,
      exitCode: 0,
    });
    const stop = startForegroundAdvisory(line => warnings.push(line), {
      platform: "win32",
      pollMs: 5,
      launchWindows: () => fake.child,
    });
    try {
      await Bun.sleep(40);
      expect(warnings).toEqual(["windows advisory"]);
      // Later CLI shutdown (both async and synchronous exit paths) must not call
      // TerminateJobObject with an already-closed job handle that Windows could reuse.
      stop(false);
      stop(true);
      expect(fake.state().terminatedJobs).toEqual([]);
      expect(fake.state().pipeDisposed).toBe(1);
      expect(fake.state().closedHandles).toEqual([0x200n, 0x100n]);
      expect(fake.state().nativeDisposed).toBe(1);
    } finally {
      stop(true);
    }
  });

  test("timeout terminates the Job Object atomically when a descendant outlives the probe root", async () => {
    const warnings: string[] = [];
    const fake = createFakeContainedWindowsChild({
      outputChunks: [Buffer.from('["too late"]')],
      // Root exited, descendant still active inside the Job -> Job accounting stays non-terminal.
      terminal: false,
    });
    const stop = startForegroundAdvisory(line => warnings.push(line), {
      platform: "win32",
      timeoutMs: 30,
      pollMs: 5,
      launchWindows: () => fake.child,
    });
    try {
      await Bun.sleep(90);
      expect(warnings).toEqual([]);
      expect(fake.state().terminatedJobs).toEqual([{ job: 0x100n, code: 1 }]);
      expect(fake.state().pipeDisposed).toBe(1);
      expect(fake.state().closedHandles).toEqual([0x200n, 0x100n]);
      expect(fake.state().nativeDisposed).toBe(1);
    } finally {
      stop(true);
    }
  });

  test("synchronous exit cleanup terminates the Windows Job Object immediately without waiting on async timers", () => {
    const warnings: string[] = [];
    const fake = createFakeContainedWindowsChild({ terminal: false });
    const stop = startForegroundAdvisory(line => warnings.push(line), {
      platform: "win32",
      timeoutMs: 10_000,
      pollMs: 50,
      launchWindows: () => fake.child,
    });
    stop(true);
    expect(fake.state().terminatedJobs).toEqual([{ job: 0x100n, code: 1 }]);
    expect(warnings).toEqual([]);
  });

  test("slow-to-settle job and failed TerminateJobObject keep backoff polling until terminal so handles never leak", async () => {
    let allowTerminate = false;
    const fake = createFakeContainedWindowsChild({
      terminal: false,
      onTerminateJob: () => allowTerminate ? undefined : false,
    });
    // Override observe so we can simulate a job that takes longer than reapMs to settle even after
    // TerminateJobObject succeeds.
    let externallyTerminal = false;
    const originalObserve = fake.child.observe.bind(fake.child);
    const wrappedChild: ContainedWindowsAdvisoryChild = {
      ...fake.child,
      observe: () => externallyTerminal ? originalObserve() : { terminal: false, exitCode: null, unknown: false },
    };

    const stop = startForegroundAdvisory(() => {}, {
      platform: "win32",
      timeoutMs: 15,
      reapMs: 25,
      pollMs: 5,
      settlePollMs: 15,
      launchWindows: () => wrappedChild,
    });
    try {
      // Wait past timeoutMs + reapMs while TerminateJobObject fails: handles stay owned and retry continues.
      await Bun.sleep(70);
      const attemptsAfterFail = fake.state().terminatedJobs.length;
      expect(attemptsAfterFail).toBeGreaterThanOrEqual(2);
      expect(fake.state().closedHandles).toEqual([]);
      expect(fake.state().pipeDisposed).toBe(0);

      // TerminateJobObject succeeds, but job still takes time past reapMs to become terminal.
      allowTerminate = true;
      await Bun.sleep(40);
      expect(fake.state().terminatedJobs.length).toBeGreaterThanOrEqual(attemptsAfterFail + 1);
      expect(fake.state().closedHandles).toEqual([]);

      // Once the slow job finally becomes terminal, backoff polling disposes all handles cleanly.
      externallyTerminal = true;
      await Bun.sleep(50);
      expect(fake.state().pipeDisposed).toBe(1);
      expect(fake.state().closedHandles).toEqual([0x200n, 0x100n]);
      expect(fake.state().nativeDisposed).toBe(1);
    } finally {
      stop(true);
    }
  });

  test("Windows output overflow terminates the Job Object and suppresses advisory output", async () => {
    const warnings: string[] = [];
    const fake = createFakeContainedWindowsChild({
      outputChunks: [Buffer.alloc(9_000, 0x20)],
      terminal: false,
    });
    const stop = startForegroundAdvisory(line => warnings.push(line), {
      platform: "win32",
      timeoutMs: 10_000,
      pollMs: 5,
      launchWindows: () => fake.child,
    });
    try {
      await Bun.sleep(60);
      expect(warnings).toEqual([]);
      expect(fake.state().terminatedJobs).toEqual([{ job: 0x100n, code: 1 }]);
    } finally {
      stop(true);
    }
  });

  test("Windows arms kill-on-job-close before CreateProcessW and fails closed before any process is created or resumed", async () => {
    const warnings: string[] = [];
    const unsupportedStop = startForegroundAdvisory(line => warnings.push(line), {
      platform: "win32",
      launchWindows: () => { throw new Error("windows_child_unsupported_platform"); },
    });
    expect(() => unsupportedStop(true)).not.toThrow();

    // Setup failure where startWindowsCliChild already terminated the suspended process
    // (WaitForSingleObject === 0): a second reapUnstarted() is skipped (even if it would return false),
    // and handles are disposed immediately without leaking.
    const alreadyReaped = createFakeContainedWindowsChild({
      setupFailure: "job_assignment",
      processHandle: 0x200n,
      processSignaled: true,
      onReapUnstarted: () => false,
    });
    const alreadyReapedStop = startForegroundAdvisory(line => warnings.push(line), {
      platform: "win32",
      launchWindows: () => alreadyReaped.child,
    });
    await Bun.sleep(20);
    expect(alreadyReaped.state().reapedUnstarted).toBe(0);
    expect(alreadyReaped.state().pipeDisposed).toBe(1);
    expect(alreadyReaped.state().closedHandles).toEqual([0x200n, 0x100n]);
    expect(alreadyReaped.state().nativeDisposed).toBe(1);
    alreadyReapedStop(true);

    // Setup failure (ResumeThread failed after CreateProcessW) combined with failed
    // TerminateProcess & TerminateJobObject: original process/job handles stay retained while
    // unsignaled, backoff polling retries reapUnstarted(), and handles are disposed only once
    // WaitForSingleObject === 0.
    let allowUnstartedReap = false;
    const failedReapSetup = createFakeContainedWindowsChild({
      setupFailure: "resume_thread",
      processHandle: 0x200n,
      processSignaled: false,
      onReapUnstarted: () => allowUnstartedReap,
      onTerminateJob: () => allowUnstartedReap ? undefined : false,
    });
    const failedReapStop = startForegroundAdvisory(line => warnings.push(line), {
      platform: "win32",
      pollMs: 5,
      reapMs: 20,
      settlePollMs: 10,
      launchWindows: () => failedReapSetup.child,
    });
    try {
      await Bun.sleep(45);
      const reapRetries = failedReapSetup.state().reapedUnstarted;
      expect(reapRetries).toBeGreaterThanOrEqual(2);
      expect(failedReapSetup.state().closedHandles).toEqual([]);
      expect(failedReapSetup.state().pipeDisposed).toBe(0);

      // Once TerminateProcess finally succeeds and process signals, handles are disposed cleanly
      // and later stop() calls never touch the closed handle.
      allowUnstartedReap = true;
      await Bun.sleep(35);
      expect(failedReapSetup.state().reapedUnstarted).toBeGreaterThanOrEqual(reapRetries + 1);
      expect(failedReapSetup.state().pipeDisposed).toBe(1);
      expect(failedReapSetup.state().closedHandles).toEqual([0x200n, 0x100n]);
      expect(failedReapSetup.state().nativeDisposed).toBe(1);

      const reapsAfterDispose = failedReapSetup.state().reapedUnstarted;
      failedReapStop(false);
      failedReapStop(true);
      expect(failedReapSetup.state().reapedUnstarted).toBe(reapsAfterDispose);
    } finally {
      failedReapStop(true);
    }

    const failedStop = alreadyReapedStop;

    // Real startWindowsCliChildWithNative fault injection proving atomic containment:
    // (1) SetInformationJobObject(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) runs BEFORE CreateProcessW;
    // (2) PROC_THREAD_ATTRIBUTE_JOB_LIST (0x2000D) attaches child.job atomically inside CreateProcessW;
    // (3) If either pre-create step fails, CreateProcessW never runs (process === 0n);
    // (4) If post-create setup (ResumeThread) AND termination both fail through shutdown -> syncCleanup,
    //     child.job (already armed with kill-on-close & bound atomically to child.process) stays open
    //     until parent exit so the Windows kernel reaps the suspended process on exit.
    const makeMockNative = (opts: {
      setLimitResult: number;
      jobListAttrResult?: number;
      resumeResult?: number;
      terminateProcessResult?: number;
      terminateJobResult?: number;
    }) => {
      const calls: string[] = [];
      const observedLimits: Array<{ job: bigint; infoClass: number; flags: number; length: number }> = [];
      const observedJobList: Array<{ attr: bigint; job: bigint; size: bigint }> = [];
      const attrCounts: number[] = [];
      const handles = new Set<bigint>();
      const borrowedMemory = new Set<Buffer>();
      const closed: bigint[] = [];
      let disposed = 0;
      let nextHandle = 0x300n;
      const native = {
        handles,
        borrowedMemory,
        closeErrors: [] as bigint[],
        privateDescriptor: () => 0x50n,
        k: {
          CreateJobObjectW: () => { calls.push("CreateJobObjectW"); return 0x100n; },
          SetInformationJobObject: (job: bigint, infoClass: number, infoPtr: number, length: number) => {
            calls.push("SetInformationJobObject");
            observedLimits.push({
              job,
              infoClass,
              flags: read.u32(infoPtr as never, WIN64_CHILD_ABI.jobLimitFlags),
              length,
            });
            return opts.setLimitResult;
          },
          CreateNamedPipeW: () => ++nextHandle,
          CreateEventW: () => ++nextHandle,
          CreateFileW: () => ++nextHandle,
          ConnectNamedPipe: () => 1,
          LocalFree: () => 0,
          InitializeProcThreadAttributeList: (listPtr: number | null, count: number, _flags: number, sizePtr: number) => {
            attrCounts.push(count);
            if (!listPtr) {
              new DataView(toArrayBuffer(sizePtr as never, 0, 8)).setBigUint64(0, 64n, true);
              return 0;
            }
            calls.push(`InitializeProcThreadAttributeList:${count}`);
            return 1;
          },
          UpdateProcThreadAttribute: (_listPtr: number, _flags: number, attr: bigint, valuePtr: number, size: bigint) => {
            calls.push(`UpdateProcThreadAttribute:0x${attr.toString(16)}`);
            if (attr === 0x2000dn) {
              observedJobList.push({ attr, job: read.u64(valuePtr as never, 0), size });
              return opts.jobListAttrResult ?? 1;
            }
            return 1;
          },
          DeleteProcThreadAttributeList: () => { calls.push("DeleteProcThreadAttributeList"); },
          CompareStringOrdinal: () => 2,
          CreateProcessW: (_e: number, _c: number, _pa: unknown, _ta: unknown, _inh: number, _cf: number, _env: number, _cwd: number, _si: number, piPtr: number) => {
            calls.push("CreateProcessW");
            const pi = new DataView(toArrayBuffer(piPtr as never, 0, WIN64_CHILD_ABI.processInformation));
            pi.setBigUint64(0, 0x200n, true); // hProcess
            pi.setBigUint64(8, 0x201n, true); // hThread
            pi.setUint32(16, 4242, true); // dwProcessId
            return 1;
          },
          GetProcessTimes: (_h: bigint, creationPtr: number) => {
            new DataView(toArrayBuffer(creationPtr as never, 0, 8)).setBigUint64(0, 1337000000n, true);
            return 1;
          },
          AssignProcessToJobObject: () => { calls.push("AssignProcessToJobObject"); return 1; },
          ResumeThread: () => { calls.push("ResumeThread"); return opts.resumeResult ?? 1; },
          TerminateProcess: () => { calls.push("TerminateProcess"); return opts.terminateProcessResult ?? 0; },
          TerminateJobObject: () => { calls.push("TerminateJobObject"); return opts.terminateJobResult ?? 0; },
          WaitForSingleObject: () => 258,
          GetLastError: () => 5,
          CloseHandle: (handle: bigint) => { closed.push(handle); return 1; },
        },
        keep(value: number | bigint) {
          const handle = BigInt(value);
          handles.add(handle);
          return handle;
        },
        close(handle: bigint) {
          if (!handles.has(handle)) return;
          closed.push(handle);
          handles.delete(handle);
        },
        dispose() {
          if (handles.size || borrowedMemory.size) return false;
          disposed += 1;
          return true;
        },
      };
      return {
        native: native as unknown as WindowsChildNative,
        calls,
        observedLimits,
        observedJobList,
        attrCounts,
        closed,
        getDisposed: () => disposed,
      };
    };

    // (1) SetInformationJobObject fails -> no process ever created.
    const failLimitMock = makeMockNative({ setLimitResult: 0 });
    const killOnCloseFailChild = startWindowsCliChildWithNative({
      executable: "C:\\Program Files\\bun\\bun.exe",
      args: [FOREGROUND_ADVISORY_ARG],
      cwd: "C:\\Users\\tester",
      env: {},
      policy: "version",
      killOnJobClose: true,
    }, failLimitMock.native);
    expect(killOnCloseFailChild.setupFailure).toBe("job_kill_on_close");
    expect(killOnCloseFailChild.process).toBe(0n);
    expect(failLimitMock.calls).toEqual(["CreateJobObjectW", "SetInformationJobObject"]);
    expect(failLimitMock.observedLimits).toEqual([{
      job: 0x100n,
      infoClass: 9,
      flags: 0x2000,
      length: WIN64_CHILD_ABI.jobExtendedLimit,
    }]);
    const abortedLimitStop = startForegroundAdvisory(line => warnings.push(line), {
      platform: "win32",
      launchWindows: () => killOnCloseFailChild,
    });
    abortedLimitStop(false);
    abortedLimitStop(true);
    await Bun.sleep(20);
    expect(failLimitMock.closed).toEqual([0x100n]);
    expect(failLimitMock.getDisposed()).toBe(1);

    // (2) PROC_THREAD_ATTRIBUTE_JOB_LIST fails -> no process ever created.
    const failJobAttrMock = makeMockNative({ setLimitResult: 1, jobListAttrResult: 0 });
    const jobAttrFailChild = startWindowsCliChildWithNative({
      executable: "C:\\Program Files\\bun\\bun.exe",
      args: [FOREGROUND_ADVISORY_ARG],
      cwd: "C:\\Users\\tester",
      env: {},
      policy: "version",
      killOnJobClose: true,
    }, failJobAttrMock.native);
    expect(jobAttrFailChild.setupFailure).toBe("attribute_job_list");
    expect(jobAttrFailChild.process).toBe(0n);
    expect(failJobAttrMock.calls).not.toContain("CreateProcessW");
    expect(failJobAttrMock.observedJobList).toEqual([{ attr: 0x2000dn, job: 0x100n, size: 8n }]);
    const abortedAttrStop = startForegroundAdvisory(line => warnings.push(line), {
      platform: "win32",
      launchWindows: () => jobAttrFailChild,
    });
    abortedAttrStop(true);
    await Bun.sleep(20);
    expect(failJobAttrMock.getDisposed()).toBe(1);

    // (3) Atomic CreateProcessW containment + post-create ResumeThread failure + continuous
    // TerminateProcess & TerminateJobObject failures through the entire production exit lifecycle
    // (shutdown stop(false) -> single syncCleanup stop(true)): process was already assigned to
    // child.job atomically via PROC_THREAD_ATTRIBUTE_JOB_LIST (never AssignProcessToJobObject),
    // kill-on-close was armed beforehand, and child.job + child.process remain open until parent
    // exit so Windows kernel JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE reaps the suspended process.
    const postCreateFailMock = makeMockNative({
      setLimitResult: 1,
      jobListAttrResult: 1,
      resumeResult: 0,
      terminateProcessResult: 0,
      terminateJobResult: 0,
    });
    const postCreateFailChild = startWindowsCliChildWithNative({
      executable: "C:\\Program Files\\bun\\bun.exe",
      args: [FOREGROUND_ADVISORY_ARG],
      cwd: "C:\\Users\\tester",
      env: {},
      policy: "version",
      killOnJobClose: true,
    }, postCreateFailMock.native);
    expect(postCreateFailChild.setupFailure).toBe("resume_thread");
    expect(postCreateFailChild.process).toBe(0x200n);
    expect(postCreateFailMock.calls).not.toContain("AssignProcessToJobObject");
    expect(postCreateFailMock.calls.indexOf("SetInformationJobObject")).toBeLessThan(postCreateFailMock.calls.indexOf("CreateProcessW"));
    expect(postCreateFailMock.calls.indexOf("UpdateProcThreadAttribute:0x2000d")).toBeLessThan(postCreateFailMock.calls.indexOf("CreateProcessW"));
    expect(postCreateFailMock.observedJobList).toEqual([{ attr: 0x2000dn, job: 0x100n, size: 8n }]);

    const postCreateFailStop = startForegroundAdvisory(line => warnings.push(line), {
      platform: "win32",
      pollMs: 5,
      launchWindows: () => postCreateFailChild,
    });
    postCreateFailStop(false);
    postCreateFailStop(true);
    await Bun.sleep(25);
    // Both child.job (with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) and child.process stay open until exit.
    expect(postCreateFailMock.native.handles.has(0x100n)).toBe(true);
    expect(postCreateFailMock.native.handles.has(0x200n)).toBe(true);
    expect(postCreateFailMock.getDisposed()).toBe(0);
    expect(postCreateFailMock.calls.filter(call => call === "TerminateProcess").length).toBeGreaterThanOrEqual(3);
    expect(postCreateFailMock.calls.filter(call => call === "TerminateJobObject").length).toBeGreaterThanOrEqual(2);

    // Durable recovery jobs remain incompatible with killOnJobClose.
    expect(() => startWindowsCliChildWithNative({
      executable: "C:\\Program Files\\bun\\bun.exe",
      args: [FOREGROUND_ADVISORY_ARG],
      cwd: "C:\\Users\\tester",
      env: {},
      policy: "installer",
      recoveryJobName: "Global\\ocx-cli-12345678-1234-1234-1234-123456789abc",
      killOnJobClose: true,
    }, makeMockNative({ setLimitResult: 1 }).native)).toThrow("windows_child_invalid_invocation");

    expect(warnings).toEqual([]);
    failedStop(true);
  });

  test("timeout still terminates a living descendant holding stdout after the probe root exits on POSIX", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "ocx-advisory-exited-root-"));
    const descendantPidFile = join(dir, "descendant.pid");
    let child!: ChildProcess;
    let descendantPid = 0;
    const cancel = startForegroundAdvisory(() => {}, {
      timeoutMs: 250,
      launch: () => {
        const script = [
          'const { spawn } = require("node:child_process");',
          'const { writeFileSync } = require("node:fs");',
          'const d = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: ["ignore", 1, "ignore"], windowsHide: true });',
          `writeFileSync(${JSON.stringify(descendantPidFile)}, String(d.pid));`,
          'process.stdout.write("root-exiting\\n", () => process.exit(0));',
        ].join(" ");
        return (child = fakeProbe(script));
      },
    });
    try {
      await once(child, "exit");
      descendantPid = Number(readFileSync(descendantPidFile, "utf8").trim());
      expect(descendantPid).toBeGreaterThan(0);
      await once(child, "close");
      expect(await waitUntilDead(descendantPid)).toBe(true);
    } finally {
      cancel(true);
      safeKillPid(descendantPid);
      await removeTreeAfterBackgroundWork(dir);
    }
  }, 15_000);
});

function fakeProbe(body: string) {
  return spawn(process.execPath, ["-e", body], {
    detached: process.platform !== "win32", stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
  });
}

test("an injected probe launcher is honored on Windows and its child is stopped", async () => {
  let child: ChildProcess | undefined;
  let windowsLaunches = 0;
  const stop = startForegroundAdvisory(() => {}, {
    platform: "win32",
    launch: () => (child = fakeProbe("setInterval(() => {}, 60000)")),
    launchWindows: () => { windowsLaunches++; throw new Error("unexpected contained launcher"); },
  });
  try {
    expect(child).toBeDefined();
    expect(windowsLaunches).toBe(0);
  } finally {
    const closed = child ? once(child, "close") : undefined;
    stop();
    if (closed) {
      const [code, signal] = await closed;
      expect(code !== 0 || signal !== null).toBe(true);
    }
  }
});

test("the listening proxy can answer a request while the advisory child is still probing", async () => {
  const previousHome = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "ocx-advisory-"));
  const codexHome = installIsolatedCodexHome("ocx-advisory-codex-");
  process.env.OPENCODEX_HOME = home;
  let server: ReturnType<typeof startServer> | undefined;
  const warnings: string[] = [];
  let child: ChildProcess | undefined;
  let cancel: (() => void) | undefined;
  try {
    saveConfig({
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "mock",
      providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:9/v1", allowPrivateNetwork: true, liveModels: false, models: ["m"] } },
      clientIntegrations: { codex: false },
      webSearchSidecar: { enabled: false },
    });
    server = startServer(0);
    cancel = startForegroundAdvisory(line => warnings.push(line), {
      launch: () => (child = fakeProbe("console.log('pending'); for (;;) {}")),
      timeoutMs: 4_000,
    });
    expect(child).toBeDefined();
    const ready = new AbortController();
    const deadline = setTimeout(() => ready.abort(), 2_000);
    try {
      await Promise.race([
        once(child!.stdout!, "data", { signal: ready.signal }),
        once(child!, "close", { signal: ready.signal }).then(() => { throw new Error("probe exited before starting"); }),
      ]);
    } finally {
      clearTimeout(deadline);
      ready.abort();
    }
    const response = await fetch(new URL("/healthz", server.url), { signal: AbortSignal.timeout(1_500) });
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("status");
    expect(child!.exitCode).toBeNull();
    expect(child!.signalCode).toBeNull();
    expect(warnings).toEqual([]);
  } finally {
    const exited = child && child.exitCode === null && child.signalCode === null ? once(child, "close") : undefined;
    cancel?.();
    try { await server?.stop(true); await exited; } finally {
      codexHome.restore();
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      await removeTreeAfterBackgroundWork(home);
    }
  }
}, BACKGROUND_WORK_TEARDOWN_TIMEOUT_MS);

test("a completed probe publishes its advisory; a timed-out probe is stopped silently", async () => {
  const warnings: string[] = [];
  let child!: ChildProcess;
  const onWarning = (line: string) => warnings.push(line);
  const cancel = startForegroundAdvisory(onWarning, {
    launch: () => (child = fakeProbe('console.log(JSON.stringify(["status guidance"]))')),
  });
  try {
    await once(child, "close");
    expect(warnings).toEqual(["status guidance"]);
  } finally { cancel(); }

  const cancelSlow = startForegroundAdvisory(onWarning, {
    launch: () => (child = fakeProbe('setTimeout(() => console.log(JSON.stringify(["too late"])), 2000)')),
    timeoutMs: 100,
  });
  try {
    const [code] = await once(child, "close");
    expect(code).not.toBe(0);
    expect(warnings).toEqual(["status guidance"]);
  } finally { cancelSlow(); }
});
