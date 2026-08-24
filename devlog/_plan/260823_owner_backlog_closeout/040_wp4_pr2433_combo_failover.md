# 040 — wp4: PR #2433, combo zero-output failover

## Item

`Ingwannu` PR #2433 `ingw/fix-combo-zero-output-failover-2431` -> `dev`, head
`3ec2b1a6`. Addresses issue #2431, "failover combos stop on zero-output SSE
terminal failures and model-EOL HTTP 410 responses".

Adds a bounded SSE preflight so failover combos can retry terminal failures
before any output is committed, plus model-lifecycle HTTP 410 classification and
synchronized documentation. 12 files.

## Reviewer verdict: FAIL

`gpt-5.6-sol` high, read-only, exact head `3ec2b1a6`:

- VERDICT FAIL, disposition NEEDS_CHANGES, risk medium.
- `bun test tests/combos.test.ts tests/combo-stream-preflight.test.ts tests/server-combo-failover-e2e.test.ts tests/core-lab-boundary.test.ts` -> 126 passed, 0 failed, 694 assertions.
- `gh pr checks 2433` -> 23 passed, 1 skipped, 0 failed.

Green tests and green CI, and still not landable. That gap is the point of the
finding: the defect is in accounting the existing tests do not assert.

## The blocker

`src/server/responses/core.ts:1974` — the new preflight manually records a failed
terminal. Native forward and pool passthrough streams already record that same
physical terminal through their eager and tee inspectors at `:3785` and `:3868`.
The once-guard added at `:1930` wraps only the exported callback, so it never
observes the inspector's direct invocation.

One physical 502 therefore increments native account health twice. A production
recorder diagnostic confirmed `consecutiveFailures: 2` for a single terminal.
The practical effect is that soft-avoid and credential rotation fire at half the
configured threshold, on an account that is healthy.

Everything else checked clean: stream commit boundary, attempt receipts, usage
handling, marker preservation, export surface, ESM/Bun constraints, no core-to-Lab
edge, no import cycle, no sensitive logging, translated docs aligned, template
complete.

## Disposition

Hold. Not closed, not merged. The required change is a single shared
once-guarded recorder owning both the preflight path and the inspector path, with
a regression asserting exactly one health transition per streamed attempt.

That fix is being built on `codex/fix-2433-exactly-once-terminal` rather than
asked of the contributor, because the PR is otherwise complete and the defect is
in a seam the original author had no reason to suspect. wp4 closes on the review
being posted; the landing of the corrected work is its own later work-phase.


## Execution record

Review posted on #2433 on 2026-08-23 naming the blocker, the reproduction, and the
required shape of the fix. PR left open, not closed. Fix in flight on
`codex/fix-2433-exactly-once-terminal`.
