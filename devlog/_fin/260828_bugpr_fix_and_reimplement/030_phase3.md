# 030 — wp4: #2745, OAuth credential boundary

Head `a90ab6ee7`, mine, 39 behind, merge CLEAN, tsc OK. Touches
`src/server/responses/core.ts` (+55/-11) and `tests/generic-oauth-failover.test.ts`.

**This is the surface `MAINTAINERS.md` requires explicit security review for.** The
PR carries a CHANGES_REQUESTED review with two open blockers: one credential-boundary
correctness defect and one test-oracle defect.

Per `AGENTS.md` §"Security working notes", the mechanism, activation path and
remediation are **not reproduced here** — the fix has not shipped and `devlog/` is
public. They live in `.tmp/2745-security-triage.md` (gitignored) and on the PR via
`gh pr view 2745 --json reviews`.

## What this phase decides

Whether the two blockers can be closed with evidence strong enough that a
credential-boundary change is safe to land, or whether it stays NEEDS_HUMAN.

The honest constraint: **I authored this PR.** Even with both blockers closed and a
behavioral regression, GitHub refuses my approval, exactly as it did for #2769. So
the realistic best outcome is "blockers closed, evidence posted, awaiting a second
maintainer" rather than a merge.

That is worth doing anyway — a reviewed PR with its blockers closed is a different
object from one with them open — but this phase should not pretend the merge is
reachable.

## Contention

`src/server/responses/core.ts` is shared with #2638 and #2497. If any of those lands
first, re-run `git merge-tree` pairwise before this one moves. Textual mergeability
is not behavioral compatibility on the auth/routing boundary.

## TESTS

`tests/generic-oauth-failover.test.ts` — the required test work is recorded with the
rest of the triage in scratch.

## Verification (C)

```bash
bun x tsc --noEmit
bun test tests/generic-oauth-failover.test.ts
```

Plus the differential probe over every arm of any changed credential-resolution
function, and a mutation oracle on the new regression.

## Terminal outcome

DONE only if a second maintainer approves. Otherwise **NEEDS_HUMAN**, with the
blockers closed and the evidence posted.
