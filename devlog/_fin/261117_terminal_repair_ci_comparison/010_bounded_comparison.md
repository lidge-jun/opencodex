# Terminal-repair PR: bounded credential-masking comparison

This is the initial record at `dad1813b3`. The subsequent production fix and
new base/head measurements are in [the profiled follow-up](020_profiled_redaction_fix.md).

## Question and result

PR #8774 reuses the incremental SSE buffer in Responses terminal repair. Its
`test changed` job failed the existing large-terminal credential-excerpt test.
This record answers the maintainer's request to compare the original PR head
with its base without skipping assertions, increasing deadlines, or retrying CI
until it passes.

The focused comparison reproduces the same 1,500 ms failure on **both** commits.
It does not establish a regression caused by terminal-repair buffering, and it
does not establish the exact scheduling cause of the Linux CI failure. All
observed target-test failures were at the elapsed-time assertion, after the
credential-content assertion. The failing CI remains a hold.

No production code, test assertions, test deadlines, test selection rules, or
workflow configuration were changed for this follow-up.

## Revisions and original CI evidence

- Base: `1d10758fa6ced80cdd780cb000bc5c4b83f84703`.
- Original PR head: `ada6a63b052da9b95f71f23e738ddaee08c78303`.
- CI: run `43721018165`, job `133247879390` (`test changed`), Ubuntu hosted
  runner, Bun `1.4.4` (`38afee6c8`), four test workers.
- CI result: 23,214 passed, 75 skipped, one failed. The existing
  `tests/responses/sse-untyped-credential-mask.test.ts:552` assertion observed
  `1555.7457600000198 ms`, requiring `<1500 ms`. Its content assertion passed.
- This follow-up did not dispatch or rerun hosted CI.

## Comparison protocol

The comparison ran on one native Windows machine with eight logical processors,
using Bun `1.4.4` and the same installed dependencies. The base used a detached
worktree with junctions to the head checkout's dependency directories; nothing
was installed or upgraded for the comparison. Each invocation used a fresh
process and the repository's ordinary test wrapper and home isolation. No other
agent test or build was run concurrently with these measurements.

The sample count and order were fixed before measurement: three pairs per
scenario, in the order **base, head, head, base, base, head**. No sample was
discarded and no failed invocation was retried to obtain green output.

Two focused scenarios used the same command on both revisions:

1. The complete, unchanged credential-masking test file, with four workers
   configured; one selected file means there is no other test-file worker load.
2. The same file plus three fixed companion files, with four workers:
   `responses-terminal-repair.test.ts`, `sse-payload-rewrite.test.ts`, and
   `sse-failed-tail.test.ts`, all under `tests/responses/`. The head includes its
   four new terminal-repair cases; this intentionally compares the actual PR
   workload, rather than removing its new tests.

An identical diagnostic preload on both revisions captured the two real
`performance.now()` values used by the target assertion. It returned the
original clock values and restored its spy after each case. Stack attribution
was checked before the first timestamp, using the unchanged line 548 call site;
only that case emitted a measurement, so parallel companion output could not
be mistaken for its timer. No fake clock or altered expectation was used.

The preload was:

```ts
import { beforeEach, afterEach, spyOn } from "bun:test";
let reads: number[] = [];
let target = false;
let clock: ReturnType<typeof spyOn> | undefined;
beforeEach(() => {
  reads = [];
  target = false;
  const now = performance.now.bind(performance);
  clock = spyOn(performance, "now").mockImplementation(() => {
    if (reads.length === 0) target = new Error().stack?.includes("sse-untyped-credential-mask.test.ts:548:") ?? false;
    const value = now();
    reads.push(value);
    return value;
  });
});
afterEach(() => {
  clock?.mockRestore();
  if (target && reads.length === 2) console.error(`PR8774_ELAPSED_MS=${reads[1]! - reads[0]!}`);
});
```

Save it outside test discovery and pass its absolute path as `PROBE` in each
checkout. The commands were equivalent to:

```sh
bun run test -- --parallel=4 --preload "$PROBE" \
  tests/responses/sse-untyped-credential-mask.test.ts
bun run test -- --parallel=4 --preload "$PROBE" \
  tests/responses/sse-untyped-credential-mask.test.ts \
  tests/responses/responses-terminal-repair.test.ts \
  tests/responses/sse-payload-rewrite.test.ts \
  tests/responses/sse-failed-tail.test.ts
```

## Every measured sample

Values below are the target assertion's elapsed milliseconds, in per-revision
execution order, rounded only for display. Every invocation exited 1; every
target sample exceeded the unchanged 1,500 ms deadline.

| Scenario | Base samples (ms) | PR samples (ms) | Base median | PR median |
| --- | --- | --- | ---: | ---: |
| Single file | 3851.76, 2714.90, 2859.51 | 3173.92, 2656.73, 2833.17 | 2859.51 | 2833.17 |
| Four files | 3052.95, 3447.86, 2847.55 | 3417.38, 3320.02, 2955.70 | 3052.95 | 3320.02 |

The single-file PR median is 0.9% lower; the four-file PR median is 8.7% higher.
The sample ranges overlap in each scenario. Three samples per revision on
Windows are not enough to declare statistical equivalence, diagnose Linux
runner contention, or dismiss the original failure as a flake.

The single-file runs all reported 95 passed / 3 failed. Four-file base runs
reported 405/3, 405/3, and 406/2; head runs reported 410/2, 409/3, and 409/3.
Other observed failures were the existing elapsed-time assertions for repeated
or self-overlapping credentials and for registry lookup. No content assertion
failed. The four new terminal-repair regression cases passed in every head
bundle.

## Control without measurement instrumentation

After the fixed comparison, one original single-file invocation per revision
omitted the diagnostic preload, with all other command arguments unchanged.
This was an instrumentation control, not a retry policy.

| Revision | Original assertion elapsed | Bun case duration | Full-file result |
| --- | ---: | ---: | --- |
| Base | 2875.48 ms | 2968.08 ms | 95 passed / 3 failed, exit 1 |
| PR | 2621.31 ms | 2710.52 ms | 96 passed / 2 failed, exit 1 |

Both controls failed the original target's elapsed-time assertion; its failure
output supplied the original clock measurement directly. Bun case durations
also include fixture/assertion overhead. The baseline failure persists without
the diagnostic spy.

## Scope and disposition

Between these commits the failing test and its synchronous masking path are
unchanged: `src/server/responses/terminal-error-redaction.ts`,
`src/lib/outbound-credential-registry.ts`, `src/lib/redact.ts`,
`src/server/sse-payload-rewrite.ts`, `src/server/bare-upstream-error.ts`, and
`src/lib/errors.ts` have no diff. The timed callback calls the terminal-error
rewrite; it does not call `relayResponsesSseWithTerminalRepair`. The original PR
changes that relay, its tests, and the byte-accounting documentation.

This supports reporting baseline timing sensitivity rather than claiming a
confirmed terminal-repair regression. It does not justify changing credential
handling or weakening its content or bounded-work contracts. This follow-up
therefore adds the comparison record only. The existing required CI failure
and maintainer hold are retained; passing local runtime/structure checks from
the original PR are not presented as a replacement for that failed CI.

Raw logs, the detached worktree, and machine-specific results remain in ignored
scratch space; no credentials, user paths, profiler data, or CI log dumps are
committed.
