# 050 — publish
Rebase on origin/dev; bun run typecheck; focused tests for every item; bun run test:changed; bun run privacy:scan; bun run structure:check; bun run lint:gui; push branch; gh pr create --base dev with template + Security review + Carries/Closes; watch automatic checks; fix failures on head.

## wp5 P (executable)
- origin/dev moved to df61bcecd5 (#5737, #5738). Overlapping files: docs-site reference/configuration/providers.md, scripts/test-layout/layout.json, structure/config.md, structure/subagents.md, tests/fixtures/test-layout-expected.json. Resolve by keeping both sides' entries.
- Before rebase: git mv devlog/_plan/260924_l4_codex_cli_service -> devlog/_fin/ is deferred until after merge (unit stays open while the PR is open).
- Validation after rebase: bun run typecheck; focused union of all item tests; bun run test:changed (worktree under /Users/jun/.codex trips the test-home guard for some temp-dir tests — compare any failure with a pristine git archive copy); bun run privacy:scan; bun run structure:check; bun run lint:gui.
- GUI screenshot: run the dashboard (bun run src/cli/index.ts start on a spare port with a throwaway OPENCODEX_HOME), open Codex settings > Multi-auth > Advanced, capture the 98% card to .tmp/. Hosting: pr-assets push only if the user authorizes; otherwise the coordinator uploads it.
- PR body: Summary per item with Carries/Closes lines, Security review for #5713, Verification with commands, Checklist, coordinator decisions (Reserve trade-off, previous opt-outs re-enabled, stale connect marker retention, 64 MiB indeterminate).
