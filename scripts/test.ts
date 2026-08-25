import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { acquireTestRunLock, TEST_RUN_ID_ENV } from "./test-run-lock";

export interface IsolatedTestEnvironment {
  root: string;
  env: Record<string, string | undefined>;
  cleanup(): void;
}

export function createIsolatedTestEnvironment(
  baseEnv: Record<string, string | undefined> = process.env,
): IsolatedTestEnvironment {
  const root = mkdtempSync(join(tmpdir(), "opencodex-test-"));
  const opencodexHome = join(root, ".opencodex");
  const codexHome = join(root, ".codex");
  mkdirSync(opencodexHome, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  if (process.platform === "win32") {
    // A Windows sandbox has to look like a real profile, because the known-folder APIs
    // resolve relative to USERPROFILE and .NET returns an EMPTY STRING — not an error —
    // when the folder it computes does not exist. `resolveWindowsRuntimeRoot` asks
    // PowerShell for `GetFolderPath(LocalApplicationData)`, so without these directories
    // every Codex coordinator lookup refuses with "Windows effective-account lookup
    // returned an empty value" and each refusal surfaces as an unrelated assertion in
    // whichever suite happened to touch a Codex home.
    mkdirSync(join(root, "AppData", "Local"), { recursive: true });
    mkdirSync(join(root, "AppData", "Roaming"), { recursive: true });
  }

  return {
    root,
    env: {
      ...baseEnv,
      // Captured BEFORE HOME is overwritten: once the child starts with a rewritten
      // HOME, `homedir()` returns the sandbox, so this hand-off is the only way the
      // real-home write guard can still know which path to protect.
      // (devlog 260730_codex_rs_upstream_v2_live_handoff/070.)
      OCX_REAL_HOME: baseEnv.OCX_REAL_HOME ?? homedir(),
      // Pin git's global config to the developer's real one before HOME moves.
      //
      // git resolves ~/.gitconfig from HOME, so a sandboxed HOME makes it invisible.
      // That silently drops `safe.directory`, and on a checkout whose directory owner
      // differs from the running account -- ordinary on Windows when a tool or
      // installer created the tree -- every `git` call a test makes then fails with
      // "detected dubious ownership". The test reads that as "this is not a git
      // repository" and asserts against a fallback, which looks like a product bug in
      // whichever adapter collected the metadata. Naming the file keeps the sandbox
      // (git still writes nothing here) while leaving git's own trust decisions intact.
      GIT_CONFIG_GLOBAL: baseEnv.GIT_CONFIG_GLOBAL ?? join(homedir(), ".gitconfig"),
      HOME: root,
      USERPROFILE: root,
      OPENCODEX_HOME: opencodexHome,
      CODEX_HOME: codexHome,
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function hasCliFlag(requested: string[], name: string): boolean {
  const delimiterIndex = requested.indexOf("--");
  const wrapperArgs = delimiterIndex === -1 ? requested : requested.slice(0, delimiterIndex);
  return wrapperArgs.some(arg => arg === name || arg.startsWith(`${name}=`));
}

const DEFAULT_TEST_PARALLELISM = 4;

// Bun 1.4.0 builds `bun test` options from its test, runtime, transpiler, and base tables.
// Only required values consume the next argument. Optional values such as `--parallel=2`
// must stay attached so a bare option cannot hide the positional filter that follows it.
const BUN_TEST_OPTIONS_REQUIRING_VALUES = new Set([
  // Test options.
  "--timeout",
  "--rerun-each",
  "--retry",
  "--seed",
  "--coverage-reporter",
  "--coverage-dir",
  "-t",
  "--test-name-pattern",
  "--grep",
  "--reporter",
  "--reporter-outfile",
  "--max-concurrency",
  "--path-ignore-patterns",
  "--parallel-delay",
  "--shard",
  "--timings",
  // Runtime options accepted by `bun test`.
  "--watch-kill-signal",
  "-r",
  "--preload",
  "--require",
  "--import",
  "--cpu-prof-name",
  "--cpu-prof-dir",
  "--cpu-prof-interval",
  "--heap-prof-name",
  "--heap-prof-dir",
  "--heap-prof-interval",
  "--install",
  "-e",
  "--eval",
  "-p",
  "--print",
  "--port",
  "--origin",
  "--conditions",
  "--fetch-preconnect",
  "--max-http-header-size",
  "--dns-result-order",
  "--redirect-warnings",
  "--disable-warning",
  "--title",
  "--unhandled-rejections",
  "--console-depth",
  "--user-agent",
  "--cron-title",
  "--cron-period",
  "--trace-event-categories",
  "--trace-event-file-pattern",
  "--stack-trace-limit",
  // Transpiler and base options accepted by `bun test`.
  "--main-fields",
  "--extension-order",
  "--tsconfig-override",
  "-d",
  "--define",
  "--drop",
  "--feature",
  "-l",
  "--loader",
  "--jsx-factory",
  "--jsx-fragment",
  "--jsx-import-source",
  "--jsx-runtime",
  "--env-file",
  "--cwd",
  "-c",
  "--config",
]);

/** True for a filter-less `bun run test`. `--timeout` / `--dots` / `--parallel=N` still count. */
function isFullSuiteRun(requested: string[]): boolean {
  const delimiterIndex = requested.indexOf("--");
  const wrapperArgs = delimiterIndex === -1 ? requested : requested.slice(0, delimiterIndex);
  const passedThrough = delimiterIndex === -1 ? [] : requested.slice(delimiterIndex + 1);
  if (passedThrough.length > 0) return false;

  for (let index = 0; index < wrapperArgs.length; index++) {
    const arg = wrapperArgs[index];
    if (arg === "-" || !arg.startsWith("-")) return false;
    if (!arg.includes("=") && BUN_TEST_OPTIONS_REQUIRING_VALUES.has(arg)) index++;
  }
  return true;
}

/**
 * Default `bun test` argv for this repo.
 *
 * `--isolate` keeps a fresh global per file. Bounded parallelism is what makes the suite
 * finishable: with isolate alone Bun re-evaluates
 * the module graph once per file on a single core, so past ~900 files the run stops looking slow
 * and starts looking hung — measured here at 1 h 29 m with zero output, ~57 % CPU and 8.5 MB RSS,
 * against a few minutes for the identical suite with four workers. Leaving Bun to select all ten
 * workers made deadline-sensitive tests fail under load, so the repository default is deterministic.
 * A caller-supplied `--parallel` or `--parallel=N` is left alone.
 */
export function resolveBunTestArgs(requested: string[]): string[] {
  const args = ["--isolate"];
  if (!hasCliFlag(requested, "--parallel")) {
    args.push(`--parallel=${DEFAULT_TEST_PARALLELISM}`);
  }
  args.push(...requested);
  if (isFullSuiteRun(requested)) args.push("./tests/");
  return args;
}

export const SERIAL_FULL_SUITE_FILES = [
  "codex-shim.test.ts",
  "cursor-native-exec-shell.test.ts",
  "issue-452-empty-503.test.ts",
  "openai-provider-option-e2e.test.ts",
  "release-helper.test.ts",
  "update-stop-first.test.ts",
] as const;

const SERIAL_LANE_TIMEOUT_MS: Partial<Record<(typeof SERIAL_FULL_SUITE_FILES)[number], number>> = {
  // This file intentionally exercises 33 complete release-script subprocess trees.
  // It is ~90s on an idle machine and measured at ~170s under unrelated host load.
  "release-helper.test.ts": 5 * 60 * 1000,
};

export interface BunTestLane {
  label: string;
  args: string[];
  timeoutMs: number;
}

function withoutParallelOverride(requested: string[]): string[] {
  return requested.filter(arg => arg !== "--parallel" && !arg.startsWith("--parallel="));
}

function canUseSerialLanes(requested: string[]): boolean {
  if (!isFullSuiteRun(requested)) return false;
  return !["--changed", "--shard", "--reporter-outfile", "--update-timings"].some(flag => hasCliFlag(requested, flag));
}

/** Build the default full-suite plan: one bounded main lane plus isolated risky files. */
export function resolveBunTestPlan(requested: string[]): BunTestLane[] {
  if (!canUseSerialLanes(requested)) {
    return [{ label: "suite", args: resolveBunTestArgs(requested), timeoutMs: 15 * 60 * 1000 }];
  }

  const mainArgs = resolveBunTestArgs(requested);
  const rootIndex = mainArgs.lastIndexOf("./tests/");
  const ignores = SERIAL_FULL_SUITE_FILES.flatMap(file => ["--path-ignore-patterns", `**/${file}`]);
  mainArgs.splice(rootIndex === -1 ? mainArgs.length : rootIndex, 0, ...ignores);
  const serialRequested = withoutParallelOverride(requested);
  return [
    { label: "parallel suite", args: mainArgs, timeoutMs: 15 * 60 * 1000 },
    ...SERIAL_FULL_SUITE_FILES.map(file => ({
      label: file,
      args: resolveBunTestArgs(["--parallel=1", ...serialRequested, `./tests/${file}`]),
      timeoutMs: SERIAL_LANE_TIMEOUT_MS[file] ?? 3 * 60 * 1000,
    })),
  ];
}

function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function runTestLane(lane: BunTestLane, runId: string): Promise<number> {
  const isolated = createIsolatedTestEnvironment({ ...process.env, [TEST_RUN_ID_ENV]: runId });
  const startedAt = Date.now();
  let interrupted: NodeJS.Signals | null = null;
  const child = Bun.spawn([process.execPath, "test", ...lane.args], {
    env: isolated.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const forward = (signal: NodeJS.Signals) => {
    interrupted = signal;
    try { child.kill(signal); } catch { /* child already exited */ }
  };
  const onInterrupt = () => forward("SIGINT");
  const onTerminate = () => forward("SIGTERM");
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);

  const exited = child.exited;
  try {
    const exitCode = await waitWithTimeout(exited, lane.timeoutMs);
    if (exitCode === null) {
      console.error(`[test] ${lane.label} exceeded ${Math.round(lane.timeoutMs / 1000)}s; terminating pid ${child.pid}.`);
      try { child.kill("SIGTERM"); } catch { /* child already exited */ }
      const graceful = await waitWithTimeout(exited, 5_000);
      if (graceful === null) {
        try { child.kill("SIGKILL"); } catch { /* child already exited */ }
        await waitWithTimeout(exited, 2_000);
      }
      return 124;
    }
    if (interrupted === "SIGINT") return 130;
    if (interrupted === "SIGTERM") return 143;
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.warn(`[test] ${lane.label} finished in ${seconds}s (exit ${exitCode}).`);
    return exitCode;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    isolated.cleanup();
  }
}

if (import.meta.main) {
  const requestedTests = process.argv.slice(2);
  const runId = randomUUID();
  const lock = await acquireTestRunLock({
    runId,
    onWait: owner => console.warn(
      `[test] another Bun test run${owner ? ` (pid ${owner.pid})` : ""} holds the machine lock; waiting. `
      + "Set OCX_TEST_NO_QUEUE=1 only for intentional overlap.",
    ),
    onAcquiredAfterWait: elapsedMs => console.warn(`[test] acquired the machine lock after ${Math.round(elapsedMs / 1000)}s.`),
  });
  const startedAt = Date.now();
  try {
    let exitCode = 0;
    for (const lane of resolveBunTestPlan(requestedTests)) {
      const laneExitCode = await runTestLane(lane, runId);
      if (laneExitCode !== 0 && exitCode === 0) exitCode = laneExitCode;
      if ([124, 130, 143].includes(laneExitCode)) break;
    }
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    if (isFullSuiteRun(requestedTests) && elapsedSeconds > 600) {
      console.warn(
        `[test] the suite took ${elapsedSeconds}s; with --parallel=${DEFAULT_TEST_PARALLELISM} it should finish in a few minutes on an idle machine. `
        + "Check for another test runner, a busy CPU, or a test that started polling something real.",
      );
    }
    process.exitCode = exitCode;
  } finally {
    lock.release();
  }
}
