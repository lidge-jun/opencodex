# OAuth Preset Reconciliation

`src/oauth/index.ts` refreshes registry-owned model rosters and capability lists at startup
and OAuth upsert. Saved `contextWindow` and `defaultMaxOutputTokens` are operator limits;
presets fill them only when absent. Saved `modelContextWindows`, `modelMaxOutputTokens`,
`modelInputModalities` and effort translation maps override preset
entries, with missing keys filled from the preset. Model keys match case-insensitively;
array values, including `[]`, replace the seeded value. A saved per-model effort translation
map is retained as one entry; request-time static policy fills missing inner aliases separately.
Preset-owned reasoning ladders refresh seeded model rows; unseeded rows and provider tiers
without preset defaults survive. `modelReasoningEffortsAuthoritative: true` explicitly makes
saved model ladders operator-owned, so their entries win over preset tiers too.
`modelContextTiers` and other operator policy remain outside catalog replacement. This keeps
Copilot long-context evidence and xAI window overrides through restarts and re-login.
Saved seeds have no provenance separate from operator edits, so existing entries are retained;
only missing operator-map defaults refresh. Live discovery and request-time admission keep their own limits.
Regression coverage: `tests/oauth/oauth-reconcile-operator-maps.test.ts`.
