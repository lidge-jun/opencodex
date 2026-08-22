# 014 — Audit round r10-20260818042302: NEAR-PASS, the third boundary defect

Scope: confirm `r8`'s fix, then sweep EVERY phase boundary for the same class of
defect — one phase produces an artifact, the next reads a different one. Two
consecutive rounds had found that shape, so the round was aimed at a third instance
rather than at re-reading settled conclusions.

It found one.

## r8's fix confirmed

- `015` ends with its own `--force-with-lease` push and an exact remote/local SHA
  assertion (`015:144`).
- `020` explicitly consumes WP2b's later push, not `010`'s checkpoint (`020:33`).
- Both snippets parse correctly under zsh; substitutions unescaped, `test A = B`
  well-formed.
- WP2→WP2b, WP2b→WP3 and WP5→WP6 are coherent; WP6 gates the named merged-`dev` SHA
  in a dedicated worktree (`050:18`).

## The finding: the verified tree was never bound to the merged PR heads

`020` verifies one specific SHA. But `030` cut branches from `cursor-call` — a
MUTABLE ref — without asserting it still equaled that SHA, and `040` checked only the
live `dev` base before each merge, never the PR's own head.

The consequence is subtle, which is why it survived nine rounds: a force-push to any
PR head introduces commits no gate has seen, and `040`'s post-merge ancestry check
**still passes**, because the verified tip remains an ancestor of a superset. The
check that was supposed to catch a bad merge is structurally incapable of catching
this one.

## The fix — one named SHA threaded through three phases

`020` now records it:

    VERIFIED_TIP=$(git rev-parse cursor-call)     # after WP2b's push, before any gate

`030` step 0 refuses to cut branches unless `cursor-call` still equals it, and step 5
records each PR's expected head (`PR1_TIP`, `PR2_TIP`, `VERIFIED_TIP`).

`040` asserts each head immediately before merging:

    gh pr view <n> --json headRefOid --jq .headRefOid    # must equal PR<N>_HEAD

with the reasoning inline, so nobody deletes it as redundant with the base check —
the base check proves `dev` has not moved and says nothing about what the PR points
at.

## Why this class kept appearing

Three rounds, three instances, same shape: `r7` (nothing pushed the rebase before
remote verification), `r8` (the push preceded WP2b, so the wrong tip was verified),
`r10` (the verified tip was never bound to what actually merges). Each document was
correct read alone. The defect only exists in the seam.

The general lesson, recorded so the next unit inherits it: **a multi-phase plan needs
its artifacts NAMED and asserted across every handoff, not merely described
correctly within each phase.** `VERIFIED_BASE`, `EXPECTED_DEV` and now
`VERIFIED_TIP` are that naming; the assertions are what make the naming load-bearing.

