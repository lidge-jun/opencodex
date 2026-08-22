# 030 — convergence verification and local restore

Work-phase wp4.

## Checks

```sh
git fetch origin --tags
git merge-base --is-ancestor 81ada7cd0 origin/main
git merge-base --is-ancestor 81ada7cd0 origin/preview
git log --oneline origin/main..origin/dev      # expect empty
npm view @bitkyc08/opencodex dist-tags --json  # latest 2.19.0, preview 2.19.0-preview.20260815
gh release view v2.19.0 --json tagName,publishedAt
gh run list --workflow release.yml --limit 4   # both runs success
```

## Restore

- Primary worktree `/Users/jun/Developer/new/700_projects/opencodex` must end
  on `dev` with the same clean status recorded at wp1 start.
- Every other worktree keeps the branch it held before this unit:
  `260728-preview` -> `preview`, `rel-main` -> `preview-rel`, `45a0` ->
  `preview-dev`, plus the four `codex/*` feature worktrees and
  `.tmp/rev3` (detached).
- Move this unit to `devlog/_fin/` once the terminal outcome is recorded.
