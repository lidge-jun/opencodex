# 009 — Audit round r6-20260818035826: FAIL, and the category error was mine

Sixth reviewer, narrow scope: does the forward-construction stack procedure work
mechanically? Verdict **FAIL**, four blockers.

## What r6 found

1. **PR3 was not stacked on PR2 (High).** Steps 1-2 created NEW commits from
   `EXPECTED_DEV` while step 3 kept the original `cursor-call`. So
   `cursor-call-cancel` was not an ancestor of `cursor-call`, and a PR against it
   would compare from the merge base and show the entire original series. A retarget
   cannot repair ancestry.
2. **PR1 copied PR2/PR3 content (High).** Taking `cursor-errors.ts` from `FINAL`
   hands PR1 the `CursorUnexpectedCancelError` that is supposed to be PR2's, making
   PR2's own checkout a no-op. Taking the whole decode directory hands PR1 the
   `040` and `050` phase docs owned by PR2 and PR3.
3. **WP2b's `live-transport.ts` part landed in PR2 (High).** PR1 deliberately took
   that file from an earlier boundary, so WP2b's helper deletion + import + re-export
   was missing there and appeared in PR2's `FINAL` checkout instead. Executed
   literally, PR1 would carry two copies of the helper.
4. **The union check proved nothing (Medium).** A whole-range `--stat` is fixed by
   its endpoints; it stays identical no matter which layer content lands in. It would
   have caught neither `r5`'s doc leak nor `r4`'s source leak.

r6 also confirmed `git checkout <ref> -- <path>` behaves as assumed, and that the
`live-transport.ts` boundary exception was internally coherent
(`dfb6fb884`: 4 `emittedTerminal`, 0 `classifyTurnFailure`; `6d9744283`: 4 of each).

## The category error

Four consecutive failures on the same question, each on a different mechanism. Under
LOOP-REPAIR-01 that is the point to stop patching the answer and re-read the
question.

I had been requiring the layers to be **subsystem-pure** — each touching only its own
files. That came from `r4` F2 noting the top commit range also edits PR1-owned files,
which I treated as a defect in the split.

It was not a defect. **A stacked PR promises reviewable increments in dependency
order, not subsystem purity.** Purity requires moving content between commits, the
history is already final, and every mechanism for moving it — cherry-pick,
`rebase -i` split, forward tree copy — broke a different git invariant. `r3` F3 had
the right answer originally; I over-corrected it away.

## The fix

`030` now cuts the rebased history at two existing commits and creates branches
there. Every property the four broken versions fought for comes free:

- ancestry is automatic (one linear history) — closes r6-1;
- union equals the branch by construction (the ranges partition it) — closes r6-4;
- no commit moves, so nothing can be dropped, duplicated, or contaminated —
  closes r6-2 and r6-3.

Step 3 proves it with four commands: two `--is-ancestor` checks and three range
counts that must sum to the whole.

## What moved as a result

WP2b and `tests/cursor-interaction-query.test.ts` are now BOTH in PR3, where WP2b
lands chronologically. `r4` F4's principle stands — a change and its contract test
belong together — and this satisfies it in the other direction. PR1 remains correct
without WP2b: PR1 makes a truncated turn reportable, PR3 makes it report tokens.
That is what a stacked increment is.

PR3's body must name the two things a reviewer would otherwise find odd: it carries
WP2b, and it carries the late honesty corrections to PR1-owned files (`2ea12062d`'s
comments, `be1b881ec`'s two decode docs).

`030` keeps a fallback: if step 3 fails, open one PR and say why. There is no sixth
splitting scheme.

