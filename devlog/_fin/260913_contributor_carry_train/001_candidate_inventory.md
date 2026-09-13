# Candidate inventory and its verification

## How the scores were collected

The maintainer leaves a `## 리뷰 · 우선순위 NN / 80` line in a comment on triaged
issues and pull requests. This unit harvested that line from every open item on
2026-09-13 through the GraphQL API.

The first attempt was wrong in a way worth recording. `gh api graphql --paginate`
only advances a query whose cursor variable is named `$endCursor`; a query using
`$cursor` re-requests page one forever. That run produced a 230 MB file of 472
identical pages and, worse, a plausible-looking result: deduplicating by number
hid the loop and returned a correct-but-partial page-one answer. Five candidates
at 61 to 68 were missing from it.

The corrected collection covers 73 open pull requests and 58 open issues. Every
one carries a score, so nothing in this inventory is an unscored guess.

Seventeen open pull requests score 60 or higher once the maintainer's own #4462
is set aside. Sixteen are dispatched here; #3389 is deferred for a reason
recorded below.

## Pull request candidates, 60 and above

| Score | PR | Author | Domain | Lane |
| --- | --- | --- | --- | --- |
| 74 | #4457 | jeongjin0 | devin adapter tool identity | C |
| 73 | #4381 | luvs01 | bridge truncated terminal | B |
| 71 | #4387 | luvs01 | web-search continuation key binding | R |
| 70 | #4455 | jeongjin0 | code-mode view_image | R |
| 69 | #4388 | luvs01 | images loop buffering bound | B |
| 68 | #3389 | Yum-wu | zero-output retry | deferred |
| 68 | #4382 | luvs01 | hub status credentials | L |
| 67 | #4438 | Yongzhaooo | OCG DeepSeek timeline instructions | C |
| 66 | #4389 | olddonkey | stream memory allocations, 44 files | C |
| 66 | #4413 | rrmlima | authenticated remote catalog pull | L |
| 66 | #4460 | AgenticLab-SH | model availability vs auth failure | B |
| 64 | #4077 | laerad777 | xAI Fast catalog copy, residue only | X |
| 63 | #4086 | Eleven-is-cool | routed continuation after replay miss | R |
| 61 | #4409 | yxr1995-maker | routed effort ladders from models.dev | R |
| 61 | #3663 | y2ambition-ai | context history relay, 19 files | H |
| 61 | #4170 | yeongjunyoo | stop refusal cause | L |
| 61 | #4447 | Veritas-7 | field-masked provider writes | S |

`#4462` also scores 74 but is maintainer-authored and belongs to the sub-agent
surface work, not this train.

`#3389` is deferred by prior judgment, not by score. The 2026-09-04 priority-65
closeout recorded `NEEDS_DESIGN`: its zero-output premise was disproved by
experiment. Reviving it needs a design decision first, so it is not dispatched
here.

## Issue candidates with no owning pull request

| Score | Issue | Reporter | Lane |
| --- | --- | --- | --- |
| 76 | #4425 | wanjinxingoo-bot | I1 |
| 76 | #4430 | samwang0041-star | I2 |
| 73 | #4454 | 321sssrt-bit | I4 |
| 71 | #3775 | leonclab | I3 |
| 70 | #4429 | mdwsk88 | I3 |
| 67 | #4442 | SeanChengN | I1 |
| 66 | #4436 | jaychou0642-create | I3 |
| 64 | #4435 | ren-min-wan-sui | I2 |

The remaining 60+ issues are excluded for a stated reason rather than by
oversight. #4456, #4412 and #4439 already have an owning pull request in this
train (#4457, #4455, #4438). #4191, #4311, #3661, #3781, #4312 and #3506 are
partially landed: the merged work references them with `Refs` and each landing
states in its own description that the issue stays open. #3375, #3376 and #3377
are maintainer feature issues under separate execution.

## Supersede closures already executed

Before this train was planned, nine contributor pull requests were closed because
the previous batch had already absorbed them. Each carrier's merge commit was
verified as an ancestor of `origin/dev` at `2df82f412` before the close, and each
close carries a comment naming the carrier, the merge commit, and the fact that
the carry preserved the author's trailer.

| Closed | Author | Carrier | Merge commit |
| --- | --- | --- | --- |
| #4319 | ke-1t | #4346 | `b551b524f` |
| #4310 | yxr1995-maker | #4354 | `b474013` |
| #3652 | itismyfield | #4355 | `c6372ca` |
| #4229 | yansigit | #4363 | `37bc1a0` |
| #4216 | ildunari | #4367 | `c240534` |
| #4119 | DamnUi | #4366 | `90667e5` |
| #4317 | cortes-ventures | #4402 | `8acd73b` |
| #4080 | terrytan95 | #4369 | `c27eeec` |
| #3458 | Ingwannu | #4362, #4372 | `19601ea`, `7874900` |

## The half-superseded case

`#4077` was not closed, and the reason generalizes. Its registry half landed
independently through `#4431` (`7ca00ffe7`), which classified the xAI OAuth lane
from its own live probe and deliberately excluded `grok-4.20-multi-agent-0309`
because the gateway answers `service_tier: "default"` when sent `priority`. That
branch flips the same model to `true`, so the landed scope is narrower on
evidence.

Its third point is still unlanded and now more visible than when it was filed:
`src/providers/registry.ts` still reads
`fastTierDescription: "Priority processing, 2x token price"`, and `#4431` opened
the OAuth subscription rows where no per-token price exists. Lane X carries that
correction with the author's trailer.

`#4431` landed without referencing `#4077` and without a trailer for its author.
That is the `missing_coauthor_credit` pattern `CREDITS.md` exists to stop
repeating, and it is why lane X exists as its own slice rather than as a footnote
in another lane.

## Duplicate to collapse

`#4171` (rrmlima, `CHANGES_REQUESTED`) and `#4455` (jeongjin0) both answer issue
`#4412` and both touch `src/responses/code-mode-helper-compat.ts` and
`src/types/tools.ts`. `#4455` is the 8-file superset. Lane R carries `#4455` with
trailers for both authors; lane X closes `#4171` after that landing is verified on
`dev`.
