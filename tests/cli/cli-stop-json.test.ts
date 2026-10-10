import { describe, expect, test } from "bun:test";
import { dispatchCommand } from "../../src/cli/dispatch";
import type { CliDispatchDeps } from "../../src/cli/dispatch";
import type { CliHead } from "../../src/cli/root";
import {
  STOP_SUMMARY_SCHEMA,
  summarizeStopRun,
  type StopRunRecord,
  type StopSummaryJson,
} from "../../src/cli/stop-report";
import { STOP_HISTORY_DEFERRED_EXIT_CODE, STOP_HISTORY_INCOMPLETE_EXIT_CODE } from "../../src/update/stop-contract.mjs";
import {
  approvalChanged,
  guardFinalStopSummary,
  managerStillActive,
  parseStopApproval,
  runApprovedStop,
  runGuardedManagerStep,
  settleApprovedTarget,
  type GuardedStopSnapshot,
  type StopApproval,
} from "../../src/cli/stop-approval";
import type { ResolveJson } from "../../src/cli/resolve";

/**
 * A test batch shares ONE Bun process, and Bun does not clear process.exitCode on a
 * bare undefined assignment — the suite convention is restore-with-`?? 0`
 * (cli-dispatch.test.ts, service.test.ts). A leftover nonzero exitCode fails the batch
 * with zero failing tests, which is exactly what shard batch output then shows.
 */
function withExitCode(code: number): () => void {
  const previousExitCode = process.exitCode;
  process.exitCode = code;
  return () => {
    process.exitCode = previousExitCode ?? 0;
  };
}

function record(overrides: Partial<StopRunRecord> = {}): StopRunRecord {
  return {
    service: "absent",
    proxy: "stopped",
    sharedTeardown: "restored",
    inheritedTeardownBlocks: false,
    receiptClearFailed: false,
    ...overrides,
  };
}

function summarize(rec: StopRunRecord, signals: { failed?: boolean; historyOnly?: boolean; historyDeferred?: boolean; exitCode?: number }): StopSummaryJson {
  return summarizeStopRun(rec, {
    failed: signals.failed ?? false,
    historyOnly: signals.historyOnly ?? false,
    historyDeferred: signals.historyDeferred ?? false,
    exitCode: signals.exitCode ?? 0,
  });
}

describe("summarizeStopRun", () => {
  test("a clean tracked-pid stop is stopped, ok, and runtime-down", () => {
    const summary = summarize(record(), { exitCode: 0 });
    expect(summary).toEqual({
      schema: STOP_SUMMARY_SCHEMA,
      ok: true,
      outcome: "stopped",
      exitCode: 0,
      runtimeDown: true,
      service: "absent",
      proxy: "stopped",
      sharedTeardown: "restored",
      message: "The proxy stopped.",
    });
  });

  test("nothing running is a successful not-running outcome", () => {
    const summary = summarize(record({ proxy: "not-running", sharedTeardown: "restored" }), { exitCode: 0 });
    expect(summary.outcome).toBe("not-running");
    expect(summary.ok).toBe(true);
    expect(summary.runtimeDown).toBe(true);
    expect(summary.message).toBe("No proxy was running.");
  });

  test("history-incomplete keeps the proxy down with its own exit code", () => {
    const summary = summarize(record(), { historyOnly: true, exitCode: STOP_HISTORY_INCOMPLETE_EXIT_CODE });
    expect(summary.outcome).toBe("history-incomplete");
    expect(summary.ok).toBe(false);
    expect(summary.runtimeDown).toBe(true);
  });

  test("history-deferred is only clean with the deferred exit code", () => {
    const clean = summarize(record({ sharedTeardown: "refused" }), {
      historyDeferred: true,
      exitCode: STOP_HISTORY_DEFERRED_EXIT_CODE,
    });
    expect(clean.outcome).toBe("history-deferred");
    expect(clean.message).toContain("refused");

    const dishonest = summarize(record({ sharedTeardown: "refused" }), { historyDeferred: true, exitCode: 1 });
    expect(dishonest.outcome).toBe("failed");
  });

  test("a respawned survivor fails with the runtime up", () => {
    const summary = summarize(record({ proxy: "respawned", service: "stopped-respawnable", sharedTeardown: "skipped" }), {
      failed: true,
      exitCode: 1,
    });
    expect(summary.outcome).toBe("failed");
    expect(summary.ok).toBe(false);
    expect(summary.runtimeDown).toBe(false);
    expect(summary.message).toContain("respawned");
  });

  test("an ownership refusal names the refusing proxy", () => {
    const summary = summarize(record({ proxy: "ownership-refused", sharedTeardown: "skipped" }), { failed: true, exitCode: 1 });
    expect(summary.outcome).toBe("failed");
    expect(summary.runtimeDown).toBe(false);
    expect(summary.message).toContain("refused the stop");
  });

  test("an unresolvable pid is reported rather than treated as stopped", () => {
    const summary = summarize(record({ proxy: "unresolvable-pid", sharedTeardown: "skipped" }), { failed: true, exitCode: 1 });
    expect(summary.runtimeDown).toBe(false);
    expect(summary.message).toContain("process id could not be resolved");
  });

  test("a service-manager failure outranks the stopped proxy for the message", () => {
    const summary = summarize(record({ service: "failed" }), { failed: true, exitCode: 1 });
    expect(summary.message).toContain("service manager did not stop");
  });

  test("inherited teardown blocks and receipt-clear failures are surfaced", () => {
    const inherited = summarize(record({ inheritedTeardownBlocks: true, sharedTeardown: "skipped" }), { failed: true, exitCode: 1 });
    expect(inherited.message).toContain("outstanding shared teardown");

    const receipt = summarize(record({ receiptClearFailed: true }), { failed: true, exitCode: 1 });
    expect(receipt.message).toContain("receipt");
  });

  test("the proxy-owned teardown keeps its own classification", () => {
    const summary = summarize(record({ sharedTeardown: "performed-by-proxy" }), { exitCode: 0 });
    expect(summary.sharedTeardown).toBe("performed-by-proxy");
    expect(summary.outcome).toBe("stopped");
  });

  test("a failed shared teardown is not reported as restored", () => {
    // restore.other means the config/catalog restore failed: the proxy is down but the
    // client config may still point at it. The summary must say failed, not restored.
    const summary = summarize(record({ sharedTeardown: "failed" }), { failed: true, exitCode: 1 });
    expect(summary.outcome).toBe("failed");
    expect(summary.runtimeDown).toBe(true);
    expect(summary.sharedTeardown).toBe("failed");
    expect(summary.message).toContain("teardown failed");
  });
});

describe("ocx stop --json dispatch", () => {
  function captureConsole() {
    const originalLog = console.log;
    const originalError = console.error;
    const stdout: string[] = [];
    const stderr: string[] = [];
    console.log = (...values: unknown[]) => { stdout.push(values.map(String).join(" ")); };
    console.error = (...values: unknown[]) => { stderr.push(values.map(String).join(" ")); };
    return {
      stdout,
      stderr,
      restore() {
        console.log = originalLog;
        console.error = originalError;
      },
    };
  }

  function stopDeps(handleStop: CliDispatchDeps["handleStop"], args: string[],
    inspectDesktopSupervision: NonNullable<CliDispatchDeps["inspectDesktopSupervision"]> = () => ({ kind: "none" }),
  ): CliDispatchDeps {
    const head: CliHead = { kind: "command", command: "stop", args };
    return { args, head, handleStop, inspectDesktopSupervision } as unknown as CliDispatchDeps;
  }

  test("emits exactly one JSON document and moves human output to stderr", async () => {
    const restoreExitCode = withExitCode(0);
    const summary = summarizeStopRun(record(), { failed: false, historyOnly: false, historyDeferred: false, exitCode: 0 });
    const captured = captureConsole();
    try {
      const code = await dispatchCommand(
        { kind: "command", command: "stop", args: ["stop", "--json"] },
        stopDeps(async () => {
          // The real handleStop logs through console.log; the JSON dispatch must move
          // that stream to stderr for the duration of the stop call.
          console.log("Service manager stopped.");
          return { ok: true, summary };
        }, ["stop", "--json"]),
      );
      expect(code).toBe(0);
      expect(captured.stdout).toHaveLength(1);
      expect(JSON.parse(captured.stdout[0]!)).toEqual(summary);
      // The stop path's human line and the downtime warning are human output: stderr
      // in JSON mode.
      expect(captured.stderr.some(line => line.includes("Service manager stopped."))).toBe(true);
      expect(captured.stderr.some(line => line.includes("will fail until it is restarted"))).toBe(true);
    } finally {
      captured.restore();
      restoreExitCode();
    }
  });

  test("preserves the history exit codes across the JSON boundary", async () => {
    const restoreExitCode = withExitCode(STOP_HISTORY_INCOMPLETE_EXIT_CODE);
    const summary = summarizeStopRun(record(), {
      failed: false,
      historyOnly: true,
      historyDeferred: false,
      exitCode: STOP_HISTORY_INCOMPLETE_EXIT_CODE,
    });
    const captured = captureConsole();
    try {
      const code = await dispatchCommand(
        { kind: "command", command: "stop", args: ["stop", "--json"] },
        stopDeps(async () => ({ ok: true, summary }), ["stop", "--json"]),
      );
      expect(code).toBe(STOP_HISTORY_INCOMPLETE_EXIT_CODE);
      expect((JSON.parse(captured.stdout[0]!) as StopSummaryJson).exitCode).toBe(STOP_HISTORY_INCOMPLETE_EXIT_CODE);
    } finally {
      captured.restore();
      restoreExitCode();
    }
  });

  test("without --json the human output and warning stay on stdout", async () => {
    const restoreExitCode = withExitCode(0);
    const summary = summarizeStopRun(record(), { failed: false, historyOnly: false, historyDeferred: false, exitCode: 0 });
    const captured = captureConsole();
    try {
      const code = await dispatchCommand(
        { kind: "command", command: "stop", args: ["stop"] },
        stopDeps(async () => {
          console.log("Service manager stopped.");
          return { ok: true, summary };
        }, ["stop"]),
      );
      expect(code).toBe(0);
      expect(captured.stdout.some(line => line.includes("Service manager stopped."))).toBe(true);
      expect(captured.stdout.some(line => line.includes("will fail until it is restarted"))).toBe(true);
      expect(captured.stdout.every(line => { try { JSON.parse(line); return false; } catch { return true; } })).toBe(true);
    } finally {
      captured.restore();
      restoreExitCode();
    }
  });

  test("a failed stop never prints the downtime warning in human mode", async () => {
    // handleStop now returns { ok, summary }: an object is always truthy, so keying the
    // warning on the return value would print "requests will fail" for a failed stop.
    const restoreExitCode = withExitCode(1);
    const summary = summarizeStopRun(record({ proxy: "stop-failed", sharedTeardown: "skipped" }), {
      failed: true, historyOnly: false, historyDeferred: false, exitCode: 1,
    });
    const captured = captureConsole();
    try {
      const code = await dispatchCommand(
        { kind: "command", command: "stop", args: ["stop"] },
        stopDeps(async () => ({ ok: false, summary }), ["stop"]),
      );
      expect(code).toBe(1);
      expect(captured.stdout.some(line => line.includes("will fail until it is restarted"))).toBe(false);
    } finally {
      captured.restore();
      restoreExitCode();
    }
  });

  const desktopNotice = "OpenCodex Desktop may start this proxy again after a short backoff. Use Stop Proxy or Quit in the OpenCodex menu to keep it stopped.";
  const desktop = { kind: "desktop", runtimePid: 4242, supervisorPid: 4200,
    app: "/Applications/OpenCodex.app/Contents/MacOS/opencodex-desktop",
    proxy: "/Applications/OpenCodex.app/Contents/MacOS/ocx" } as const;

  for (const evidence of [desktop, { kind: "unknown", reason: "probe-timeout", desktopSeen: true }] as const) {
    test(`ordinary stop warns on stderr before stopping: ${evidence.kind}`, async () => {
      const restoreExitCode = withExitCode(0);
      const captured = captureConsole();
      const calls: string[] = [];
      try {
        const args = ["stop"];
        const code = await dispatchCommand({ kind: "command", command: "stop", args }, stopDeps(async () => {
          calls.push("stop");
          expect(captured.stderr).toEqual([desktopNotice]);
          console.log("Service manager stopped.");
          return { ok: true, summary: summarize(record(), { exitCode: 0 }) };
        }, args, () => { calls.push("inspect"); return evidence; }));
        expect(code).toBe(0);
        expect(process.exitCode).toBe(0);
        expect(calls).toEqual(["inspect", "stop"]);
        expect(captured.stderr).toEqual([desktopNotice]);
        expect(captured.stdout[0]).toBe("Service manager stopped.");
        expect(captured.stdout.some(line => line.includes("will fail until it is restarted"))).toBe(true);
      } finally { captured.restore(); restoreExitCode(); }
    });
  }

  for (const exitCode of [0, 1, STOP_HISTORY_INCOMPLETE_EXIT_CODE, STOP_HISTORY_DEFERRED_EXIT_CODE]) {
    test(`Desktop stop --json never probes or emits supervision guidance, exit ${exitCode}`, async () => {
      const restoreExitCode = withExitCode(exitCode);
      const captured = captureConsole();
      let stops = 0;
      const summary = summarize(record(), { exitCode, failed: exitCode === 1,
        historyOnly: exitCode === STOP_HISTORY_INCOMPLETE_EXIT_CODE,
        historyDeferred: exitCode === STOP_HISTORY_DEFERRED_EXIT_CODE });
      try {
        const args = ["stop", "--json"];
        const code = await dispatchCommand({ kind: "command", command: "stop", args }, stopDeps(async () => {
          stops++;
          return { ok: exitCode !== 1, summary };
        }, args, () => { throw new Error("JSON stop must not inspect supervision"); }));
        expect(stops).toBe(1);
        expect(code).toBe(exitCode);
        expect(process.exitCode).toBe(exitCode);
        expect(captured.stdout).toEqual([JSON.stringify(summary)]);
        expect(captured.stderr.some(line => line.includes("OpenCodex Desktop"))).toBe(false);
      } finally { captured.restore(); restoreExitCode(); }
    });
  }

  for (const evidence of [{ kind: "none" }, { kind: "unknown", reason: "probe-timeout", desktopSeen: false },
    { kind: "unsupported" }] as const) {
    test(`non-Desktop stop retains output and behavior: ${evidence.kind}`, async () => {
      const restoreExitCode = withExitCode(0);
      const captured = captureConsole();
      let stops = 0;
      try {
        const args = ["stop"];
        expect(await dispatchCommand({ kind: "command", command: "stop", args }, stopDeps(async () => {
          stops++;
          return { ok: true, summary: summarize(record(), { exitCode: 0 }) };
        }, args, () => evidence))).toBe(0);
        expect(stops).toBe(1);
        expect(captured.stderr).toEqual([]);
        expect(captured.stdout).toHaveLength(1);
        expect(captured.stdout[0]).toContain("will fail until it is restarted");
      } finally { captured.restore(); restoreExitCode(); }
    });
  }

  test("Desktop supervision notice remains useful when stop detects a respawn", async () => {
    const restoreExitCode = withExitCode(1);
    const captured = captureConsole();
    const summary = summarize(record({ proxy: "respawned", service: "stopped-respawnable", sharedTeardown: "skipped" }),
      { failed: true, exitCode: 1 });
    let stops = 0;
    try {
      const args = ["stop"];
      expect(await dispatchCommand({ kind: "command", command: "stop", args }, stopDeps(async () => {
        stops++;
        return { ok: false, summary };
      }, args, () => desktop))).toBe(1);
      expect(stops).toBe(1);
      expect(summary.runtimeDown).toBe(false);
      expect(captured.stderr).toEqual([desktopNotice]);
      expect(captured.stdout).toEqual([]);
      expect(process.exitCode).toBe(1);
    } finally { captured.restore(); restoreExitCode(); }
  });

  test("guarded JSON stop forwards approval and rejects partial args before action", async () => {
    const flags = ["--json", "--expect-pid", "42", "--expect-port", "10100",
      "--expect-hostname", "", "--expect-config-home", "/sandbox",
      "--expect-cli-version", "2.61.0", "--expect-compatibility-token", "a".repeat(64)];
    const restoreExitCode = withExitCode(0);
    const captured = captureConsole();
    let calls = 0;
    let received: StopApproval | undefined;
    const handler: CliDispatchDeps["handleStop"] = async approval => {
      calls++;
      received = approval;
      return { ok: true, summary: summarize(record(), { exitCode: 0 }) };
    };
    try {
      const valid = ["stop", ...flags];
      expect(await dispatchCommand(
        { kind: "command", command: "stop", args: valid }, stopDeps(handler, valid),
      )).toBe(0);
      expect(calls).toBe(1);
      expect(received).toMatchObject({ pid: 42, port: 10100, compatibilityToken: "a".repeat(64) });
      const partial = ["stop", "--json", "--expect-pid", "42"];
      expect(await dispatchCommand(
        { kind: "command", command: "stop", args: partial }, stopDeps(handler, partial),
      )).toBe(64);
      expect(calls).toBe(1);
    } finally {
      captured.restore();
      restoreExitCode();
    }
  });
});

const STOP_APPROVAL: StopApproval = {
  pid: 42, port: 10100, hostname: "", configHome: "/sandbox",
  cliVersion: "2.61.0", compatibilityToken: "a".repeat(64),
};

const STOP_RESOLVE = {
  schema: "ocx-resolve/1", cliVersion: STOP_APPROVAL.cliVersion,
  configHome: STOP_APPROVAL.configHome,
  port: { effective: 10100, configured: 10100, source: "runtime" },
  liveness: { status: "live", pid: 42, port: 10100, source: "runtime" },
  ownership: { kind: "none", revision: 0 },
  takeover: { kind: "supported", protocolVersion: 1,
    minimumCliVersion: "2.61.0", token: STOP_APPROVAL.compatibilityToken },
} as ResolveJson;

const TRACKED_STOP_TARGET = () => ({ pid: 42, port: 10100, hostname: "" });
const BOUND_STOP_MANAGER = () => ({ kind: "bound" as const, pid: 42,
  managerPid: 7, backend: "launchd" as const, childNeedsSeparateStop: false as const });

describe("approval-bound stop", () => {
  test("mismatched evidence refuses before manager or proxy stop", async () => {
    expect(parseStopApproval(["--json", "--expect-pid", "42"]).ok).toBe(false);
    let managerStops = 0;
    let proxyStops = 0;
    const stop = async () => {
      managerStops++;
      proxyStops++;
      return { ok: true, summary: summarize(record(), { exitCode: 0 }) };
    };
    const changed = { ...STOP_RESOLVE,
      takeover: { ...STOP_RESOLVE.takeover, token: "b".repeat(64) } } as ResolveJson;
    const refused = await runApprovedStop(STOP_APPROVAL, async () => changed,
      TRACKED_STOP_TARGET, BOUND_STOP_MANAGER, stop);
    expect(refused.summary).toMatchObject({ outcome: "approval-changed", exitCode: 1 });
    const wrongManager = await runApprovedStop(STOP_APPROVAL, async () => STOP_RESOLVE,
      TRACKED_STOP_TARGET, () => ({ ...BOUND_STOP_MANAGER(), pid: 43 }), stop);
    expect(wrongManager.summary.outcome).toBe("approval-changed");
    expect(managerStops).toBe(0);
    expect(proxyStops).toBe(0);
  });

  test("an approval-changed refusal names the guard fact that failed", async () => {
    const stop = async () => ({ ok: true, summary: summarize(record(), { exitCode: 0 }) });

    // Token vs manager-inspection discrimination: the umbrella outcome has to say
    // WHICH re-verification failed, or a transient probe and genuine drift look alike.
    const tokenFlip = { ...STOP_RESOLVE,
      takeover: { ...STOP_RESOLVE.takeover, token: "b".repeat(64) } } as ResolveJson;
    const refused = await runApprovedStop(STOP_APPROVAL, async () => tokenFlip,
      TRACKED_STOP_TARGET, BOUND_STOP_MANAGER, stop);
    expect(refused.summary).toMatchObject({ outcome: "approval-changed",
      detail: "the compatibility fingerprint changed" });
    expect(refused.summary.message).toContain("the compatibility fingerprint changed");

    const pidDrift = { ...STOP_RESOLVE,
      liveness: { ...STOP_RESOLVE.liveness, pid: 43 } } as ResolveJson;
    const drifted = await runApprovedStop(STOP_APPROVAL, async () => pidDrift,
      TRACKED_STOP_TARGET, BOUND_STOP_MANAGER, stop);
    expect(drifted.summary.detail).toBe("the live PID is now 43 (approved 42)");

    const blockedNow = { ...STOP_RESOLVE,
      takeover: { kind: "blocked", reason: "managing-cli-unknown", detail: "x",
        minimumCliVersion: "2.61.0" } } as ResolveJson;
    const blocked = await runApprovedStop(STOP_APPROVAL, async () => blockedNow,
      TRACKED_STOP_TARGET, BOUND_STOP_MANAGER, stop);
    expect(blocked.summary.detail).toBe("takeover compatibility is now blocked (managing-cli-unknown)");

    const untracked = await runApprovedStop(STOP_APPROVAL, async () => STOP_RESOLVE,
      () => null, BOUND_STOP_MANAGER, stop);
    expect(untracked.summary.detail).toBe("the tracked runtime record could not be verified");

    const managerGone = await runApprovedStop(STOP_APPROVAL, async () => STOP_RESOLVE,
      TRACKED_STOP_TARGET, () => ({ kind: "unknown" as const, reason: "CIM read failed" }), stop);
    expect(managerGone.summary.detail).toBe("the service manager could not be re-verified (CIM read failed)");

    const unresolved = await runApprovedStop(STOP_APPROVAL, async () => null,
      TRACKED_STOP_TARGET, BOUND_STOP_MANAGER, stop);
    expect(unresolved.summary.detail).toBe("the runtime could not be re-resolved");

    const swapped = await runGuardedManagerStep(
      { approval: STOP_APPROVAL, manager: BOUND_STOP_MANAGER() },
      {
        revalidateManager: () => ({ kind: "absent" }),
        stopManager: () => "stopped",
        signalApproved: async () => false,
        settle: async () => true,
        managerState: async () => "inactive",
      });
    expect(swapped.effect).toBe("approval-changed");
    expect(swapped.detail).toBe("the service manager changed between approval and stop");

    // An unprovable manager is not a proven swap: the refusal names the observation
    // failure and its reason, and no stop or signal runs against an unknown target.
    let managerStops = 0, signals = 0;
    const unprovable = await runGuardedManagerStep(
      { approval: STOP_APPROVAL, manager: BOUND_STOP_MANAGER() },
      {
        revalidateManager: () => ({ kind: "unknown" as const, reason: "the process table could not be read" }),
        stopManager: () => { managerStops += 1; return "stopped"; },
        signalApproved: async () => { signals += 1; return false; },
        settle: async () => true,
        managerState: async () => "inactive",
      });
    expect(unprovable.effect).toBe("approval-changed");
    expect(unprovable.detail).toBe("the service manager could not be re-verified (the process table could not be read)");
    expect(managerStops).toBe(0);
    expect(signals).toBe(0);
  });

  test("an asynchronous manager stop settles before status decides success", async () => {
    const order: string[] = [];
    let state: "active" | "inactive" = "active";
    let pidAlive = true;
    let endpointLive = true;
    let proxyStops = 0;
    const result = await runApprovedStop(STOP_APPROVAL, async () => STOP_RESOLVE,
      TRACKED_STOP_TARGET, BOUND_STOP_MANAGER, async snapshot => {
        const step = await runGuardedManagerStep(snapshot, {
          revalidateManager: BOUND_STOP_MANAGER,
          stopManager: () => {
            order.push("stop-manager");
            pidAlive = false;
            endpointLive = false;
            return "stopped";
          },
          signalApproved: async () => { proxyStops++; return false; },
          settle: async () => {
            order.push("settle");
            state = "inactive";
            return !pidAlive && !endpointLive;
          },
          managerState: async () => { order.push("manager-state"); return state; },
        });
        expect(step.effect).toBe("stopped");
        return { ok: true, summary: summarize(record({ service: step.service, proxy: step.proxy }), {
          exitCode: 0,
        }) };
      });
    expect(result.summary.outcome).toBe("stopped");
    expect(order).toEqual(["stop-manager", "settle", "manager-state"]);
    expect(proxyStops).toBe(0);
  });

  test("timeout, active, unknown and reappearing managers never report guarded success", async () => {
    const snapshot: GuardedStopSnapshot = { approval: STOP_APPROVAL, manager: BOUND_STOP_MANAGER() };
    for (const [settled, state] of [[false, "inactive"], [true, "active"], [true, "unknown"]] as const) {
      let reads = 0;
      const step = await runGuardedManagerStep(snapshot, {
        revalidateManager: BOUND_STOP_MANAGER,
        stopManager: () => "stopped",
        signalApproved: async () => false,
        settle: async () => settled,
        managerState: async () => { reads++; return state; },
      });
      expect(step.effect).toBe("manager-still-active");
      expect(reads).toBe(settled ? 1 : 0);
      expect(managerStillActive(step.service).summary.outcome).toBe("manager-still-active");
    }
    const done = record({ service: "stopped", proxy: "stopped" });
    let published = 0;
    const final = await guardFinalStopSummary(done, async () => "active", () => {
      published++;
      return { ok: true, summary: summarize(done, { exitCode: 0 }) };
    });
    expect(final.summary.outcome).toBe("manager-still-active");
    expect(published).toBe(0);
  });

  test("a replaced manager refuses before receipt, manager stop, or proxy signal", async () => {
    let managerPid = 7;
    let managerStops = 0;
    let proxySignals = 0;
    let settles = 0;
    const result = await runApprovedStop(STOP_APPROVAL, async () => STOP_RESOLVE,
      TRACKED_STOP_TARGET, () => ({ ...BOUND_STOP_MANAGER(), managerPid }), async snapshot => {
        managerPid = 8;
        const step = await runGuardedManagerStep(snapshot, {
          revalidateManager: () => ({ ...BOUND_STOP_MANAGER(), managerPid }),
          stopManager: () => { managerStops++; return "stopped"; },
          signalApproved: async () => { proxySignals++; return false; },
          settle: async () => { settles++; return true; },
          managerState: async () => "inactive",
        });
        expect(step.effect).toBe("approval-changed");
        return step.effect === "approval-changed" ? approvalChanged()
          : { ok: true, summary: summarize(record(), { exitCode: 0 }) };
      });
    expect(result.summary.outcome).toBe("approval-changed");
    expect(managerStops).toBe(0);
    expect(proxySignals).toBe(0);
    expect(settles).toBe(0);
  });

  test("settlement shares one deadline and needs a definitive dead probe", async () => {
    let now = 0;
    const calls: string[] = [];
    expect(await settleApprovedTarget(STOP_APPROVAL, {
      now: () => now,
      waitExit: () => { calls.push("exit"); now += 200; return true; },
      waitPort: async () => { calls.push("port"); now += 200; return true; },
      probe: async () => { calls.push("health"); now += 200; return "dead"; },
    })).toBe(true);
    expect(calls).toEqual(["exit", "port", "health"]);
    expect(await settleApprovedTarget(STOP_APPROVAL, {
      now: () => 0, waitExit: () => true, waitPort: async () => true,
      probe: async () => "unknown",
    })).toBe(false);
    let later = 0;
    now = 0;
    expect(await settleApprovedTarget(STOP_APPROVAL, {
      now: () => now,
      waitExit: () => { now = 5_000; return true; },
      waitPort: async () => { later++; return true; },
      probe: async () => { later++; return "dead"; },
    })).toBe(false);
    expect(later).toBe(0);
  });
});
