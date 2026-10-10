# B2 — #3666 free-only filter in the Dashboard model catalog

Raw research: `_research/3666.md`.

## Verdict

Real. Live `/models` rows carry `pricing`, but nothing downstream keeps it, and
both Dashboard lists only substring-search. The "Free" UI that exists today is
**provider-tier** (`freeTier` / `keyOptional`), which is exactly why OpenRouter —
`freeTier` unset, mixed paid and `:free` slugs — cannot be narrowed to $0 models.

## Root cause

`extractProviderModelItems` admits the whole row, so `pricing.prompt` and
`pricing.completion` survive (`src/providers/model-discovery.ts:33`, `:513`), and
then `catalogHintsFromModelsApiItem` returns only window / modalities / reasoning /
capabilities (`src/codex/catalog/provider-fetch.ts:1404`, `:1468`). That object
becomes the catalog row (`:1917`), `CatalogModel` has no cost field
(`src/codex/catalog/parsing.ts:96`), `GET /api/models` adds only the **manual**
overlay marker (`src/server/management/model-rows.ts:40`, `:185`), and the GUI row
type matches (`gui/src/pages/models-shared.ts:32`).

## Chosen fix

One classifier, then consumers:

1. In `catalogHintsFromModelsApiItem` (or a helper it calls), map
   `pricing.prompt|input` + `pricing.completion|output` — numeric or numeric
   string — to `pricingStatus: "free" | "paid" | "unknown"`, and put the field on
   `CatalogModel`.
2. `listManagementModelRows` already spreads the row, so `/api/models` carries it.
   Keep `manualPricing` orthogonal.
3. GUI toggle in `renderGroup` (`gui/src/pages/Models.tsx:1411`) and
   `ProviderModelInventory` (`gui/src/components/provider-workspace/ProviderModels.tsx:77`).
   Filter **before** the search sort, `PAGE = 60`, and `CHIP_RENDER_CAP = 300`, or
   free models stay hidden behind Show more on a 200-row OpenRouter list. Counts
   and empty states read the filtered set.
4. `ocx models live --provider <p> --free-only` on the same field
   (`src/cli/models-runtime.ts:57`). Note that the issue's `ocx model list --free-only`
   does not exist as a command.

## Decided defaults

- **Missing, partial, invalid, or negative price is `unknown` and is excluded from
  free-only.** Fail closed: showing a paid model under a Free filter costs the user
  money, hiding a free one costs a click.
- **A `:free` id suffix is not evidence.** It is an OpenRouter convention; Nous
  ships `:free` slugs with `freeTier: false` on purpose (`src/providers/registry.ts:1553`).
- **Do not reuse `modelCosts` zeros as discovered-free.** That overlay is the
  operator's own estimate and `src/usage/cost.ts:247` already drops all-zero rows.
- Filter state is session UX, not persisted config.
- Do not touch `isFreeProvider` / `ProviderCatalog` badges; provider-tier Free and
  model-tier Free must not collide.
- Kilo's live shape is not in this tree and was not probed. Ship the OpenRouter
  path; Kilo rows classify as `unknown` until someone verifies the field.

## Regression test

Primary red/green in `tests/codex-integration/` (`catalog-*` maps there), either a
new `catalog-free-pricing-status.test.ts` — which then needs entries in
`scripts/test-layout/layout.json` `explicit` **and**
`tests/fixtures/test-layout-expected.json` — or an extension of
`tests/providers/provider-model-discovery-contract.test.ts:254`.

```ts
catalogHintsFromModelsApiItem("openrouter", {
  id: "google/gemma-3-1b-it:free",
  pricing: { prompt: "0.00000000", completion: "0" },
}).pricingStatus === "free"

catalogHintsFromModelsApiItem("openrouter", {
  id: "anthropic/claude-sonnet-5",
  pricing: { prompt: "0.000003", completion: "0.000015" },
}).pricingStatus === "paid"

catalogHintsFromModelsApiItem("ollama", { id: "llama3.2" }).pricingStatus === "unknown"
```

Red today: the return has no `pricingStatus`. Also pin one-sided, negative, and
non-numeric input to not-free. API contract in
`tests/server/model-costs-management-api.test.ts`; GUI filter in `tests/gui/`.

## Watch

OpenRouter prices are USD **per token** strings while overlays and the jawcode
bundle are per 1M. Classify on numeric zero, never on a unit conversion.

## PR

`feat(catalog): classify discovered model pricing and filter free models` — branch
`lane-b/1-3666`, PR base `dev`, bottom of the Lane B stack. Closes #3666.
