import { describe, expect, test } from "bun:test";
import { fixturePath } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

/**
 * The test runner's Bun must deliver a spawnSync child's exit after finalizers ran inside an
 * earlier spawnSync (#4956).
 *
 * Bun 1.4.0 loses it: the call spins at full CPU past its own `timeout`, so a bounded
 * `Bun.spawnSync` in one file can hold a whole multi-file `--isolate` batch until the batch
 * deadline kills it, after every earlier file passed and with nothing to attribute. That is
 * how Linux shard 1/4 batch 5 timed out in runs 38146205183 and 38162375606 inside
 * release-version-sources.test.ts. Bun 1.4.3 carries the upstream fix (oven-sh/bun#44581);
 * `package.json` `testRunnerBun` must stay at or above it.
 *
 * The child runs the mechanism directly rather than hoping a batch composition triggers it.
 * One finalized poll can make the second call spin forever on 1.4.0; three make it return only at
 * its timeout with no output, every time. `collectedDuringCall` keeps the case honest: if the collection
 * ever stops landing inside the first call, the assertion names that instead of passing.
 *
 * The parent waits asynchronously under its own deadline, so a regressed runtime fails this
 * test instead of wedging the batch it runs in. The child shells out to `sh` and `true`;
 * upstream skips its case on Windows for the same reason.
 */

const CHILD = fixturePath("spawnsync-finalizer-drift-child.ts");
/** Far above the ~0.1 s the fixed runtime needs and the 2 s inner timeout a regressed one hits. */
const OUTER_DEADLINE_MS = 10_000;
/** After the deadline's SIGKILL, how long the exit and both pipe EOFs get before the case gives up on them. */
const REAP_GRACE_MS = 3_000;

type DriftOutcome =
  | { kind: "settled"; exitCode: number; stdout: string; stderr: string }
  | { kind: "deadline"; reaped: boolean }
  | { kind: "read-error"; error: string; reaped: boolean };

/**
 * Bounded on every path: the deadline kills the child and the case settles after a short reap
 * grace whether or not the kill is delivered, the exit is observed, or a pipe reaches EOF. A
 * regressed runtime therefore fails this case instead of holding its batch, which is the very
 * failure the case exists to catch.
 */
async function runDriftChild(writers: number): Promise<DriftOutcome> {
  const child = Bun.spawn([process.execPath, CHILD], {
    env: { ...process.env, OCX_DRIFT_WRITERS: String(writers), BUN_JSC_slowPathAllocsBetweenGCs: "3" },
    stdin: "ignore",
    stdout: "pipe",
    // Must be a pipe: a Bun.stderr writer registers a poll only when stderr is pollable.
    stderr: "pipe",
  });
  const work = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    .then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error: String(error) }));
  const settledWork = work.then(() => true);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"deadline">(resolve => { deadline = setTimeout(() => resolve("deadline"), OUTER_DEADLINE_MS); });
  let readError: string | undefined;
  try {
    const first = await Promise.race([work, expired]);
    if (first !== "deadline" && first.ok) {
      const [stdout, stderr, exitCode] = first.value;
      return { kind: "settled", exitCode, stdout: stdout.trim(), stderr: stderr.trim().slice(-2_000) };
    }
    // A pipe read that failed leaves the child unobserved; it gets the same bounded cleanup.
    if (first !== "deadline") readError = first.error;
  } finally {
    clearTimeout(deadline);
  }
  try { child.kill("SIGKILL"); } catch { /* A failed kill must not extend the wait. */ }
  let grace: ReturnType<typeof setTimeout> | undefined;
  const reaped = await Promise.race([
    settledWork,
    new Promise<false>(resolve => { grace = setTimeout(() => resolve(false), REAP_GRACE_MS); }),
  ]);
  clearTimeout(grace);
  // A child or pipe that outlived its kill must not keep this test process alive either.
  if (!reaped) child.unref();
  return readError === undefined ? { kind: "deadline", reaped } : { kind: "read-error", error: readError, reaped };
}

describe.skipIf(process.platform === "win32")("test-runner Bun spawnSync after finalizers inside spawnSync", () => {
  for (const writers of [1, 3]) {
    test(`a child exit is still polled after ${writers} finalized poll(s)`, async () => {
      const result = await runDriftChild(writers);
      const report = JSON.stringify(result);
      if (result.kind === "deadline") {
        throw new Error(`spawnSync never returned within ${OUTER_DEADLINE_MS} ms (Bun ${Bun.version}): ${report}`);
      }
      if (result.kind === "read-error") throw new Error(`reading the drift child's output failed: ${report}`);
      expect(result.exitCode, report).toBe(0);
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      expect({
        collectedDuringCall: parsed.collectedDuringCall,
        stdout: parsed.stdout,
        exitedDueToTimeout: parsed.exitedDueToTimeout,
      }, report).toEqual({ collectedDuringCall: writers, stdout: "polled\n", exitedDueToTimeout: false });
    }, SPAWN_BUDGET_MS);
  }
});
