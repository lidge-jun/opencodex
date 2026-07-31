# 061 — PR #337 root-suite failure investigation

> Research-only companion to `060_pr337_takeover.md`. This artifact owns reproduction and
> classification of the four root-suite failures reported on PR #337. It does not pre-authorize a
> production/test fix or widen Cycle 6's file map.

## Question and evidence baseline

The PR report recorded `3780 passed, 4 skipped, 4 failed`, with all four failures in unchanged
`tests/release-helper.test.ts`; a standalone rerun reportedly passed 5/5. Determine whether each
failure is caused by the PR, deterministic on post-WP1 `dev`, order/concurrency-sensitive, or not
reproduced. Record evidence without inferring causality from unchanged-file status alone.

For every run retain: OS/architecture, `bun --version`, branch name, exact SHA, isolated HOME path,
command, start/end time, exit code, pass/skip/fail counts, all four test names, assertion text, stderr,
and neighboring test output. Sanitize local paths and never retain credentials/account identifiers.

## Reproduction commands

Run from a clean PR #337 worktree. Store logs under the parent cycle's approved evidence location;
this research file records only paths/counts/classification.

```bash
git status --short
git rev-parse HEAD
bun --version
uname -a

bun run test 2>&1 | tee <evidence>/pr337-root-initial.log

bun test --isolate tests/release-helper.test.ts 2>&1 | tee <evidence>/release-helper-1.log
bun test --isolate tests/release-helper.test.ts 2>&1 | tee <evidence>/release-helper-2.log
bun test --isolate tests/release-helper.test.ts 2>&1 | tee <evidence>/release-helper-3.log

bun run test 2>&1 | tee <evidence>/pr337-root-repeat-1.log
bun run test 2>&1 | tee <evidence>/pr337-root-repeat-2.log
```

Use `scripts/test.ts` via `bun run test` for the root repeats so its real HOME isolation and suite
ordering execute. If the failure appears order-sensitive, rerun the smallest preceding/failing test
sequence that reproduces it and record that exact command; do not substitute a new runner or add
test-only production branches.

Baseline definition (CYCLE6-BASE-01): the comparison base is NOT a fixed
"post-WP1 dev". Record `CYCLE6_BASE_SHA` = the exact `origin/dev` tip onto which
PR #337 is actually rebased at cycle-6 start (which may already include WP2-WP4
merges per the 000 phase map). Every baseline run below executes against that
recorded SHA in a separate clean worktree; a failure only counts as PR-caused if
it reproduces on the rebased PR branch and NOT on `CYCLE6_BASE_SHA`:

```bash
# in the clean baseline worktree, checked out at CYCLE6_BASE_SHA
git rev-parse HEAD
bun test --isolate tests/release-helper.test.ts
bun run test
bun run test
```

Inspect failed release-helper temporary shim directories, logs, child-process lifetime, port/path
reuse, environment restoration, and overlap with neighboring tests. Read-only inspection is allowed;
do not patch while classification is incomplete.

## Per-failure classification rubric

Classify each of the four named failures independently and cite its log/run evidence:

- **PR-caused** — reproduces on the PR head, does not reproduce on the exact post-WP1 `dev` base
  under the same environment/order, and a concrete causal path from an actual PR diff hunk to the
  assertion/resource exists.
- **Baseline deterministic** — reproduces on `CYCLE6_BASE_SHA` under the same environment/order with a
  stable assertion and repeatable owner.
- **Order/concurrency flake** — standalone remains green, but a repeatable suite order, shared path,
  process overlap, environment leak, or resource collision triggers the failure on PR and/or base.
- **Non-reproduced** — neither the required standalone repetitions nor two full-suite repetitions
  produce the failure and no causal path is evidenced. Label it an unconfirmed flake, never “fixed.”

For PR-caused or reproducible order/concurrency defects, identify the smallest owning test/helper and
the focused regression that would fail before/pass after. For baseline deterministic findings,
report the evidence and escalate rather than silently bundling unrelated repair. For non-reproduced
findings, retain the original failure log plus clean reruns and require final CI/root gates.

## Mandatory amendment rule before any fix

No file is writable merely because this investigation identifies it. If the required fix touches a
path not already present in `060_pr337_takeover.md`'s exact change map:

1. stop before Build/implementation;
2. enter P phase for Cycle 6 and amend `060_pr337_takeover.md`;
3. add the exact `MODIFY path/to/file` entry;
4. include the exact current **before** excerpt and proposed **after** diff, the classified failure it
   resolves, and its focused verifier;
5. obtain the parent/maintainer audit decision, then build only within that amended scope.

This rule applies even to `tests/release-helper.test.ts` or a seemingly test-only helper. Any fix in
`scripts/release.ts`, `.github/workflows/**`, dependencies, auth, credentials, release automation, or
another security boundary additionally requires explicit scope expansion/security review; the P
amendment alone does not waive that gate.

## Disposition and closure gate

Record a four-row table with: test name, first failing log/line, reproduction matrix, classification,
causal evidence, owner path, and disposition. If a fix is authorized and implemented, rerun its
focused regression, three standalone release-helper runs, and two full root suites after the last
code change.

Cycle 6 may update the contributor branch only when:

- every reported failure has an evidence-backed classification/disposition;
- any out-of-map fix has the exact P-phase amendment required above;
- two consecutive post-change `bun run test` executions pass;
- the focused release-helper run is supporting evidence, not sole closure; and
- required Cross-platform CI is green on the exact pushed head.
