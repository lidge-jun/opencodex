import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { repoRoot } from "./repo-root";
import { SPAWN_BUDGET_MS } from "./test-budget";

/**
 * Pay a child's COLD module-graph load once, in setup, instead of inside a timed assertion.
 *
 * ## The defect this exists for
 *
 * A test that spawns a real Bun child and bounds it with `INTERNAL_DEADLINE_MS` is measuring two
 * different things at once: the behaviour it asserts, and whatever the child had to load before it
 * could run. The second is not a property of the code under test. It is a property of what ELSE ran
 * on that machine first, which is decided by shard composition.
 *
 * The decay is visible in the log and it is per module graph, not per file. Run 35305115672, Windows
 * 2/9, job 105475642050, `tests/cli/cli-connect-readiness.test.ts`:
 *
 * ```text
 * (pass) #4207 connected-client readiness > first-time connect escapes ...        2893.60ms
 * (pass) #4207 connected-client readiness > an installed catalog ...               571.90ms
 * (fail) connected-client runtime probe scope > observes only the selected ...   15339.29ms
 * (pass) connected-client runtime probe scope > a rejected preferred runtime ...  2162.84ms
 * ```
 *
 * Two cold starts in one file. The first describe's first child paid 2.9s against a 0.57s warm
 * baseline; the second describe's first child paid more than 15s against a 2.1s warm baseline,
 * because the `observed` ladder additionally loads `src/codex/runtime` and probes real runtime
 * shims. `spawnSync` returns a null status when its timeout kills the child, which is the
 * `Expected: 0 / Received: null` that failed the shard while 308 other cases passed.
 *
 * That the two deltas differ by an order of magnitude in the same process is the evidence that the
 * cost tracks the GRAPH. A fixed per-process or per-spawn overhead would have moved both rows by the
 * same amount. PR #4948 saw the same shape in `tests/cli/cli-status-json.test.ts` (15587, 13074,
 * then 1518-1741ms) and fixed that one file by hand; this helper is the same remedy made shared.
 *
 * ## Why not the alternatives
 *
 * Raising `INTERNAL_DEADLINE_MS` is refused by `test-budget.ts`, which records what happened the
 * last time a shared budget was widened for one case: `SPAWN_BUDGET_MS` moved 45s -> 90s and halved
 * the reporting speed of 339 Windows cases. The same file also records a derivation chain that
 * reached 265s, long enough that one hang on a ~25-minute Windows shard returns an opaque
 * cancellation instead of a readable Bun timeout.
 *
 * `watchdogMs()` (tests/helpers/ci-watchdog.ts) would raise the bound per call site instead of
 * globally — 45s on Windows CI — and `codex-retained-root-serialization.test.ts` already uses it at
 * one site, which is why that site has never failed this way. It is rejected here for the same
 * reason: it widens the window that a wedged child hides in, and it still leaves a cold start
 * inside a measured assertion, so the log cannot tell a slow start from a hang.
 *
 * A runner-level preload in `tests/preload.ts` would warm once per test process with no per-file
 * edit, and is rejected on three counts. It would run in all four workers of every shard including
 * the shards with no spawning test; `tests/preload.ts` already documents an incident where a spawn
 * added to it timed out, threw out of the preload, and left the real-home guard DISARMED for the
 * whole worker; and it cannot know which graph to warm — the failure quoted above happened in the
 * SECOND graph of a file whose first graph was already warm, so a single generic warm-up would not
 * have prevented it.
 *
 * ## How the warm-up stays honest
 *
 * A warm-up that names its modules by hand stops working the first time an import moves, silently,
 * because nothing fails when it warms the wrong thing. So nothing here is named by hand:
 * `moduleGraphSpecifiers` reads the child's OWN source at run time and asks Bun's transpiler which
 * modules it loads. If an import moves, the warm-up follows it in the same commit. Type-only imports
 * are erased by `transformSync` first, so the scan reports what the child loads at run time rather
 * than what it mentions. The same `scanImports` pass is already the basis of the import-boundary
 * oracles in `tests/responses/responses-fetch-helpers-boundary.test.ts` and
 * `tests/providers/api-key-selection-capture.test.ts`.
 *
 * Only repository-relative and absolute specifiers are warmed. `node:fs` and `bun:test` are builtins
 * with no transpile step, and warming them would measure nothing.
 *
 * `warmColdSpawn` is the other entry point, for a file whose own child runner is the honest warm-up:
 * it replays that runner once with a larger deadline, so the warmed path and the measured path are
 * the same call with no second copy to drift. It also covers cost an import scan cannot see, such as
 * the grandchild runtime shims `cli-connect-readiness` spawns.
 *
 * ## Failure policy
 *
 * A warm-up failure is a setup failure, never a retry. Two things fail closed, because both mean the
 * mechanism is dead rather than slow: a scan that finds no repository module to warm, and a warm
 * child that times out, crashes, or loads nothing. An individual specifier that will not import in
 * isolation is reported by name and does not fail the file — it degrades that one module back to the
 * status quo, where the bound under test is unchanged, and the printed name is how it gets noticed.
 */

/**
 * `removeTreeWithRetry`'s Windows cleanup bound, which a warm-up hook must leave for teardown.
 * Numerically equal to `INTERNAL_DEADLINE_MS` and unrelated to it; do not collapse the two.
 */
const WARMUP_TEARDOWN_RESERVE_MS = 15_000;

/** Reaping the warm-up child after its deadline. */
const WARMUP_REAP_RESERVE_MS = 5_000;

/**
 * Budget for the hook that performs a warm-up. This is `SPAWN_BUDGET_MS` because a warm-up IS a real
 * child process, which is exactly what that budget is for.
 */
export const COLD_SPAWN_WARMUP_HOOK_BUDGET_MS = SPAWN_BUDGET_MS;

/**
 * Deadline for the warm-up child itself: the hook budget minus teardown and reap. 25s, the same
 * number #4948 derived by hand for `cli-status-json`, now derived from its inputs so it moves with
 * them instead of being a literal in one test file.
 */
export const COLD_SPAWN_WARMUP_DEADLINE_MS =
  SPAWN_BUDGET_MS - WARMUP_TEARDOWN_RESERVE_MS - WARMUP_REAP_RESERVE_MS;

const warmed = new Map<string, Promise<void>>();
const transpiler = new Bun.Transpiler({ loader: "ts" });

/** Test seam: the memo is per process, and a unit test needs to observe more than one first call. */
export function resetColdSpawnWarmupForTests(): void {
  warmed.clear();
}

/**
 * The repository modules a child loads at run time, read from the child's own source.
 *
 * `resolveDir` is what a relative specifier is relative to: the entry file's directory for a spawned
 * file, and the child's `cwd` for an `--eval` script, because that is what Bun resolves against.
 */
export function moduleGraphSpecifiers(source: string, resolveDir: string): string[] {
  // `export {}` forces module context before the transform. Several of these children are scanned
  // from a hoisted import prologue rather than a whole file, and a fragment whose only statement is
  // a top-level `await import(...)` is otherwise ambiguous enough to be read as a script, where
  // top-level await is an error. The marker changes nothing the scan reports.
  //
  // The shebang has to come off first. A CLI entry begins with one, and a shebang is only valid on
  // the first line: prepending the marker to `src/cli/index.ts` moved it to line 2 and the scan
  // died with a syntax error instead of warming anything (run 35318878762, shards test 2/4 and
  // windows 8/9). It carries no import, so dropping it loses nothing.
  const scanned = transpiler
    .scanImports(transpiler.transformSync(`export {};\n${withoutShebang(source)}`))
    .map(entry => entry.path);
  const repositorySpecifiers = [...new Set(scanned)].filter(
    specifier => specifier.startsWith(".") || isAbsolute(specifier),
  );
  return repositorySpecifiers.map(
    specifier => (isAbsolute(specifier) ? specifier : resolve(resolveDir, specifier)),
  );
}

function withoutShebang(source: string): string {
  if (!source.startsWith("#!")) return source;
  const firstLineEnd = source.indexOf("\n");
  return firstLineEnd === -1 ? "" : source.slice(firstLineEnd + 1);
}

export type ColdSpawnWarmup = Readonly<{
  /**
   * Names the module graph, not the test file. Two files that spawn the same entry SHOULD share a
   * key: the cost being warmed is the machine's, so the second file inherits the first file's work
   * and skips its own warm-up. `codex-history-lock` and `codex-history-worker` are that case.
   */
  graph: string;
  /** A child entry file to scan. Its directory is the default `resolveDir`. */
  entry?: string;
  /** An inline `--eval` child script to scan. Pass the same string the test spawns. */
  source?: string;
  /** Working directory for the warm-up child. Defaults to the repository root. */
  cwd?: string;
  /** Environment additions for the warm-up child, for a module that reads one at import. */
  env?: Record<string, string | undefined>;
}>;

/**
 * Run `warm` once per process for `graph`, before anything times a child that loads it.
 *
 * The callback receives the warm-up deadline so the caller can hand it to its own child runner
 * instead of `INTERNAL_DEADLINE_MS`. Call this from `beforeAll(..., COLD_SPAWN_WARMUP_HOOK_BUDGET_MS)`.
 */
export async function warmColdSpawn(
  graph: string,
  warm: (deadlineMs: number) => unknown,
): Promise<void> {
  const existing = warmed.get(graph);
  if (existing) return existing;
  const startedAt = performance.now();
  const pending = (async () => {
    await warm(COLD_SPAWN_WARMUP_DEADLINE_MS);
    console.log(
      `[cold-spawn-warmup] graph=${graph} mode=replay elapsedMs=${(performance.now() - startedAt).toFixed(0)}`,
    );
  })();
  // The rejection is memoized on purpose. A second file that shares the graph must see the same
  // setup failure rather than quietly retrying the spawn that just failed.
  warmed.set(graph, pending);
  return pending;
}

/**
 * Load a child's module graph once per process, in a child that imports and exits.
 *
 * This is the cheap form: it pays the transpile and load of everything the real child loads without
 * running the real child's work, so it neither takes the locks nor writes the files the test asserts
 * on. Use `warmColdSpawn` instead when the cold cost includes work an import cannot reach.
 */
export async function warmModuleGraph(options: ColdSpawnWarmup): Promise<void> {
  return warmColdSpawn(options.graph, deadlineMs => runModuleGraphWarmup(options, deadlineMs));
}

export interface ModuleGraphWarmupResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

/**
 * Spawn the warm-up child asynchronously and bound it on a live event loop.
 *
 * A blocking `Bun.spawnSync` made its own `timeout` the only bound it could honour, and that
 * turned out to be no bound at all: while the synchronous wait runs, the event loop is dead, so
 * the calling hook's budget and the suite's per-test timeout freeze inside the same wait and
 * nothing can report anything. Run 35511743422's macos 2/2 leg held that shape for eighteen
 * silent minutes inside tests/clients/client-connect.test.ts before the job ceiling cut it and
 * reported `cancelled` — a result the `ci` gate reads as failure rather than evidence. Whether
 * the child or the spawn primitive wedged is not observable from the outside, so the bound here
 * does not depend on either: SIGKILL at the deadline, a short reap grace, and the call settles
 * with or without the child's exit or EOF. A child that outlives its kill — or a descendant
 * holding its pipes — cannot turn a warm-up into an unbounded wait.
 */
export function spawnModuleGraphWarmupChild(
  script: string,
  cwd: string,
  env: Record<string, string | undefined> | undefined,
  deadlineMs: number,
): Promise<ModuleGraphWarmupResult> {
  const maxCaptureBytes = 1024 * 1024;
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, ["--eval", script], {
        cwd,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      reject(new Error("[cold-spawn-warmup] the warm-up child could not be spawned"));
      return;
    }
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let timedOut = false;
    let exitCode: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let reap: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(reap);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode,
        signal,
        timedOut,
      });
    };
    const beginReapGrace = () => {
      if (settled) return;
      reap ??= setTimeout(finish, WARMUP_REAP_RESERVE_MS);
    };
    const stop = () => {
      if (settled || timedOut) return;
      timedOut = true;
      clearTimeout(deadline);
      beginReapGrace();
      try { child.kill("SIGKILL"); } catch { /* The kill's own failure must not extend the wait. */ }
    };
    const capture = (chunk: Buffer, into: Buffer[]) => {
      if (settled || timedOut) return;
      bytes += chunk.length;
      if (bytes > maxCaptureBytes) { stop(); return; }
      into.push(chunk);
    };
    child.stdout?.on("data", (chunk: Buffer) => capture(chunk, stdoutChunks));
    child.stderr?.on("data", (chunk: Buffer) => capture(chunk, stderrChunks));
    child.stdout?.on("error", stop);
    child.stderr?.on("error", stop);
    // The child was never started or died at launch; there is nothing to reap.
    child.on("error", finish);
    child.once("exit", (code, exitSignal) => {
      exitCode = code;
      signal = exitSignal;
      clearTimeout(deadline);
      // A descendant retaining a pipe must not turn a clean exit into a wait for EOF.
      beginReapGrace();
    });
    child.once("close", (code, exitSignal) => {
      exitCode = code;
      signal = exitSignal;
      finish();
    });
    deadline = setTimeout(stop, deadlineMs);
  });
}

async function runModuleGraphWarmup(options: ColdSpawnWarmup, deadlineMs: number): Promise<void> {
  const cwd = options.cwd ?? repoRoot();
  const source = options.source ?? readFileSync(requireEntry(options), "utf8");
  const resolveDir = options.entry === undefined ? cwd : dirname(options.entry);
  const specifiers = moduleGraphSpecifiers(source, resolveDir);
  if (specifiers.length === 0) {
    throw new Error(
      `[cold-spawn-warmup] graph=${options.graph} scanned no repository module to warm. `
      + "The child's imports moved out of reach of the scan, so the warm-up is doing nothing.",
    );
  }

  const startedAt = performance.now();
  const result = await spawnModuleGraphWarmupChild(
    warmupScript(specifiers, deadlineMs),
    cwd,
    options.env,
    deadlineMs,
  );
  const elapsedMs = (performance.now() - startedAt).toFixed(0);
  const report = parseWarmupReport(result.stdout);
  if (result.timedOut) {
    throw new Error(
      `[cold-spawn-warmup] graph=${options.graph} warm-up child did not exit within ${deadlineMs}ms `
      + `and was killed (specifiers=${specifiers.length}). `
      + `stderr: ${result.stderr.trim().slice(0, 600)}`,
    );
  }
  if (result.exitCode !== 0 || report === undefined || report.loaded === 0) {
    throw new Error(
      `[cold-spawn-warmup] graph=${options.graph} loaded nothing in ${elapsedMs}ms `
      + `(exitCode=${String(result.exitCode)}, specifiers=${specifiers.length}). `
      + `stderr: ${result.stderr.trim().slice(0, 600)}`,
    );
  }
  console.log(
    `[cold-spawn-warmup] graph=${options.graph} mode=import elapsedMs=${elapsedMs} `
    + `loaded=${report.loaded}/${specifiers.length}`,
  );
  for (const failure of report.failures) {
    console.warn(`[cold-spawn-warmup] graph=${options.graph} unloaded ${failure}`);
  }
}

function requireEntry(options: ColdSpawnWarmup): string {
  if (options.entry === undefined) {
    throw new Error(`[cold-spawn-warmup] graph=${options.graph} needs either an entry or a source`);
  }
  return options.entry;
}

const WARMUP_REPORT_PREFIX = "ocx-cold-spawn-warmup:";

/** Margin for the child to print its report before the parent's deadline kills it. */
const WARMUP_REPORT_RESERVE_MS = 3_000;

/**
 * Each import is attempted on its own so one module that will not load in isolation reports its own
 * name instead of hiding the rest. `process.exit` is deliberate: a warmed module may hold a live
 * timer or handle, and the point of this child is to have loaded, not to shut down cleanly.
 *
 * The child also keeps its own budget, a few seconds inside the deadline that would kill it, so one
 * module that never settles at import cannot consume the whole warm-up and turn a slow file red. It
 * stops and reports what it got, which leaves the bound under test exactly where it already was.
 */
function warmupScript(specifiers: readonly string[], deadlineMs: number): string {
  return [
    `const specifiers = ${JSON.stringify(specifiers)};`,
    `const budgetEndsAt = Date.now() + ${Math.max(1_000, deadlineMs - WARMUP_REPORT_RESERVE_MS)};`,
    "const failures = [];",
    "let loaded = 0;",
    "for (const specifier of specifiers) {",
    "  const remaining = budgetEndsAt - Date.now();",
    "  if (remaining <= 0) { failures.push(specifier + \": warm-up budget exhausted\"); continue; }",
    "  try {",
    "    const settled = await Promise.race([",
    "      import(specifier).then(() => \"loaded\"),",
    "      Bun.sleep(remaining).then(() => \"unsettled\"),",
    "    ]);",
    "    if (settled === \"loaded\") loaded += 1;",
    "    else failures.push(specifier + \": did not settle within the warm-up budget\");",
    "  }",
    "  catch (error) { failures.push(specifier + \": \" + String(error && error.message)); }",
    "}",
    `console.log(${JSON.stringify(WARMUP_REPORT_PREFIX)} + JSON.stringify({ loaded, failures }));`,
    "process.exit(0);",
  ].join("\n");
}

function parseWarmupReport(stdout: string): { loaded: number; failures: string[] } | undefined {
  const line = stdout.split("\n").find(candidate => candidate.startsWith(WARMUP_REPORT_PREFIX));
  if (line === undefined) return undefined;
  try {
    const parsed = JSON.parse(line.slice(WARMUP_REPORT_PREFIX.length)) as {
      loaded?: unknown;
      failures?: unknown;
    };
    if (typeof parsed.loaded !== "number" || !Array.isArray(parsed.failures)) return undefined;
    return { loaded: parsed.loaded, failures: parsed.failures.map(String) };
  } catch {
    return undefined;
  }
}
