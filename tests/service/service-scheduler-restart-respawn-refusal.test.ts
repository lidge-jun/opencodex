/**
 * #8416: a Windows scheduler restart must not abort on the tracked proxy's own 409.
 *
 * "ocx service restart" on Windows ends the Task Scheduler task, kills the surviving
 * wrappers, then stops the still-running proxy through its own POST /api/stop. The route
 * re-asks installedServiceRespawnRisk -- "is a scheduler task registered that could
 * respawn me?" -- and the task the restart is midway through replacing is still
 * registered, so it answers 409 respawnable_service. Before the re-land that refusal
 * escaped repairService and left the task stopped with the proxy still serving.
 *
 * The test drives the real path rather than a deps seam. The proxy, its management route,
 * admin-token admission, stopTrackedProxyIfRunning, stopProxy and the route's respawn gate
 * are production code. Only the Windows host under them is a fixture, and the child-hosted
 * proxy means a stop the route ACCEPTS can only end the child.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { repairService } from "../../src/service/repair";
import { withWindowsServiceMutationLock } from "../../src/lib/windows-service-mutation-lock";
import { buildWindowsTaskXml } from "../../src/service/windows-taskxml";
import { fixturePath, repoRoot } from "../helpers/repo-root";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const ADMIN_TOKEN = "fixture-admin-token-value";
const sid = "S-1-5-21-111-222-333-1001";
const launcher = "C:" + String.fromCharCode(92) + "fixture" + String.fromCharCode(92) + "launcher.vbs";
const healthy = buildWindowsTaskXml("fixture.cmd", launcher, undefined, sid);

let home: TempHome | null = null;
const originalToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;

afterEach(() => {
  home?.remove();
  home = null;
  if (originalToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = originalToken;
});

type Proxy = {
  pid: number;
  port: number;
  stop: () => Promise<void>;
  output: () => string;
};

/**
 * Start the fixture proxy and resolve once it is listening and its records exist.
 *
 * Completion is an observed line, never a delay: the child prints READY only after
 * Bun.serve has bound and the pid and runtime-port records are written, which is exactly
 * the state the restart consumes.
 */
async function startProxy(root: TempHome): Promise<Proxy> {
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = ADMIN_TOKEN;
  // verifyPidIdentity accepts this home's proxy only when the command line names ocx and
  // the start verb. A symlink named "ocx" next to the fixture gives that command line
  // while keeping the fixture's own relative module resolution.
  const entry = root.path("ocx");
  symlinkSync(fixturePath("service-restart-respawn-proxy-child.ts"), entry);

  let output = "";
  const child = Bun.spawn({
    cmd: [process.execPath, entry, "start", "--port", "0"],
    cwd: repoRoot(),
    env: {
      HOME: root.root,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      OCX_TEST_HOME_GUARD: "1",
      OPENCODEX_HOME: root.configDir,
      CODEX_HOME: root.codexHome,
      CLAUDE_CONFIG_DIR: root.path("claude-config"),
      OPENCODEX_ADMIN_AUTH_TOKEN: ADMIN_TOKEN,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const decoder = new TextDecoder();
  const collect = async (stream: ReadableStream<Uint8Array> | undefined) => {
    if (!stream) return;
    for await (const chunk of stream) output += decoder.decode(chunk, { stream: true });
  };
  void collect(child.stderr);

  const ready = new RegExp("READY ([0-9]+) ([0-9]+)");
  let match: RegExpExecArray | null = null;
  for await (const chunk of child.stdout) {
    output += decoder.decode(chunk, { stream: true });
    match = ready.exec(output);
    if (match) break;
  }
  if (!match) throw new Error("fixture proxy did not become ready: " + output);
  const pid = Number(match[1]);
  const port = Number(match[2]);
  const stop = async () => {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  };
  return { pid, port, stop, output: () => output };
}

test("a scheduler restart stops the surviving tracked proxy instead of aborting on its own respawn refusal", async () => {
  home = createTempHome("ocx-scheduler-restart-8416-");
  const proxy = await startProxy(home);
  const effects: string[] = [];
  try {
    await repairService({
      platform: "win32",
      verb: "restart",
      configDir: () => home!.configDir,
      inspectSupervision: () => ({ kind: "none" }),
      diagnose: () => ({
        supported: true, installed: true, enabled: true, running: true, viable: true,
        startable: true, stale: false, conflict: false, backend: "scheduler", summary: "fixture",
      }),
      readOwnership: () => ({ kind: "none", revision: 0 }),
      assertEnv: () => {},
      assertAuth: () => {},
      selectRuntime: () => ({ path: process.execPath, source: "override", overrideEnv: "OPENCODEX_BUN_PATH" }),
      assertRuntimeWritable: () => {},
      launcherPathDiagnostic: () => null,
      readSchedulerXml: () => healthy,
      resolveExpectedUserId: () => sid,
      schedulerLauncher: launcher,
      prepareDisconnectedClientRestart: async () => {},
      stopScheduler: () => { effects.push("stop-scheduler"); },
      killServiceWrappers: () => { effects.push("kill-wrappers"); },
      writeSchedulerAssets: () => { effects.push("write-assets"); },
      startScheduler: () => { effects.push("start-scheduler"); },
      writeSchedulerState: () => { effects.push("write-state"); },
      reregisterScheduler: async () => {
        throw new Error("the fixture registration is healthy; no re-register expected");
      },
      settleSchedulerRead: () => {},
      // stopTrackedProxy and schedulerProxyStillLive stay ABSENT on purpose: the real
      // stopTrackedProxyIfRunning and proxyStillLiveAfterStop run against the child.
    });
    // The whole sequence proves the stop was accepted and the replacement was started.
    // On the regression the call rejects at the tracked-proxy step instead.
    expect(effects).toEqual([
      "stop-scheduler", "kill-wrappers", "write-assets", "start-scheduler", "write-state",
    ]);
  } catch (error) {
    const receipt = JSON.parse(readFileSync(home.path("stop-response.json"), "utf8"));
    expect(receipt.status).toBe(409);
    expect(receipt.response.code).toBe("respawnable_service");
    expect(receipt.query).toBe("");
    expect(effects).toEqual(["stop-scheduler", "kill-wrappers"]);
    expect((await fetch(`http://127.0.0.1:${proxy.port}/healthz`)).status).toBe(200);
    const calls = JSON.parse(readFileSync(home.path("scheduler-calls.json"), "utf8")) as string[];
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(call => call.startsWith("/query"))).toBe(true);
    throw error;
  } finally {
    await proxy.stop();
  }

  // The child accepted the stop and exited on its own; nothing was killed past a refusal.
  expect(existsSync(home.path("accepted-stop.json"))).toBe(true);
  expect(existsSync(home.path("ocx.pid"))).toBe(false);
});

test("a refused stop keeps the proxy serving and never reports a completed restart", async () => {
  home = createTempHome("ocx-scheduler-restart-8416-denied-");
  const proxy = await startProxy(home);
  const effects: string[] = [];
  try {
    await repairService({
      platform: "win32",
      verb: "restart",
      configDir: () => home!.configDir,
      inspectSupervision: () => ({ kind: "none" }),
      diagnose: () => ({
        supported: true, installed: true, enabled: true, running: true, viable: true,
        startable: true, stale: false, conflict: false, backend: "scheduler", summary: "fixture",
      }),
      readOwnership: () => ({ kind: "none", revision: 0 }),
      assertEnv: () => {},
      assertAuth: () => {},
      selectRuntime: () => ({ path: process.execPath, source: "override", overrideEnv: "OPENCODEX_BUN_PATH" }),
      assertRuntimeWritable: () => {},
      launcherPathDiagnostic: () => null,
      readSchedulerXml: () => healthy,
      resolveExpectedUserId: () => sid,
      schedulerLauncher: launcher,
      prepareDisconnectedClientRestart: async () => {},
      stopScheduler: () => { effects.push("stop-scheduler"); },
      killServiceWrappers: () => { effects.push("kill-wrappers"); },
      writeSchedulerAssets: () => { effects.push("write-assets"); },
      startScheduler: () => { effects.push("start-scheduler"); },
      writeSchedulerState: () => { effects.push("write-state"); },
      reregisterScheduler: async () => { throw new Error("no re-register expected"); },
      settleSchedulerRead: () => {},
      // An UNAUTHENTICATED stop of this same proxy: real admission must refuse it before the
      // route runs, so the refusal under test cannot be bypassed with a fabricated principal.
      stopTrackedProxy: async () => {
        const response = await fetch("http://127.0.0.1:" + String(proxy.port) + "/api/stop", { method: "POST" });
        expect(response.status).toBe(401);
        effects.push("stop-denied");
        throw new Error("proxy refused the stop");
      },
    });
    throw new Error("a refused tracked-proxy stop must not report a completed restart");
  } catch (error) {
    expect((error as Error).message).toContain("proxy refused the stop");
  } finally {
    await proxy.stop();
  }

  // The denied request changed nothing: no accepted stop, the records still name the proxy,
  // and no replacement assets were written.
  expect(effects).toEqual(["stop-scheduler", "kill-wrappers", "stop-denied"]);
  expect(existsSync(home.path("accepted-stop.json"))).toBe(false);
  expect(existsSync(home.path("ocx.pid"))).toBe(true);
  expect(existsSync(home.path("opencodex-service.cmd"))).toBe(false);
});

test("a direct stop still reaches the proxy while a service mutation owns the lock", async () => {
  home = createTempHome("ocx-scheduler-restart-lock-8416-");
  const proxy = await startProxy(home);
  try {
    await withWindowsServiceMutationLock(async () => {
      const response = await fetch(`http://127.0.0.1:${proxy.port}/api/stop`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe("respawnable_service");
      expect((await fetch(`http://127.0.0.1:${proxy.port}/healthz`)).status).toBe(200);
      expect(existsSync(home!.path("accepted-stop.json"))).toBe(false);
    }, {
      lockPath: home.path("service-lock.sqlite"),
      hardenDirectory: () => {},
      hardenFile: () => {},
    });
  } finally {
    await proxy.stop();
  }
});

