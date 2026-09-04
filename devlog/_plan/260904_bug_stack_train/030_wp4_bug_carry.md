# 030 — wp4: carried contributor fixes (PARALLEL, not stacked)

Corrected after plan audit. These were originally drafted as a third stack layer above
deviceauth. That was wrong: none of the four consumes deviceauth and none consumes
another, so stacking them would impose a false merge order. DEV-STACK-01 says
independent parts open as parallel PRs off trunk, and DEV-STACK-03 says one thesis per
layer — four unrelated theses in one layer violates both.

Each fix therefore gets its own branch off `dev`, merged independently:
`codex/carry-3335`, `codex/carry-3333`, `codex/carry-3322`, `codex/carry-3357`.

Four PRs were judged root-correct with RED-without-fix regressions. Each is carried as
its own independent PR with a `Co-authored-by` trailer in its commit, so the
contributor graph records the author (AGENTS.md; `CREDITS.md` exists because 27
landings previously lost attribution).

| Source PR | Author trailer | Scope |
|-----------|----------------|-------|
| #3335 | `Co-authored-by: x3M3x <amroeid1999@gmail.com>` | GUI combo strategy selector: render all five |
| #3333 | `Co-authored-by: hajune <june@smartix.co.kr>` | Models tab spacing + Combos layout stability |
| #3322 | `Co-authored-by: luvs01 <27862058+luvs01@users.noreply.github.com>` | `logs --follow` capability contract |
| #3357 | `Co-authored-by: huaiqing-afk <huaiqing-afk@users.noreply.github.com>` | Cursor repeated-narration breaker |

Carry method: fetch the PR head and re-apply its source/test hunks onto a fresh branch
off `dev`, one commit per source PR, each carrying its trailer. Do not pipe
`gh pr diff` straight into `git apply` for #3335 — GitHub emits binary PNG hunks
without full index data, so the whole-patch check fails on the two
`docs/pr-assets/*.png` files even though every source hunk applies cleanly.

Focused verification, per branch — each branch runs only its own tests:

| Branch | Command |
|--------|---------|
| `codex/carry-3335` | `cd gui && bun test tests/combo-strategy-selector.test.tsx` |
| `codex/carry-3333` | `cd gui && bun test tests/models-tab-layout.test.ts` |
| `codex/carry-3322` | `bun test tests/cli-usage-report.test.ts tests/cli-capabilities.test.ts` |
| `codex/carry-3357` | `bun test tests/cursor-repetition-breaker.test.ts` |

No repository-wide suite (explicit user constraint).
