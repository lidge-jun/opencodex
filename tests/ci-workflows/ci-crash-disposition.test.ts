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
 * this fake-toolchain harness stays Linux-only because it synthesizes GNU `timeout` and POSIX
 * process statuses. The manual Windows matrix exercises the real Git-for-Windows Bash/coreutils
 * path. That is platform evidence matched to the actual runner rather than a local emulation.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

// GNU timeout, reduced to what the runner uses: flags, a duration, then the command. In
// "timeout" mode it reports 124 for a multi-file batch without ever starting Bun, which is
// exactly what a wedged batch looks like to the runner.
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

// A single file always passes. That is the whole point: the defect being modelled is one only a
// multi-file process can have, so the attribution sweep is guaranteed to come back clean.
const FAKE_BUN = [
  "#!/bin/sh",
  "files=0",
  'for arg in "$@"; do',
  '  case "$arg" in *.test.ts) files=$((files + 1)) ;; esac',
  "done",
  "printf '%s|%s|%s\\n' \"$files\" \"${OCX_TEST_NO_QUEUE:-}\" \"$*\" >> \"$FIXTURE_CALLS\"",
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
  "esac",
  "exit 0",
  "",
].join("\n");

type RunnerResult = { status: number | null; output: string; calls: string[] };

function runBatches(
  mode: "green" | "crash" | "timeout" | "assert",
  fileScope: "general" | "all" = "general",
): RunnerResult {
  const directory = mkdtempSync(join(tmpdir(), "ocx-batch-disposition-"));
  try {
    const binDirectory = join(directory, "bin");
    mkdirSync(binDirectory);
    mkdirSync(join(directory, "tmp"));
    mkdirSync(join(directory, "tests"));
    for (const file of FIXTURE_FILES) writeFileSync(join(directory, "tests", file), "");
    writeFileSync(join(directory, "tests", DEDICATED_FILE), "");
    writeFileSync(join(binDirectory, "timeout"), FAKE_TIMEOUT, { mode: 0o755 });
    writeFileSync(join(binDirectory, "bun"), FAKE_BUN, { mode: 0o755 });
    const calls = join(directory, "calls.log");
    writeFileSync(calls, "");

    const result = Bun.spawnSync(["bash", RUNNER, "1/1"], {
      cwd: directory,
      env: {
        PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`,
        HOME: directory,
        TMPDIR: join(directory, "tmp"),
        CI: "true",
        BUN_TEST_BATCH_SIZE: "3",
        BUN_TEST_FILE_SCOPE: fileScope,
        OCX_TEST_NO_QUEUE: "1",
        OPENCODEX_BUN_PATH: join(binDirectory, "bun"),
        FIXTURE_MODE: mode,
        FIXTURE_CALLS: calls,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    return {
      status: result.exitCode,
      output: `${decode(result.stdout)}${decode(result.stderr)}`,
      calls: readFileSync(calls, "utf8").split("\n").filter(Boolean),
    };
  } finally {
    removeTreeWithRetry(directory);
  }
}

const batchCalls = (result: RunnerResult): string[] =>
  result.calls.filter(call => !call.startsWith("1|"));
const singletonCalls = (result: RunnerResult): string[] =>
  result.calls.filter(call => call.startsWith("1|"));
const noQueueFlags = (result: RunnerResult): string[] =>
  result.calls.map(call => call.split("|")[1] ?? "");

describe.skipIf(process.platform !== "linux")("the Linux batch runner, executed", () => {
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
    // Seven files at batch size three produce two full primary batches and one
    // one-file primary batch. `singletonCalls` deliberately classifies by file
    // count for the failure fixtures below, so it cannot distinguish that final
    // primary batch from attribution. Assert the complete green call sequence.
    expect(run.calls.map(call => Number(call.split("|", 1)[0]))).toEqual([3, 3, 1]);
    expect(run.output).toContain("7 files in 3 primary Bun processes (scope all");
    expect(run.calls.some(call => call.includes(DEDICATED_FILE))).toBe(true);
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
});
