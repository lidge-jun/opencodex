# 030 wp4: track #6743 (anthropic2 account pool)

Owner: thread 01a1199c-9aa9-7c43-8f2e-f13a7c191846 (worktree `/Users/jun/.codex/worktrees/f0fe/opencodex`,
branch `codex/anthropic2-account-pool`). The coordinator does not push to that branch while the thread is
active.

Procedure: poll the thread (`wait_threads`, `read_thread`) and the PR (`gh pr view 6743`, checks). When the
thread reports done, verify: draft cleared, exact-head required checks green, an independent sol review
APPROVE bound to the exact head (run one if the thread did not), clean merge-tree against dev (if #6370
landed first, rerun spend and oauth focused tests on the merged tree), then squash merge with
`--match-head-commit`. If the thread stops with a blocker or NEEDS_HUMAN, record it and do not merge.

Acceptance: merge SHA, CI run id and reviewer verdict recorded, or the blocker recorded.
