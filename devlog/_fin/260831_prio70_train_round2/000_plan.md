# 260831 round 2 — priority-70+ train: what is left after the entitlement stack

Round 1 of this train closed five units and they are all on `dev`: #3022 (PR #3035),
#3011 (PR #3044), #3023 (PR #3054), tri-state entitlement authority (#3057) and the
entitlement diagnostic (#3058). This unit is the rescan that follows, taken at
2026-08-31T12:0x KST against `dev` = `5cec0a33e`.

## The rubric

Four axes, 0-20 each, 80 total. An item enters the train at 70.

| axis | what it measures |
| --- | --- |
| blast radius | how many users and surfaces the defect reaches |
| data, credential or durability risk | state loss, credential corruption, broken durable persistence |
| reproducibility and evidence quality | a concrete repro, a file:line trace, or a reporter measurement |
| shippability | fixable in a bounded, testable diff on this tree now |

Round 1 used the same four axes but never wrote them down, which is why #3022 was
"78/80" in a table nobody could recheck. The scores below are recheckable.

## Method

Four read-only `gpt-5.6-sol` high-effort lanes, split by cluster so no two lanes
shared a verdict: tools/proxy issues, platform/Windows issues, account-pool/catalog
issues, and the open bug-labelled PRs. Every lane read the real issue body with
`gh`, then verified the claim against the tree. Where a lane and the tree disagreed,
the tree won and the disagreement is recorded.

The PR lane deliberately overlapped the issue lanes on #3026/#3056 and #3071/#3069.
Both pairs agreed independently, which is the only reason those two scores are quoted
without a third look.

## The >=70 set

Components are blast radius / data-durability / evidence / shippability, each 0-20.
They are printed because a total alone is not recheckable — wp6 sits exactly on the
threshold, so its admission cannot be audited without them (audit `002`, blocker 9).

| wp | target | blast | data | evid | ship | total | doc | disposition |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| wp0 | this roadmap | — | — | — | — | — | `000`-`00x` | — |
| wp1 | #3071 Console Go `web_search_call` missing `query` | 15 | 18 | 20 | 20 | **73** | `010` | merge PR #3069 after rebase + review |
| wp2 | #3032 response-spill aggregate disk budget | 18 | 20 | 20 | 17 | **75** | `020` | repair the PR's Windows publication gap, then land |
| wp3 | #3026 forked-rollout history restore | 19 | 20 | 19 | 17 | **75** | `030` | PR #3056 is half a fix; complete it |
| wp4 | #3029 exhausted 5-hour pool account stays selected | 18 | 15 | 19 | 20 | **72** | `040` | reimplement; no PR targets it |
| wp5 | #3008 update aborts after a history-only stop failure | 18 | 17 | 18 | 18 | **71** | `050` | PR #3040 fails open; reimplement |
| wp6 | #3019 WHAM 401 bypasses stored-token refresh | 17 | 17 | 18 | 18 | **70** | `060` | carry PR #3020's core, drop the rest |

Where the load-bearing components come from: wp2's 20 on data is a measured ENOSPC
(6.8 GiB in 44 minutes), wp3's 20 is recovery requiring manual DB surgery, and wp1's 18
is a stored item that poisons every later turn in the thread. wp6's 18 on shippability
is the one to argue with if anything: the primitive exists, but credential lineage is
security-sensitive, and audit round 1 found the first design got it wrong.

Ordering is by independence, not by score. wp1 is one function and lands first. wp2 and
wp3 both touch durable state but in unrelated files. wp5 and wp6 are independent of
everything else.

wp6 was originally declared a stacked child of wp4 because both were called
"account-pool". Audit round 1 (`002`, blocker 7) disproved it: wp4 changes
`src/codex/routing.ts` scoring, wp6 changes auth/token recovery, and PR #3020 touches no
`routing.ts`. All six phases base directly on `dev`.

## Below the bar, and why

These are real defects. They are recorded so the next scan does not re-litigate them.

| item | score | why it misses |
| --- | --- | --- |
| #3009 Windows 20s repair deadline | 69/80 | PR #3039 is substantively right; it needs a rebase and one restored assertion, not a train slot |
| #3064 non-ASCII scheduler path | 68/80 | PR #3067 relocated the defect correctly but its `[^\\/]*` relaxation accepts arbitrary ASCII in a path-ownership check |
| #3024 dated configured models dropped | 66/80 | PR #3034 fixes the safe half; PR #3041's reverse inference can resurrect retired ids without callability evidence |
| #2999 native-main publication race | 64/80 | 20/20 on credential risk, but PR #3000's musl-unsafe FFI and late-rotation discard put shippability at 15 |
| #3066 routed private metadata | 62/80 | availability only; the compact lane gap is a follow-up, and #3038 is a worse duplicate |
| #3051 Cursor HTTP/2 pre-header EOF | 62/80 | PR #3052 is correct and narrow — merge it on the ordinary queue |
| #3021 encrypted subagent MESSAGE | 59/80 | one occurrence, no ciphertext captured |
| #3078 start shadow guard | 59/80 | targets `main`, and its test does not typecheck |
| #3053 sidecar catalog modalities | 47/80 | no linked user report |
| #3063 combo compact failover | 42/80 | the guard is right, the claimed regression is vacuous |
| #1419 Bun SIGTRAP | 39/80 | reported against Bun 1.3.14; `dev` ships 1.4.0 and there is no current repro |
| #1527 Cursor large-context collapse | 37/80 | the four named mechanisms are all fixed on `dev` |
| #3059 restore-dialog focus | 22/80 | the tree contradicts the claimed unmount path |
| #3070 usage keeps decreasing | 51/80 | model filtering landed in `b68edc077`; the residual is a GUI control gap |
| #2813 Luna Reserve disables routed rows | 48/80 | no OpenCodex Reserve gate exists; needs a request-boundary dump first |
| #3068 | duplicate | same author, body, and repro as #3071 — close in its favor |

Scores for the below-bar rows are recorded per item in `001`; they are not repeated here
because none of them is a threshold call.

## Audit

Ten adversarial `gpt-5.6-sol` rounds, all FAIL, every blocker verified in-tree and
amended rather than argued with. `002`-`011` record them. From round 8 the A-phase
reviewer is resumed rather than respawned, so a closure round judges its own findings.

Round 1 found nine holes in the original plan, two of which invalidated a premise it was
built on: wp3's claim that OpenCodex never writes `has_user_event`, and wp5's assumption
that there is one updater. Round 2 read a stale index (a staging error of mine) and still
produced two real refinements. Round 3 found five, **four of them inside round 1's own
amendments**. Round 4 found four more, including the one that matters most: wp3's
provenance field would have refused every manifest already on disk, which is the exact
population #3026 is about.

Round 5 cleared wp2 and wp5. Round 6 cleared wp4. Round 7 found zero blockers in wp1,
wp2, wp4, wp5 and wp6 — every finding since has been wp3, which is where the difficulty
in this train actually sits. Round 9 confirmed wp3's four-shape partition disjoint and
moved the remaining questions to transitions between shapes; round 10 reduced those to a
single cell that no durable fact can decide, which refuses by design.

The pattern worth naming: after round 1, the defects stopped being in the plan and
started being in the fixes. A remedy can be right about the defect it names and wrong
about its own boundary, and that failure mode does not announce itself — all four of
round 3's would have shipped as working code with passing tests.

wp3 alone absorbed four consecutive rounds on one predicate, which is what finally
forced the right answer: stop hand-writing a pattern that recognizes OpenCodex's own
write, and compute the expected post-image from the same rules the routing statements
use (`007`).

## Verification constraint (carried from round 1, user-imposed)

No local full suites. Focused `bun test <file>` locally; every suite, typecheck and
privacy scan runs on `ssh lidge` at the exact pushed head. Every completion claim
carries a receipt: command, host, exit code, pass/fail/skip counts. Every regression
test is driven RED against pre-fix source and that red result is recorded.

## Delivery

Stacked in this worktree per `DEV-STACK-01` — one branch per work-phase, cherry-pick
and squash rather than a dispatched merge worktree. Pushed `--no-verify` because the
pre-push hook runs the forbidden local suite. Merge into `dev` is authorized; nothing
beyond `dev` is.
