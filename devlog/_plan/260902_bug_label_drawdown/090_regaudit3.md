# 090 — regaudit3: final recount and closeout

Terminal phase after `p3226`–`p3232` and `r3239`.

## Recount (2026-09-02, tip `b54508c8c`)

`gh issue list -l bug --state open` → 5, `gh pr list -l bug --state open` → 0. Combined **5**.
The five are the recorded blockers from 072 (#3152, #3141, #2999, #1527, #1419), each with a
maintainer comment naming the evidence it needs and `needs-info` where the reporter owns the
next step (#2999 is the runtime-primitive blocker). No item was closed to lower the count.

## Landings since regaudit2 (all ancestors of `origin/dev`)

| item | landing | note |
|---|---|---|
| #3226 → #3234 | `b732b0d0f` | carry + nested `function.name` fix |
| #3227 → #3236 | `1c8278b4d` | carry, author credit |
| #3228 → #3239 | `744d12d02` | source half only; GUI editor left for a feature PR |
| regression from #3239 → #3240 | `7f00d0eee` | r3239: recovery gates bypassed by the synthesized chain |
| #3229 → #3241 | `b54508c8c` | carry on the repaired tip |
| #3232 | `261b7e012` | merged by the maintainer directly; verified |

## Trailing CI

The `push` runs on `dev` during this train were all cancelled by the next push. The r3239
regression was caught by the next cycle's focused check, not by CI, and repaired before anything
else landed — which is the point of pairing "CI behind the work" with a focused red-green gate
on every PR. Exact-head `workflow_dispatch` on `b54508c8c` (branch
`codex/regaudit-ci-b54508c8c`, run 33581824312, Windows on): CI3_PLACEHOLDER

## Devlog landing

PR #3218 (this stack) → DEVLOG_PLACEHOLDER

## Criterion c-7

Met at the fallback threshold: 5 open bug-labelled items, all with recorded, evidence-backed
blockers. From 24 at the start of the campaign.

