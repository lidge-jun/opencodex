# 00A — Audit round r7-20260818040721: NEAR-PASS, gate closed

Seventh reviewer, scoped to the branch-pointer stack plus a whole-plan consistency
sweep. **NEAR-PASS**: the stack passed on every property, and one execution blocker
plus one naming inconsistency were found and fixed.

## The stack passed

Measured, not asserted:

- History is linear: 39 commits, zero merges.
- Boundary subjects unique and correctly ordered
  (`git log --format='%s' <base>..cursor-call | sort | uniq -d` returns nothing).
- Ranges partition exactly: 17 + 3 + 19 = 39, no commit in two ranges, none omitted.
- Creating branches at those commits adds pointers only — no commit moves.
- A rebase preserves relative order for a linear, non-interactive, non-autosquashed
  series, so the boundaries survive the rewrite.

That is all four properties the previous four schemes fought for, obtained by not
fighting for subsystem purity.

## Layering judged honest

- **PR1** is independently gateable: its EOF resolution keeps `emittedTerminal` and
  the terminal guard without needing PR2 or PR3, and its test asserts the standalone
  error-event shape.
- **PR2** honestly depends on PR1's `emittedTerminal` and adds CANCEL provenance as
  its own increment.
- **PR3** is broad but not a dumping ground: bridge/adapter terminal correctness is
  its thesis, WP2b extends the same truncated-terminal path with usage, and the
  cross-layer edits are identified comment/doc corrections that its body must name.
- Running `cursor-eof-terminal.test.ts` in both PR1 and PR3 is meaningful rather than
  redundant: PR1 verifies terminal SHAPE, PR3 adds the usage cases, and PR1's
  `toMatchObject` tolerates the added field.
- `tests/cursor-interaction-query.test.ts` is not edited at all — `015` preserves its
  imports through the re-export — but PR3 owns running that existing contract.

## Blocker — the rebased branch was never pushed before remote verification

`020` has lidge fetch `origin/cursor-call` and create a worktree at the new SHA, and
`010` said the audit happens "before pushing" — but no push command existed anywhere
between them. lidge would have fetched the PRE-rebase branch and then either failed
on an unknown revision or, worse, silently tested stale code without the rebase or
WP2b. `origin/cursor-call` was still at `9f8ccec9d` when `r7` checked.

**Fixed.** `010` gains step 7:

    git push --force-with-lease --no-verify origin cursor-call
    test "$(git ls-remote origin refs/heads/cursor-call | cut -f1)" = "$(git rev-parse cursor-call)"

`--force-with-lease` rather than `--force`: the rewrite is expected, clobbering
someone else's push is not. `020` also re-confirms the SHA on lidge before installing.

## Naming inconsistency

`030`'s prose still called the construction base `EXPECTED_DEV`, which `040` defines
as the EVOLVING merge-time variable, while `030`'s own commands correctly used
`VERIFIED_BASE`. Renamed throughout `030`; `EXPECTED_DEV` now appears only in `040`,
where it is initialized from `VERIFIED_BASE` and advanced per merge.

## Terminal state of the roadmap cycle

Seven rounds, 27 findings, all verified against the tree and absorbed. The plan is
executable end to end as written.

