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
3. Confirm no `gui/` asset or screenshot entered the branch, no version/tag changed, no other lane worktree or excluded item was modified, and the only non-devlog code delta is the isolated standalone fix and its owning doc/test.
4. Run privacy and structure gates on the final report, then confirm required CI on the actual head after push and on `dev` after merge.
