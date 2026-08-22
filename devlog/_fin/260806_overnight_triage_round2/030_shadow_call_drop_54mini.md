# 030 — Drop gpt-5.4-mini from the shadow-call intercept defaults

User decision (2026-08-06): Codex clients on 0.145.0+ use `gpt-5.6-luna`
for helper calls; `gpt-5.4-mini` only mattered for clients ≤0.144.x. Remove
it from the intercept defaults in code and GUI.

Branch: `codex/shadow-call-drop-54mini`, base `origin/dev` 6e1a4e429.
Note: touches the SAME shadow-call surface as PR #1087 but different
files/lines (constants vs select options) — no textual overlap; if both
land, no conflict expected (`src/lib/shadow-call.ts` vs `gui/src/pages/
dashboard-shared.ts`).

## Scope (intercept defaults only)

In scope:

- `src/lib/shadow-call.ts:10` — `DEFAULT_SHADOW_SOURCE_MODELS` becomes
  `["gpt-5.6-luna"]`. Doc comment updated: the 5.4-mini era is history,
  users on ancient clients can restore it via the `sourceModels` override
  (mechanism already exists and is tested).
- `gui/src/pages/shadow-call-source.ts:9` — `FALLBACK_SOURCE_MODELS`
  becomes `["gpt-5.6-luna"]` (only used when the runtime is too old to
  send `sourceModels`).
- `src/server/responses/core.ts:1379` — stale comment naming 5.4-mini.
- Tests: `tests/responses-shadow-intercept.test.ts` (default-list
  assertions at :24-25 prefix behavior, :213 sourceModels echo),
  `gui/tests/shadow-call-source.test.ts` (fallback expectations).
  Keep the prefix-set mechanism tests; only the default list shrinks.
  ADD a regression: `isShadowSourceModel("gpt-5.4-mini")` is now FALSE by
  default but TRUE with an explicit `sourceModels: ["gpt-5.4-mini"]`
  override — that pins the escape hatch.
- Docs (en + ko/ja/zh-cn/ru): `reference/configuration/server.md` (table
  row + JSON example), `reference/cli/providers-accounts.md` (shadow
  status row). Wording: default is `gpt-5.6-luna`; older clients
  (≤0.144.x) used `gpt-5.4-mini` and can be re-covered via `sourceModels`.

Out of scope (5.4-mini appearances that are NOT the shadow intercept):

- `DEFAULT_SUBAGENT_MODELS` (config.ts:1340), vision sidecar default
  (vision/index.ts:16), warmup model (codex/warmup.ts:29,
  token-guardian.ts:55), catalog/pricing/cursor tables, the sidecar
  migration at server/index.ts:386-396, stale web-search comments in
  types.ts:37,167. These serve different subsystems where 5.4-mini is
  still a real model.

## Verification

`bun run typecheck`, `bun test tests/responses-shadow-intercept.test.ts`,
`cd gui && bun test tests/shadow-call-source.test.ts tests/shadow-call-model-options.test.ts 2>/dev/null || cd gui && bun test tests/shadow-call-source.test.ts`,
`bun run privacy:scan`. GUI badge change → screenshot in PR body
(badge now reads `5.6-luna` only).
