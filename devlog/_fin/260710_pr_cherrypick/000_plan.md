# 260710 — Cherry-pick PRs #76 / #74 / #70 into dev

## Objective

Merge all three open contributor PRs into the dev branch via cherry-pick,
resolving review feedback and verifying builds/tests after each.

## Work Phases

### WP1: PR #76 fix(anthropic): normalize tool input schemas
- Cherry-pick commit dae62a9
- Fix: translate Korean Decision Log comment to English
- Fix: add known-limitation comment for oneOf/anyOf property collision
- Verify: tsc + tests

### WP2: PR #74 feat(debug): unified provider/usage debug CLI and GUI tab
- Cherry-pick 4 commits from feat/debug-provider-gui
- Verify: server/index.ts compat with dev branch
- Verify: tsc + tests

### WP3: PR #70 feat(diagnostics): project config bypass warnings
- Cherry-pick 2 commits from feat/project-codex-config-warnings
- Fix: test isolation (CODEX_HOME)
- Verify: tsc + tests

### WP4: Final verification + push + PR ops
- Full bun test pass
- Push dev to origin
- Comment + close PRs #76, #74, #70

## Cherry-pick order: #76 -> #74 -> #70

Smallest-first. #74 and #70 both touch management-api.ts and i18n files,
so #74 goes first (larger surface, base for #70).
