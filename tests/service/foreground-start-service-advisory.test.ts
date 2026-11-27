import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
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
    onTerminateJob?: (job: bigint, code: number) => boolean | void;
  } = {}) {
    let eof = false;
    let terminal = options.terminal ?? false;
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
            exitCode = code;
            eof = true;
            return 1;
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
        return true;
      },
    };

    return {
      child,
      setTerminal(nextExitCode: number) { terminal = true; exitCode = nextExitCode; },
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

  test("failed TerminateJobObject retains job handle ownership for later retry instead of closing handles", async () => {
    let allowTerminate = false;
    const fake = createFakeContainedWindowsChild({
      terminal: false,
      onTerminateJob: () => allowTerminate,
    });
    const stop = startForegroundAdvisory(() => {}, {
      platform: "win32",
      timeoutMs: 20,
      reapMs: 30,
      pollMs: 5,
      launchWindows: () => fake.child,
    });
    // Wait past timeoutMs + reapMs while TerminateJobObject returns 0 (failure).
    await Bun.sleep(90);
    expect(fake.state().terminatedJobs.length).toBeGreaterThanOrEqual(1);
    // Handles must NOT be released while the job remains nonterminal / termination failed.
    expect(fake.state().closedHandles).toEqual([]);
    expect(fake.state().pipeDisposed).toBe(0);
    expect(fake.state().nativeDisposed).toBe(0);

    // A failed synchronous exit attempt also retains ownership for a subsequent retry.
    const beforeSyncFail = fake.state().terminatedJobs.length;
    stop(true);
    expect(fake.state().terminatedJobs.length).toBe(beforeSyncFail + 1);

    // Once TerminateJobObject succeeds, the retained handle completes termination cleanly.
    allowTerminate = true;
    stop(true);
    expect(fake.state().terminatedJobs.length).toBe(beforeSyncFail + 2);
    // Further stops after successful termination are no-ops.
    stop(true);
    expect(fake.state().terminatedJobs.length).toBe(beforeSyncFail + 2);
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

  test("Windows fails closed when pre-resume Job containment cannot be established", async () => {
    const warnings: string[] = [];
    const unsupportedStop = startForegroundAdvisory(line => warnings.push(line), {
      platform: "win32",
      launchWindows: () => { throw new Error("windows_child_unsupported_platform"); },
    });
    expect(() => unsupportedStop(true)).not.toThrow();

    const failedSetup = createFakeContainedWindowsChild({
      setupFailure: "job_assignment",
      processHandle: 0x200n,
    });
    const failedStop = startForegroundAdvisory(line => warnings.push(line), {
      platform: "win32",
      launchWindows: () => failedSetup.child,
    });
    await Bun.sleep(20);
    expect(failedSetup.state().reapedUnstarted).toBe(1);
    expect(failedSetup.state().pipeDisposed).toBe(1);
    expect(failedSetup.state().closedHandles).toEqual([0x200n, 0x100n]);
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
