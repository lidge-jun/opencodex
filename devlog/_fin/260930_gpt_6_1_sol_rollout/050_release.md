# 050 Release (wp4)

1. Isolated verification in a /private/tmp checkout of the exact head with fresh OPENCODEX_HOME / CODEX_HOME: typecheck, focused tests, test:changed, structure:check, privacy:scan, skill:surface:check, file-size ratchet.
2. One PR to dev from codex/gpt-6-1-sol-rollout with the template; wait for exact-head required CI; maintainer merge under MAINTAINERS.md dev policy.
3. Release train per scripts/release.ts and the 2.70.0 precedent: dev version pre-move PR, preview promotion PR, main promotion PR; push-event Cross-platform CI + Service lifecycle green on each promotion SHA; release.yml dispatched with expected-sha for preview then stable.
4. Verify GitHub release assets, npm `latest` / `preview` dist-tags, latest.json.
5. Close the unit: move to devlog/_fin with an outcome doc.

## 2.73.0 concrete steps (revalidated at wp4 P, 2026-09-30)

Scope, on the owner's request to bundle the RT6 stabilization chat: 2.73.0 ships everything on `dev`
since v2.72.0 — the RT6 train (13 PRs through #6203, recorded in `devlog/_plan/260930_release_train_6/`
by that chat), #6261 (`540af24384`, Windows keyring test portability), and this PR. That chat was asked
not to run the release train itself. `dev` already reads 2.73.0 (#6243).

1. PR from `codex/gpt-6-1-sol-rollout` (rebased on `540af24384`). Exact-head PR CI plus a
   `lane=all` Cross-platform CI dispatch on the head (the pull_request event skips windows 1-9).
   Before merge, an explicit read-only security review of the TokenLab wire change
   (MAINTAINERS.md: credential handling): where the API key is sent, which header, endpoint binding
   of the Claude pin, no new logging; verdict recorded on the PR.
   `scripts/ci/assert-mergeable-review.sh --maintainer-integration <pr>`, decision comment,
   `gh pr merge --admin --squash --match-head-commit <head>` -> C. Assert `git show C:package.json` = 2.73.0.
2. Pre-move: `gh workflow run dev-version-bump.yml --ref main -f intended-version=2.73.0 -f mode=pre-move`;
   merge its PR after CI -> dev 2.74.0.
3. Preview: branch `codex/promote-preview-2.73.0` from C, `git merge -s ours origin/preview`,
   `bun scripts/release-version-sources.ts sync 2.73.0-preview.20260930`; diff vs C = four version sources.
   PR to preview, `--admin --merge --match-head-commit` after its PR checks. The maintainer-integration
   exception covers only `dev`; promotion merges run on the owner's explicit release authorization
   for this unit (2026-09-30, "exec and release" / "배포해줘"), as 2.70.0-2.72.0 did, and each promotion
   PR records that authorization.
4. Main: branch `codex/promote-main-2.73.0` from C, `git merge -s ours origin/main`, `git diff --quiet C HEAD`.
   PR to main, same merge.
5. Push-event Cross-platform CI + Service lifecycle success on each promotion SHA.
6. `gh workflow run release.yml --ref preview -f version=2.73.0-preview.20260930 -f tag=preview -f dry-run=false -f expected-sha=<preview>`,
   then `gh workflow run release.yml --ref main -f version=2.73.0 -f tag=latest -f dry-run=false -f expected-sha=<main>`
   (release.yml defaults to a dry run and rejects other refs). Never republish; resume with
   `resume-after-npm-publish=true` after an npm-acknowledged failure.
7. Verify npm dist-tags, gitHead, GitHub releases (stable not prerelease, asset count as v2.72.0), latest.json.
8. Record PR moving this unit to `devlog/_fin/`.
