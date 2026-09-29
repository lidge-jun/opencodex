# 011 wp2 execution: regression gate and merge

| Step | Evidence |
|---|---|
| Final copy | #6240 took TokenLab's final blurbs and referral link at `2b9295fea6` (030 findings); the `lane=all` run on `21cddd35c9` was cancelled |
| PR-event CI on `2b9295fea6` | Cross-platform CI 36591071773, Service lifecycle 36591071699, React Doctor 36591071756: success; 32 pass, 5 path-skipped |
| Full-lane gate | Cross-platform CI `lane=all` 36591083341: attempt 1 failed windows 7/9 (`cli-connect-readiness` installed-root probe, exit null at 18 s) and windows 8/9 (`main quota policy at native admission`, 32 s cases); neither loads a changed module (`init`, `provider-runtime` are lazy CLI imports). One rerun (attempt 2): both shards and `ci` success |
| Review | Codex P2 and CodeRabbit sponsor-first-run fixed; CodeRabbit wording suggestion declined (verbatim sponsor copy, adapter chip visible, Responses-first pending) |
| Policy | `assert-mergeable-review.sh --maintainer-integration 6240`: OK; decision comment 5894282491 |
| Merge | `gh pr merge 6240 --admin --squash --match-head-commit 2b9295fea6` → dev `1cd9d25517` = C; `package.json` 2.72.0, version-sources check 2.72.0 passes |
| Pre-move | #6243 (four version sources 2.72.0 → 2.73.0), `maintainer-sponsored` after review, merged → dev `73289d46ae` (2.73.0) |

Local regression scope: focused sponsor/registry/README/GUI suites and `test:changed`; a full local run
is not possible from a worktree under `~/.codex` (test home guard), so CI above is the full-suite proof.
