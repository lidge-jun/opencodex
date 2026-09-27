# 040 — Publication and outcome plan

This document begins as the executable final phase design. At Done it becomes the receipt for this lane. The report to land on `dev` is `000_plan.md`, `010_issue_actions.md`, `020_pr_actions.md`, `030_standalone_carry.md`, and this document, all within `devlog/_plan/260927_release_train_4/issue-triage/`. No other lane's devlog path changes.

## External write map

- For the five issue status changes named in `010_issue_actions.md`, post English source-linked comments on #5745, #5493, #4198, #4173 and #2834; read back the comment URL and current issue state. The other seven issues remain open with the recorded reason. No close is planned absent later proof.
- For each of the 21 PRs in `020_pr_actions.md`, post a concrete English release decision to that PR only after confirming its head has not moved. Read back each comment URL. Keep the feature PR open; #6079 remains open after the narrow helper carry.
- If the helper carry clears its checks, create a `dev`-targeting PR with Summary, Verification and Checklist; attribute `luvs01`, link #6079, and merge only after exact-head required CI and the fresh-`dev` union check. Read back the merge SHA and `dev` CI run. If no helper carry is safe, explain why it stayed open.
- Publish the decision report by a `dev` PR after comments and carry outcome have been recorded. The docs PR needs `git diff --cached --check` before commit and `git diff --check origin/dev...HEAD` after commit, `bun run privacy:scan`, a complete PR template, exact-head required CI and post-merge `dev` confirmation.

## Evidence slots to fill from readback

At finalization, replace this section with a table of exact issue comment URLs, PR comment URLs, any closed issues/PRs and their evidence, carry PR/head/merge SHA, docs PR/head/merge SHA, exact-head CI run URLs and conclusions, post-merge `dev` CI, and the remaining risks. Never mark an unrun suite passed. If an item head changes, refresh its decision and comment before finalizing.

## Final reconciliation checks

1. Compare `gh issue list --limit 300 --json number` with the exclusion set in `000_plan.md`; every owned open issue must appear in `010_issue_actions.md` or be newly appended with a decision.
2. Compare `gh pr list --limit 300 --json number,headRefOid` with the 21 requested PR IDs, then check `020_pr_actions.md` and the posted comment receipts; all must be present exactly once.
3. Confirm no `gui/` asset or screenshot entered the branch, no version/tag changed, no other lane worktree or excluded item was modified, and the carry PR contains only the isolated standalone helper, regression and owning structure files, while the separate final docs PR has no non-devlog delta.
4. Run privacy and structure gates on the final report, then confirm required CI on the actual head after push and on `dev` after merge.

## wp1 issue comment receipts

All five comments were posted once from the reviewed English drafts while remote `dev` was `24b2f39b77a2`, with open-state and latest-comment checks before the write and exact body readback afterward. No owned issue was closed; all 12 retain unmet acceptance.

| Issue | Comment |
|---|---|
| #5745 | [status and next step](https://github.com/lidge-jun/opencodex/issues/5745#issuecomment-5856932574) |
| #5493 | [status and next step](https://github.com/lidge-jun/opencodex/issues/5493#issuecomment-5856933033) |
| #4198 | [status and next step](https://github.com/lidge-jun/opencodex/issues/4198#issuecomment-5856933529) |
| #4173 | [status and next step](https://github.com/lidge-jun/opencodex/issues/4173#issuecomment-5856934021) |
| #2834 | [status and next step](https://github.com/lidge-jun/opencodex/issues/2834#issuecomment-5856934492) |

## wp2 PR comment receipts

At posting, remote `dev` remained `24b2f39b`; each of the 21 PRs retained its audited full head and `dev` base. The poster checked review/draft state and latest comment ID/update time, posted the English item-specific decision once, and read its body and URL back. No original PR was closed. #6079 will receive the focused carry PR URL by editing its same comment in wp3.

| PR | Decision comment |
|---|---|
| #6079 | [release train 4 decision](https://github.com/lidge-jun/opencodex/pull/6079#issuecomment-5857047467) |
| #6077 | [release train 4 decision](https://github.com/lidge-jun/opencodex/pull/6077#issuecomment-5857048095) |
| #5955 | [release train 4 decision](https://github.com/lidge-jun/opencodex/pull/5955#issuecomment-5857048648) |
| #5947 | [release train 4 decision](https://github.com/lidge-jun/opencodex/pull/5947#issuecomment-5857049158) |
| #5800 | [release train 4 decision](https://github.com/lidge-jun/opencodex/pull/5800#issuecomment-5857049686) |
| #5782 | [release train 4 decision](https://github.com/lidge-jun/opencodex/pull/5782#issuecomment-5857050257) |
| #5631 | [release train 4 decision](https://github.com/lidge-jun/opencodex/pull/5631#issuecomment-5857050737) |
| #5424 | [release train 4 decision](https://github.com/lidge-jun/opencodex/pull/5424#issuecomment-5857051217) |
| #5374 | [release train 4 decision](https://github.com/lidge-jun/opencodex/pull/5374#issuecomment-5857051718) |
| #5253 | [release train 4 decision](https://github.com/lidge-jun/opencodex/pull/5253#issuecomment-5857052212) |
| #5912 | [release train 4 decision](https://github.com/lidge-jun/opencodex/pull/5912#issuecomment-5857052786) |
| #4647 | [release train 4 decision](https://github.com/lidge-jun/opencodex/pull/4647#issuecomment-5857053337) |
| #4259 | [release train 4 decision](https://github.com/lidge-jun/opencodex/pull/4259#issuecomment-5857053915) |
| #4228 | [release train 4 decision](https://github.com/lidge-jun/opencodex/pull/4228#issuecomment-5857054492) |
| #4222 | [release train 4 decision](https://github.com/lidge-jun/opencodex/pull/4222#issuecomment-5857054992) |
| #4177 | [release train 4 decision](https://github.com/lidge-jun/opencodex/pull/4177#issuecomment-5857055544) |
| #4056 | [release train 4 decision](https://github.com/lidge-jun/opencodex/pull/4056#issuecomment-5857056048) |
| #4022 | [release train 4 decision](https://github.com/lidge-jun/opencodex/pull/4022#issuecomment-5857056608) |
| #3742 | [release train 4 decision](https://github.com/lidge-jun/opencodex/pull/3742#issuecomment-5857057185) |
| #3463 | [release train 4 decision](https://github.com/lidge-jun/opencodex/pull/3463#issuecomment-5857057686) |
| #3025 | [release train 4 decision](https://github.com/lidge-jun/opencodex/pull/3025#issuecomment-5857058233) |
