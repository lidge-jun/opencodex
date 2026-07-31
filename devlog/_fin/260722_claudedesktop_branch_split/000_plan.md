# 000 — Claude Desktop branch split

- Date: 2026-07-22
- Work class: C4 (remote `dev` history rewrite)
- Objective: keep stable `dev` free of the immature Claude Desktop surface while preserving the complete Desktop work on a branch stacked directly on that `dev` baseline.

## Verified split points

- Current local/remote dev: `6da54a8965c24cdd31c4641ac3a864aad4968204`
- Desktop merge: `418d29b1a0e7ae4945648720bd1bda390caf12ba`
- Clean dev baseline (merge first parent): `79e5067a4058f6c7e44462dbb188707fa6df70d6`
- Desktop feature parent: `0c092de3ab54d78e87d0d84dad1c5826b1ef636c`

Current dev has only two commits after the Desktop merge; both are Desktop/i18n integration repairs:

- `ed2ed675` removes stray conflict-marker lines introduced by the Desktop branch.
- `6da54a89` adds Claude Desktop keys to ja/ru.

Therefore the clean non-Desktop dev is exactly `418d29b1^1 = 79e5067a`.

## Plan

Execution is a short write-freeze window: there is one local worktree, no other local `dev`
checkout, and no other agent may push `dev` until post-rewrite verification finishes. After the
rewrite, every stale checkout based on `6da54a89` must reset/rebase before its next push; otherwise
an ordinary fast-forward push could accidentally restore Desktop to `dev`.

1. Fetch/prune and fail unless all preconditions hold immediately before mutation: clean worktree;
   local `dev == origin/dev == 6da54a89`; local and remote `claudedesktop` absent; origin has only
   main/preview/dev.
2. Create local `claudedesktop` at current dev `6da54a89`.
3. Create the remote backup first with an absent-ref lease:
   `git push --force-with-lease=refs/heads/claudedesktop: origin refs/heads/claudedesktop:refs/heads/claudedesktop`.
   Verify remote `claudedesktop == 6da54a89`; abort without moving dev if this fails.
4. Move checked-out local `dev` to `79e5067a` only after rechecking the clean worktree.
5. Rewrite `origin/dev` with
   `--force-with-lease=refs/heads/dev:6da54a8965c24cdd31c4641ac3a864aad4968204`
   so concurrent remote movement aborts instead of being overwritten.
6. Verify:
   - `dev` equals `79e5067a` locally and remotely.
   - `claudedesktop` equals `6da54a89` locally and remotely.
   - `git merge-base --is-ancestor dev claudedesktop` succeeds.
   - `origin` contains exactly `main`, `preview`, `dev`, `claudedesktop` (plus `HEAD`).
   - `gui/src/pages/ClaudeDesktop.tsx` is absent on dev and present on claudedesktop.

## Boundaries

- No source edits.
- No main/preview movement.
- No release or npm publish.
- No other remote branches created or deleted.
- Rollback: fetch/prune; assert exact `origin/dev ==
  79e5067a4058f6c7e44462dbb188707fa6df70d6` and local `claudedesktop ==
  6da54a8965c24cdd31c4641ac3a864aad4968204`; then restore remote dev with
  `git push --force-with-lease=refs/heads/dev:79e5067a4058f6c7e44462dbb188707fa6df70d6
  origin refs/heads/claudedesktop:refs/heads/dev`. Verify remote dev equals `6da54a89`; assert a
  completely clean local worktree; only then reset local dev to the exact `6da54a89` SHA. Keep
  `claudedesktop` as the backup unless the user separately authorizes its deletion.

## Result

- `dev` local/remote: `79e5067a4058f6c7e44462dbb188707fa6df70d6`
- `claudedesktop` local/remote: `6da54a8965c24cdd31c4641ac3a864aad4968204`
- `main` and `preview`: unchanged at `6d6bef8b98d762ff9679916546cb44e8e3effebc`
- Origin heads: exactly `claudedesktop`, `dev`, `main`, `preview`
- Ancestry: `dev` is an ancestor of `claudedesktop`
- Content boundary: `ClaudeDesktop.tsx` absent on dev, present on claudedesktop
- Worktree: clean; local dev equals origin/dev
- Verification: `bun run typecheck` passed; isolated test suite completed without a failing exit;
  existing Cross-platform CI run `29914489485` for exact dev SHA `79e5067a` is green.
