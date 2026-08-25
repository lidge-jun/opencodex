# 080 — wp12: catalog defaults and aliases (GUI-bearing)

All three issues are unimplemented (only docs-only PR #2466 merged, `438b9cc77`) and
all three change `gui/src/pages/Models.tsx`. Per the loop contract this phase routes
through cxc-dev-uiux-design for direction, then cxc-dev-frontend for implementation and
rendered verification. No visual claim without a screenshot.

### #2465 — latest-only default preset
Configuration has only `selectedModels`, where absent/empty exposes everything
(`src/types/provider.ts:262`) and an empty selection deletes the allowlist
(`src/server/management/model-routes.ts:546`). No `modelPreset` symbol exists.
Care: "empty preset materializes to all" means zero-match handling must be atomic.

### #2464 — new models arrive disabled
The live cache is memory-only with a 5-minute TTL (`src/codex/model-cache.ts:1`), so
there is no durable baseline to diff arrivals against. HIGH risk: baseline corruption
or repeated arrival detection could hide entire catalogs or repeatedly override a
user's enable choice.

### #2463 — provider/model aliases
`displayName` is display-only metadata (`src/types/config.ts:175`); the only runtime
alias today is the combo alias resolved before provider routing
(`src/router.ts:625`). HIGH risk: alias collisions can shadow combos, native models,
account namespaces, or `defaultProvider`.

Sequencing note: #2464 and #2465 both write the visibility baseline and must not be
implemented in the same cycle.

