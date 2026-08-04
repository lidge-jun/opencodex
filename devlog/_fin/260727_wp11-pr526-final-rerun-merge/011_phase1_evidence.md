# 011 — WP11 PR #526 final rerun evidence

## Branch and rebase state

- Worktree: `/Users/jun/.codex/worktrees/260727-pr526/opencodex`
- Branch: `codex/catalog-written-signal`
- Rebase base: `origin/dev@7c74e0a22ec96dd5849d3d7253758f0ab15d9737`
- Pushed head: `ce716cc117ab23e4420c8c9fe860959968f66cdc`
- Preserved remote branch after merge:
  `refs/heads/codex/catalog-written-signal@ce716cc117ab23e4420c8c9fe860959968f66cdc`

## Local verification

- `bun test tests/codex-refresh.test.ts tests/codex-sync-api.test.ts tests/injection-model-api.test.ts`
  - Result: 24 pass, 0 fail, 112 assertions.
- `bun x tsc --noEmit`
  - Result: exit 0.
- `git diff --check origin/dev`
  - Result: exit 0.
- Pre-push gate from `git push --force-with-lease origin codex/catalog-written-signal`
  - `bun run typecheck`: pass.
  - `bun run lint:gui`: pass.
  - `bun run test`: 5051 pass, 0 fail, 24881 assertions.
  - `bun run privacy:scan`: pass.
  - `bun run doctor:gui:if-changed`: skipped because no `gui/` changes in push range.

## Hosted checks

PR: https://github.com/lidge-jun/opencodex/pull/526

Latest PR head at check time:
`ce716cc117ab23e4420c8c9fe860959968f66cdc`

All hosted checks completed successfully for that head:

- CodeRabbit: success.
- label: success.
- react-doctor: success.
- ubuntu-latest: success.
- macos-latest: success.
- windows-latest: success.
- npm-global ubuntu-latest: success.
- npm-global macos-latest: success.
- npm-global windows-latest: success.

## Pre-merge stale-base gate

- Remote `refs/heads/dev` immediately before merge:
  `7c74e0a22ec96dd5849d3d7253758f0ab15d9737`.
- PR head immediately before merge:
  `ce716cc117ab23e4420c8c9fe860959968f66cdc`.
- `gh pr view 526 --json mergeable,mergeStateStatus`:
  `MERGEABLE` / `CLEAN`.
- REST merge state:
  `mergeable: true`, `mergeable_state: clean`.

## Merge result

- Squash merge was executed through GraphQL `mergePullRequest` with
  `expectedHeadOid=ce716cc117ab23e4420c8c9fe860959968f66cdc`.
- Merged at: `2026-07-27T12:05:44Z`.
- Merge commit on `dev`:
  `9dd3c42dae2e7feda3581c6d477cf5a0d6e646bf`.
- Remote `codex/catalog-written-signal` branch was not deleted and still points to
  `ce716cc117ab23e4420c8c9fe860959968f66cdc`.
