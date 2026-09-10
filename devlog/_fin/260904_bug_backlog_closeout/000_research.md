# 260904 bug backlog closeout — research

Goal: drive every bug-labeled OPEN issue and bug-labeled OPEN PR in lidge-jun/opencodex
to a terminal state (merged, superseded with attribution, or closed with rationale).

Session FSM: PABCD under an ACTIVE host goal (HOTL). Goalplan slug
`close-out-the-bug-backlog-of-lidge-jun-opencodex`.

## Board snapshot (captured at goal start, dev = 072df52eb)

### Bug-labeled open PRs (12)

| PR | Author | State | Base | Note |
|----|--------|-------|------|------|
| 3430 | ChickenBreast-ky | READY, all checks pass | dev | Closes #3428 |
| 3420 | ildunari | READY, all checks pass | dev | no Closes tag |
| 3405 | adtumk | READY, all checks pass | dev | Closes #3378 |
| 3403 | ianlyoo | READY, all checks pass | dev | Closes #3402 |
| 3401 | agentHits | READY, all checks pass | dev | Closes #3400 |
| 3432 | luvs01 | DRAFT | dev | lab file-URI privacy |
| 3407 | turin-dev | DRAFT, 33 behind | dev | integrations toggle |
| 3394 | kremnyi | DRAFT, 33 behind | dev | grok 4.6 responses |
| 3388 | zleo-ai | DRAFT, 44 behind | dev | grok sparse output |
| 3348 | RHODIZSECURITY | DRAFT, 33 behind | dev | 2338-line failover overhaul |
| 3332 | full999 | DRAFT, 66 behind | dev | claude combo capabilities |
| 3325 | luvs01 | DRAFT, checks FAIL | dev | workflow surface, unsponsored |

### Bug-labeled open issues (13)

Claimed by a PR: #3428 (3430), #3402 (3403), #3400 (3401), #3406 (3407).
Unclaimed: #3433, #3425, #3424, #3352.
needs-info: #3320, #3279, #3255, #3245, #1527.

## Verification constraint (user-stated, binding)

The local full suite is FORBIDDEN for this unit: no `bun run test`, no bare `bun test`.
Live GitHub CI (`gh pr checks`) is the authoritative verifier; CI already runs
Linux/Windows/macOS. At most one named focused test file may be run when a change
needs a local signal. This overrides the AGENTS.md PR-ready full-suite gate for
this session because the maintainer explicitly directed it.

## Attribution constraint

AGENTS.md `missing_coauthor_credit` and CREDITS.md: reimplementing, superseding,
carrying, or rebasing another author's PR REQUIRES a `Co-authored-by:` trailer
naming that author in a branch commit so it survives the squash. Prose credit is
not equivalent — GitHub reads the trailer, not the sentence.

## Repository permission

`gh api repos/lidge-jun/opencodex --jq .permissions` returns
`{"admin":true,"maintain":true,"pull":true,"push":true,"triage":true}`.
Squash-merge into dev is therefore available to this session. Branch rulesets
still require a reviewed PR; force-push and direct dev push remain refused.

## What "terminal" means for this unit (settled after plan audit round 2)

The plan auditor argued that only MERGED or CLOSED counts, and that a live PR or a
posted NEEDS_HUMAN is "deferred closure, not a terminal repository state." That is
rejected as the completion bar, deliberately, and the reason is recorded here so the
D-phase claim can be checked against a stated rule rather than a mood.

The goal contract this session was given names BLOCKED, NEEDS_HUMAN, UNSAFE, and NOOP
as terminal outcomes alongside DONE. Some items genuinely cannot reach CLOSED from
inside this session without lying or destroying information:

- #3255 asks for a product decision about matching official ChatGPT behavior. Closing it
  to satisfy a counter would discard a legitimate request; inventing the product intent
  would be worse.
- #3245, #3279, #1527 need evidence only the reporter has. Closing them before the
  reporter answers converts a real bug into a silent one. `stale-needs-info.yml` exists
  precisely because this project already decided how that timeout is owned.
- A workflow-surface change (#3325) requires maintainer sponsorship that admin rights do
  not substitute for.

So the bar for this unit is: every item reaches a RECORDED terminal outcome, where
DONE means merged/closed and the non-DONE outcomes require (a) a named reason from the
goal contract, (b) evidence with file:line or a posted URL, and (c) a visible artifact on
the issue or PR itself. What is forbidden is the thing the auditor was right to attack:
an item left open with no posted artifact and no named outcome. Silence is not a
disposition. That distinction is the operative rule for wp3, wp5, and wp6.
