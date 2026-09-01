# 070 — outcome: merge train round 3

Terminal outcome: **DONE**. Every item in the round-3 scope reached a terminal state.

## What landed on `dev`

| commit | what | origin |
| --- | --- | --- |
| `abcda8e13` | 2026-08-31 non-priority-70 bug triage record | #3114 |
| `0dc01cdaa` | canonical fake-IP addresses on provider PATCH | #3122 via #3133 |
| `b14b741dc` | Windows cold-start budget + code-page scheduler paths | #3104 via #3134 |
| `c8c8dc338` | startup-prime window fix + this roadmap unit | #3139 |
| `58be3c5bb` | probe for a free pid instead of assuming 4242 is dead | #3042 via #3137 |

## Closed

Issues #3009, #3064. Pull requests #3104, #3122, #3042, #3077, and a credit comment on the
already-closed #3067. Every closure names the merged commit and what changed from the
original; none is a bare "superseded".

#3039 was closed by its own author at `2026-09-01T04:17:43Z`, not by this train. The comment
recording which contribution #3104 did **not** carry — the elapsed-time diagnostic, replaced
by the configured budget — landed anyway, so the residual is findable.

## Rebased, not merged

#3109 to `b3b502045` (five commits; `926a8d8c` dropped because it had already landed as
#3128) and #3112 to `f3c4e9f75` (four commits). Both `range-diff`-identical. Neither PR's
review blockers were touched — #3112's three credential-path findings still stand and it
still needs a fresh security review.

## Untouched, deliberately

#3117 reverses a direction `b46164e78` pinned one day earlier and is a policy decision about
#1690, not a mechanical. #3061 has a substantive rebuttal on record. Both were named OUT at
wp0 and stayed out.

## What the round is actually evidence of

**Three wrong explanations, caught by measurement rather than review.** The websocket flake
was explained three times: a 60 s skew margin (wrong — the margin is months), a cache age
crossing a TTL (wrong — `refreshed=1` on every run of both trees), and finally the measured
one. Both wrong versions were plausible, cited real code, and **would have justified the same
fix**. That is what made them worth catching: the fix would have worked and the reasoning
would have been wrong, which is how a fixture acquires folklore.

`LOOP-MECHANISM-PROOF-01` is why it was caught. Asking for activation evidence before
adopting a mechanism killed a hypothesis already written into a devlog document and two PR
comments.

**A citation can be worse than silence.** "#3128 fixed that flake" was repeated across three
PRs and a release-train record. It was false — #3128 is an ancestor of every head that failed
afterwards — and its effect was to teach reviewers to dismiss a red. The correction is now on
#3109, #3112, #3104, and in `051` and `060`.

**A plan audit that returns FAIL is cheap.** Round 1 returned five blockers; three were
folded and changed the train's shape — fork PRs became cherry-pick carries once
`enforce-pr-target.yml:740-746` was read properly, and #3039's closure was withdrawn. Two
were rebutted with evidence. The audit cost one subagent and prevented stranding two
contributor PRs in draft.

**The test suite commits into the developer's checkout.**
`tests/test-runner.test.ts` calls `commitFixture(cwd, ...)`, which makes a real commit in
whatever worktree runs the suite. It rode along on the first push of two carry branches
(author `OpenCodex Test <test@opencodex.invalid>`, adding `base.txt`) and both had to be
reset and force-pushed. Not fixed here — it is a real trap and belongs to its own unit.

## Verification summary

| check | result |
| --- | --- |
| `bun test tests/service.test.ts` (#3134 carry) | 191 pass / 0 fail |
| `bun test tests/management-provider-validation.test.ts tests/destination-policy-resolved.test.ts` (#3133 carry) | 129 pass / 0 fail |
| `bun test tests/responses-state.test.ts tests/doctor.test.ts tests/cli-status-json.test.ts` (#3137 carry) | 214 pass / 0 fail |
| `bun test tests/server-auth.test.ts` (flake fix) | 91 pass / 0 fail |
| exact-head CI on #3133, #3134, #3137, #3139 | fully green before each merge |

Every merge used `--admin`, because GitHub refuses self-approval and `dev` requires a
reviewed PR. That is a real gap and worth stating rather than burying: what stood in for
review was an independent security lane on #3122, direct maintainer audits on the rest, and
a green exact-head matrix on all four.
