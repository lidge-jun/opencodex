# npm Release Plan: 2.5.6 latest and 2.5.7-preview.20260627 preview

## Context

- `origin/main`, `origin/dev`, and `origin/preview` currently point to `d3303bf`.
- `origin/cursor-provider-stack` remains based on `origin/dev` and is out of release scope.
- Current npm state:
  - `latest`: `2.5.5`
  - `preview`: `2.5.5-preview.2`
- The release workflow is manual (`workflow_dispatch`) and accepts only:
  - stable versions on `main` with `tag=latest`
  - `*-preview.*` versions on `preview` with `tag=preview`

## Goal

Publish:

1. `@bitkyc08/opencodex@2.5.6` from `main` with npm dist-tag `latest`.
2. `@bitkyc08/opencodex@2.5.7-preview.20260627` from `preview` with npm dist-tag `preview`.

If `2.5.7-preview.20260627` is already occupied, use the next unused suffix with the same base,
for example `2.5.7-preview.20260627.1`.

## Plan

### Phase 1: Main stable release

- On `main`, change `package.json` version from `2.5.5` to `2.5.6`.
- Run local release parity checks:
  - `bun install --frozen-lockfile`
  - `bun x tsc --noEmit`
  - `bun test tests`
  - `bun run privacy:scan`
  - `bun build scripts/release.ts --target=bun --outdir=.tmp/ci-release-script-check`
  - `cd gui && bun install && bun run build`
  - `bun run src/cli.ts help`
- Commit: `release: v2.5.6`.
- Push `main`.
- Monitor Cross-platform CI and Service lifecycle for the new `main` commit.
- Dispatch Release workflow on `main`:
  - `version=2.5.6`
  - `tag=latest`
  - `dry-run=false`
- Monitor release workflow to success.
- Verify npm registry:
  - `npm view @bitkyc08/opencodex@2.5.6 version`
  - `npm dist-tag ls @bitkyc08/opencodex`
- Verify GitHub release/tag `v2.5.6`.

### Phase 2: Preview prerelease

- Start from the post-2.5.6 `main` commit and update `preview` to the release base.
- Change `package.json` version from `2.5.6` to `2.5.7-preview.20260627`
  unless that version already exists on npm or as a tag.
- Run the same local release parity checks.
- Commit: `release: v2.5.7-preview.20260627`.
- Push `preview`.
- Monitor Cross-platform CI and Service lifecycle for the new `preview` commit.
- Dispatch Release workflow on `preview`:
  - `version=2.5.7-preview.20260627`
  - `tag=preview`
  - `dry-run=false`
- Monitor release workflow to success.
- Verify npm registry:
  - `npm view @bitkyc08/opencodex@2.5.7-preview.20260627 version`
  - `npm dist-tag ls @bitkyc08/opencodex`
- Verify GitHub release/tag `v2.5.7-preview.20260627`.

## Constraints

- Do not rewrite `main` or `preview`; use normal pushes.
- Do not modify `dev`, `cursor-provider-stack`, or `dev-with-cursor-backup`.
- Do not apply `stash@{0}`.
- If CI or release workflow fails, stop release progression, inspect logs, fix forward with a new commit, and rerun.
- Do not create an npm release with an occupied version.

## Expected final state

- `origin/main` points to a `release: v2.5.6` commit.
- `origin/preview` points to a `release: v2.5.7-preview.20260627` commit based on the stable release.
- npm `latest` points to `2.5.6`.
- npm `preview` points to `2.5.7-preview.20260627`.
- Cursor branches remain unchanged from their isolated state.
