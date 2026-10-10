# Phase 1 (wp2): overnight PRs

1. #6339 → #6341 is merged (6f2f6ae9cf). Close #6339 with credit (done).
2. #6342 (TokenLab guide link) is docs-only; merge after hygiene/enforce-target pass.
3. #6299: apply the translated buffering note to ja, ko, ru and zh-cn; carry in a maintainer PR with
   `Co-authored-by: foxytanuki` (the readiness gate re-drafts contributor PRs after a maintainer push).
4. #6278: install GUI deps in its worktree, run its GUI tests and typecheck, keep the reviewer's
   aria-describedby fix; carry with `Co-authored-by: colthreepv`. The GUI screenshot from the original
   PR is linked in the carry description.
5. #6336 and #6335: post the reviewer findings as a comment and leave open.
6. Each landing: local integration onto current `origin/dev`, `bun x tsc --noEmit` and the PR's test
   files, `assert-mergeable-review.sh --maintainer-integration`, integration comment, squash merge with
   `--match-head-commit`, then cancel any Cross-platform run the push triggered.
