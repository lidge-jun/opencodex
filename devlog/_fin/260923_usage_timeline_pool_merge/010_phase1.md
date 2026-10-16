# Phase 1 — normalize timeline providers

## Diff

`src/usage/timeline.ts`

- import `baseProviderLabel` from `../providers/label`.
- `timelineModelId(provider, model)` returns `${baseProviderLabel(provider)}/${model}`; series id,
  series `provider`, and `availableModels` use it.
- `normalizeTimelineModelId` maps a saved `models` selection such as `openai-p6bc633/gpt-6-astra`
  onto the merged id, so an old selection keeps selecting the (whole) merged row.
  `appliedFilters.models` still echoes the raw request, which the Rust host and Swift client
  compare against their settings.
- `hiddenProviders` hides an attribution when either the raw or the base provider is listed.
- `modelAccount` grouping: account = explicit `accountLogLabel`, else the `main`/`p<hex6>`
  suffix of a provider, else `unknown`.

`tests/usage/usage-timeline.test.ts`

- one case feeding `openai-p6bc633`, `openai-pe2d42f`, `openai`, `openai-main`, `chatgpt` rows of
  one model: merged row total, legacy model filter, both hidden-provider forms, account grouping.

`src/companion/settings.ts` (audit finding)

- The GUI panel (`companionTimelineProjection`), Swift `UsageTimeline.projected`, and the Rust
  `timeline_rows`/`selected` projector all re-filter timeline rows against `settings.models`
  verbatim. A saved `openai-p6bc633/...` selection would drop the merged `openai/...` row in every
  client even though the server matched it. `applyCompanionSettingsPatch` (used by load and PUT)
  now maps `models` through `normalizeTimelineModelId` and dedupes, so every client receives,
  sends, and compares the merged ids from one server-side place.

`tests/server/companion-settings.test.ts`

- a saved per-account selection loads as merged ids, and a PUT with duplicate account forms dedupes.

## Verification

- `bun install --frozen-lockfile`: passed (104 packages installed).
- `bun test tests/usage/usage-timeline.test.ts tests/server/companion-settings.test.ts tests/providers/provider-registry-parity.test.ts tests/ci-workflows/structure-ssot.test.ts`: 129 pass, 0 fail after merging current `origin/dev`. This covers the timeline and persisted-settings behavior, the registry conflict resolution, and the owned structure contract.
- `bun run typecheck`: passed.
- `bun run test:changed` and the full local suite were not run under this repair lane's focused-validation limit. Exact-head hosted CI after the merge remains to be checked.
