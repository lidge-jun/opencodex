# 070 — Cycle 7: final gate

1. Confirm final dev head CI fully green (gh run list --branch dev; the ci aggregate job).
1b. Docs-sync check: after 2295 (en-only doctor docs) + 2289 (8-locale lifecycle) both land, confirm locale lifecycle pages do not contradict the English page (AGENTS.md docs-sync rule).
2. If macos/windows shard flakes, rerun; if real regression from the train, fix forward on dev.
3. Close remaining linked issues with landing-commit comments (#2287, #2291, #2046 decision).
4. Move devlog unit to _fin with terminal outcomes recorded per PR.
5. Goalplan criteria capturedEvidence filled; cxc loop validate green; update_goal complete.
