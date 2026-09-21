# wp5 — Wave 2 integration and the dev regression gate

## Order

S, I3, I4, H. Lane S is first because it has been waiting since wave 1 and is a
single link. H is last because it is the largest diff and the one most exposed to
everything that landed before it, and because it was prepared on top of I4.

The merge procedure is identical to 020_wave1_merge.md, including the exact-head
CI check, the ancestry verification, the trailer check in the landed commit, and
the three-part merge comment.

## Security-review holds

Two lanes do not merge on green CI alone. Lane S (#4447) touches CORS and the
management provider routes; lane I4 (#4454) repairs a fail-closed bypass. Both are
inside the MAINTAINERS.md security-review boundary. If review is not available
within this goal, they are recorded as deferred with the reason rather than merged
on a CI signal that was never meant to certify them.

Deferring lane I4 has a consequence worth stating up front: lane H was prepared on
top of it. If I4 is held, H is rebased onto dev without it before merging, or H is
held too. H is not merged with an unmerged parent silently folded in.

## The regression gate

A merge report is not a regression proof. The gate is a dev workflow run that
concluded success on a commit that contains the whole batch.

Two distinctions carried over from the previous batch, both learned the hard way:

- A run that ends cancelled is not a pass. Merges inside one concurrency group
  supersede each other, which is the workflow behaving as configured; the evidence
  is the completed run on a descendant commit.
- The commit the run executed on must be an ancestor-verified descendant of the
  last merge. git merge-base --is-ancestor <last-merge> <run-head> is the check.

If the final run is red, the failure is triaged before any completion claim. A
failure that belongs to a landed lane is fixed as a follow-up pull request in this
same goal, not recorded as an acceptable residue.

## Exit criteria

Every lane is merged or explicitly deferred with a stated reason, and one dev run
has concluded success on a batch-containing commit, recorded by run id and head
SHA.
