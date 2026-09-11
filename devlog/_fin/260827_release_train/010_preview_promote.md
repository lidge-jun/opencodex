# 010 — promote dev content onto preview

## What changes

`preview` moves from `678517f56` to a merge carrying `dev`'s tree at `7c333f30e`.
No file in the repository is edited by this phase; it is a branch move only.

## How

`preview` requires a pull request, so:

```
gh pr create --base preview --head dev --title 'release: promote dev to preview' ...
gh pr merge <n> --merge --admin
```

A PR from `dev` directly rather than a `codex/` branch, because the content being promoted
IS `dev` — an intermediate branch would add a commit that says nothing.

Note `enforce-target` rejects PRs that do not target `dev`. A promotion PR targets
`preview` by definition, so expect that check to complain and confirm it is the
promotion exemption rather than a real finding before overriding it.

## Acceptance

- `git diff --stat origin/dev origin/preview` shows only `package.json` (the stale version
  string) or nothing at all
- the merge sha is recorded
- no `src/` or `tests/` file differs between the two branches

## What would make this wrong

Promoting before confirming the reconciliation in `000`. That check is done: since the
merge-base, `preview`'s only exclusive change is the version string.
