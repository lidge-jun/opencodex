# Close-out — terminal completion contract shipped

Terminal outcome: **DONE**.

## What shipped

PR #3012, merged to `dev` at 2026-08-30T15:31:15Z as `f5a625cf3`. Two injected
surfaces now state that the private completion tool is terminal:

- `kiroCompletionTool()` schema description in `src/adapters/kiro.ts`, which
  travels with the tool object the model chooses between.
- `KIRO_COMPLETION_INSTRUCTIONS` in `src/adapters/kiro-constants.ts`, so the
  prose contract cannot contradict the schema.

The mid-task rules are untouched: commentary still does not end the turn, and
the model must still keep using tools before completing. Only what may follow
the completion call is constrained. `tests/kiro-adapter.test.ts` pins both
surfaces and asserts the two commentary sentences survive.

## Verification

`bun run typecheck` clean. 197 pass / 0 fail across `kiro-adapter`,
`kiro-stream`, and `tool-catalog-nudge`. `privacy:scan` passes. The regression
test was driven red against the old description first.

CI on the merged head: 20 checks green. The single failure, on both
`test 2/4` and `macos`, was `release version line > the in-tree version is
never behind a released one` — reproduced identically on a pristine
`origin/dev` worktree at `df8b3882f` with none of this unit's commits, and
owned by PR #3006. A release-version bump does not belong in an unrelated bug
fix.

## Review findings and what was done with them

Three findings, all answered on the PR.

A P1 privacy finding was correct: the measurement table carried a remote
absolute home path into a public devlog directory, which `privacy:scan` rejects.
Fixed in `da9b4989c`; the hostname, PID, and version carry the evidence without
an account identifier.

A truncation-ordering finding was plausible and turned out to be unreachable.
The completion contract is charged last against
`MAX_KIRO_INJECTED_INSTRUCTION_CHARS` (16384), so in principle a large enough
injected context could slice it mid-clause. Measured: the omission notice tops
out at 922 characters under a hostile 60-tool probe, the nudge ceiling is about
5540 under the 48-tool and 64-character caps, and the contract is 696 — roughly
9900 characters of headroom. The caller's system prompt is not charged to this
budget at all, so no caller input can crowd the contract out.

A reservation guard plus a budget-exhaustion test were implemented first, then
reverted: the test passed with the guard removed, because the only available
lever for inflating the budget was the uncharged system prompt. A guard for an
unreachable path whose test cannot detect its own removal is worse than the
documented measurement, so the measurement is what stayed. If a future addition
starts charging caller-sized text to this budget, the numbers above are the
starting point.

A duplicate-`.find` finding was a false positive: one call rendered across two
lines. Applying the proposed fix would have deleted the only lookup.

## Follow-up

Causality is not claimed as proven. The pre-change selection rate is recorded at
25 completion calls across 4069 required-mode attempts; the follow-up is the
same measurement on traffic served by a proxy running `f5a625cf3` or later.
Both hosts were on older builds at measurement time (local 2.36.0, `macmini-cf`
2.35.0), so a restart onto current `dev` is the precondition for that comparison.

## Landed-state verification

Checked against `origin/dev` after both merges (`6f75616f0`), reading the files
out of the remote ref rather than the working tree:

- `src/adapters/kiro.ts` contains the terminal schema description.
- `src/adapters/kiro-constants.ts` contains the appended terminal clause.
- `tests/kiro-adapter.test.ts` contains the both-surfaces regression test.
- This unit's close-out record is present.

Merge trail: `f5a625cf3` (#3012, the contract change) and `6f75616f0`
(#3014, this record).
