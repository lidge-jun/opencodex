import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { watchdogMs } from "../helpers/ci-watchdog";
import { captureTestOutput } from "../../scripts/test";

const repoRoot = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli", "index.ts");

/**
 * Every subprocess in this file runs against a private temp OPENCODEX_HOME so no
 * check can ever discover/inspect/mutate the operator's real proxy state. The
 * ready describe keeps ONLY the help-routing subprocess checks: the
 * network/no-proxy/argument-validation ready tests live as injected tests in
 * tests/cli/cli-ready.test.ts (no real loopback/home).
 */
// These are correctness watchdogs, not startup latency assertions. Scale only execution.
const CLI_BUDGET = { execution: watchdogMs(10_000), term: 5_000, reap: 2_000, drain: 1_000 };
const CLI_TEST_TIMEOUT = CLI_BUDGET.execution + CLI_BUDGET.term + CLI_BUDGET.reap + CLI_BUDGET.drain + 3_000;
type CliChild = Pick<Bun.Subprocess<"ignore", "pipe", "pipe">, "pid" | "exited" | "signalCode" | "stdout" | "stderr" | "kill">;
type CliSpawn = (argv: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; stdout: "pipe"; stderr: "pipe";
}) => CliChild;
type CliState = {
  id: string; startedAt: number; pid: number | null; reaped: boolean;
  status: number | null; signal: NodeJS.Signals | null;
  stdout: string; stderr: string; complete: boolean;
};
const cliHomes = new Map<string, CliState>();

function cliStage(state: CliState, stage: string): void {
  console.warn(`[cli-probe:${state.id}] ${stage} elapsedMs=${Date.now() - state.startedAt} pid=${state.pid}`);
}

function errorTag(error: unknown): string {
  const name = error instanceof Error ? error.name : "UnknownError";
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  // Error messages can contain argv or environment. Log only conventional name/code tags.
  return `${/^[A-Za-z]+$/.test(name) ? name : "Error"}${/^[A-Z0-9_]+$/.test(code) ? `:${code}` : ""}`;
}

class CliHarnessError extends Error {
  constructor(readonly failures: string[], readonly outcome: CliState) {
    super(`[cli-probe:${outcome.id}] ${failures.join(", ")} pid=${outcome.pid} status=${outcome.status} signal=${outcome.signal} reaped=${outcome.reaped} complete=${outcome.complete}`);
    this.name = "CliHarnessError";
  }
}

async function waitForCliExit(exited: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exited.then(() => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), milliseconds); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function runCli(args: string[], env: Record<string, string> = {}, control?: {
  spawn: CliSpawn; budget: typeof CLI_BUDGET;
}): Promise<{ status: number; stdout: string; stderr: string }> {
  const state = cliHomes.get(env.OPENCODEX_HOME);
  if (!state) throw new Error("CLI probe requires an owned isolated home");
  const budget = control?.budget ?? CLI_BUDGET;
  const spawn: CliSpawn = control?.spawn ?? ((argv, options) => Bun.spawn(argv, options));
  const failures: string[] = [];
  let child: CliChild | undefined;
  let exited: Promise<void> | undefined;
  let capture: ReturnType<typeof captureTestOutput> | undefined;
  let boundary = "spawn";
  try {
    cliStage(state, "03 spawn requested");
    child = spawn([process.execPath, cliPath, ...args], {
      cwd: repoRoot, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe",
    });
    state.pid = child.pid; // Establish ownership before any observation or capture can fail.
    const owned = child;
    exited = owned.exited.then(status => {
      state.reaped = true;
      state.status = status;
      state.signal = owned.signalCode ?? null;
      cliStage(state, `08 exit status=${status} signal=${state.signal}`);
    }).catch(error => {
      failures.push(`exit-observation-error:${errorTag(error)}`);
      cliStage(state, `08 ${failures[failures.length - 1]}`);
    });
    cliStage(state, "04 child owned");
    boundary = "capture";
    capture = captureTestOutput(owned.stdout, owned.stderr);
    boundary = "execution";
    if (!await waitForCliExit(exited, budget.execution)) {
      failures.push("execution-timeout");
      cliStage(state, "05 execution timeout");
    }
  } catch (error) {
    failures.push(`${boundary}-error:${errorTag(error)}`);
  } finally {
    if (child && !state.reaped) {
      cliStage(state, "06 TERM");
      try { child.kill("SIGTERM"); } catch (error) { cliStage(state, `06 TERM error=${errorTag(error)}`); }
      if (exited) await waitForCliExit(exited, budget.term);
      if (!state.reaped) {
        cliStage(state, "07 KILL");
        try { child.kill("SIGKILL"); } catch (error) { cliStage(state, `07 KILL error=${errorTag(error)}`); }
        if (exited) await waitForCliExit(exited, budget.reap);
      }
      if (!state.reaped) failures.push("reap-timeout");
    }
    if (capture) {
      try { Object.assign(state, await capture.finish(budget.drain)); }
      catch (error) { failures.push(`capture-error:${errorTag(error)}`); }
      cliStage(state, `09 capture complete=${state.complete}`);
      if (!state.complete) failures.push("incomplete-output");
    }
  }
  if (!state.reaped || state.status === null || !Number.isInteger(state.status)) failures.push("exit-not-observed");
  if (state.signal !== null) failures.push("signal-exit");
  // Never turn timeout/incomplete capture into status 1: health legitimately expects 1.
  if (failures.length) throw new CliHarnessError([...failures], { ...state });
  return { status: state.status!, stdout: state.stdout, stderr: state.stderr };
}

function isolatedHome(prefix: string): string {
  const state: CliState = {
    id: prefix, startedAt: Date.now(), pid: null, reaped: false,
    status: null, signal: null, stdout: "", stderr: "", complete: false,
  };
  cliStage(state, "01 home setup");
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cliHomes.set(dir, state);
  return dir;
}

function cleanupCliHome(dir: string, primaryFailed = false): void {
  const state = cliHomes.get(dir);
  if (!state) throw new Error("Cannot clean an unowned CLI home");
  if (state.pid !== null && !state.reaped) {
    cliStage(state, "10 home retained: child unreaped");
    return;
  }
  try {
    removeTreeWithRetry(dir);
    cliHomes.delete(dir);
    cliStage(state, "10 home removed");
  } catch (error) {
    cliStage(state, `10 cleanup error=${errorTag(error)}`);
    if (!primaryFailed) throw error;
  }
}

function writeIsolatedConfig(dir: string): void {
  cliStage(cliHomes.get(dir)!, "02 config setup");
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    port: 19999,
    providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
    defaultProvider: "openai",
    codexAutoStart: false,
  }), "utf8");
}

describe("CLI subprocess lifecycle", () => {
  const budget = { execution: 10, term: 10, reap: 10, drain: 10 };
  const scenarios: Array<{
    name: string; mode: "exit" | "timeout" | "unreaped" | "spawn-error" | "exit-error";
    status: number | null; signal?: NodeJS.Signals; open?: boolean;
    failures: string[]; signals: NodeJS.Signals[]; reaped: boolean; retained?: boolean;
  }> = [
    { name: "returns exit 0", mode: "exit", status: 0, failures: [], signals: [], reaped: true },
    { name: "returns health exit 1", mode: "exit", status: 1, failures: [], signals: [], reaped: true },
    { name: "preserves exit 23", mode: "exit", status: 23, failures: [], signals: [], reaped: true },
    { name: "timeout stays failed after TERM yields exit 0", mode: "timeout", status: 0,
      failures: ["execution-timeout"], signals: ["SIGTERM"], reaped: true },
    { name: "open output after exit 0 fails", mode: "exit", status: 0, open: true,
      failures: ["incomplete-output"], signals: [], reaped: true },
    { name: "open output after exit 1 fails", mode: "exit", status: 1, open: true,
      failures: ["incomplete-output"], signals: [], reaped: true },
    { name: "unreaped child retains its home after TERM and KILL", mode: "unreaped", status: null,
      failures: ["execution-timeout", "reap-timeout", "exit-not-observed"],
      signals: ["SIGTERM", "SIGKILL"], reaped: false, retained: true },
    { name: "spawn error is not command exit 1", mode: "spawn-error", status: null,
      failures: ["spawn-error:Error:ENOENT", "exit-not-observed"], signals: [], reaped: false },
    { name: "rejected observation is not reaping", mode: "exit-error", status: null,
      failures: ["exit-observation-error:Error:EPIPE", "reap-timeout", "exit-not-observed"],
      signals: ["SIGTERM", "SIGKILL"], reaped: false, retained: true },
    { name: "signal exit is not a completed command", mode: "exit", status: 0, signal: "SIGTERM",
      failures: ["signal-exit"], signals: [], reaped: true },
  ];

  for (const scenario of scenarios) test(scenario.name, async () => {
    const dir = isolatedHome(`ocx-cli-control-${scenario.name.replace(/[^a-z0-9]+/gi, "-")}-`);
    const state = cliHomes.get(dir)!;
    let resolveExit!: (status: number) => void;
    let rejectExit!: (error: Error) => void;
    const exited = new Promise<number>((resolve, reject) => { resolveExit = resolve; rejectExit = reject; });
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    let cancelled = false;
    const child: CliChild = {
      pid: 424242, exited, signalCode: scenario.signal ?? null,
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("CLI_CONTROL_STDOUT\n"));
          if (!scenario.open) controller.close();
        },
        cancel() { cancelled = true; },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode("CLI_CONTROL_STDERR\n")); controller.close(); },
      }),
      kill(signal) {
        signals.push(signal);
        if (scenario.mode === "timeout") resolveExit(0);
      },
    };
    const spawn: CliSpawn = (argv, options) => {
      expect(argv).toEqual([process.execPath, cliPath, "health"]);
      expect(options.cwd).toBe(repoRoot);
      expect(options.env.OPENCODEX_HOME).toBe(dir);
      if (scenario.mode === "spawn-error") throw Object.assign(new Error("fixture"), { code: "ENOENT" });
      if (scenario.mode === "exit-error") rejectExit(Object.assign(new Error("fixture"), { code: "EPIPE" }));
      if (scenario.mode === "exit") resolveExit(scenario.status!);
      return child;
    };
    try {
      const result: unknown = await runCli(["health"], { OPENCODEX_HOME: dir }, { spawn, budget })
        .then(value => value, error => error);
      if (scenario.failures.length) {
        expect(result).toBeInstanceOf(CliHarnessError);
        if (!(result instanceof CliHarnessError)) throw new Error("Expected CLI harness failure");
        expect(result.failures).toEqual(scenario.failures);
        if (scenario.open) expect(result.outcome.stdout).toBe("CLI_CONTROL_STDOUT\n");
      } else {
        expect(result).toEqual({ status: scenario.status, stdout: "CLI_CONTROL_STDOUT\n", stderr: "CLI_CONTROL_STDERR\n" });
      }
      expect(state.status).toBe(scenario.status);
      expect(state.pid).toBe(scenario.mode === "spawn-error" ? null : 424242);
      expect(state.signal).toBe(scenario.signal ?? null);
      expect(state.reaped).toBe(scenario.reaped);
      expect(state.complete).toBe(scenario.mode !== "spawn-error" && !scenario.open);
      expect(signals).toEqual(scenario.signals);
      expect(cancelled).toBe(Boolean(scenario.open));
      cleanupCliHome(dir, scenario.failures.length > 0);
      expect(existsSync(dir)).toBe(Boolean(scenario.retained));
      expect(cliHomes.has(dir)).toBe(Boolean(scenario.retained));
    } finally {
      // The seam never launched an OS process; only this test owns the retained fake home.
      cliHomes.delete(dir);
      removeTreeWithRetry(dir);
    }
  });
});

describe("ocx restart", () => {
  test("restart --help prints usage", async () => {
    const dir = isolatedHome("ocx-restart-help-");
    let failed = false;
    try {
      const result = await runCli(["restart", "--help"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ocx restart");
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      cleanupCliHome(dir, failed);
    }
  }, CLI_TEST_TIMEOUT);

  test("help restart shows restart help entry", async () => {
    const dir = isolatedHome("ocx-restart-help-entry-");
    let failed = false;
    try {
      const result = await runCli(["help", "restart"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Stop the proxy and restart");
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      cleanupCliHome(dir, failed);
    }
  }, CLI_TEST_TIMEOUT);
});

describe("ocx health", () => {
  test("health --help prints usage", async () => {
    const dir = isolatedHome("ocx-health-help-");
    let failed = false;
    try {
      const result = await runCli(["health", "--help"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ocx health");
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      cleanupCliHome(dir, failed);
    }
  }, CLI_TEST_TIMEOUT);

  test("help health shows health help entry", async () => {
    const dir = isolatedHome("ocx-health-help-entry-");
    let failed = false;
    try {
      const result = await runCli(["help", "health"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Check proxy health");
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      cleanupCliHome(dir, failed);
    }
  }, CLI_TEST_TIMEOUT);

  test("health exits 1 with no proxy running (isolated home)", async () => {
    const dir = isolatedHome("ocx-health-");
    let failed = false;
    try {
      writeIsolatedConfig(dir);
      const result = await runCli(["health"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("not healthy");
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      cleanupCliHome(dir, failed);
    }
  }, CLI_TEST_TIMEOUT);

  test("health --json exits 1 with valid JSON when no proxy", async () => {
    const dir = isolatedHome("ocx-health-json-");
    let failed = false;
    try {
      writeIsolatedConfig(dir);
      const result = await runCli(["health", "--json"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.pid).toBeNull();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      cleanupCliHome(dir, failed);
    }
  }, CLI_TEST_TIMEOUT);
});

describe("ocx ready", () => {
  // Only the help-routing subprocess checks live here. The default-probe,
  // --json, --wait, --timeout, and argument-validation cases are injected tests
  // in tests/cli/cli-ready.test.ts (no real loopback/home).
  test("ready --help prints usage (exit 0)", async () => {
    const dir = isolatedHome("ocx-ready-help-");
    let failed = false;
    try {
      const result = await runCli(["ready", "--help"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ocx ready");
      expect(result.stdout).toContain("--wait");
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      cleanupCliHome(dir, failed);
    }
  }, CLI_TEST_TIMEOUT);

  test("help ready shows the ready help entry", async () => {
    const dir = isolatedHome("ocx-ready-help-entry-");
    let failed = false;
    try {
      const result = await runCli(["help", "ready"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("post-sync readiness");
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      cleanupCliHome(dir, failed);
    }
  }, CLI_TEST_TIMEOUT);
});
