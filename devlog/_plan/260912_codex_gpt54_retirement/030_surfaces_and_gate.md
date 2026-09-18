# wp4 — GUI, docs, structure docs, and the closing gate

## MODIFY gui/src

- `gui/src/pages/dashboard-overview-sections.tsx:447` — `sidecar?.vision.model ?? "gpt-5.4-mini"`
  becomes `?? "gpt-5.6-luna"`, matching the runtime default from wp3. Left alone, the
  dashboard would display a retired model for an unset vision config.
- `gui/src/pages/api-keys-panels.tsx:322,330` — the copy-paste curl samples name
  `gpt-5.4`; move them to `gpt-5.6-luna` so a user pasting the sample gets a live model.
- KEEP `gui/src/pages/shadow-call-source.ts:5` — 0.144.x history, already luna in code.

## MODIFY gui/tests

Vision floor: `vision-sidecar-dashboard.test.tsx` 39/107/307/311/372/377,
`vision-reasoning-contract.test.ts` 15/19 → luna.
Native examples: `api-access-models.test.ts`, `apikeys-actions.test.tsx`,
`apikeys-model-test-wire.test.tsx`, `apikeys-models-states.test.tsx`,
`client-config-panel.test.tsx`, `subagents-fallback.test.tsx` → a surviving native.
KEEP `models-native-group-controls.test.ts` (custom, non-native row id) and
`shadow-call-source.test.ts` (explicit override rendering).

## MODIFY docs-site (English first, then the seven locales)

Each family below changes in `docs/` and in `fr`, `ja`, `ko`, `ru`, `tr`, `zh-cn`,
`zh-tw`. The English page is the source; a locale must not disagree with it.

- `guides/codex-app-models.md` — drop `gpt-5.4` and `gpt-5.4-mini` from the native
  fallback set. zh-tw `guides/sub-agent-surface.md:218` additionally carries an effort
  row for the retired natives that English does not have; delete that row.
- `getting-started/quickstart.md` — the advertised five native picker models still end
  in `gpt-5.4-mini`, while `DEFAULT_SUBAGENT_MODELS` is already Astra/sol/terra/luna/5.5.
  Make the docs match the shipped default.
- `guides/codex-integration.md` — the account-verification warmup sentence becomes
  "defaults to `gpt-5.6-luna`, retries with `gpt-5.5`".
- `reference/configuration/providers.md` — `codexWarmupModel` default cell → luna.
- `reference/configuration/server.md` — the vision `model?` default cell → luna. KEEP
  the "legacy explicit `gpt-5.4-mini` migrates on start" sentence; that is still true.
- `guides/sidecars.md` — the code fallback → luna; keep the migration sentence.
- `reference/configuration/agents.md` and `guides/sub-agent-surface.md` — the
  `subagentModelFallback` examples name a retired model; move to luna.
- `docs-site/src/components/Landing.astro` 89/320 — the marketing line advertises a
  "gpt-5.4-mini sidecar" in every translated string; update all of them together.
- KEEP the Copilot mixed-wire lists in `guides/providers.md` and
  `reference/configuration/providers.md`; those describe a vendor roster this unit does
  not touch. KEEP the shadow-intercept restore notes, but fix zh-tw
  `reference/cli/providers-accounts.md:283`, which states the default is both slugs
  while English says luna only.
- `guides/codex-integration.md` explicit-account example `work/gpt-5.4` → `work/gpt-5.5`,
  so no page advertises a retired slug even as an illustration.

## MODIFY docs/ (maintainer-facing, separate from docs-site)

- `docs/shadow-call-intercept.md:14-17` — says the default source-prefix set is
  `gpt-5.4-mini` and `gpt-5.6-luna`. `DEFAULT_SHADOW_SOURCE_MODELS` is luna-only, so this
  page is already wrong today. State luna as the default and `gpt-5.4-mini` as the 0.144.x
  restore value, matching the correction in `src/types/config.ts` from wp3.
- `docs/codex-app-model-catalog.md:111` — uses `gpt-5.5`/`gpt-5.4` as the example of
  snapshot entries that are staler than the installed catalog. Replace the retired half of
  the example.

## MODIFY structure/

- `structure/ops/service-and-sidecars.md:52` — vision default cell → `gpt-5.6-luna`.
- `structure/gui-and-management-api.md:129` — the shadow `sourceModels` sentence says
  the default is `gpt-5.4-mini` + `gpt-5.6-luna`; the code ships luna only. Correct the
  default and keep mini as the documented restore value.

## MODIFY scripts/release-notes.ts

Line 1137 — `process.env.OPENAI_MODEL ?? "gpt-5.4"` becomes `?? "gpt-5.6-luna"`. The
tool is maintainer-facing but would fail against a retired model.
KEEP `scripts/model-metadata.source.json` entirely: 129 hits across vendor snapshots
plus openai/openai-codex pricing rows, none of which are the Codex-login catalog.

## Closing gate

1. `bun run typecheck`
2. `bun run test` (full suite, PR-ready gate)
3. `bun run lint:gui` and the GUI tests
4. `bun run structure:check`
5. Final `rg "gpt-5\\.4"` sweep, read against an explicit allowlist rather than an
   expectation of zero hits. Survivors that are CORRECT and must remain:
   vendor rosters (`src/providers/registry.ts` Copilot, `src/adapters/cursor/*`,
   `src/providers/codebuddy-models.ts`, `scripts/model-metadata.source.json`,
   `tests/providers/**`, `tests/fixtures/commandcode-models.json`, the Copilot/mixed-wire
   docs pages); historical pricing (`src/usage/expected-prices.ts`, `tests/usage/**`,
   `docs-site/src/data/frontier-benchmarks.json` benchmark rows);
   generated metadata (`src/generated/model-metadata.ts`); different slugs
   (`-nano`, `-pro`, `-high`, `openai/gpt-5.4-mini`, `cursor/gpt-5.4`); the shadow-intercept
   restore hatch (`src/lib/shadow-call.ts`, `tests/responses/**`, the sourceModels docs);
   negative and fixture assertions (`tests/routing/subagent-*`, `tests/server/api-debug.test.ts`,
   `tests/server/config.test.ts`, `server-startup-reconcile-resilience.test.ts`,
   `codex-app-server-processes.test.ts`, `slug-codec.test.ts`, `empty-completion-guard.test.ts`,
   `codex-catalog.test.ts:3817`); and this devlog unit. A hit outside that list is a defect.

Receipts go to `.tmp/`, and `040_done.md` records the outcome with quoted evidence.
