# 040 — Publication and outcome plan

This document begins as the executable final phase design. At Done it becomes the receipt for this lane. The report to land on `dev` is `000_plan.md`, `010_issue_actions.md`, `020_pr_actions.md`, `030_standalone_carry.md`, and this document, all within `devlog/_fin/260927_release_train_4/issue-triage/`. No other lane's devlog path changes.

## External write map

- For the five issue status changes named in `010_issue_actions.md`, post English source-linked comments on #5745, #5493, #4198, #4173 and #2834; read back the comment URL and current issue state. The other seven issues remain open with the recorded reason. No close is planned absent later proof.
- For each of the 21 PRs in `020_pr_actions.md`, post a concrete English release decision to that PR only after confirming its head has not moved. Read back each comment URL. Keep the feature PR open; #6079 remains open after the narrow helper carry.
- If the helper carry clears its checks, create a `dev`-targeting PR with Summary, Verification and Checklist; attribute `luvs01`, link #6079, and merge only after exact-head required CI and the fresh-`dev` union check. Read back the merge SHA and `dev` CI run. If no helper carry is safe, explain why it stayed open.
- Publish the decision report by a `dev` PR after comments and carry outcome have been recorded. The docs PR needs `git diff --cached --check` before commit and `git diff --check origin/dev...HEAD` after commit, `bun run privacy:scan`, a complete PR template, exact-head required CI and post-merge `dev` confirmation.

## Evidence slots to fill from readback

The filled receipts are under **Final outcome** at the end of this document. The original instruction was to add a table of exact issue comment URLs, PR comment URLs, any closed issues/PRs and their evidence, carry PR/head/merge SHA, docs PR/head/merge SHA, exact-head CI run URLs and conclusions, post-merge `dev` CI, and the remaining risks. Never mark an unrun suite passed. If an item head changes, refresh its decision and comment before finalizing.

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

## wp3 resume plan (receiving thread, 2026-09-28 KST)

The previous thread stopped in wp3 Build with the carry commit `08271bdf` unpushed and `test:changed` interrupted. This thread resumes from that state. Fresh `origin/dev` is still `24b2f39b`, so no carry rebase is needed yet, and #6079 is still at `9068502a`.

Inventory recheck found one owned issue created after the audit: [#6093](https://github.com/lidge-jun/opencodex/issues/6093) asks the provider pacing panel to expose `requestPacing.maxConcurrentRequests`, whose backend landed in #5954. Its author opened [#6094](https://github.com/lidge-jun/opencodex/pull/6094) with the GUI change. Decision: review #6094 on its merits for this release; if it is correct and the exact-head product CI can be run, land it and close #6093 after the change is on `dev`; otherwise leave a specific English review on #6094 and a status comment on #6093.

Ordered steps:

1. Carry PR. Confirm the verify checkout HEAD equals `08271bdf`, rerun `bun run test:changed` there, push `codex/t4-issue-triage-standalone`, open a `dev` PR with the full template and the `luvs01` co-author trailer, and dispatch `ci.yml` with `lane=all` on the branch because the nine Windows shards run only on `workflow_dispatch`; record that run's head and result separately from the PR-event checks. Merge only on exact-head success with reviewer findings resolved. Then edit the existing #6079 decision comment with the carry PR link and thanks, keeping #6079 open. A compiled macOS probe already showed `import.meta.url` = `file:///$bunfs/root/probe` and the new helper returning true; Windows compiled proof stays with CI and the contributor.
2. #6094 review by a Sol reviewer in `/private/tmp/t4-issue-triage-6094` (diff against backend contract, locale completeness, file-size ratchet, test layout, screenshot, gates). Act on the verdict as above; pushing to a contributor fork is not allowed, so a small blocker is fixed only by a maintainer carry PR with a co-author trailer.
3. Sol re-verification of the prior 12 issue and 21 PR decisions, which another model produced. Any DISAGREE is reconciled here with a recorded reason before the docs PR; #5782 and #5800 are rechecked for a narrow, low-risk bug slice.
4. Docs PR. Rebase this audit branch on the post-merge `dev`, fill the evidence table (carry PR/head/merge SHA/CI, #6079 comment edit, #6093/#6094 outcome, re-verification result), run `privacy:scan`, `structure:check` and diff checks, then open, CI-verify and merge a devlog-only PR and confirm `dev` CI after merge.

## Final outcome (2026-09-28 KST)

The lane is done. Two focused bug fixes landed on `dev` with contributor credit; no issue met the full-resolution bar for closing; every large feature PR stays open with a posted decision.

| Item | Result | Evidence |
|---|---|---|
| [#6098](https://github.com/lidge-jun/opencodex/pull/6098) standalone URL carry from #6079 | Merged, squash `ef4e9940`, `Co-authored-by: luvs01` | Head `c72b88ca`. PR-event product CI passed on every pushed head; Windows shards (`lane=all` dispatch) passed on the same diff at `9366801b` ([run 36333848482](https://github.com/lidge-jun/opencodex/actions/runs/36333848482)). The first dispatch had one Windows temp-dir `EPERM` cleanup flake in `server-management-auth.test.ts`. Local union tree with `dev` `3401e1ee`: focused 5 pass, typecheck, layout/ratchet 27 pass, structure, privacy exit 0. `test:changed` at `08271bdf`: 26181 pass / 20 fail; 16 of those pass in isolation, the other 4 fail identically on unchanged `dev` (machine-load timeouts). Compiled macOS probe: `file:///$bunfs/root/probe` → standalone. CodeRabbit and Codex: no findings. |
| [#6100](https://github.com/lidge-jun/opencodex/pull/6100) service-home refusal log from #5782 | Merged, squash `7b83dede`, `Co-authored-by: tcflying` | Head `75f863c6`. Red-then-green regression; path-free log line (raw admission message can contain private paths). Sol review NEAR-PASS; its stale `structure/config.md` finding was fixed (file at its 600-line budget). Local union tree with `dev` `3401e1ee`: focused 30 pass, typecheck, layout/ratchet 27 pass, structure, privacy exit 0. `test:changed` not completed: stopped externally while waiting on another lane's test lock. Codex review: no findings. |
| #6079 / #5782 originals | Kept open | Existing decision comments edited with carry links and thanks: [#6079](https://github.com/lidge-jun/opencodex/pull/6079#issuecomment-5857047467), [#5782](https://github.com/lidge-jun/opencodex/pull/5782#issuecomment-5857050257). |
| [#6094](https://github.com/lidge-jun/opencodex/pull/6094) for #6093 | Reviewed, awaiting maintainer merge | Fork CI approved and passed at `edb17c73`; [review comment](https://github.com/lidge-jun/opencodex/pull/6094#issuecomment-5857585625). Contributor-PR merges are outside this lane's authority. |
| 15 owned open issues | 0 closed | 12 audited plus #6093, #6118, #6122; all have unmet acceptance. Sol re-verification agreed with all 12 original decisions. |
| 21 large PRs | 0 merged as-is, 0 closed | Sol re-verification agreed with 20; the #5782 disagreement produced #6100. |

Per the coordinator's closing rule, per-PR Cross-platform CI was not awaited after the last rebase; the coordinator runs it once on the final `dev`. Remaining risks: no compiled Windows binary was run, so the Windows `%7EBUN` URL shape is proven only by unit cases and CI shards; `structure/config.md` sits exactly at its 600-line budget, so the next edit there must move text out.
