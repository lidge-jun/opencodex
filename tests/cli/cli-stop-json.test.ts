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

  function stopDeps(handleStop: CliDispatchDeps["handleStop"], args: string[]): CliDispatchDeps {
    const head: CliHead = { kind: "command", command: "stop", args };
    return { args, head, handleStop } as unknown as CliDispatchDeps;
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
});
