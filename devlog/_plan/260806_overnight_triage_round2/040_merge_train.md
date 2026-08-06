# 040 — Merge train: seven PRs into dev, one at a time

User authorization (2026-08-06): merge the stack, first stack pair onward,
with terra verification per step.

## Order

| Step | PR | Head | Note |
|------|----|------|------|
| 1 | #1069 | codex/1057-deepseek-effort-ladder | stack parent |
| 2 | #1070 | codex/1043-zen-text-only | retarget to dev after 1, adjacent registry edits |
| 3 | #1071 | codex/1061-native-profile-harness | independent |
| 4 | #1072 | codex/1046-startup-stale-app-server | independent |
| 5 | #1088 | codex/1065-bounded-body-first-byte | independent |
| 6 | #1089 | codex/shadow-call-drop-54mini | independent |
| 7 | #1087 | codex/1075-shadow-call-namespaced | CONFLICTING vs dev — resolve first |

Merge method: repo history shows maintainer merge commits ("Merge pull
request #NNNN") — use `gh pr merge --merge --match-head-commit <sha>`.
PRs target dev, so linked issues do not auto-close: close #1057, #1043,
#1061, #1046, #1065, #1075 manually with the merge SHA.

#1087's conflict is expected to be against #1089's shadow-call edits (both
touch shadow-call surfaces) or the RI-10 dashboard refactor; diagnose at
step 7, merge dev into the branch, resolve, push --no-verify, re-verify CI.

## Ledger (filled as the train runs)

| Step | Merge SHA | Issue closed | Verified |
|------|-----------|--------------|----------|
| 1 #1069 | `cdb963e67` (pinned 45ac9ebf8) | #1057 | terra pre-verify SAFE; merge-tree clean over 55-commit gap |
| 2 #1070 | `0803642fe` (pinned a6f3b2fc2) | #1043 | retargeted to dev, checks re-ran green (ci/gates pass) |
| 3 #1071 | `ac1aa3373` (pinned ee7657862) | #1061 | terra batch verify; sequential sim clean |
| 4 #1072 | `2a0cdfcb7` (pinned 254db138c) | #1046 | same batch |
| 5 #1088 | `4db2eb3f3` (pinned c96abb78a) | #1065 | core.ts overlap with #1089 proven non-colliding |
| 6 #1089 | `302715390` (pinned 61388e356) | — (user request, no issue) | same batch |
| 7 #1087 | `bfbc9a405` (pinned d53253b39) | #1075 (#1078 dup closed earlier) | conflict vs dev `formatNamespacedModelId` resolved: canonical value + dev label formatting; gui 610 pass local; CI 23 pass |

The #1087 conflict was the RI-10/#1074 era label change on dev
(`label: formatNamespacedModelId(...)`) colliding with our options rewrite.
Resolution composes both: `shadowCallModelOptions` supplies canonical
values, the label maps through `formatNamespacedModelId`, the empty
option is untouched. Merge commit on branch: `d53253b39`.

## Post-train verification

Terra verifier: all seven merge SHAs are ancestors of dev tip
`bfbc9a405`; all PRs MERGED; issues #1057/#1043/#1061/#1046/#1065/#1075
/#1078 CLOSED; throwaway-worktree health at the tip — typecheck clean,
core focused suites 40 pass, gui focused suites 14 pass; no open PR
overlaps the merged surfaces.

Dev CI on the #1087 merge tip (run 31061634811) first failed on a Bun
1.3.14 segfault in `test 2/4` — `panic: Segmentation fault at
0xFFFFFFFFFFFFFFF8` after the shard completed its last listed test, with
a bun.report crash link and exit 132. That is a runtime crash, not a
test failure attributable to the merged diffs. `gh run rerun --failed`
brought the run to `completed success`.

Terminal outcome: DONE.

## Post-train verification (terra + live rerun)

- All seven merge SHAs are ancestors of `origin/dev` tip `bfbc9a405`;
  all seven PRs read MERGED; issues #1057/#1043/#1061/#1046/#1065/#1075/#1078
  all CLOSED (terra verifier, live gh reads).
- Throwaway-worktree health at the tip: typecheck clean, core focused
  suites 40 pass, gui focused suites 14 pass.
- No open PR overlaps the touched surfaces (registry, core.ts, gui
  dashboards) — no rebase debt created.
- Post-merge dev CI: the #1087 run first FAILED on `test 2/4` with a Bun
  1.3.14 segfault ("panic: Segmentation fault… This indicates a bug in
  Bun, not your code", exit 132) after 64s of passing tests — a runner
  crash, not a test failure. Rerun of failed jobs completed SUCCESS
  (run 31061634811). Not attributable to any PR in this train.

Terminal outcome: DONE.
