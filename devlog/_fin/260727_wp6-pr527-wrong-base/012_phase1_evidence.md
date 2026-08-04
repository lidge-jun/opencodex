# 012 — WP6 PR #527 evidence

## Live PR state

- PR: https://github.com/lidge-jun/opencodex/pull/527
- State: `OPEN`
- Base: `codex/catalog-written-signal@ce716cc117ab23e4420c8c9fe860959968f66cdc`
- Head: `codex/app-server-restart@a64aa585630f664a83c25253497a62810133e832`
- Merge state: `CONFLICTING` / `DIRTY`
- Checks:
  - `enforce-target`: failure because the PR target is not `dev`.
  - CodeRabbit status is success but review was skipped because the base branch
    is not `dev` or `preview`.

## Topology evidence

- PR #526 is merged into `dev` as
  `9dd3c42dae2e7feda3581c6d477cf5a0d6e646bf`.
- PR #527 still includes the old pre-squash #526 commit
  `1ba588eff663a5be846a8723b90a452dca8cd04c`.
- `origin/dev...origin/codex/app-server-restart` count: `134 2`.
- Read-only `git merge-tree origin/dev origin/codex/app-server-restart`
  reported conflicts in:
  - `tests/codex-refresh.test.ts`
  - `tests/injection-model-api.test.ts`

## Audit result

Independent A-gate reviewer Ramanujan returned:

`VERDICT: GO-WITH-FIXES (blockers=1)`

The blocker was folded into the comment plan: do not request a generic rebase or
simple retarget; request a clean rebuild from current `dev`, drop duplicate
commit `1ba588eff663a5be846a8723b90a452dca8cd04c`, and port only the
app-server restart behavior from `a64aa585630f664a83c25253497a62810133e832`.

## Maintainer comment

Posted:

https://github.com/lidge-jun/opencodex/pull/527#issuecomment-5091163284

Live verification confirmed that the comment body exists on PR #527 and was
authored by `lidge-jun` at `2026-07-27T12:15:43Z`.

## Terminal outcome

`DONE` for WP6.

#527 remains open as `needs-maintainer-rebuild` / `needs-author-rebase`; it is
not merge-ready and was not retargeted, pushed, or merged in this work-phase.
