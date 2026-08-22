# 008 — Audit round r5-20260818035046: FAIL, and the approach changes

Fifth reviewer, narrow scope: verify `r4`'s four closures and answer whether the
sequence is executable end to end.

Verdict **FAIL**. Two of four closures held; `r4`-F2's did not, and the reviewer was
right that the sequence could not be carried out as written.

## Closures that held

- **r4-F1 (evolving base pin).** `040:26` correctly evolves `EXPECTED_DEV` through
  PR1, PR2, and PR3, with a live read and a stop-and-rebase branch before every
  merge.
- **r4-F3 (second conflict at the import line).** `010:176`'s resolved import
  contains exactly the surviving symbols, and `f145fd513` has no other dependency on
  `CursorStreamTruncatedError` — verified by reading the commit's own diff.
- **r4-F4 (WP2b's contract test).** `020:105` has it in PR1, and every other test in
  the table imports code its layer owns.

## F1 (High) — the stack procedure was not executable

Four concrete defects in `030`'s five steps:

1. Steps 2-3 placed commits on `cursor-call-wire` **before step 4 created it**, and
   step 4 created it at the OLD `PR1_TIP`, which would have excluded exactly those
   commits.
2. No restack of PR2/PR3 after PR1 changed.
3. "Let the original commit become a no-op during the retarget" is not a thing a
   retarget can do — the commit still exists in the child's history.
4. No handling for two late DOC edits.

## F2 (High) — the partition still leaked

`6d9744283..cursor-call` also edits `devlog/_plan/260817_cursor_toolcall_decode/000_index.md`
and `020_phase2-toolresult-image-passthrough.md` (by `be1b881ec`, the F1 capability
correction). Those docs belong to PR1 by the Owns table, yet the procedure only moved
the three `2ea12062d` source/test paths.

Also: `cursor-interaction-query.test.ts` sat in PR1's Owns set while `015` explicitly
preserves that file unchanged — so an exact file-set match was impossible by
construction.

## F3 (Medium) — the first literal execution failure

`010:163` wrote `VERIFIED_BASE=\$(...)` and `git rebase \$VERIFIED_BASE`. Under zsh
the escaped form assigns the command TEXT and passes the literal variable name to
`git rebase`. Fixed to `$(...)` and `"$VERIFIED_BASE"`.

## The real lesson: stop re-slicing a finished history

Four rounds attacked the split and each produced a different broken procedure. The
common cause is that all four tried to **re-slice a completed linear history**, which
forces commits to move between layers, and every mechanism for moving them
(cherry-pick, `rebase -i`, retarget) broke a different invariant.

`030` is now rewritten to build the stack **forward**. Each layer branch is cut from
its base and its files are checked out from `FINAL` (the rebased `cursor-call` tip),
then committed as that layer's contribution. Two consequences:

- **PR1 ∪ PR2 ∪ PR3 is identical to `cursor-call` by construction**, because every
  layer's tree comes from `FINAL`. That is the property the previous procedures kept
  failing to guarantee, and `030` step 4 now checks it mechanically
  (`git diff EXPECTED_DEV cursor-call --stat` equals the union of the three layer
  diffs).
- **The late doc edits stop being a special case.** Step 1 takes the whole
  `260817_cursor_toolcall_decode/` directory from `FINAL`, so `be1b881ec`'s edits are
  included automatically. `r5` was right about the leak; taking final state rather
  than mid-history state is the fix.

One file needs care under forward construction: `live-transport.ts`. `FINAL`'s
version contains PR2's `classifyTurnFailure`, so PR1 takes that single file from the
rebased wire-work boundary commit instead (its subject is unique in the range —
`git log --format='%s' | sort | uniq -d` returns nothing, confirmed by `r5`), and PR2
takes it from `FINAL`. Documented in `030` step 1.

`030` also now states a fallback out loud: if the union check fails for a genuine
interleaving reason, open ONE PR and say why. Iterating on the split a fifth time is
not on the table.

## Note on the rebuilt layers

Forward construction creates new commit objects, so the campaign's original messages
are carried over deliberately — the devlog cites them. `cursor-call` remains the
canonical history and the PR bodies say so.

