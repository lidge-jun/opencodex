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
import { existsSync, readdirSync, readFileSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { repairService } from "../../src/service/repair";
import { claimPendingTeardown } from "../../src/config/pending-teardown";
import { withWindowsServiceMutationLock } from "../../src/lib/windows-service-mutation-lock";
import { buildWindowsTaskXml } from "../../src/service/windows-taskxml";
import { fixturePath, repoRoot } from "../helpers/repo-root";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const ADMIN_TOKEN = "fixture-admin-token-value";
// The real restart path includes proxyStillLiveAfterStop's 7s respawn window and the stop drain.
const RESTART_TIMEOUT_MS = 60_000;
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
async function startProxy(root: TempHome, entryName = "ocx", extraEnv: Record<string, string> = {}): Promise<Proxy> {
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = ADMIN_TOKEN;
  // verifyPidIdentity accepts this home's proxy only when the command line names ocx and
  // the start verb. A symlink named "ocx" next to the fixture gives that command line
  // while keeping the fixture's own relative module resolution.
  const entry = root.path(entryName);
  symlinkSync(fixturePath("service-restart-respawn-proxy-child.ts"), entry);

  let output = "";
  // Launched through a shell that exits at once, so the proxy is reparented to init and reaped by
  // it. As a direct child of this test it would stay a zombie after exiting: stopProxy waits with
  // Atomics.wait, which blocks the event loop that reaps it, and a zombie still answers kill(0).
  // A production proxy is never the restarting CLI's child either.
  const child = Bun.spawn({
    cmd: ["/bin/sh", "-c", '"$0" "$1" start --port 0 &', process.execPath, entry],
    cwd: repoRoot(),
    env: {
      HOME: root.root,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      OCX_TEST_HOME_GUARD: "1",
      OPENCODEX_HOME: root.configDir,
      CODEX_HOME: root.codexHome,
      CLAUDE_CONFIG_DIR: root.path("claude-config"),
      OPENCODEX_ADMIN_AUTH_TOKEN: ADMIN_TOKEN,
      ...extraEnv,
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
    try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
  };
  return { pid, port, stop, output: () => output };
}

test("a scheduler restart stops the surviving tracked proxy instead of aborting on its own respawn refusal", async () => {
  home = createTempHome("ocx-scheduler-restart-8416-");
  const proxy = await startProxy(home);
  const effects: string[] = [];
  let confirmed: readonly number[] = [];
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
      // No scheduler starts a replacement here; confirming one stands in for that, so the restart
      // releases the receipt it kept.
      confirmSchedulerReplacement: async (receipt, pids) => { confirmed = [receipt.endpoint.port, ...pids]; return true; },
      // stopTrackedProxy and schedulerProxyStillLive stay ABSENT on purpose: the real
      // stopTrackedProxyIfRunning and proxyStillLiveAfterStop run against the child.
    });
    // The whole sequence proves the stop was accepted and the replacement was started. The
    // wrappers are cleaned up only after the proxy accepted its stop, so a refusal leaves them.
    expect(effects).toEqual([
      "stop-scheduler", "kill-wrappers", "write-assets", "start-scheduler", "write-state",
    ]);
  } finally {
    await proxy.stop();
  }

  // The stop named a receipt the route could verify, so the route's respawn gate let it through
  // and the proxy deferred its shared teardown to the restart instead of restoring client config.
  const stop = JSON.parse(readFileSync(home.path("stop-response.json"), "utf8"));
  expect(stop.status).toBe(200);
  expect(stop.query).toMatch(/^\?deferSharedTeardown=1&teardownNonce=[0-9a-f]{32}$/);
  expect(stop.response.sharedTeardown).toBe("deferred");
  // The restart kept its receipt until a replacement other than the stopped proxy served, then
  // released it; nothing is left for a later `ocx stop` or the updater to trip over.
  // Checked against the stopped proxy's own endpoint, excluding the stopped pid.
  expect(confirmed).toEqual([proxy.port, proxy.pid]);
  expect(readdirSync(home.configDir).filter(name => name.startsWith("pending-teardown"))).toEqual([]);
  // The child accepted the stop and exited on its own; nothing was killed past a refusal.
  expect(existsSync(home.path("accepted-stop.json"))).toBe(true);
  expect(existsSync(home.path("ocx.pid"))).toBe(false);
}, RESTART_TIMEOUT_MS);

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

  // The denied request changed nothing: no accepted stop, the records still name the proxy, no
  // replacement assets were written, and the wrappers that supervise the proxy were left running.
  expect(effects).toEqual(["stop-scheduler", "stop-denied"]);
  expect(existsSync(home.path("accepted-stop.json"))).toBe(false);
  expect(existsSync(home.path("ocx.pid"))).toBe(true);
  expect(existsSync(home.path("opencodex-service.cmd"))).toBe(false);
}, RESTART_TIMEOUT_MS);

test("a survivor this home cannot verify is refused before the wrappers that supervise it are removed", async () => {
  home = createTempHome("ocx-scheduler-restart-8416-unverified-");
  // Not named ocx: verifyPidIdentity cannot tie this process to the home, as for a reused pid.
  const proxy = await startProxy(home, "unverified-proxy");
  const effects: string[] = [];
  try {
    await expect(repairService({
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
    })).rejects.toThrow("could not be verified");
    // Nothing was signalled, and the proxy still serves under the wrappers that were left running.
    expect(effects).toEqual(["stop-scheduler"]);
    expect(existsSync(home.path("stop-response.json"))).toBe(false);
    expect((await fetch(`http://127.0.0.1:${proxy.port}/healthz`)).status).toBe(200);
  } finally {
    await proxy.stop();
  }
}, RESTART_TIMEOUT_MS);

test.each(["no replacement answers", "wrapper cleanup fails"] as const)("the restart keeps its teardown receipt when %s after the proxy accepted its stop", async mode => {
  home = createTempHome("ocx-scheduler-restart-8416-receipt-");
  const proxy = await startProxy(home);
  const effects: string[] = [];
  try {
    const restart = repairService({
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
      killServiceWrappers: () => {
        effects.push("kill-wrappers");
        if (mode === "wrapper cleanup fails") throw new Error("fixture wrapper cleanup refused");
      },
      writeSchedulerAssets: () => { effects.push("write-assets"); },
      startScheduler: () => { effects.push("start-scheduler"); },
      writeSchedulerState: () => { effects.push("write-state"); },
      reregisterScheduler: async () => { throw new Error("no re-register expected"); },
      settleSchedulerRead: () => {},
      confirmSchedulerReplacement: async () => false,
    });
    if (mode === "wrapper cleanup fails") await expect(restart).rejects.toThrow("fixture wrapper cleanup refused");
    else await restart;
  } finally {
    await proxy.stop();
  }
  // The proxy accepted the deferred stop and exited keeping client routing, so the obligation to
  // restore it is still owed: a valid receipt for that exact endpoint stays for `ocx stop`.
  expect(existsSync(home.path("accepted-stop.json"))).toBe(true);
  const receipts = readdirSync(home.configDir).filter(name => name.startsWith("pending-teardown-"));
  expect(receipts).toHaveLength(1);
  const receipt = JSON.parse(readFileSync(join(home.configDir, receipts[0]!), "utf8"));
  expect(receipt).toMatchObject({ endpoint: { hostname: "127.0.0.1", port: proxy.port }, endpointSource: "exact", ownerPid: process.pid });
  expect(effects).toEqual(mode === "wrapper cleanup fails"
    ? ["stop-scheduler", "kill-wrappers"]
    : ["stop-scheduler", "kill-wrappers", "write-assets", "start-scheduler", "write-state"]);
}, RESTART_TIMEOUT_MS);

test("a receipt for the port this listener is bound to is honoured without its runtime record, whatever port is configured", async () => {
  home = createTempHome("ocx-scheduler-restart-8416-bound-port-");
  const proxy = await startProxy(home, "ocx", { OCX_FIXTURE_CONFIG_PORT_SKEW: "1" });
  try {
    const previousHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = home.configDir;
    let nonce: string;
    try { nonce = claimPendingTeardown({ hostname: "127.0.0.1", port: proxy.port }, "exact").nonce; }
    finally { if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome; }
    // The record is gone; the route decides from the port it is actually bound to, not from it.
    unlinkSync(join(home.configDir, "runtime-port.json"));
    const response = await fetch(`http://127.0.0.1:${proxy.port}/api/stop?deferSharedTeardown=1&teardownNonce=${nonce}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).sharedTeardown).toBe("deferred");
  } finally {
    await proxy.stop();
  }
});

test("a listener that cannot prove this home's attestation secret is sent no token and keeps its wrappers", async () => {
  home = createTempHome("ocx-scheduler-restart-8416-unattested-");
  const proxy = await startProxy(home, "ocx", { OCX_FIXTURE_NO_ATTESTATION: "1" });
  const effects: string[] = [];
  try {
    await expect(repairService({
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
    })).rejects.toThrow("could not prove it serves this home's endpoint");
    // No stop request (and so no admin token) reached it, no receipt was written, the wrappers
    // were left in place, and it still serves.
    expect(effects).toEqual(["stop-scheduler"]);
    expect(existsSync(home.path("stop-response.json"))).toBe(false);
    expect(readdirSync(home.configDir).filter(name => name.startsWith("pending-teardown-"))).toEqual([]);
    expect((await fetch(`http://127.0.0.1:${proxy.port}/healthz`)).status).toBe(200);
  } finally {
    await proxy.stop();
  }
}, RESTART_TIMEOUT_MS);

test("a receipt for another endpoint does not defer this proxy's stop", async () => {
  home = createTempHome("ocx-scheduler-restart-8416-foreign-receipt-");
  const proxy = await startProxy(home);
  try {
    const previousHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = home.configDir;
    let nonce: string;
    try { nonce = claimPendingTeardown({ hostname: "127.0.0.1", port: proxy.port + 1 }, "exact").nonce; }
    finally { if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome; }
    const response = await fetch(`http://127.0.0.1:${proxy.port}/api/stop?deferSharedTeardown=1&teardownNonce=${nonce}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    // The valid receipt names a different port, so the respawn gate still applies to this proxy.
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("respawnable_service");
    expect(existsSync(home.path("accepted-stop.json"))).toBe(false);
    expect((await fetch(`http://127.0.0.1:${proxy.port}/healthz`)).status).toBe(200);
  } finally {
    await proxy.stop();
  }
});

test.each([true, false])("a failed asset rewrite after the accepted stop settles the receipt by the recovered proxy (serving %p)", async serving => {
  home = createTempHome("ocx-scheduler-restart-8416-recovery-");
  const proxy = await startProxy(home);
  const effects: string[] = [];
  let failure: unknown = null;
  try {
    failure = await repairService({
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
      snapshotSchedulerAssets: () => () => { effects.push("restore-assets"); },
      writeSchedulerAssets: () => { effects.push("write-assets"); throw new Error("fixture read-only asset"); },
      startScheduler: () => { effects.push("start-scheduler"); },
      writeSchedulerState: () => { effects.push("write-state"); },
      reregisterScheduler: async () => { throw new Error("no re-register expected"); },
      settleSchedulerRead: () => {},
      confirmSchedulerReplacement: async () => serving,
    }).then(() => null, (error: unknown) => error);
  } finally {
    await proxy.stop();
  }
  expect(effects).toEqual(["stop-scheduler", "kill-wrappers", "write-assets", "restore-assets", "start-scheduler"]);
  expect((failure as Error).message).toContain("fixture read-only asset");
  const receipts = readdirSync(home.configDir).filter(name => name.startsWith("pending-teardown-"));
  // A recovered proxy serving the stopped endpoint takes the receipt; otherwise it is kept and named.
  expect(receipts).toHaveLength(serving ? 0 : 1);
  expect((failure as Error).message.includes("kept its teardown receipt")).toBe(!serving);
}, RESTART_TIMEOUT_MS);

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
