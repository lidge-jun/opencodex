/**
 * The Bun crash classifier is one definition, every lane sources it, and a crash fails the shard.
 *
 * Two separate defects are pinned here.
 *
 * The first is duplication. The signature list used to exist four times: in the Linux batch
 * runner and inline in three ci.yml legs. #2152 broke one copy by anchoring on
 * `panic(thread 2852)` when Bun also emits `panic(main thread)` for the same class, so half the
 * crashes stopped matching in that lane alone. ci-workflows.test.ts responded by pinning the four
 * copies in sync, which only ever detects the drift it was written to expect. One definition
 * cannot drift, so the contract is now that the copies do not exist.
 *
 * The second is masking, and it is the one that cost a release. `run-bun-test-batches.sh`
 * classified exit 139 as a runtime crash, re-ran the batch one file per process, and reported
 * success when that sweep passed. The sweep is not a retry of a flaky test: one file per process
 * is a configuration in which this class of defect cannot occur, so it was guaranteed to pass and
 * guaranteed to report nothing. Linux CI segfaulted twelve to fourteen times per run from
 * 2026-09-08 while reporting green, and the Windows lane -- which has no sweep -- was the only
 * place the Bun 1.4.2 regression was visible at all. The sweep is kept for attribution; the shard
 * now fails regardless of its result.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";

const CLASSIFIER_REL = "scripts/ci/bun-crash-signatures.sh";
const SOURCE_LINE = `source ${CLASSIFIER_REL}`;

/** Every signature that means "the interpreter died", not "a test failed". */
const CRASH_SIGNATURES = [
  "oh no: Bun has crashed",
  "Internal assertion failure",
  "Segmentation fault at address",
  "Illegal instruction",
  "Bus error",
] as const;

function read(...segments: string[]): string {
  return readFileSync(repoPath(...segments), "utf8");
}

/** The literal text of one `run:` block, located by a line only that block contains. */
function runBlockContaining(workflow: string, anchor: string): string {
  const index = workflow.indexOf(anchor);
  expect(`anchor present: ${anchor}`).toBe(`anchor present: ${anchor}`);
  expect(index).toBeGreaterThan(-1);
  const start = workflow.lastIndexOf("run: |", index);
  expect(start).toBeGreaterThan(-1);
  const end = workflow.indexOf("\n      - name:", index);
  return workflow.slice(start, end === -1 ? undefined : end);
}

describe("the Bun crash classifier is shared", () => {
  const classifier = read("scripts", "ci", "bun-crash-signatures.sh");
  const batchScript = read("scripts", "ci", "run-bun-test-batches.sh");
  const workflow = read(".github", "workflows", "ci.yml");

  const lanes = {
    windows: runBlockContaining(workflow, "bun test --isolate --timeout 60000 tests --shard=${{ matrix.shard }}/6"),
    "macos-shard": runBlockContaining(workflow, "run_macos_suite tests"),
    "macos-control": runBlockContaining(workflow, "bun test --isolate --timeout 60000 tests 2>&1"),
  };

  test("the signatures exist in the classifier", () => {
    for (const signature of CRASH_SIGNATURES) {
      expect(`classifier:${signature}:${classifier.includes(signature)}`).toBe(`classifier:${signature}:true`);
    }
  });

  test("no lane and no script carries an inline copy of them", () => {
    const others: Array<readonly [string, string]> = [
      ["batch-script", batchScript],
      ...Object.entries(lanes),
    ];
    for (const [name, text] of others) {
      for (const signature of CRASH_SIGNATURES) {
        expect(`${name}:inline:${signature}:${text.includes(signature)}`)
          .toBe(`${name}:inline:${signature}:false`);
      }
    }
  });

  test("every lane sources the classifier and calls the shared predicate", () => {
    for (const [name, text] of Object.entries(lanes)) {
      expect(`${name}:sources:${text.includes(SOURCE_LINE)}`).toBe(`${name}:sources:true`);
      expect(`${name}:calls:${text.includes("is_bun_runtime_crash \"$suite_status\" \"$suite_log\"")}`)
        .toBe(`${name}:calls:true`);
    }
    expect(batchScript).toContain("bun-crash-signatures.sh");
    expect(batchScript).toContain('is_bun_runtime_crash "$status" "$log_file"');
  });

  test("the thread-numbered panic form is the anchor nowhere", () => {
    // `panic(thread 2852)` and `panic(main thread)` are the same class (#2152).
    for (const [name, text] of [["classifier", classifier], ["batch-script", batchScript], ...Object.entries(lanes)] as Array<readonly [string, string]>) {
      expect(`${name}:${text.includes("panic\\(thread")}`).toBe(`${name}:false`);
    }
  });

  test("fatal signal codes classify on the status alone, and exit 3 never does", () => {
    // 128+N is unambiguous. 3 is an ordinary small exit code any process may return, so it is
    // recognised only when Bun also printed a panic banner -- which is how the Windows shard 5/6
    // crashes of runs 35087572377, 35093667426 and 35098735960 are caught. Trusting 3 bare would
    // reclassify a real failure as a crash and hide it, which is the mistake this file prevents.
    expect(classifier).toContain("132|133|134|135|136|137|139) return 0 ;;");
    expect(classifier).not.toMatch(/^\s*3\|/m);
    expect(classifier).not.toContain("|3)");
  });
});

describe("a Bun runtime crash fails the Linux shard", () => {
  const batchScript = read("scripts", "ci", "run-bun-test-batches.sh");

  test("crashed batches are collected and the shard exits non-zero", () => {
    expect(batchScript).toContain("CRASHED_BATCHES=()");
    expect(batchScript).toContain('CRASHED_BATCHES+=("$batch_number")');
    expect(batchScript).toContain("if (( ${#CRASHED_BATCHES[@]} > 0 )); then");
    // The failure is an error annotation and a non-zero exit, not a warning and a green shard.
    const tail = batchScript.slice(batchScript.indexOf("if (( ${#CRASHED_BATCHES[@]} > 0 )); then"));
    expect(tail).toContain("::error::");
    expect(tail).toContain("exit 1");
  });

  test("the singleton sweep reports a crash as an error rather than a recovery", () => {
    expect(batchScript).toContain('if [[ "$batch_failure_kind" == "runtime" ]]; then');
    // The old wording promised recovery. A crash may not be announced that way again.
    const sweepEnd = batchScript.slice(batchScript.indexOf("recover_batch_file_by_file"));
    expect(sweepEnd).not.toContain("passed under singleton isolation after the original runtime");
  });

  test("a real failing file found by the sweep still reports that file immediately", () => {
    // Failing on the crash must not swallow an assertion the sweep genuinely attributed.
    expect(batchScript).toContain("Singleton isolation identified ${file} as a failing test file.");
    expect(batchScript).toContain("if (( recovery_status != 0 )); then");
  });

  test("a timeout may still recover, because a timeout is a load condition", () => {
    expect(batchScript).toContain('if [[ "$LAST_FAILURE_KIND" != "runtime" && "$LAST_FAILURE_KIND" != "timeout" ]]; then');
    expect(batchScript).toContain("passed under singleton isolation after the original ${batch_failure_kind}; continuing.");
  });
});

