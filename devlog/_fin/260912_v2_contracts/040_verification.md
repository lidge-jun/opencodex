# Final hosted verification and handoff

Consumes published implementation heads. No product change is planned unless exact hosted failure or independent audit identifies a defect; then amend this design with the concrete source delta before repair.

MODIFY this unit's cycle records with actual outcomes. MODIFY ignored `.tmp/v2/handoff.md` and NEW ignored `.tmp/v2/final-ci.json` with own branch/worktree/session, original dispositions, credit, carry PR URLs, exact heads, chain order if any, remaining issue acceptance, unresolved review/security judgments and local NOT RUN.

Commands: `git diff --check` observes whitespace only. `gh pr view` observes live head/base/reviews. `gh run list --commit <sha>` finds hosted runs; `gh run view <id> --json headSha,status,conclusion,jobs,url` provides final evidence. Inspect `.github/workflows/ci.yml` or actual workflow source for full lane dispatch. Do not claim skipped/cancelled jobs passed. CI failure repairs are additional PABCD cycles when they form a separate work-phase.

Before publish, inspect exact diff and original contributor commits; push only owned branches using `git push --no-verify`. Populate Summary/Verification/Checklist template honestly with NOT RUN local tests. No closure or merge. Capture remote PR head equality with local final SHA and final Cross-platform CI result. A source scan or receipt wrapper is not product test evidence. Independent review has a source SHA and limitations. Any live upstream canary absent remains explicit.

Integration refresh: fetched dev81f0c78d7a after parent integrated other lanes. Read-only merge-tree previews identified only shared structure-document EOF additions as conflicts; source hunks combined without conflict. Move this lane's added paragraphs to separate existing section boundaries while preserving their bytes, then verify clean merge-tree previews for both independent PRs. No branch merge, rebase or force push is needed. Joint runtime composition remains the integration owner's verification duty.
