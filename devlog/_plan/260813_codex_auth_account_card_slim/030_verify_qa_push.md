# 030 — Tests, Browser QA, push, remote suite

## Files
MODIFY tests listed in 010/020 as needed.
No production behavior beyond leftovers from 010/020.

## Verify in worktree
bun test gui/tests/codex-account-pool-pinned-badge.test.tsx gui/tests/codex-account-pool-toast-tone.test.tsx gui/tests/codex-auto-switch-controller.test.tsx gui/tests/codex-account-picker-setting.test.tsx gui/tests/account-priority.test.tsx gui/tests/i18n-locales.test.ts

## Browser QA (in-app Browser plugin)
1. Open http://localhost:10100/#codex-auth
2. Screenshot default: cards are three rows; no log/usage; Advanced closed; strategy visible.
3. Open Advanced; screenshot whole boxes expanded; no inner fold.
4. Confirm quota still on the card.

## Publish
Commit on codex/260813-codex-auth-account-card-slim.
Push --no-verify (user authorized).
Start bun run test and bun run typecheck on ssh lidge against the pushed SHA.
Do not merge.
