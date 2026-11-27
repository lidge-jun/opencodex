import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  FOREGROUND_ADVISORY_ARG,
  maybeStartForegroundAdvisory,
  parseWindowsProcessSnapshot,
  selectOwnedWindowsDescendants,
  shouldStartForegroundAdvisory,
  startForegroundAdvisory,
  windowsProcessSnapshotArgs,
  type ForegroundAdvisoryEligibility,
  type WindowsAdvisoryJob,
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

describe("Windows handle-bound and Job Object advisory teardown", () => {
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

  test("Job Object containment terminates root and descendants atomically without snapshot or bare-PID commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-advisory-job-"));
    const descendantPidFile = join(dir, "descendant.pid");
    let child!: ChildProcess;
    let descendantPid = 0;
    const rootTicks = 639_000_000_000_000_000n;
    const attached: Array<{ pid: number; ticks: bigint }> = [];
    let jobTerminated = 0;
    let jobClosed = 0;
    let snapshotCalls = 0;
    const cancel = startForegroundAdvisory(() => {}, {
      platform: "win32",
      timeoutMs: 120,
      windowsNative: () => ({
        sameUserIdentity: () => ({ ticks: rootTicks }),
        terminate: () => { throw new Error("Job Object already terminated the tree"); },
      }),
      attachWindowsJob: (pid, ticks): WindowsAdvisoryJob => {
        attached.push({ pid, ticks });
        return {
          terminateAndClose: () => {
            jobTerminated += 1;
            safeKillPid(descendantPid);
            if (child.pid) safeKillPid(child.pid);
            return true;
          },
          close: () => { jobClosed += 1; },
        };
      },
      spawnSnapshot: (() => {
        snapshotCalls += 1;
        throw new Error("snapshot must not run when Job Object termination succeeds");
      }) as typeof spawn,
      launch: () => {
        const script = [
          'const { spawn } = require("node:child_process");',
          'const { writeFileSync } = require("node:fs");',
          'const d = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: ["ignore", 1, "ignore"], windowsHide: true });',
          `writeFileSync(${JSON.stringify(descendantPidFile)}, String(d.pid));`,
          'console.log("ready");',
          "setInterval(() => {}, 60000);",
        ].join(" ");
        return (child = fakeProbe(script));
      },
    });
    try {
      await once(child.stdout!, "data");
      descendantPid = Number(readFileSync(descendantPidFile, "utf8").trim());
      expect(descendantPid).toBeGreaterThan(0);
      await once(child, "close");
      expect(await waitUntilDead(descendantPid)).toBe(true);
      expect(attached).toEqual([{ pid: child.pid!, ticks: rootTicks }]);
      expect(jobTerminated).toBe(1);
      expect(jobClosed).toBe(0);
      expect(snapshotCalls).toBe(0);
    } finally {
      cancel(true);
      safeKillPid(descendantPid);
      await removeTreeAfterBackgroundWork(dir);
    }
  }, 15_000);

  test("normal probe completion releases the Windows Job Object handle without forcing termination", async () => {
    let child!: ChildProcess;
    const warnings: string[] = [];
    let jobTerminated = 0;
    let jobClosed = 0;
    const cancel = startForegroundAdvisory(line => warnings.push(line), {
      platform: "win32",
      windowsNative: () => ({
        sameUserIdentity: () => ({ ticks: 639_000_000_000_000_000n }),
        terminate: () => ({ status: "gone" }),
      }),
      attachWindowsJob: (): WindowsAdvisoryJob => ({
        terminateAndClose: () => { jobTerminated += 1; return true; },
        close: () => { jobClosed += 1; },
      }),
      launch: () => (child = fakeProbe('console.log(JSON.stringify(["normal advisory"]))')),
    });
    try {
      await once(child, "close");
      expect(warnings).toEqual(["normal advisory"]);
      expect(jobClosed).toBe(1);
      expect(jobTerminated).toBe(0);
    } finally {
      cancel(true);
    }
  });

  test("handle-bound fallback defeats PID reuse for both the root and descendants between snapshot and terminate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-advisory-pid-reuse-"));
    const descendantPidFile = join(dir, "descendant.pid");
    let child!: ChildProcess;
    let descendantPid = 0;
    const rootTicks = 639_000_000_000_000_000n;
    const genuineDescTicks = rootTicks + 50_000n;
    const reusedDescPid = 999_001;
    const staleReusedDescTicks = rootTicks + 60_000n;
    const replacementDescTicks = rootTicks + 90_000_000n;
    const replacementRootTicks = rootTicks + 80_000_000n;
    const unrelatedChildOfReusedRootPid = 999_002;
    const unrelatedChildOfReusedRootTicks = replacementRootTicks + 10_000n;

    // Simulated OS process table at the moment native.terminate(pid, boundTicks) opens a handle:
    // - root's PID has been reused by an unrelated process with newer ticks (replacementRootTicks);
    // - reusedDescPid exited after snapshot and was reused with newer ticks (replacementDescTicks);
    // - descendantPid still matches genuineDescTicks and is genuinely terminated.
    const terminated: Array<{ pid: number; ticks: bigint | number; status: string }> = [];
    const cancel = startForegroundAdvisory(() => {}, {
      platform: "win32",
      timeoutMs: 180,
      killDeadlineMs: 2_000,
      resolvePowerShell: () => "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      attachWindowsJob: () => null,
      windowsNative: () => ({
        sameUserIdentity: () => ({ ticks: rootTicks }),
        terminate: (pid, boundStartTime) => {
          const liveTicks = new Map<number, bigint>([
            [child.pid!, replacementRootTicks],
            [descendantPid, genuineDescTicks],
            [reusedDescPid, replacementDescTicks],
            [unrelatedChildOfReusedRootPid, unrelatedChildOfReusedRootTicks],
          ]);
          const actual = liveTicks.get(pid);
          if (actual === undefined) {
            terminated.push({ pid, ticks: boundStartTime, status: "gone" });
            return { status: "gone" };
          }
          if (actual !== boundStartTime) {
            terminated.push({ pid, ticks: boundStartTime, status: "reused" });
            return { status: "reused" };
          }
          terminated.push({ pid, ticks: boundStartTime, status: "terminated" });
          safeKillPid(pid);
          return { status: "terminated" };
        },
      }),
      spawnSnapshot: ((_cmd: string, args: readonly string[]) => {
        expect(args).toEqual(windowsProcessSnapshotArgs());
        expect(args[4]).not.toContain("Stop-Process");
        const snapshotLines = [
          `${child.pid!},1,${replacementRootTicks}`,
          `${descendantPid},${child.pid!},${genuineDescTicks}`,
          `${reusedDescPid},${child.pid!},${staleReusedDescTicks}`,
          `${unrelatedChildOfReusedRootPid},${child.pid!},${unrelatedChildOfReusedRootTicks}`,
        ].join("\n");
        return spawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(snapshotLines)})`], {
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        });
      }) as typeof spawn,
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
      // Genuine descendant was terminated via handle-bound ticks.
      expect(terminated).toContainEqual({ pid: descendantPid, ticks: genuineDescTicks, status: "terminated" });
      // Descendant whose PID was reused after snapshot was rejected as "reused" (never killed).
      expect(terminated).toContainEqual({ pid: reusedDescPid, ticks: staleReusedDescTicks, status: "reused" });
      // Reused root PID was rejected as "reused" (never killed).
      expect(terminated).toContainEqual({ pid: child.pid!, ticks: rootTicks, status: "reused" });
      // Child spawned by the unrelated replacement root was never even selected.
      expect(terminated.some(entry => entry.pid === unrelatedChildOfReusedRootPid)).toBe(false);
    } finally {
      cancel(true);
      safeKillPid(descendantPid);
      await removeTreeAfterBackgroundWork(dir);
    }
  }, 15_000);

  test("Windows stdout close after exited root keeps async snapshot active and allows synchronous exit retry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-advisory-win-exited-root-"));
    const descendantPidFile = join(dir, "descendant.pid");
    let child!: ChildProcess;
    let descendantPid = 0;
    const rootTicks = 639_000_000_000_000_000n;
    const descTicks = rootTicks + 50_000n;
    let asyncSnapshotSignal: NodeJS.Signals | null = null;
    let syncSnapshotCalls = 0;
    const cancel = startForegroundAdvisory(() => {}, {
      platform: "win32",
      timeoutMs: 180,
      killDeadlineMs: 2_000,
      resolvePowerShell: () => "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      attachWindowsJob: () => null,
      windowsNative: () => ({
        sameUserIdentity: () => ({ ticks: rootTicks }),
        terminate: (pid, ticks) => {
          if (pid === descendantPid && ticks === descTicks) {
            safeKillPid(pid);
            return { status: "terminated" };
          }
          return { status: "gone" };
        },
      }),
      spawnSnapshot: (() => {
        const hung = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], {
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        });
        hung.once("exit", (_code, signal) => { asyncSnapshotSignal = signal; });
        return hung;
      }) as typeof spawn,
      execSnapshotSync: (() => {
        syncSnapshotCalls += 1;
        return `${descendantPid},${child.pid!},${descTicks}\n`;
      }) as typeof import("node:child_process").execFileSync,
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
      await Bun.sleep(60);
      // "close" must NOT have cancelled the in-flight async snapshot or marked cleanup done.
      expect(asyncSnapshotSignal).toBeNull();
      // Synchronous exit cleanup cancels the hung async snapshot and completes handle-bound reap.
      cancel(true);
      expect(await waitUntilDead(descendantPid)).toBe(true);
      expect(syncSnapshotCalls).toBe(1);
      await Bun.sleep(50);
      expect(asyncSnapshotSignal).not.toBeNull();
    } finally {
      cancel(true);
      safeKillPid(descendantPid);
      await removeTreeAfterBackgroundWork(dir);
    }
  }, 15_000);

  test("unavailable native Windows API never attempts unchecked PID-only termination", async () => {
    let child!: ChildProcess;
    let snapshotSpawned = false;
    const cancel = startForegroundAdvisory(() => {}, {
      platform: "win32",
      timeoutMs: 100,
      windowsNative: () => null,
      spawnSnapshot: (() => {
        snapshotSpawned = true;
        throw new Error("snapshot must not run without handle-bound native termination");
      }) as typeof spawn,
      launch: () => (child = fakeProbe("setInterval(() => {}, 60000)")),
    });
    try {
      await once(child, "close");
      expect(snapshotSpawned).toBe(false);
    } finally {
      cancel(true);
    }
  }, 15_000);

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

  test("parseWindowsProcessSnapshot and selectOwnedWindowsDescendants exclude reused-root and older processes", () => {
    const rootTicks = 639_000_000_000_000_000n;
    const rows = parseWindowsProcessSnapshot([
      `42,1,${rootTicks + 90_000n}`,        // reused root PID (newer ticks)
      `100,42,${rootTicks - 10n}`,          // created before our root -> excluded
      `101,42,${rootTicks + 1_000n}`,       // genuine child -> included
      `102,101,${rootTicks + 2_000n}`,      // genuine grandchild -> included
      `103,42,${rootTicks + 95_000n}`,      // child of reused root -> excluded
      "malformed,line",
    ].join("\n"));
    const selected = selectOwnedWindowsDescendants(rows, 42, rootTicks, rootTicks + 50_000n);
    expect(selected.map(row => row.pid)).toEqual([101, 102]);
  });
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
