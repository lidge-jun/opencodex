# 021 — wp2 cherry-pick onto privacy-clean origin/dev

wp1 landed as #3197 squash `4be4326d7`. Unique #3190 commits cherry-picked onto that tip:

- `e1fc1729b` -> `3ee25f58e` feat(combo): adapt reasoning effort to target capabilities
- `5f8cd24dd` -> `c2a89e321` test(combo): cover adaptive effort mode and the tool-bearing opt-out

Conflicts: none. Auto-merged `src/codex/catalog/aggregation.ts`, `src/server/management/provider-routes.ts`, `docs-site/src/content/docs/reference/configuration/providers.md`, `tests/combos.test.ts`, `tests/management-provider-validation.test.ts`.

Focused checks on `c2a89e321`: `bun x tsc --noEmit` exit 0; `cd gui && bun x tsc --noEmit` exit 0; `bun run privacy:scan` exit 0; `bun test` of the six named files 528 pass / 0 fail.
