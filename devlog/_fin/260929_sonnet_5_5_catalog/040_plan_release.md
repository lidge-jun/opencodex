# 040 Plan (wp3): release 2.70.0

Candidate: `c34c4d20db` (dev after #6210, Sonnet 5.5). Version sources on the candidate read 2.70.0.
Cross-platform CI on the candidate: run 36474965294 (workflow_dispatch). Same procedure as
`devlog/_fin/260928_release_2_69_0/000_plan.md`; the user asked to deploy on 2026-09-29.

1. Pre-move `dev`: dispatch `dev-version-bump.yml` from `main` with `intended-version=2.70.0`; the
   opened PR must change only version sources to 2.71.0; merge it through the maintainer dev path.
2. Preview: branch from the candidate, `git merge -s ours origin/preview`,
   `bun scripts/release-version-sources.ts sync 2.70.0-preview.20260929`, PR to `preview`, merge
   commit. Dispatch `release.yml` on `preview` with `version=2.70.0-preview.20260929`, `tag=preview`,
   `dry-run=false`, `expected-sha=<preview head>`.
3. Stable: branch from the candidate, `git merge -s ours origin/main` (tree equals the candidate),
   PR to `main`, merge commit. Dispatch `release.yml` on `main` with `version=2.70.0`, `tag=latest`,
   `dry-run=false`, `expected-sha=<main head>`.
4. Verify npm `latest=2.70.0` and `preview=2.70.0-preview.20260929`, both GitHub releases with the
   full asset set and prerelease flags, and `latest.json` at 2.70.0 with five signed platforms.
5. Land the outcome on `dev`.

Guards: each promotion SHA needs a successful push-event Cross-platform CI and Service lifecycle run
before its release dispatch (release.yml gates on both). Verify the preview tree differs from the
candidate only in the four version sources and the main tree equals the candidate. Do not weaken
release preflight, exact-SHA or CI gates; a failing run is fixed through `dev` and re-promoted.

If a release run fails after npm publication was acknowledged, re-dispatch with the same version and
expected-sha plus `resume-after-npm-publish: true`; never republish.
