# 010 — Phase 1: dev sync (local → origin/dev)

## Precondition (verified 2026-07-16)

`git status -sb` → `## dev...origin/dev [ahead 5]`, no behind marker ⇒ pure fast-forward.

## Commands

```sh
git checkout dev
git push origin dev
git rev-parse dev origin/dev   # must print the same SHA twice (f44dd916 at plan time)
```

## Accept criteria

- `origin/dev` == local `dev`; push output shows `ee5f6ad2..f44dd916`.
- No new commits appeared on origin/dev in the meantime (if they did: `git pull --rebase origin dev`
  first, rerun tests before push — activation scenario for the non-ff fallback).
- CI on pushed dev starts (ci.yml push trigger) — conclusion handled in WP3 alongside
  the integration push; WP1 only records the run URL.
