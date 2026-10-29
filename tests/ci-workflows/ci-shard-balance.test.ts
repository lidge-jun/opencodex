/**
 * Shard assignment by recorded duration, asserted by execution.
 *
 * Sorted round-robin split the suite evenly by count while file durations differ by three orders of
 * magnitude, so the slowest Linux shard carried 394 s of tests against 248 s on another (run
 * 35816902207). The batch runner now weighs each file by `scripts/ci/test-durations.tsv` and puts
 * the heaviest file on the least-loaded shard. These cases run the real runner with a fake `bun`
 * and `timeout`, the same way ci-crash-disposition.test.ts does, and exercise the refresh tool that
 * keeps the table current.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { DURATIONS_TABLE, mergeDurations, parseJobLog, parseTable, renderTable, WINDOWS_DURATIONS_TABLE } from "../../scripts/ci/test-durations";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

const RUNNER = repoPath("scripts", "ci", "run-bun-test-batches.sh");
const FILES = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"].map(name => `${name}.test.ts`);
const ISOLATED = "api-usage.test.ts";

// Answers the isolated-manifest query and records every other call's test files.
const FAKE_BUN = [
  "#!/bin/sh",
  'if [ "$1" = "-e" ]; then printf "%s\\n" "$FIXTURE_ISOLATED"; exit 0; fi',
  "files=''",
  'for arg in "$@"; do case "$arg" in *.test.ts) files="$files $arg" ;; esac; done',
  'echo "${files# }" >> "$FIXTURE_CALLS"',
  "exit 0",
  "",
].join("\n");
const FAKE_TIMEOUT = [
  "#!/bin/sh",
  "while [ $# -gt 0 ]; do",
  '  case "$1" in --*) shift ;; *) shift; break ;; esac',
  "done",
  'exec "$@"',
  "",
].join("\n");

type ShardOptions = {
  durations?: Record<string, number> | null;
  batchSize?: string;
  timeoutSeconds?: string;
  /** Leave BUN_TEST_DURATIONS_FILE unset so the runner picks its own committed table. */
  defaultTable?: boolean;
  env?: Record<string, string>;
};

function runShard(shard: string, options: ShardOptions = {}): string[][] {
  return runShardWithOutput(shard, options).batches;
}

function runShardWithOutput(shard: string, options: ShardOptions = {}): { batches: string[][]; output: string } {
  const directory = mkdtempSync(join(tmpdir(), "ocx-shard-balance-"));
  try {
    const bin = join(directory, "bin");
    mkdirSync(bin);
    mkdirSync(join(directory, "tmp"));
    mkdirSync(join(directory, "tests"));
    for (const file of [...FILES, ISOLATED]) writeFileSync(join(directory, "tests", file), "");
    writeFileSync(join(bin, "bun"), FAKE_BUN, { mode: 0o755 });
    writeFileSync(join(bin, "timeout"), FAKE_TIMEOUT, { mode: 0o755 });
    const durations = join(directory, "durations.tsv");
    if (options.durations) {
      writeFileSync(durations, [
        "# fixture",
        ...Object.entries(options.durations).map(([file, ms]) => `${ms}\ttests/${file}`),
        "",
      ].join("\n"));
    }
    const calls = join(directory, "calls.log");
    writeFileSync(calls, "");
    const result = Bun.spawnSync(["bash", RUNNER, shard], {
      cwd: directory,
      env: {
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        HOME: directory,
        TMPDIR: join(directory, "tmp"),
        BUN_TEST_BATCH_SIZE: options.batchSize ?? "12",
        ...(options.timeoutSeconds ? { BUN_TEST_BATCH_TIMEOUT_SECONDS: options.timeoutSeconds } : {}),
        ...(options.defaultTable ? {} : { BUN_TEST_DURATIONS_FILE: durations }),
        OPENCODEX_BUN_PATH: join(bin, "bun"),
        FIXTURE_ISOLATED: ISOLATED,
        FIXTURE_CALLS: calls,
        ...options.env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;
    expect(`status:${result.exitCode}`, output).toBe("status:0");
    const batches = readFileSync(calls, "utf8").split("\n").filter(Boolean).map(line => line.split(" "));
    return { batches, output };
  } finally {
    removeTreeWithRetry(directory);
  }
}

const filesOf = (batches: string[][]): string[] => batches.flat();
const tests = (names: string[]): string[] => names.map(name => `tests/${name}`);

describe.skipIf(process.platform === "win32")("duration-weighted shards, executed", () => {
  test("the heaviest file gets a shard to itself when it outweighs the rest", () => {
    const durations = Object.fromEntries(FILES.map(file => [file, file === "alpha.test.ts" ? 10_000 : 1_000]));
    expect(filesOf(runShard("1/2", { durations }))).toEqual(tests(["alpha.test.ts"]));
    expect(filesOf(runShard("2/2", { durations }))).toEqual(tests(FILES.filter(file => file !== "alpha.test.ts")));
  }, SPAWN_BUDGET_MS);

  test("without a table every file weighs the same and membership is the old sorted round-robin", () => {
    for (const index of [1, 2]) {
      expect(filesOf(runShard(`${index}/2`, { durations: null })))
        .toEqual(tests(FILES.filter((_, position) => position % 2 === index - 1)));
    }
  }, SPAWN_BUDGET_MS);

  test("the shards still tile the suite exactly under a skewed table", () => {
    const durations = { "alpha.test.ts": 9_000, "delta.test.ts": 4_000, "foxtrot.test.ts": 3_500 };
    const seen = [1, 2, 3, 4].flatMap(index => filesOf(runShard(`${index}/4`, { durations })));
    expect([...seen].sort()).toEqual(tests(FILES));
  }, SPAWN_BUDGET_MS);

  test("each shard runs its files in sorted order", () => {
    const durations = { "foxtrot.test.ts": 9_000, "alpha.test.ts": 1 };
    const files = filesOf(runShard("2/2", { durations }));
    expect(files).toEqual([...files].sort());
  }, SPAWN_BUDGET_MS);

  test("a batch closes before its predicted time passes half the process timeout", () => {
    // Budget: 2 s timeout / 2 = 1,000 ms. Two 600 ms files would predict 1,200 ms, so every file
    // runs in its own process even though the size cap would allow three.
    const durations = Object.fromEntries(FILES.map(file => [file, 600]));
    const batches = runShard("1/1", { durations, batchSize: "3", timeoutSeconds: "2" });
    expect(batches.map(batch => batch.length)).toEqual([1, 1, 1, 1, 1, 1]);
  }, SPAWN_BUDGET_MS);

  test("light files still fill a batch up to the size cap", () => {
    const durations = Object.fromEntries(FILES.map(file => [file, 100]));
    const batches = runShard("1/1", { durations, batchSize: "3", timeoutSeconds: "2" });
    expect(batches.map(batch => batch.length)).toEqual([3, 3]);
  }, SPAWN_BUDGET_MS);

  test("Windows runners default to their own table, and an explicit table still wins", () => {
    const tableUsed = (env: Record<string, string>, defaultTable = true) =>
      /Predicted shard time from recorded durations \(([^)]+)\)/
        .exec(runShardWithOutput("1/1", { defaultTable, env, durations: { "alpha.test.ts": 1 } }).output)?.[1];
    expect(tableUsed({ RUNNER_OS: "Windows" })).toBe("test-durations.windows.tsv");
    expect(tableUsed({ RUNNER_OS: "Linux" })).toBe("test-durations.tsv");
    expect(tableUsed({ RUNNER_OS: "macOS" })).toBe("test-durations.tsv");
    expect(tableUsed({ RUNNER_OS: "Windows" }, false)).toBe("durations.tsv");
  }, SPAWN_BUDGET_MS);
});

describe("the duration table tool", () => {
  const apiLog = [
    "2026-09-23T04:06:19.0000000Z ##[group]shard 1/4 batch 1/2 (2 files)",
    "2026-09-23T04:06:19.1000000Z   tests/a/one.test.ts",
    "2026-09-23T04:06:19.2000000Z ##[group]tests/a/one.test.ts:",
    "2026-09-23T04:06:19.9000000Z (pass) one [1.00ms]",
    "2026-09-23T04:06:20.5000000Z ##[endgroup]",
    "2026-09-23T04:06:20.5100000Z ##[group]tests/a/two.test.ts:",
    "2026-09-23T04:06:21.0000000Z ##[endgroup]",
    "2026-09-23T04:06:21.1000000Z ##[endgroup]",
    "2026-09-23T04:06:22.0000000Z ##[group]shard 1/4 batch 1/2 attribution 1/2 (1 files)",
    "2026-09-23T04:06:22.1000000Z ##[group]tests/a/one.test.ts:",
    "2026-09-23T04:06:40.0000000Z ##[endgroup]",
  ].join("\n");

  test("charges process start to the first file and ignores attribution sweeps", () => {
    const samples = parseJobLog(apiLog);
    expect(samples.get("tests/a/one.test.ts")).toEqual([1_500]);
    expect(samples.get("tests/a/two.test.ts")).toEqual([500]);
  });

  test("reads gh run view --log output, keeping each job's timeline separate", () => {
    const prefixed = [
      "test 1/4\tTest in fresh-process batches\t2026-09-23T04:06:19.0000000Z ##[group]shard 1/4 batch 1/1 (1 files)",
      "test 2/4\tTest in fresh-process batches\t2026-09-23T04:06:30.0000000Z ##[group]shard 2/4 batch 1/1 (1 files)",
      "test 1/4\tTest in fresh-process batches\t2026-09-23T04:06:19.1000000Z ##[group]tests/b/one.test.ts:",
      "test 2/4\tTest in fresh-process batches\t2026-09-23T04:06:30.1000000Z ##[group]tests/b/two.test.ts:",
      "test 1/4\tTest in fresh-process batches\t2026-09-23T04:06:21.0000000Z ##[endgroup]",
      "test 2/4\tTest in fresh-process batches\t2026-09-23T04:06:30.4000000Z ##[endgroup]",
    ].join("\n");
    const samples = parseJobLog(prefixed);
    expect(samples.get("tests/b/one.test.ts")).toEqual([2_000]);
    expect(samples.get("tests/b/two.test.ts")).toEqual([400]);
  });

  test("reads Windows shard headers, which print backslash paths, under forward-slash keys", () => {
    const windows = [
      "windows 8/9\tUNKNOWN STEP\t2026-10-12T08:52:18.9199935Z ##[group]shard 8/9 batch 1/45 (6 files)",
      "windows 8/9\tUNKNOWN STEP\t2026-10-12T08:52:18.9851789Z ##[group]tests\\adapters\\anthropic\\one.test.ts:",
      "windows 8/9\tUNKNOWN STEP\t2026-10-12T08:52:19.5906751Z ##[endgroup]",
    ].join("\r\n");
    expect(Object.fromEntries(parseJobLog(windows))).toEqual({ "tests/adapters/anthropic/one.test.ts": [671] });
  });

  test("refresh --table writes the named table and leaves the shared one alone", () => {
    const directory = mkdtempSync(join(tmpdir(), "ocx-durations-table-"));
    try {
      const log = join(directory, "windows.log");
      const table = join(directory, "windows.tsv");
      writeFileSync(log, [
        "2026-10-12T08:52:18.9199935Z ##[group]shard 8/9 batch 1/45 (1 files)",
        "2026-10-12T08:52:18.9851789Z ##[group]tests\\ci-workflows\\ci-shard-balance.test.ts:",
        "2026-10-12T08:52:19.5906751Z ##[endgroup]",
      ].join("\r\n"));
      const shared = readFileSync(DURATIONS_TABLE, "utf8");
      const result = Bun.spawnSync(
        [process.execPath, repoPath("scripts", "ci", "test-durations.ts"), "refresh", "--table", table, "--source", "fixture", log],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(parseTable(readFileSync(table, "utf8"))).toEqual(new Map([["tests/ci-workflows/ci-shard-balance.test.ts", 671]]));
      expect(readFileSync(DURATIONS_TABLE, "utf8")).toBe(shared);
    } finally {
      removeTreeWithRetry(directory);
    }
  }, SPAWN_BUDGET_MS);

  test("merges new measurements over kept rows and drops files that no longer exist", () => {
    const previous = new Map([["tests/kept.test.ts", 70], ["tests/gone.test.ts", 90], ["tests/remeasured.test.ts", 5]]);
    const measured = new Map([["tests/remeasured.test.ts", [100, 300]], ["tests/zero.test.ts", [0]]]);
    const merged = mergeDurations(previous, measured, path => path !== "tests/gone.test.ts");
    expect(Object.fromEntries(merged)).toEqual({ "tests/kept.test.ts": 70, "tests/remeasured.test.ts": 200, "tests/zero.test.ts": 1 });
    expect(parseTable(renderTable(merged, "fixture"))).toEqual(merged);
  });

  for (const table of [DURATIONS_TABLE, WINDOWS_DURATIONS_TABLE]) {
    test(`the committed table ${table.split(/[\\/]/).pop()} is well formed`, () => {
      const text = readFileSync(table, "utf8");
      const rows = text.split("\n").filter(line => line !== "" && !line.startsWith("#"));
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row).toMatch(/^\d+\ttests\/\S+$/);
      const paths = rows.map(row => row.split("\t")[1]!);
      expect(paths).toEqual([...new Set(paths)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
      expect(parseTable(text).size).toBe(rows.length);
    });
  }
});
