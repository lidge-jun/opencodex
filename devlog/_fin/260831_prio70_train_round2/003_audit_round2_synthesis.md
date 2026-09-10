# 003 — audit round 2: FAIL on a process error of mine, plus two real refinements

## What actually happened

Round 2 returned FAIL with "0/9 closed" — and it was right about the index it read. I
had staged the roadmap *before* writing the round-1 amendments and never re-staged, so
the auditor compared its brief against the pre-amendment blobs. Its blockers 2-10 are
restatements of round 1 against stale content.

Recording it rather than quietly re-running, because the failure mode is worth keeping:
**an audit reads the index, not the working tree.** A reviewer given a stale index
produces a confident, fully-cited, useless report, and the citations look exactly as
solid as real ones. The fix is mechanical — stage, then dispatch — and the cost of
forgetting is one full high-effort round.

It also cuts the other way: the auditor never claimed the working tree was wrong. It
said the *staged* diff was, and it was.

## Two findings that are not restatements

Round 2 read the source around the amendments and produced two things round 1 did not.

### The wp5 exit code is available, and the range is bounded

`handleStop()` sets `process.exitCode = 1` and nothing else
(`src/cli/index.ts:747`); `src/cli/index.ts` otherwise uses only `0`, `1` and `130`;
and `bin/ocx.mjs:659-663` mirrors the child's code verbatim. So a distinct
history-only code propagates through the npm launcher with no extra plumbing, and the
plan is not proposing a collision. `050` now names those constraints.

### The wp4 freshness gate is reachable — but the unit is ambiguous

The auditor confirmed `shortResetAt` is populated on the short-only path
(`src/codex/quota.ts:596-598`), so gating on it does not make the terminal branch
unreachable. It also flagged the unit, and following that up produced the sharper
finding: `normalizeResetAt` (`:192-200`) normalizes scale not at all, and the GUI
disambiguates by magnitude at read time —
`resetAt < 10_000_000_000 ? resetAt * 1000 : resetAt`
(`gui/src/components/QuotaBars.tsx:355`).

Both seconds and milliseconds therefore reach storage. A comparison written against one
assumption is off by 1000x against the other, and in the seconds-read-as-milliseconds
direction every terminal reading looks like it reset in 1970 and scores unknown. That
is a fix that passes its own test and does nothing — the exact vacuity class this gate
exists to catch, arriving one level below where round 1 was looking.

`040` now requires the same magnitude normalization the GUI uses, an injected `now`,
and a regression for each unit.

### One test-file name still to fix

`050` plans a new `tests/update-stop-classification.test.ts`, which round 2 listed as
nonexistent. It is new by design — the doc says so — but `tests/update-stop-first.test.ts`
already owns the stop-ordering surface, so the new cases belong there rather than in a
second file. Corrected in `050`.

## State

Round 1's nine blockers are amended in the working tree and now staged. Round 2's two
substantive findings are folded in. Round 3 audits the staged tree.
