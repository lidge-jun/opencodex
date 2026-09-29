# 020 — Release 2.72.0 (wp3)

Same procedure as `devlog/_fin/260929_release_2_71_0/041_wp4_execution.md`, with C = the #6240
squash commit from 010 (never a later `dev` tip, which would carry 2.73.0).

1. Pre-move: `gh workflow run dev-version-bump.yml -R lidge-jun/opencodex --ref main
   -f intended-version=2.72.0 -f mode=pre-move` → PR moving exactly the four version sources to
   2.73.0; merge `--admin --squash --match-head-commit` after its CI.
2. Preview: branch `codex/promote-preview-2.72.0` from C, `git merge -s ours origin/preview`,
   `bun scripts/release-version-sources.ts sync 2.72.0-preview.20260930`, commit; diff vs C must be
   exactly the four version sources, and `bun scripts/release-version-sources.ts` check mode passes.
   PR to preview with the #6240 pr-assets screenshots, `gh pr merge --admin --merge --match-head-commit`.
3. Main: branch `codex/promote-main-2.72.0` from C, `git merge -s ours origin/main`, tree equals C.
   (`git diff --quiet C HEAD`). PR to main with the screenshots, merged the same way. enforce-target
   flags promotion PRs as wrong base by design; it is not required on preview/main.
4. Gate each promotion SHA: push-event Cross-platform CI and Service lifecycle `success`.
5. Dispatch preview then stable:
   `gh workflow run release.yml --ref preview -f version=2.72.0-preview.20260930 -f tag=preview
   -f dry-run=false -f expected-sha=<preview sha>`, then `--ref main -f version=2.72.0 -f tag=latest
   -f dry-run=false -f expected-sha=<main sha>`. After an npm-acknowledged failure, resume with
   `-f resume-after-npm-publish=true`; never republish.
6. Verify dist-tags, `npm view @bitkyc08/opencodex@2.72.0 gitHead` = main sha, `gh release view v2.72.0`
   (not prerelease, 25 assets as v2.71.0), preview release prerelease, latest.json 2.72.0 signed.

The installed proxy/app on this machine is not updated (same as 2.70.0/2.71.0).
