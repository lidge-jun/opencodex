# Phase 4: Promote preview to latest

## Objective

Promote the verified `preview` head to `main`, publish stable version `2.7.1`
with the npm `latest` dist-tag, and preserve `2.7.1-preview.20260710` as the
published preview artifact.

## Preconditions

- `origin/main` is an ancestor of `origin/preview` (`0 14` divergence count).
- Preview head `308787a4` passed Cross-platform CI and Service lifecycle.
- Preview release `v2.7.1-preview.20260710` is public and points to `308787a4`.
- npm version `2.7.1` and GitHub release `v2.7.1` do not exist.

## Build

1. Fast-forward local `main` from `origin/main` to `preview`.
2. Change `package.json` version from `2.7.1-preview.20260710` to `2.7.1`.
3. Commit the stable version and push `main`.

## Check

- Run the local typecheck, full test suite, privacy scan, GUI build, and diff check.
- Require successful Cross-platform CI for the exact stable commit.
- Run and require Service lifecycle for the exact stable commit because
  `package.json` changed since the prior stable tag.

## Deploy

- Dispatch `release.yml` from `main` with version `2.7.1`, tag `latest`, and
  `dry-run=false`.
- Verify npm version/dist-tags, Git tag, GitHub Release metadata, and clean git state.

## Rollback

Do not move or overwrite published tags. If any gate fails, stop before release,
fix forward on `main`, and rerun the exact-commit gates.
