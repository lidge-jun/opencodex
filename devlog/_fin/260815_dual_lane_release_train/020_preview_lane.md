# 020 — preview lane: dev to preview, npm preview 2.19.0-preview.20260815

Work-phase wp3. Runs after wp2 so the preview train never publishes content the
stable lane has not already accepted, and so `release.yml` concurrency
(group `release`, `cancel-in-progress: false`) does not queue two publishes.

## Diff-level steps

1. Work in a worktree holding `preview`.
   `/Users/jun/.codex/worktrees/260728-preview/opencodex` already has
   `preview` checked out at `6a8c74965`, which is stale relative to
   `origin/preview` (`a0f5897d4`). Confirm ownership before touching it; if in
   doubt, use a fresh worktree instead of resetting someone else's.
2. `git reset --hard origin/preview`, then
   `git merge --no-ff origin/dev -m "Merge dev into preview: v2.19.0 train"`.
   Also merge `origin/main` so the preview line carries the stable release
   commit, following the precedent
   `6a8c74965 Merge main into preview: v2.14.2 release (preview keeps its
   prerelease version)`. On any `package.json` conflict, keep the preview
   prerelease version; step 4 sets the final value.
3. `bun install` and `cd gui && bun install`.
4. `bun scripts/release.ts 2.19.0-preview.20260815 --publish`. The helper
   derives dist-tag `preview` from the branch and rejects a non-prerelease
   version on `preview`.

## Guard rails

- `release.yml` rejects a `preview` dispatch whose version lacks `-preview.`
  and any dist-tag other than `preview`.
- The preview changelog baseline is lineage-relative: the newest prior release
  of either channel reachable from HEAD. Merging `main` first keeps that
  baseline at `v2.19.0` so the preview notes do not restate the stable range.

## Exit criteria

- `git merge-base --is-ancestor 81ada7cd0 origin/preview` exits 0
- `release.yml` run on `preview` concluded success with its `expected-sha`
- `npm view @bitkyc08/opencodex dist-tags --json` shows
  `preview: 2.19.0-preview.20260815`
