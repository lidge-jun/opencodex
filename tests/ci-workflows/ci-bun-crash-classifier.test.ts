/**
 * The Bun crash classifier is one definition, every direct lane or shared runner uses it, and a
 * crash fails the shard.
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
 * 2026-09-08 while reporting green, and the then-unbatched Windows lane was the only place the
 * Bun 1.4.2 regression was visible at all. The sweep is kept for attribution; the shard now fails
 * regardless of its result.
 *
 * What this file may and may not assert. Reading shell SOURCE TEXT proves only that a string is
 * present, which is why the disposition contract does NOT live here any more: the old
 * "a timeout may still recover" case pinned the mask itself, and every other case in this
 * describe would have passed just as happily against a runner that retried everything into
 * green. Disposition is asserted by EXECUTING the runner in
 * tests/ci-workflows/ci-crash-disposition.test.ts. What is left here is the property that has
 * no executable form: that the signature list exists exactly once and that no lane carries a
 * private copy of it.
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

  test("every direct lane and the shared batch runner use the classifier", () => {
    for (const [name, text] of Object.entries(lanes)) {
      expect(`${name}:sources:${text.includes(SOURCE_LINE)}`).toBe(`${name}:sources:true`);
      expect(`${name}:calls:${text.includes("is_bun_runtime_crash \"$suite_status\" \"$suite_log\"")}`)
        .toBe(`${name}:calls:true`);
    }
    expect(batchScript).toContain("bun-crash-signatures.sh");
    expect(batchScript).toContain('is_bun_runtime_crash "$status" "$log_file"');
    expect(workflow.match(/run: bash scripts\/ci\/run-bun-test-batches\.sh/g)).toHaveLength(2);
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

describe("no lane can retry its way to green", () => {
  const batchScript = read("scripts", "ci", "run-bun-test-batches.sh");
  const workflow = read(".github", "workflows", "ci.yml");

  test("the sweep is named and documented as attribution, not recovery", () => {
    // A reader of this script has to be able to tell, from the name alone, that the
    // one-file-per-process pass cannot change the outcome. It was called
    // `recover_batch_file_by_file` while it did exactly that.
    expect(batchScript).toContain("attribute_batch_file_by_file");
    expect(batchScript).not.toContain("recover_batch_file_by_file");
    for (const promise of [
      "passed under singleton isolation",
      "passed on its single",
      "may recover",
      "failing after one retry",
    ]) {
      expect(`batch-script:${promise}:${batchScript.includes(promise)}`)
        .toBe(`batch-script:${promise}:false`);
    }
  });

  test("no platform lane loops over attempts", () => {
    // The macOS shard, the macOS control and the Windows shard each carried
    // `for attempt in 1 2`. A second execution that happens not to crash does not un-crash
    // the first, so every one of them is gone and none may come back in any form.
    expect(workflow).not.toContain("for attempt in");
    expect(workflow).not.toContain("attempt ${attempt}");
    expect(workflow).not.toContain("while true");
    for (const promise of [
      "assertion failures are not retried",
      "failing after one retry",
      "crash repeated",
    ]) {
      expect(`workflow:${promise}:${workflow.includes(promise)}`)
        .toBe(`workflow:${promise}:false`);
    }
  });
});
