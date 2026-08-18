# 007 — Audit round r4-20260818033946: FAIL, 4 findings, all accepted

Fourth reviewer, dispatched as an `explorer` role so the `SubagentStop` observer
actually records the verdict — rounds `r2` and `r3` had to be aborted as
inconclusive because their reviewers ran outside that matcher
(`hooks/subagent-stop-observing-review.json` matches `^(explorer)?$`). Their findings
were still absorbed; only the FSM record was missing.

Verdict **FAIL**: every code judgment held, and four EXECUTION-procedure defects
remained.

## What passed

- Both remote phases use dedicated worktrees, no `checkout -f` on the shared lidge
  checkout (`020:19`, `050:16`).
- `build:gui` and the publish caveat are in both gate phases (`020:49`, `050:32`).
- Release-state reads are live (`050:49`).
- WP2b's helper move and re-export are technically correct
  (`protobuf-events.ts:1340`, `message-mapper.ts:28`).
- **PR1 and PR2 tests do not depend on PR3 code** — the stack is genuinely layered.
- No release-authority gate forgotten: exact-SHA Cross-platform CI and Service
  lifecycle are already required before publication (`050:73`).

## F1 (High) — the base pin was recorded but not USED, and it cannot be one SHA

Two problems in one finding.

First, `010` still said `git rebase origin/dev` while `020` recorded a live SHA — so
the pin was decorative. The remote had already moved again to `1645bb924` by the time
`r4` ran (third observed value after `87f7f970b` and `e1bdbc1e5`).

Second, and worse: `040` required every merge to see live `dev` equal to the original
`VERIFIED_BASE`. That is false by construction the moment PR1 lands — PR1's merge
result IS the new `dev`. The doc defined PR2's updated expectation but never repeated
it for PR3.

**Accepted.** `010` step 1 now captures `VERIFIED_BASE` with `git ls-remote` and
rebases onto that SHA. `040` replaces the frozen check with an evolving
`EXPECTED_DEV`: verified base before PR1, then each layer's merge result before the
next, re-read live every time, with an explicit stop-and-rebase branch if it differs.

## F2 (High) — the three-layer topology was not constructible as written

Measured against the tree:

- `<base>..dfb6fb884` = 17 commits — correct.
- `dfb6fb884..6d9744283` = 3 — correct.
- `6d9744283..fe2237038` = **11**, `6d9744283..HEAD` = **16** — the doc said
  "15 + WP2b".

Worse than the miscount: `git diff --name-only 6d9744283 cursor-call` shows the top
range also touches `src/adapters/cursor/request-builder.ts`,
`tests/cursor-request-builder.test.ts`, and `tests/cursor-tool-result-image.test.ts`
— all PR1-owned, edited later by `2ea12062d` (the `r2` honesty corrections). And the
rebase REWRITES `dfb6fb884` and `6d9744283`, so the plan named branch points that
will not exist when it runs. WP2b was declared part of PR1 with no instruction for
how it gets there.

**Accepted, and `030` is rewritten around OWNERSHIP rather than commit ranges.** Each
layer is defined by the subsystem it changes; the doc now carries a five-step
procedure: map the rewritten boundaries by SUBJECT LINE (the rebase preserves order),
move the late PR1-owned edits below the PR1 boundary (fix-forward cherry-pick, or
`rebase -i` split if that is not clean — and record which route was taken), land
WP2b inside PR1 before the branch is cut, create the branches, then re-verify every
layer's file set and refuse to open a mislabeled PR.

## F3 (Medium) — `f145fd513` hits a second, unplanned conflict

`010` said every commit after `54f68daf5` applies cleanly. Not true: step 2 removes
`CursorStreamTruncatedError` from the import at `live-transport.ts:51`, and
`f145fd513` edits that exact line to add `CursorUnexpectedCancelError` while still
listing the removed symbol.

The reviewer also confirmed the good news: the functional context survives. The
`emittedTerminal` write in `push()` (`:541`) and both `classifyTurnFailure` throw
sites (`:642`) still exist after the step-2 resolution, so this is an import line and
nothing more.

**Accepted.** `010` gains an explicit step 3 with the literal resolved import line
and a warning not to let the conflict marker tempt a wider edit.

## F4 (Medium) — WP2b's own contract test was gated one layer too high

`015` re-exports `partialUsageFromEventState` specifically so
`tests/cursor-interaction-query.test.ts` keeps working (five dynamic imports at
`:150`, `:164`, `:172`, `:189`, `:195`), and names that file in its verification.
But `020`'s per-layer table assigned it to PR3 while WP2b lands in PR1 — so PR1
could have merged with the re-export untested.

**Accepted.** The test moves to PR1's gate, and the table now names WP2b as part of
PR1 rather than PR3.

