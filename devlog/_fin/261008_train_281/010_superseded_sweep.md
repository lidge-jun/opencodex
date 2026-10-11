# 010 wp2: superseded sweep

Input: read-only sol sweep at dev `aeebf11e5a` (`.tmp/train281/superseded.md`, scratch) covering 54 open PRs
and 51 open issues against dev source and merged history.

Result: 0 confident close candidates. Partial landings with remaining scope or explicit maintainer keep-open
comments include #6567 (#6582 row labels only), #6532 (#6559 code; live cache acceptance kept open), #6649
(#6686 journal half; restart admission open), #6695, #5782, #6472, #5955, #5950/#5660, #6370, #6654, #6520,
#6478, #6671, #3742, #6436/#6143, #6723.

Plan: after wp3/wp4 land, recheck on the final dev tip the items those merges can supersede (#6370 closes
with its carry; #6532 and #3375 against #6743's account-pool work). Close only with a comment naming the
merged PR/commit and the evidence; otherwise record KEEP.

Acceptance: a table of every closed item with its superseding SHA; nothing closed on title similarity.

## Record at dev aeebf11e5a (wp2 cycle, 2026-10-08)

| Check | Result |
|---|---|
| Open inventory | 54 PRs, 51 issues |
| Confident CLOSE (superseded or duplicate) | 0 |
| Reviewer spot-check (#6567, #6532, #6649, #6520, #6671, #3742) | KEEP confirmed against source and maintainer comments |
| Merged PRs Oct 6-8 with closing references | 55 searched, 15 references, every referenced issue already closed |

No GitHub writes at this tip. The final-tip recheck runs as wp5 step 1.
