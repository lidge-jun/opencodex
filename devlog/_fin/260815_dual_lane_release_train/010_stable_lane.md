# 010 — stable lane: dev to main, npm latest 2.19.0

Work-phase wp2. Depends on nothing but the wp1 audit.

## Diff-level steps

1. Use the dedicated release worktree `/Users/jun/.codex/worktrees/rel-main`.
   It currently has `preview-rel` checked out; the primary worktree holds
   `dev` and must not move. Create or reuse a worktree that can hold `main`
   without disturbing `/Users/jun/Developer/new/700_projects/opencodex`
   (`dev`), `/Users/jun/.codex/worktrees/260728-preview/opencodex`
   (`preview`), or `.tmp/rev3` (detached).
2. `git fetch origin`, `git checkout main`, `git reset --hard origin/main`
   inside that worktree only.
3. `git merge --no-ff origin/dev -m "Merge dev into main: v2.19.0"`. Expect a
   clean merge: `main` carries only version-bump commits, so the only possible
   conflict is `package.json` version. Resolve to the dev content; the bump
   happens in step 5.
4. `bun install` and `cd gui && bun install` in the fresh worktree before any
   gate runs — otherwise typecheck fails with `Cannot find type definition file
   for 'bun-types'`.
5. `bun scripts/release.ts 2.19.0 --publish`. It runs the clean-tree check,
   `audit:high`, typecheck, `bun test --isolate tests`, `privacy:scan`, bumps
   `package.json` to 2.19.0, commits `release: v2.19.0`, pushes `main`, waits
   for `ci.yml` and `service-lifecycle.yml` on the release SHA, re-reads the
   live remote head, then dispatches `release.yml` with `expected-sha` and
   watches it.

## Failure recovery

If the helper exits after the bump was already pushed, do not rerun it blindly.
Rerun the failed workflow once, confirm the remote SHA did not move, then
dispatch manually:

```sh
gh workflow run release.yml --ref main \
  -f version=2.19.0 -f tag=latest -f dry-run=false -f expected-sha=<sha>
```

If the `v2.19.0` tag already exists at a different commit, the publish is
refused; take the next patch number rather than deleting a tag.

## Exit criteria

- `git merge-base --is-ancestor 81ada7cd0 origin/main` exits 0
- `release.yml` run on `main` concluded success with the dispatched
  `expected-sha`
- `npm view @bitkyc08/opencodex dist-tags --json` shows `latest: 2.19.0`
- GitHub release `v2.19.0` exists
