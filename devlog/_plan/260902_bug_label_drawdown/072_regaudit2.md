# 072 — regaudit2: final recount, exact-head CI on `d23eab43a`, devlog landing

Terminal phase after `i3217`.

## Recount (2026-09-02, after #3224 and #3223 disposition)

`gh issue list -l bug --state open` → 5. `gh pr list -l bug --state open` → 0. Combined **5**.

| item | disposition | blocker recorded in |
|---|---|---|
| #3152 dashboard log panel jitter | NEEDS_REPRO — reporter environment detail (row count, viewport) | 052_i3152.md |
| #3141 aggressive responses-state writes | NEEDS_HUMAN — reporter measurement; numbers do not reconcile | 051_i3141.md |
| #2999 native-main refresh publication race | DONE for the publication guard (#3183 `fecb77a91`, #3199 `c17bc94c2`); last window needs `renameat2(RENAME_EXCHANGE)`, which Bun does not expose | 057_i2999.md |
| #1527 Cursor large-context collapse | NEEDS_INFO — matched direct-vs-adapter trace for the 429 asymmetry and prefix-cache residuals | 059_i1527.md |
| #1419 bundled Bun SIGTRAP | NEEDS_HUMAN — reporter crash artifact | 056_i1419.md |

Each has a written comment on the issue naming the evidence and the exact artifact that would
unblock it, plus the `needs-info` label where the reporter owns the next step. That meets the
objective's fallback ("5 acceptable if the last few are genuinely blocked"), and the four
external-dependency items are honest blockers rather than deferrals: two need a reporter
artifact, one needs a reporter measurement, one needs a runtime primitive.

#3223 (contributor PR for #3217) was closed as superseded by #3224 with a comment crediting the
independent diagnosis and inviting the tighter catalog-scoped scrub as a follow-up.

## Exact-head CI on the final dev tip

`d23eab43a` = `origin/dev` after #3224. `workflow_dispatch` on branch
`codex/regaudit-ci-d23eab43a`, run 33562938994, Windows shards on. Result: CI2_PLACEHOLDER

## Devlog landing

PR #3218 (this stack, rebased on `d23eab43a`) → DEVLOG_PLACEHOLDER

