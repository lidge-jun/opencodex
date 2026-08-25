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

export interface ChangedRunPreflight {
  comparisonRef: string;
  comparisonCommit: string;
  changedFiles: string[];
}

const changedComparisonRefs = ["upstream/dev", "origin/dev", "dev"] as const;

/** Choose the highest-priority conventional dev ref without assuming which remote is canonical. */
export function selectChangedComparisonRef(refExists: (ref: string) => boolean): string | null {
  return changedComparisonRefs.find(refExists) ?? null;
}

function decodeOutput(output: Uint8Array | undefined): string {
  return output ? new TextDecoder().decode(output) : "";
}

function changedComparisonRef(requested: string[]): string | null {
  const delimiterIndex = requested.indexOf("--");
  const wrapperArgs = delimiterIndex === -1 ? requested : requested.slice(0, delimiterIndex);
  const changedArg = wrapperArgs.find(arg => arg === "--changed" || arg.startsWith("--changed="));
  if (!changedArg) return null;
  if (changedArg === "--changed" || changedArg === "--changed=") {
    throw new Error(
      "[test] changed mode requires an explicit comparison ref; use --changed=<ref> so the selection can be validated.",
    );
  }
  return changedArg.slice("--changed=".length);
}

function gitRefExists(
  ref: string,
  cwd: string,
  env: Record<string, string | undefined>,
): boolean {
  const result = Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    cwd,
    env,
    stdout: "ignore",
    stderr: "ignore",
  });
  return result.exitCode === 0;
}

function gitOutput(
  args: string[],
  cwd: string,
  env: Record<string, string | undefined>,
): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const detail = decodeOutput(result.stderr).trim() || `exit ${result.exitCode ?? "unknown"}`;
    throw new Error(`[test] git ${args[0]} failed while validating changed mode: ${detail}`);
  }
  return decodeOutput(result.stdout);
}

/** Resolve changed mode and inventory the diff against that commit before invoking Bun. */
export function inspectChangedRun(
  requested: string[],
  cwd: string = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): ChangedRunPreflight | null {
  const requestedComparisonRef = changedComparisonRef(requested);
  if (!requestedComparisonRef) return null;
  if (requestedComparisonRef.startsWith("-")) {
    throw new Error(
      `[test] --changed comparison ref ${JSON.stringify(requestedComparisonRef)} is invalid.`,
    );
  }

  const comparisonRef = requestedComparisonRef === "dev"
    ? selectChangedComparisonRef(ref => gitRefExists(ref, cwd, env))
    : requestedComparisonRef;
  if (!comparisonRef) {
    throw new Error(
      `[test] --changed=dev could not resolve a comparison ref; none of ${changedComparisonRefs.join(", ")} exists.`,
    );
  }

  if (!gitRefExists(comparisonRef, cwd, env)) {
    throw new Error(
      `[test] --changed comparison ref ${JSON.stringify(comparisonRef)} does not resolve to a commit.`,
    );
  }

  const comparisonCommit = gitOutput(["merge-base", "HEAD", comparisonRef], cwd, env).trim();
  if (!comparisonCommit) {
    throw new Error(
      `[test] --changed comparison ref ${JSON.stringify(comparisonRef)} has no merge base with HEAD.`,
    );
  }

  const diff = gitOutput(["diff", "--name-only", comparisonCommit, "--"], cwd, env);
  const changedFiles = [...new Set(diff.split("\n").filter(Boolean))];
  return { comparisonRef, comparisonCommit, changedFiles };
}

/** Refuse a successful changed-mode run when Bun silently selected no tests for a real diff. */
export function changedSelectionFailure(
  preflight: ChangedRunPreflight,
  output: string,
): string | null {
  if (preflight.changedFiles.length === 0) return null;
  const summary = output
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .match(/Ran\s+(\d+)\s+tests?\s+across\s+(\d+)\s+files?\b/i);
  if (!summary) {
    return `[test] could not validate --changed=${preflight.comparisonCommit} (${preflight.comparisonRef} merge base): Bun did not emit a recognizable selection summary for a diff containing ${preflight.changedFiles.length} changed file(s).`;
  }
  if (Number(summary[1]) !== 0 || Number(summary[2]) !== 0) return null;
  return `[test] --changed=${preflight.comparisonCommit} (${preflight.comparisonRef} merge base) selected 0 tests across 0 files, but the diff contains ${preflight.changedFiles.length} changed file(s). Bun follows only the parsed module graph; run the relevant focused tests for subprocess, read-as-data, or golden-file dependencies, or run the full suite.`;
}

/**
 * True for a filter-less `bun run test`: no file arguments and no `--changed`.
 * `--timeout` / `--dots` / `--parallel=N` still count as full.
 */
/** True for a filter-less `bun run test`. `--timeout` / `--dots` / `--parallel=N` still count. */
function isFullSuiteRun(requested: string[]): boolean {
  const delimiterIndex = requested.indexOf("--");
  const wrapperArgs = delimiterIndex === -1 ? requested : requested.slice(0, delimiterIndex);
  const passedThrough = delimiterIndex === -1 ? [] : requested.slice(delimiterIndex + 1);
  if (passedThrough.length > 0) return false;
  if (hasCliFlag(requested, "--changed")) return false;

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
export function resolveBunTestArgs(
  requested: string[],
  comparisonCommit?: string,
): string[] {
  const delimiterIndex = requested.indexOf("--");
  const effectiveRequested = comparisonCommit
    ? requested.map((arg, index) => (
        (delimiterIndex === -1 || index < delimiterIndex)
          && (arg === "--changed" || arg.startsWith("--changed="))
          ? "--changed=" + comparisonCommit
          : arg
      ))
    : requested;
  const args = ["--isolate"];
  if (!hasCliFlag(effectiveRequested, "--parallel")) {
    args.push(`--parallel=${DEFAULT_TEST_PARALLELISM}`);
  }
  args.push(...effectiveRequested);
  if (isFullSuiteRun(effectiveRequested)) args.push("./tests/");
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
export function resolveBunTestPlan(requested: string[], comparisonCommit?: string): BunTestLane[] {
  if (!canUseSerialLanes(requested)) {
    return [{ label: "suite", args: resolveBunTestArgs(requested, comparisonCommit), timeoutMs: 15 * 60 * 1000 }];
  }

  const mainArgs = resolveBunTestArgs(requested, comparisonCommit);
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

async function runTestLane(lane: BunTestLane, runId: string, capture = false): Promise<{ exitCode: number; output: string }> {
  const isolated = createIsolatedTestEnvironment({ ...process.env, [TEST_RUN_ID_ENV]: runId });
  const startedAt = Date.now();
  let interrupted: NodeJS.Signals | null = null;
  const child = Bun.spawn([process.execPath, "test", ...lane.args], {
    env: isolated.env,
    stdin: "inherit",
    stdout: capture ? "pipe" : "inherit",
    stderr: capture ? "pipe" : "inherit",
  });
  const stdoutP = capture ? new Response(child.stdout).text() : Promise.resolve("");
  const stderrP = capture ? new Response(child.stderr).text() : Promise.resolve("");
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
      return { exitCode: 124, output: "" };
    }
    const [stdout, stderr] = await Promise.all([stdoutP, stderrP]);
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    const output = stdout + "\n" + stderr;
    if (interrupted === "SIGINT") return { exitCode: 130, output };
    if (interrupted === "SIGTERM") return { exitCode: 143, output };
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.warn(`[test] ${lane.label} finished in ${seconds}s (exit ${exitCode}).`);
    return { exitCode, output };
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    isolated.cleanup();
  }
}

if (import.meta.main) {
  const requestedTests = process.argv.slice(2);
  let changedRun: ReturnType<typeof inspectChangedRun> = null;
  try {
    changedRun = inspectChangedRun(requestedTests);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
  if (process.exitCode !== 1) {
    if (changedRun) {
      console.warn(
        `[test] changed mode comparison ref: ${changedRun.comparisonRef}; merge base: ${changedRun.comparisonCommit}`,
      );
    }
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
      let captured = "";
      for (const lane of resolveBunTestPlan(requestedTests, changedRun?.comparisonCommit)) {
        const result = await runTestLane(lane, runId, Boolean(changedRun));
        captured += result.output;
        if (result.exitCode !== 0 && exitCode === 0) exitCode = result.exitCode;
        if ([124, 130, 143].includes(result.exitCode)) break;
      }
      if (exitCode === 0 && changedRun) {
        const selectionFailure = changedSelectionFailure(changedRun, captured);
        if (selectionFailure) {
          console.error(selectionFailure);
          exitCode = 1;
        }
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
}
