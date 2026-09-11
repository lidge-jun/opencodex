# 060 — wp7: close-out

Produce `070_outcome.md`: PR, lane, action taken, terminal state, and the merge SHA
or the exact unresolved question. Every row cites evidence produced in this round.

## Verification

```bash
git fetch origin && git log --oneline origin/dev | head -12
git rev-list --first-parent --count 50e955604..origin/dev
git rev-list --first-parent --no-merges --count 50e955604..origin/dev   # expect 0
gh pr list --repo lidge-jun/opencodex --state open --label bug
bun x tsc --noEmit
bun run privacy:scan
```

Plus, for every landed PR: the merge SHA, a mutation-verified regression, and the
differential probe table for any behavior-changing function.

## Criteria mapping

- c1 — the 070 table covers every target, verified against live `gh`.
- c2 — the 000 merged-tree table plus per-phase receipts.
- c3 — per-PR mutation oracles recorded in each phase doc.
- c4 — first-parent counts show merges only.
- c5 — differential probe tables for changed functions.
- c6 — auth/OAuth surfaces carry a named trigger and the unresolved question.

## Expected shape of the honest answer

Two PRs (#2747, #2740) are fixable and mergeable by me. One (#2693) is
reimplementable and mergeable. Three (#2745, #2638, #2497) sit on credential or
auth-routing surfaces where `MAINTAINERS.md` requires a second maintainer, and two
more (#2769, #2770) are blocked only because GitHub refuses self-approval.

So the realistic terminal state is **three merged, five awaiting a human**, and the
value delivered on those five is that each arrives current, rebased and evidenced
rather than stale. Stating that up front is not lowering the bar — it is the
difference between work that is blocked and work that is merely unfinished.

If a phase discovers it can do better than this — for example #2638's rebase proving
behaviorally clean — the plan is wrong in the right direction and the outcome doc
should say so explicitly rather than quietly matching the prediction.
