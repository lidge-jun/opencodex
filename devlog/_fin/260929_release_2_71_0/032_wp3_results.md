# 032 wp3 results: landed on dev

| Step | Evidence |
|---|---|
| Screenshots | pr-assets 947e869c8b (`260929-release-2-71-0/request-pacing.png`, `cursor-installer.png`), fast-forward from ea1749154d |
| PR | #6224 `chore(release): integrate six reviewed PRs for 2.71.0`, head dcfbb2f708 |
| PR-event CI | Cross-platform CI 36525839698 success; Service lifecycle 36525839767 success; React Doctor 36525839694, PR hygiene, Enforce PR target branch success |
| Full-lane CI | Cross-platform CI workflow_dispatch 36526719414 (lane all) success: 39 jobs success, 1 skipped; includes windows 1/9-9/9 (the pull_request event skips the Windows matrix, ci.yml:835-839) and macos control |
| Head totals | 80 check-runs: 74 success, 6 skipped by design, 0 failed |
| Policy | `scripts/ci/assert-mergeable-review.sh --maintainer-integration 6224`: OK; decision recorded in PR comment 5884552184 |
| Merge | `gh pr merge 6224 --admin --merge --match-head-commit dcfbb2f708` -> dev d161c0e83e; all six land commits and four fixes are ancestors of dev |
| Source PRs | #6206 #6201 #6209 #6094 #5905 #6198 closed with a comment naming the land commit; issue #6208 closed with the #6209 commit |

Note: windows 8/9 passed in 36526719414, including the 32-profile transaction case that failed
the dev tip in 36499924172, now under BULK_DURABLE_IO_BUDGET_MS.

Candidate for 040: dev d161c0e83e (version sources 2.71.0).

