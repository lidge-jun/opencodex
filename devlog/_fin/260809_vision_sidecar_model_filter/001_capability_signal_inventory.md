# 001 — where a model's image capability actually comes from

Research doc. No diffs here; the diffs live in the decade docs.

## The four sources, in the order the runtime consults them

1. **Native pinned metadata** — `src/codex/catalog/metadata.ts:117`
   `nativeInputModalities(slug)` reads `src/codex/data/upstream-models.json`.
   Verified contents for the seven supported native slugs:

   ```
   gpt-5.6-sol   ["text","image"]
   gpt-5.6-terra ["text","image"]
   gpt-5.6-luna  ["text","image"]
   gpt-5.5       ["text","image"]
   gpt-5.4       ["text","image"]
   gpt-5.4-mini  ["text","image"]
   gpt-5.3-codex-spark  (absent from snapshot → falls back to ["text","image"])
   ```

   So **every** native OpenAI slug is image-capable. The native side of the picker
   is not where over-listing happens.

2. **Generated vendor metadata** — `src/generated/model-metadata.ts`, `DATA` rows
   whose 4th column is a comma-joined modality string. `getModelMetadata(provider,
   id)` and `getModelMetadataCaseInsensitive` return `input?: ("text"|"image"|"video")[]`.
   Every `anthropic` row in that table carries `text,image`, including
   `claude-haiku-4-5` and `claude-haiku-4-5-20251001`.

3. **Live catalog rows** — `CatalogModel.inputModalities`, populated by
   `catalogHintsFromModelsApiItem` (`provider-fetch.ts:938`) from the provider's
   own `/models` payload, then post-processed by `applyProviderConfigHints`.

4. **Operator config** — `provider.modelInputModalities[id]`, which
   `configuredInputModalities` treats as the base before the `noVisionModels`
   augmentation.

## Live evidence from this machine

`GET /api/models` (admin token, port 10100) returned 11 providers. The two the
picker currently sources from:

```
openai     7 rows, inputModalities: absent on every row
anthropic 11 rows, inputModalities: absent on every row
```

That absence is the second load-bearing fact. `listManagementModelRows`
(`src/server/management/model-rows.ts:45-54`) builds native rows by hand and never
attaches `inputModalities`; anthropic rows come through `dedupedRouted` from the
catalog, where the anthropic provider's `/models` response also omits it.

**A naive `row.inputModalities?.includes("image")` filter would therefore empty the
picker completely.** Unknown must not be read as zero. The predicate has to fall
back to pinned/generated metadata before concluding a model cannot see, and when
all four sources are silent it must stay permissive.

## The inverted signal

`applyProviderConfigHints` (`provider-fetch.ts:574-582`) appends `"image"` to a
model listed in `provider.noVisionModels`. `tests/catalog-vision-sidecar-modalities.test.ts`
asserts exactly this: `glm-5.2`, a text-only model, comes out as
`["text","image"]`.

`noVisionModels` is also the trigger for the sidecar itself —
`planVisionSidecar` (`src/vision/index.ts:237`) returns undefined unless
`modelInList(provider.noVisionModels, modelId)`. One list, two opposite meanings
depending on which side of the sidecar you stand on.

Consequence for the predicate: membership in `noVisionModels` is a **hard
disqualifier** for being a describer, and it must be checked before the modality
list, because the modality list was rewritten by that very membership.

## Which models a sidecar can actually reach

`planVisionSidecar` has exactly two branches:

- `backend === "anthropic"` → `describeImageAnthropic`, which requires an enabled
  `adapter: "anthropic"`, `authMode: "oauth"` provider with a non-reauth active
  account (`findAnthropicVisionProvider`, `src/vision/index.ts:171`).
- `backend === "openai"` → `describeImage` against
  `${forwardProvider.baseUrl}/responses`, requiring a resolved OpenAI forward
  sidecar (ChatGPT login).

There is no third executor. A `xai/grok-4.5` row, image-capable though it is,
has no code path that would describe an image today. Eligibility must therefore be
scoped to the two backend families, not opened to every image-capable row in the
catalog — otherwise the picker would offer selections that silently produce no
plan at all.

That is the honest answer to "can we allow other models?": **within the two
supported wire protocols, yes — and the current filter is the wrong shape.
Outside them, not without a new executor**, which this unit scopes out.

## Baseline requirement

The user requires `gpt-5.6-luna` to always appear when the GPT side is enabled and
a haiku model to always appear when Claude is registered. Both are image-capable by
the tables above, so the baselines are not exceptions to the capability rule — they
are a **presence** guarantee against an empty or unfetched catalog, which the live
evidence above shows is a real state (`/api/models` can be cold, and
`fetchAllModels` can return nothing while a provider is cooling down after a fetch
failure).
