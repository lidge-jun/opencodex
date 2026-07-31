# Dev -> Preview -> Main Release Plan

## Context

- `dev` is the cleaned non-Cursor stack: `origin/main...origin/dev = 0 30`.
- `cursor-provider-stack` is isolated on top of `dev`: `origin/dev...origin/cursor-provider-stack = 0 58`.
- `dev-with-cursor-backup` preserves the original mixed history and must not be rebased or deleted.
- The repository release workflow publishes only from `main` or `preview`, and requires successful Cross-platform CI for the exact release commit.

## Goal

Promote the cleaned `dev` stack safely:

1. Verify `dev` is locally mergeable to `main`.
2. Publish/update `preview` from `dev` for pre-merge CI/release preflight.
3. If checks pass, merge `dev` into `main`.
4. Run and monitor the relevant GitHub Actions deployment workflows.

## Plan

### Phase 1: Local mergeability and verification

- Check branch graph:
  - `git rev-list --left-right --count origin/main...origin/dev`
  - `git merge-base --is-ancestor origin/main origin/dev`
  - `git rev-list --left-right --count origin/dev...origin/cursor-provider-stack`
- Create or reset a local preview branch from `origin/dev`.
- Run:
  - `bun install --frozen-lockfile`
  - `bun x tsc --noEmit`
  - `bun test tests`
  - `bun run privacy:scan`
  - `bun build scripts/release.ts --target=bun --outdir=.tmp/ci-release-script-check`
  - `cd gui && bun install && bun run build`
  - `bun run src/cli.ts help`

### Phase 2: Remote preview

- Update local `preview` from `origin/dev`.
- Push local `preview` to `origin/preview`. Use `--force-with-lease` only if the remote
  branch is not a fast-forward; current topology shows `origin/preview` is an ancestor of
  `origin/dev`, so a normal push should be enough.
- Monitor GitHub Cross-platform CI for `preview`.
- Monitor Service lifecycle if it is triggered by the push.
- Do not dispatch the Release workflow from `preview` unless `package.json` is first bumped
  on the preview branch to an unused `*-preview.*` version. The workflow enforces
  `package.json == inputs.version` even for dry-runs, so the current `2.5.5` cannot satisfy
  the preview release gate.

### Phase 3: Main promotion

- Merge `dev` into `main` with a fast-forward or normal merge commit if possible.
- Push `main`.
- Monitor Cross-platform CI on `main`.
- Monitor Service lifecycle if it is triggered by the push.
- Monitor docs deploy; `origin/main..origin/dev` includes `docs-site/**`, so GitHub Pages
  deploy should auto-trigger on the main push.
- Do not dispatch the Release workflow from `main` without a version bump. `v2.5.5` already
  exists at the old main commit, and the workflow rejects a dry-run when the requested tag
  exists at a different commit. A real or dry-run package release requires a new stable
  version commit such as `2.5.6`.

## Constraints

- Do not modify or delete `dev-with-cursor-backup`.
- Do not apply `stash@{0}` during release promotion; it contains Cursor tool-call WIP.
- Use `--force-with-lease` for `preview` only if non-fast-forward is required; prefer a
  normal push when the branch is fast-forwardable.
- Use a normal push for `main`; no force push to `main`.
- Do not run release workflow with `2.5.5` after main moves; both dry-run and real publish
  need a version bump.

## Evidence to collect

- Local branch counts and merge-base checks.
- Local test/build command output.
- GitHub Actions run URLs and conclusions.
- Final branch status:
  - `origin/main` commit
  - `origin/dev` commit
  - `origin/preview` commit
  - `origin/cursor-provider-stack` still based on `origin/dev`
