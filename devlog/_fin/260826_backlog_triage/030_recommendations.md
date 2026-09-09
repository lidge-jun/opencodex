# 030 — recommendations

Ordered by value per unit of risk, not by size.

## 1. #1829 — a maintainer pass on the only non-stale large PR

0 commits behind `dev`, CI green, 4 files. Every other large PR on the list carries a rebase
tax measured in hundreds of commits; this one carries none. If it is going to be reviewed at
all, reviewing it now costs the least it will ever cost.

## 2. #2033 — reimplement the 14-line sidecar gap

The gap is real: GET and PUT sidecar responses omit an `enabled` field
([config-routes.ts:571](../../../src/server/management/config-routes.ts), :809). At 869 commits
behind, revival means reimplementation rather than rebase — which is fine at this size, and the
author should be credited in the commit message.

## 3. #1820 — the best of the MEDIUM tier

The backend already computes aggregate cache tokens and per-model estimated cost
([summary.ts:67](../../../src/usage/summary.ts)). The work is GUI row types and table columns,
which is a bounded, verifiable slice.

## 4. #2083 — ask the owner, not the author

The image-auth contract disagreement is a product decision. Asking for a rebase before deciding
whether OAuth-authenticated image relay is wanted would waste the contributor's time on a PR
that may be declined on principle.

## 5. Author check-ins, not closures

#1557, #1645, #1756, #2213, #2230, #2244, #2326 need explicit continuation from their authors.
All accounts still resolve. Closing them for being behind would be closing other people's work
for the backlog's convenience — the honest move is to ask, and to say plainly that a rebase of
that size is a rewrite.

## What NOT to do

**Do not batch-close by age.** The audit found exactly two safe supersessions (#1769, #2215) out
of 18, and both were proven by naming the commit that landed first. Age correlated with nothing
useful: #1829 is nine days old and perfectly current; #2033 is seven days old and 869 commits
behind.

