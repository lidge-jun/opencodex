# Release 2.69.0

Candidate: `870f39e75e` (dev after release train 4). Final Cross-platform CI run 36348371944 on this exact SHA passed (privacy gate skipped by its path condition). Version sources on the candidate read 2.69.0.

## Steps

1. Pre-move `dev` past the release: dispatch `dev-version-bump.yml` with `intended-version=2.69.0` from the default branch, verify the opened PR only changes version sources to 2.70.0, merge it through the maintainer dev integration path.
2. Preview: branch from the candidate, `git merge -s ours origin/preview`, run `bun scripts/release-version-sources.ts sync 2.69.0-preview.20260928`, check, open PR to `preview`, merge with a merge commit. Dispatch `release.yml` on `preview` with `version=2.69.0-preview.20260928`, `tag=preview`, `dry-run=false`, `expected-sha=<preview head>`.
3. Stable: branch from the candidate, `git merge -s ours origin/main`, check version sources for 2.69.0 (tree equals the candidate), open PR to `main`, merge with a merge commit. Dispatch `release.yml` on `main` with `version=2.69.0`, `tag=latest`, `dry-run=false`, `expected-sha=<main head>`.
4. Verify npm `latest=2.69.0` and `preview=2.69.0-preview.20260928`, both GitHub releases with the full asset set and correct prerelease flags, and `latest.json` reporting 2.69.0 with five platform signatures.
5. Land this record with the outcome on `dev`.

## Guards

Before each release dispatch, the merged promotion SHA itself must carry a successful push-event Cross-platform CI run and a successful Service lifecycle run (release.yml gates on both; the candidate's workflow_dispatch run 36348371944 does not satisfy them). Verify the preview merge tree differs from `870f39e75e` only in the four version sources, and the main merge tree equals it, then use each verified merge SHA as `expected-sha`.

Do not weaken release preflight, exact-SHA, or CI gates. If a release run fails, read the failing job, fix through a PR to `dev` and re-promote, or use the workflow's documented resume input only when npm publication was acknowledged for the same commit.
