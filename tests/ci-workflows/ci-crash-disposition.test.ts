/**
 * Disposition, asserted by execution.
 *
 * Every earlier contract for this machinery read shell SOURCE TEXT: it checked that a string
 * was present in `run-bun-test-batches.sh` or in a ci.yml `run:` block. That proves nothing
 * about what the script DOES. One of those cases was called "a timeout may still recover" and
 * pinned the mask in place: the runner classified a batch timeout separately, re-ran the batch
 * one file per process, and returned success when the singletons passed. Singleton isolation
 * removes exactly the conditions that produce the failure -- batch concurrency, shared process
 * state, resource pressure -- so the sweep was always going to pass. Linux CI segfaulted twelve
 * to fourteen times per run from 2026-09-08 and reported green (run 35087572377, job
 * 104766021341, batches 11, 15, 18, 19, 22 and 26).
 *
 * So this file runs the real scripts. The classifier is executed against synthesized exit
 * statuses and log fixtures; the batch runner is executed against a fake `bun` and a fake
 * `timeout` that reproduce a crash, a hang and an assertion failure on demand. The assertion
 * in every runner case is the process exit status, which is the only thing GitHub reads.
 *
 * The two halves have different local harness reach on purpose. The classifier is portable shell,
 * so it runs wherever a POSIX shell exists. The batch runner executes in Linux and Windows CI;
 * this fake-toolchain harness runs on Linux/macOS with a synthesized `timeout` and POSIX
 * process statuses. The manual Windows matrix exercises the real Git-for-Windows Bash/coreutils
 * path. That is platform evidence matched to the actual runner rather than a local emulation.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath, repoRoot as resolveRepoRoot } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

const repoRoot = resolveRepoRoot();
const CLASSIFIER = repoPath("scripts", "ci", "bun-crash-signatures.sh");
const RUNNER = repoPath("scripts", "ci", "run-bun-test-batches.sh");
const decode = (value: Uint8Array): string => new TextDecoder().decode(value);

// Sources the real classifier and prints its verdict for one (status, log) triple.
const PROBE = [
  "set -euo pipefail",
  'source "$1"',
  'if is_bun_runtime_crash "$2" "$3"; then echo CRASH; else echo TEST; fi',
].join("\n");

const EPOLL_LOG = [
  "# Unhandled error between tests",
  "-------------------------------",
  "error: EEXIST: file already exists, epoll_ctl",
  "      at new WriteStream (internal:fs/streams:412:11)",
  "-------------------------------",
  "",
].join("\n");
// The same failure without the WriteStream frame: an ordinary EEXIST, not Bun's internal one.
const PARTIAL_EPOLL_LOG = EPOLL_LOG.split("\n")
  .filter(line => !line.includes("new WriteStream"))
  .join("\n");

function classify(status: number, log: string): string {
  const directory = mkdtempSync(join(tmpdir(), "ocx-crash-classifier-"));
  try {
    const logPath = join(directory, "bun.log");
    writeFileSync(logPath, log, "utf8");
    const result = Bun.spawnSync(
      ["bash", "--noprofile", "--norc", "-c", PROBE, "probe", CLASSIFIER, String(status), logPath],
      { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
    );
    // A probe that failed to source would print nothing and silently answer "TEST".
    expect(`exit:${result.exitCode} stderr:${decode(result.stderr)}`).toBe("exit:0 stderr:");
    return decode(result.stdout).trim();
  } finally {
    removeTreeWithRetry(directory);
  }
}

describe.skipIf(process.platform === "win32")("the shared Bun crash classifier, executed", () => {
  const cases: Array<[string, number, string, "CRASH" | "TEST"]> = [
    ["a fatal signal status is a crash whatever the log says", 139, "", "CRASH"],
    ["SIGABRT likewise", 134, "", "CRASH"],
    [
      "the banner Bun printed in run 35087572377",
      1,
      "panic(main thread): Segmentation fault at address 0x10\noh no: Bun has crashed.\n",
      "CRASH",
    ],
    // #2152 broke one lane by anchoring on the thread-numbered form; both forms are one class.
    ["the thread-numbered panic form", 1, "panic(thread 2852): Illegal instruction\n", "CRASH"],
    ["Windows exit 3 corroborated by the banner", 3, "oh no: Bun has crashed.\n", "CRASH"],
    // The whole reason 3 is not in the status list: it is an ordinary small exit code.
    ["Windows exit 3 with no banner stays a test failure", 3, "(fail) fixture > 1 fail\n", "TEST"],
    ["an ordinary assertion failure", 1, "(fail) fixture > expected true, received false\n", "TEST"],
    ["Bun's internal epoll WriteStream failure", 1, EPOLL_LOG, "CRASH"],
    ["the same EEXIST without the WriteStream frame", 1, PARTIAL_EPOLL_LOG, "TEST"],
    ["the banner in upper case", 1, "OH NO: BUN HAS CRASHED.\n", "CRASH"],
  ];

  test.each(cases)("%s", (_name, status, log, expected) => {
    expect(classify(status, log)).toBe(expected);
  }, SPAWN_BUDGET_MS);
});

// Six files at batch size three: two batches, so a failure in the first also proves the shard
// stops rather than continuing to collect batches it can no longer pass.
const FIXTURE_FILES = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"]
  .map(name => `${name}.test.ts`);
const DEDICATED_FILE = "api-usage.test.ts";
const FIRST_BATCH = FIXTURE_FILES.slice(0, 3);
const SECOND_BATCH = FIXTURE_FILES.slice(3);

// GNU timeout, reduced to what the runner uses: flags, a duration, then the command. The runner
// also probes this shape before using it. In "timeout" mode it reports 124 for a multi-file batch
// without ever starting Bun, which is exactly what a wedged batch looks like to the runner.
const FAKE_TIMEOUT = [
  "#!/bin/sh",
  "while [ $# -gt 0 ]; do",
  '  case "$1" in',
  "    --*) shift ;;",
  "    *) break ;;",
  "  esac",
  "done",
  "shift",
  "files=0",
  'for arg in "$@"; do',
  '  case "$arg" in *.test.ts) files=$((files + 1)) ;; esac',
  "done",
  'if [ "${FIXTURE_MODE:-green}" = "timeout" ] && [ "$files" -gt 1 ]; then',
  '  echo "fixture: the batch never finished"',
  "  exit 124",
  "fi",
  'exec "$@"',
  "",
].join("\n");

// A BSD-style timeout that rejects GNU options, as on macOS with a non-GNU timeout on PATH. The
// runner must fall back to its portable deadline rather than run batches unbounded.
const FAKE_NON_GNU_TIMEOUT = [
  "#!/bin/sh",
  'echo "timeout: illegal option -- -" >&2',
  "exit 125",
  "",
].join("\n");

// A single file always passes. That is the whole point: the defect being modelled is one only a
// multi-file process can have, so the attribution sweep is guaranteed to come back clean.
const FAKE_BUN = [
  "#!/bin/sh",
  'if [ "$1" = "-e" ]; then printf "%s\\n" "$FIXTURE_ISOLATED"; exit "${FIXTURE_MANIFEST_STATUS:-0}"; fi',
  "files=0",
  'for arg in "$@"; do',
  '  case "$arg" in *.test.ts) files=$((files + 1)) ;; esac',
  "done",
  "printf '%s|%s|%s\\n' \"$files\" \"${OCX_TEST_NO_QUEUE:-}\" \"$*\" >> \"$FIXTURE_CALLS\"",
  'if [ "${FIXTURE_MODE:-}" = "isolated-assert" ] && [ "$files" -eq 1 ]; then',
  '  case "$*" in *tests/bravo.test.ts) echo "(fail) isolated fixture"; exit 23 ;; esac',
  'fi',
  'if [ "$files" -le 1 ]; then',
  "  exit 0",
  "fi",
  'case "${FIXTURE_MODE:-green}" in',
  "  crash)",
  '    echo "panic(main thread): Segmentation fault at address 0x10"',
  '    echo "oh no: Bun has crashed."',
  "    exit 139",
  "    ;;",
  "  assert)",
  '    echo "(fail) fixture > expected true, received false"',
  "    exit 1",
  "    ;;",
  // A wedged batch whose child ignores TERM: the batch process itself dies at the deadline, the
  // child survives TERM and holds the output pipe until the group KILL removes it.
  "  hang)",
  "    ( trap '' TERM; exec sleep 300 ) &",
  '    echo "$!" > "$FIXTURE_CHILD_PID"',
  "    sleep 300",
  "    exit 0",
  "    ;;",
  // A wedged batch that ignores TERM itself, so only KILL ends it.
  "  hang-ignore-term)",
  "    trap '' TERM",
  "    sleep 300",
  "    exit 0",
  "    ;;",
  "esac",
  "exit 0",
  "",
].join("\n");

type RunnerResult = { status: number | null; output: string; calls: string[]; childPid?: number };

type RunnerOptions = {
  isolated?: string[];
  manifestStatus?: number;
  shard?: string;
  parallel?: string;
  additionalFiles?: string[];
  batchSize?: string;
  timeoutTool?: "gnu" | "non-gnu";
  batchTimeoutSeconds?: string;
  killGraceSeconds?: string;
};

function runBatches(
  mode: "green" | "crash" | "timeout" | "assert" | "isolated-assert" | "hang" | "hang-ignore-term",
  fileScope: "general" | "all" = "general",
  options: RunnerOptions = {},
): RunnerResult {
  const directory = mkdtempSync(join(tmpdir(), "ocx-batch-disposition-"));
  try {
    const binDirectory = join(directory, "bin");
    mkdirSync(binDirectory);
    mkdirSync(join(directory, "tmp"));
    mkdirSync(join(directory, "tests"));
    for (const file of FIXTURE_FILES) writeFileSync(join(directory, "tests", file), "");
    writeFileSync(join(directory, "tests", DEDICATED_FILE), "");
    for (const file of options.additionalFiles ?? []) writeFileSync(join(directory, "tests", file), "");
    writeFileSync(
      join(binDirectory, "timeout"),
      options.timeoutTool === "non-gnu" ? FAKE_NON_GNU_TIMEOUT : FAKE_TIMEOUT,
      { mode: 0o755 },
    );
    writeFileSync(join(binDirectory, "bun"), FAKE_BUN, { mode: 0o755 });
    const calls = join(directory, "calls.log");
    writeFileSync(calls, "");
    const childPidFile = join(directory, "child.pid");

    const result = Bun.spawnSync(["bash", RUNNER, options.shard ?? "1/1"], {
      cwd: directory,
      env: {
        PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`,
        HOME: directory,
        TMPDIR: join(directory, "tmp"),
        CI: "true",
        BUN_TEST_BATCH_SIZE: options.batchSize ?? "3",
        ...(options.batchTimeoutSeconds === undefined ? {} : { BUN_TEST_BATCH_TIMEOUT_SECONDS: options.batchTimeoutSeconds }),
        ...(options.killGraceSeconds === undefined ? {} : { BUN_TEST_BATCH_KILL_GRACE_SECONDS: options.killGraceSeconds }),
        BUN_TEST_FILE_SCOPE: fileScope,
        ...(options.parallel === undefined ? {} : { BUN_TEST_PARALLEL: options.parallel }),
        OCX_TEST_NO_QUEUE: "1",
        OPENCODEX_BUN_PATH: join(binDirectory, "bun"),
        FIXTURE_MODE: mode,
        FIXTURE_CALLS: calls,
        FIXTURE_ISOLATED: (options.isolated ?? [DEDICATED_FILE]).join("\n"),
        FIXTURE_MANIFEST_STATUS: String(options.manifestStatus ?? 0),
        FIXTURE_CHILD_PID: childPidFile,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    return {
      status: result.exitCode,
      output: `${decode(result.stdout)}${decode(result.stderr)}`,
      calls: readFileSync(calls, "utf8").split("\n").filter(Boolean),
      ...(existsSync(childPidFile) ? { childPid: Number(readFileSync(childPidFile, "utf8").trim()) } : {}),
    };
  } finally {
    removeTreeWithRetry(directory);
  }
}

/** True once the process is gone, or only a zombie waiting for its new parent to reap it. */
function processGone(pid: number): boolean {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = decode(Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]).stdout).trim();
    if (state === "" || state.startsWith("Z")) return true;
    Bun.sleepSync(100);
  }
  return false;
}

const batchCalls = (result: RunnerResult): string[] =>
  result.calls.filter(call => !call.startsWith("1|"));
const singletonCalls = (result: RunnerResult): string[] =>
  result.calls.filter(call => call.startsWith("1|"));
const noQueueFlags = (result: RunnerResult): string[] =>
  result.calls.map(call => call.split("|")[1] ?? "");

describe.skipIf(process.platform === "win32")("the hosted batch runner, executed", () => {
  test("a clean run is green and runs each batch exactly once", () => {
    const run = runBatches("green");
    expect(`status:${run.status}`, run.output).toBe("status:0");
    expect(batchCalls(run)).toHaveLength(2);
    expect(singletonCalls(run)).toEqual([]);
    expect(noQueueFlags(run)).toEqual(["1", "1"]);
    expect(run.calls.some(call => call.includes(DEDICATED_FILE))).toBe(false);
  }, SPAWN_BUDGET_MS);

  test("all scope preserves the dedicated families in the Windows suite", () => {
    const run = runBatches("green", "all");
    expect(`status:${run.status}`, run.output).toBe("status:0");
    // The isolated entry keeps its sorted position; every other file is still batched.
    expect(run.calls.map(call => Number(call.split("|", 1)[0]))).toEqual([1, 1, 3, 2]);
    expect(run.output).toContain("7 files in 4 primary Bun processes (scope all");
    expect(run.calls.some(call => call.includes(DEDICATED_FILE))).toBe(true);
  }, SPAWN_BUDGET_MS);

  test("unsharded single-worker control selects every file and dedicated family exactly once", () => {
    const storage = ["api-storage-policy-already-running", "api-storage-policy-mutation-busy",
      "api-storage-policy-put-race", "api-storage-policy-run", "api-storage-policy", "api-storage"]
      .map(name => `${name}.test.ts`);
    const run = runBatches("green", "all", {
      shard: "1/1", parallel: "1", batchSize: "12", isolated: ["bravo.test.ts"], additionalFiles: storage,
    });
    expect(run.status, run.output).toBe(0);
    const paths = (call: string) => call.split("|")[2]!.split(" ").filter(arg => arg.endsWith(".test.ts"));
    const files = run.calls.flatMap(paths);
    expect(files).toEqual([...FIXTURE_FILES, DEDICATED_FILE, ...storage].map(file => `tests/${file}`).sort());
    for (const call of run.calls) {
      expect(call).toContain("--parallel=1");
      expect(call).toContain("--isolate");
      expect(call).toContain("--timeout 60000");
      expect(paths(call).length).toBeLessThanOrEqual(12);
    }
    for (const file of [DEDICATED_FILE, ...storage, "bravo.test.ts"]) {
      const calls = run.calls.filter(call => paths(call).includes(`tests/${file}`));
      expect(calls).toHaveLength(1);
      expect(paths(calls[0]!)).toEqual([`tests/${file}`]);
    }
  }, SPAWN_BUDGET_MS);

  test.each([["assert", 1], ["timeout", 124], ["crash", 139]] as const)("single-worker control keeps %s failures red", (mode, status) => {
    const run = runBatches(mode, "all", { shard: "1/1", parallel: "1" });
    expect(run.status, run.output).toBe(status);
    // Sorted singleton api-usage splits alpha from the failing bravo/charlie/delta batch.
    for (const file of ["echo.test.ts", "foxtrot.test.ts"]) expect(run.calls.some(call => call.includes(file))).toBe(false);
    if (mode === "assert") expect(run.output).not.toContain("Attribution:");
    else expect(run.output).toContain("every file passed alone");
  }, SPAWN_BUDGET_MS);

  test("invalid parallelism refuses before a primary process starts", () => {
    const run = runBatches("green", "all", { parallel: "0" });
    expect(run.status).toBe(64);
    expect(run.calls).toEqual([]);
  }, SPAWN_BUDGET_MS);

  test("isolated entries run once alone without changing shard membership or order", () => {
    const isolated = ["bravo.test.ts", "delta.test.ts"];
    const files = (run: RunnerResult) => run.calls.flatMap(call =>
      call.split("|")[2]!.split(" ").filter(arg => arg.endsWith(".test.ts")));
    const whole = runBatches("green", "general", { isolated });
    expect(whole.status, whole.output).toBe(0);
    expect(files(whole)).toEqual(FIXTURE_FILES.map(file => `tests/${file}`));
    for (const file of isolated) {
      const calls = whole.calls.filter(call => call.includes(`tests/${file}`));
      expect(calls).toHaveLength(1);
      expect(calls[0]).toStartWith("1|");
    }
    for (const index of [1, 2]) {
      const shard = runBatches("green", "general", { isolated, shard: `${index}/2` });
      expect(shard.status, shard.output).toBe(0);
      expect(files(shard)).toEqual(FIXTURE_FILES.filter((_, i) => i % 2 === index - 1).map(file => `tests/${file}`));
    }
  }, SPAWN_BUDGET_MS);

  test("a failing isolated primary process stays red and stops later files", () => {
    const run = runBatches("isolated-assert", "general", { isolated: ["bravo.test.ts"] });
    expect(run.status, run.output).toBe(23);
    expect(run.calls).toHaveLength(2);
    expect(run.calls[1]).toContain("tests/bravo.test.ts");
    expect(run.output).not.toContain("Attribution:");
  }, SPAWN_BUDGET_MS);

  test("failed or invalid manifests cannot silently drop isolation", () => {
    for (const options of [
      { manifestStatus: 23 }, { isolated: [] }, { isolated: ["../outside.test.ts"] },
      { isolated: ["missing.test.ts"] }, { isolated: ["bravo.test.ts", "bravo.test.ts"] },
    ]) {
      const run = runBatches("green", "general", options);
      expect(run.status, run.output).not.toBe(0);
      expect(run.calls).toEqual([]);
    }
  }, SPAWN_BUDGET_MS);

  test("a runtime crash fails the shard even though every file passes alone", () => {
    const run = runBatches("crash");
    // 139 is the crash's own status, propagated rather than laundered into 0.
    expect(`status:${run.status}`, run.output).toBe("status:139");
    // The sweep still happens, so a human still learns what was in the batch.
    expect(singletonCalls(run)).toHaveLength(FIRST_BATCH.length);
    expect(run.output).toContain("every file passed alone");
    // And it is reported as attribution, not as a recovery that continued the shard.
    expect(run.output).not.toContain("continuing");
    // The shard stopped: batch 2 never ran under a disposition it could no longer change.
    for (const file of SECOND_BATCH) {
      expect(`${file}:${run.calls.some(call => call.includes(file))}`).toBe(`${file}:false`);
    }
  }, SPAWN_BUDGET_MS);

  test("a batch timeout fails the shard even though every file passes alone", () => {
    const run = runBatches("timeout");
    // This is the exact case the deleted "a timeout may still recover" contract pinned green.
    expect(`status:${run.status}`, run.output).toBe("status:124");
    expect(singletonCalls(run)).toHaveLength(FIRST_BATCH.length);
    // The bypass reaches both the primary process and every attribution process;
    // otherwise a survivor from the failed process can queue the diagnostic sweep too.
    expect(new Set(noQueueFlags(run))).toEqual(new Set(["1"]));
    expect(run.output).toContain("every file passed alone");
    expect(run.output).not.toContain("continuing");
  }, SPAWN_BUDGET_MS);

  test("an assertion failure fails immediately and is never swept", () => {
    const run = runBatches("assert");
    expect(`status:${run.status}`, run.output).toBe("status:1");
    expect(batchCalls(run)).toHaveLength(1);
    // Bun already named the failing test; re-running the batch file by file would only add
    // minutes to a shard that has already failed.
    expect(singletonCalls(run)).toEqual([]);
    expect(run.output).toContain("not retrying assertion/test failures");
  }, SPAWN_BUDGET_MS);

  // macOS ships no GNU timeout. The fallback must keep the same per-batch ceiling and the same
  // statuses GNU reports, or a wedged batch there runs until the job's wall clock.
  test("without GNU timeout a clean run is green under the portable deadline", () => {
    const run = runBatches("green", "general", { timeoutTool: "non-gnu" });
    expect(`status:${run.status}`, run.output).toBe("status:0");
    expect(batchCalls(run)).toHaveLength(2);
    expect(singletonCalls(run)).toEqual([]);
    expect(run.output).toContain("GNU timeout is unavailable");
  }, SPAWN_BUDGET_MS);

  test("without GNU timeout a hung batch stops at its deadline with 124 and its children are killed", () => {
    const run = runBatches("hang", "general", { timeoutTool: "non-gnu", batchTimeoutSeconds: "1", killGraceSeconds: "1" });
    // The batch process died on TERM, which GNU timeout reports as 124.
    expect(`status:${run.status}`, run.output).toBe("status:124");
    expect(run.output).toContain("timed out after 1s");
    expect(singletonCalls(run)).toHaveLength(FIRST_BATCH.length);
    // Its child ignored TERM; the group KILL after the grace period removed it anyway, which is
    // also why this run returned at all: the child held the output pipe open.
    expect(run.childPid).toBeGreaterThan(0);
    expect(processGone(run.childPid!)).toBe(true);
  }, SPAWN_BUDGET_MS);

  test("without GNU timeout a batch that ignores TERM is killed and reports 137, as GNU does", () => {
    const run = runBatches("hang-ignore-term", "general", { timeoutTool: "non-gnu", batchTimeoutSeconds: "1", killGraceSeconds: "1" });
    // GNU timeout signals its own process group, so a KILL after the grace period ends it with
    // 137; the disposition reads that as a runtime crash and still sweeps the batch.
    expect(`status:${run.status}`, run.output).toBe("status:137");
    expect(run.output).toContain("Bun runtime crash");
    expect(singletonCalls(run)).toHaveLength(FIRST_BATCH.length);
  }, SPAWN_BUDGET_MS);
});
