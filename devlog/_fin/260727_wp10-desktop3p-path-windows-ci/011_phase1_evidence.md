# 011 — WP10 Phase 1 evidence

## Local branch

- Worktree: `/Users/jun/.codex/worktrees/260727-desktop3p-path/opencodex`
- Branch: `codex/desktop3p-path-windows-ci`
- Base: `origin/dev@ff831858388179d3f76f4dd7c119d84470214fa6`
- Commit: `f6d2881dd422830eece502e0ba8de493205fe9d1`
- PR: https://github.com/lidge-jun/opencodex/pull/552

## Code delta

- `src/claude/desktop-3p-paths.ts`
  - Replaced host `node:path.join` use in Desktop 3P resolver with target-platform
    `posix` / `win32` joins.
  - Preserved `OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR` trim-then-verbatim override.
- `tests/desktop-3p.test.ts`
  - Corrected public entry-point expectations so Darwin/Linux use POSIX and
    Windows uses `win32.join`.
- `tests/claude-desktop-config-path.test.ts`
  - Corrected pure resolver expectations by target platform while keeping host
    `join` for temp-file fixture paths.

## Local verification

- `bun test tests/desktop-3p.test.ts tests/claude-desktop-config-path.test.ts`
  - Result: 30 pass, 0 fail, 84 assertions.
- `bun x tsc --noEmit`
  - Result: exit 0.
- `git diff --check origin/dev`
  - Result: exit 0.
- Pre-push hook for remote branch creation:
  - `bun run typecheck`
  - `bun run lint:gui`
  - `bun run test`
  - `bun run privacy:scan`
  - `bun run doctor:gui:if-changed`
  - Result: 5047 pass, 0 fail, 24858 assertions; privacy scan passed; GUI
    doctor skipped because no `gui/` files changed.

## Independent review

- A-gate reviewer Huygens: `GO-WITH-FIXES (blockers=1)`.
  - Blocker: plan named wrong override env var. Folded into `000_plan.md` and
    `010_phase1.md` before B.
- C-gate reviewer Aquinas: `PASS`.
  - Confirmed override semantics preserved, target-platform joins are consistent,
    host temp-file joins remain host joins, and test assertions were corrected
    rather than weakened.

## Hosted verification

- PR #552 created at 2026-07-27T11:35Z.
- Latest head: `f6d2881dd422830eece502e0ba8de493205fe9d1`.
- Hosted checks:
  - CodeRabbit: success.
  - Enforce PR target branch: success.
  - PR Labeler: success.
  - React Doctor: success.
  - Cross-platform CI:
    - `ubuntu-latest`: success.
    - `macos-latest`: success.
    - `windows-latest`: success.
    - `npm-global ubuntu-latest`: success.
    - `npm-global macos-latest`: success.
    - `npm-global windows-latest`: success.
- PR #552 was squash-merged at 2026-07-27T11:43:58Z.
- Merge commit on `origin/dev`: `7c74e0a22ec96dd5849d3d7253758f0ab15d9737`.
- Remote branch `codex/desktop3p-path-windows-ci` was deleted after merge.
