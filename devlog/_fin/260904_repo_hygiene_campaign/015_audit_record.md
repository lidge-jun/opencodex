# 015 — Audit record for the deletion ledger

The branch-deletion ledger was reviewed by an independent auditor before any
branch was touched. It failed three times. Each failure is recorded here because
each one would have destroyed work.

## Round 1 — FAIL

> `cursor-call-prerebase-260818` was matched to unrelated PR #2608 by parsing a
> date-like branch suffix and still contains unique unmerged patches

The scratch-branch rule extracted the first 3–4 digit run from a branch name and
treated the matching PR's state as merge evidence. The branch is dated
2026-08-18, so `260818` yielded `2608`, which is a real merged PR about a
completely different subject. The branch carries two unique Cursor fixes — an
unlabeled stream EOF failure and a cancel surface — and 31 commits reachable
from nothing else.

This is the same class of error that deleted open-PR head refs on 2026-09-02,
reproduced inside the unit written to prevent it. Writing the rule down did not
prevent it; an auditor running the numbers did.

Fix: the PR number must be a whole numeric token of the branch name, and PR
state alone no longer authorizes anything — the branch must be proven a
duplicate of that PR's head (same SHA, ancestor, or content-identical).
Candidate set 104 → approved 71.

## Round 2 — FAIL

> `final.py` can authorize deletion from a stale PR-head ref or failed `git
> diff` because both command failures are ignored

The generator ignored return codes. A failed `fetch` left a stale
`refs/prhead/<n>` that would be compared as if current, and a failed `git diff`
produced empty stdout that read as "no difference" — the same shape as the zsh
bug in `010_method.md`, where absence of output was mistaken for absence of
change. Twice in one unit, so it is a pattern and not an accident: **empty
output is not evidence unless the command is known to have succeeded.**

Fix: fail-closed. Git failures raise, PR heads are force-fetched with a checked
return code, and any error rejects the branch. Regenerating produced exactly the
same 71 branches, which is itself the evidence that the earlier approvals were
sound rather than lucky.

## Round 3 — FAIL

> cached T1/T2 and T3 proofs are not recomputed or SHA-bound, so a branch that
> moves after classification can lose new work

Proofs were inherited from JSON snapshots taken earlier in the session and the
ledger stored no SHAs, so a branch that gained a commit between classification
and deletion would still be deleted on the strength of a stale verdict.

Fix: snapshots now supply only the candidate list. Every proof is recomputed
live, and each approval records the branch tip, the proof, and the `origin/dev`
SHA it was proven against. Execution re-reads each tip immediately before
deletion and refuses on any mismatch.

## Round 4 — PASS

- 71/71 recorded tips equal current branch tips
- 71/71 proofs still hold at the recorded SHA
- 33/33 rejected branches still present, including `cursor-call-prerebase-260818`
- guards empty against live state: no open-PR head, no worktree ref, nothing protected
- `origin/dev` moved during the audit (`b5777aa2d` → `664d80c76`) and invalidates
  no proof; no rejected branch became landed as a result

Non-safety note from the auditor: `rb-2122-ELZMyj` and `rb-2734` are
tree-identical to their PR heads but stay preserved because the comparison uses
three-dot form. Over-preservation, so it stands.

## What this cost and why it was worth it

Four rounds against one auditor, no branch deleted until the fourth passed. The
first round alone justifies the whole exercise: the plan document explicitly
warned against branch-name guessing on line 46, and the implementation did it
anyway on line 12 of the very next file. A rule you wrote does not audit the
code you wrote.
