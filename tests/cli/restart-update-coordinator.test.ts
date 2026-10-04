/**
 * Injected regressions for the CLI-newer update coordinator: the attested
 * restart identity must survive every step, and anything else refuses before
 * acting. No real service is touched — every boundary is a fake.
 */
import { describe, expect, test } from "bun:test";
import { STOP_SUMMARY_SCHEMA, type StopOutcome } from "../../src/cli/stop-report";
import type { StopApproval } from "../../src/cli/stop-approval";
import type { ResolveJson, ResolveLivenessJson } from "../../src/cli/resolve";
import type { ProxyRestartStartOutcome } from "../../src/cli/tray-proxy";
import type { LiveProxy } from "../../src/server/proxy-liveness";
import {
  runRestartUpdate,
  type RestartUpdateIo,
  type RestartUpdateTarget,
} from "../../src/cli/restart-update-coordinator";

const CLI_VERSION = "2.77.0";
const TARGET: RestartUpdateTarget = { pid: 4242, port: 10100 };
const TOKEN = "a".repeat(64);
const TEST_CONFIG_HOME = "/tmp/ocx-test-config-home";

function live(over: Partial<LiveProxy> = {}): LiveProxy {
  return {
    pid: 4242, port: 10100, hostname: "127.0.0.1",
    source: "runtime", version: "2.69.0", ...over,
  };
}

function resolveOk(
  livenessOver: Partial<ResolveLivenessJson> = {},
  topOver: Partial<ResolveJson> = {},
): ResolveJson {
  return {
    schema: "ocx-resolve/1",
    cliVersion: CLI_VERSION,
    configHome: TEST_CONFIG_HOME,
    port: { effective: 10100, configured: 10100, source: "runtime" },
    liveness: {
      status: "live", pid: 4242, port: 10100,
      hostname: "127.0.0.1", source: "runtime", version: "2.69.0",
      ...livenessOver,
    },
    ownership: { kind: "unknown", reason: "test" },
    takeover: { kind: "supported", protocolVersion: 1, minimumCliVersion: "0.0.0", token: TOKEN },
    ...topOver,
  };
}

function stopSummary(outcome: StopOutcome["summary"]["outcome"], message: string): StopOutcome {
  return {
    ok: outcome === "stopped",
    summary: {
      schema: STOP_SUMMARY_SCHEMA, ok: outcome === "stopped", outcome,
      exitCode: outcome === "stopped" ? 0 : 1, runtimeDown: outcome === "stopped",
      service: "absent", proxy: outcome === "stopped" ? "stopped" : "unknown",
      sharedTeardown: "skipped", message,
    },
  };
}

interface ScriptedIo extends RestartUpdateIo {
  stopCalls: StopApproval[];
  startCalls: boolean[];
}

function scriptIo(script: {
  lives?: Array<LiveProxy | null>;
  resolve?: ResolveJson | null;
  stop?: StopOutcome;
  start?: ProxyRestartStartOutcome;
}): ScriptedIo {
  let now = 1_000_000;
  const liveQueue = [...(script.lives ?? [])];
  let last: LiveProxy | null = null;
  const stopCalls: StopApproval[] = [];
  const startCalls: boolean[] = [];
  return {
    stopCalls,
    startCalls,
    cliVersion: CLI_VERSION,
    now: () => now,
    sleep: async ms => { now += ms; },
    findLive: async () => {
      if (liveQueue.length > 0) last = liveQueue.shift()!;
      return last;
    },
    resolve: async () => script.resolve ?? null,
    stopGuarded: async approval => {
      stopCalls.push(approval);
      return script.stop ?? stopSummary("stopped", "stopped");
    },
    startWhenStopped: async recovering => {
      startCalls.push(recovering);
      return script.start ?? { status: "started" };
    },
  };
}

function run(io: ScriptedIo) {
  return runRestartUpdate(TARGET, 1_000_000 + 30_000, io);
}

describe("restart update coordinator", () => {
  test("updates through guarded stop/start when the attested target is stable", async () => {
    const io = scriptIo({
      resolve: resolveOk(),
      lives: [null, null, live({ version: CLI_VERSION })],
      stop: stopSummary("stopped", "stopped"),
      start: { status: "started" },
    });
    const result = await run(io);
    expect(result).toEqual({ ok: true, live: live({ version: CLI_VERSION }) });
    expect(io.stopCalls).toEqual([{
      pid: 4242, port: 10100, hostname: "127.0.0.1",
      configHome: TEST_CONFIG_HOME,
      cliVersion: CLI_VERSION, compatibilityToken: TOKEN,
    }]);
    expect(io.startCalls).toEqual([true]);
  });

  test("refuses without stopping when a supervisor replaced the target (A-to-B)", async () => {
    const io = scriptIo({
      resolve: resolveOk({ pid: 9999 }),
      lives: [live({ pid: 9999 })],
    });
    const result = await run(io);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("target-changed");
    expect(io.stopCalls).toHaveLength(0);
    expect(io.startCalls).toHaveLength(0);
  });

  test("refuses unresolvable, unattested, or client-role runtimes without stopping", async () => {
    for (const resolve of [
      null,
      resolveOk({ status: "absent-proven", pid: null, port: null }),
      resolveOk({ source: "config" }),
      resolveOk({ role: "client" }),
    ]) {
      const io = scriptIo({ resolve });
      const result = await run(io);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("target-changed");
      expect(io.stopCalls).toHaveLength(0);
      expect(io.startCalls).toHaveLength(0);
    }
  });

  test("refuses the stop when the guarded stop declines under lease", async () => {
    const io = scriptIo({
      resolve: resolveOk(),
      stop: stopSummary("approval-changed", "the live PID is now 9999 (approved 4242)"),
    });
    const result = await run(io);
    expect(result).toEqual({
      ok: false, reason: "stop-refused",
      detail: "the live PID is now 9999 (approved 4242)",
    });
    expect(io.stopCalls).toHaveLength(1);
    expect(io.startCalls).toHaveLength(0);
  });

  test("fails closed when the guarded stop fails", async () => {
    const io = scriptIo({
      resolve: resolveOk(),
      stop: stopSummary("failed", "stop exploded"),
    });
    const result = await run(io);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("stop-failed");
      expect(result.detail).toBe("stop exploded");
    }
    expect(io.startCalls).toHaveLength(0);
  });

  test("refuses to start over a port that still answers after the stop", async () => {
    const io = scriptIo({
      resolve: resolveOk(),
      lives: [live()],
      stop: stopSummary("stopped", "stopped"),
    });
    const result = await run(io);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("target-not-confirmed-stopped");
    expect(io.stopCalls).toHaveLength(1);
    expect(io.startCalls).toHaveLength(0);
  });

  test("refuses when the replacement does not start", async () => {
    const io = scriptIo({
      resolve: resolveOk(),
      lives: [null],
      stop: stopSummary("stopped", "stopped"),
      start: { status: "failed", launch: "unknown" },
    });
    const result = await run(io);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("start-failed");
  });

  test("refuses an unverified replacement identity or version", async () => {
    const wrongVersion = scriptIo({
      resolve: resolveOk(),
      lives: [null, live({ pid: 5555, version: "2.69.0" })],
      stop: stopSummary("stopped", "stopped"),
      start: { status: "started" },
    });
    const stale = await run(wrongVersion);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.reason).toBe("replacement-unverified");
    const never = scriptIo({
      resolve: resolveOk(),
      lives: [],
      stop: stopSummary("stopped", "stopped"),
      start: { status: "started" },
    });
    const absent = await run(never);
    expect(absent.ok).toBe(false);
    if (!absent.ok) expect(absent.reason).toBe("replacement-unverified");
  });
});
