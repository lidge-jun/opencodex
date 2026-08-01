# 160.20 — Phase 2: Hide Image/Video Generation Models

- **Status:** Done
- **Date:** 2026-06-20
- **Work class:** C2 (single backend choke-point + test)
- **Resolves:** Open Q1 in [00_overview.md](00_overview.md)

## Decision (Q1 resolved by user)

> "image video는 노출 안되게 해놓으라는거였고" — the request was to **hide** image/video
> models, not to surface or add them.

This rejects options (A) capability-badge surfacing and (B) adding generation models from
[02_grok-media-models-and-registry-gap.md](02_grok-media-models-and-registry-gap.md). The
intent is the opposite: image/video **generation** models must never be exposed. They are
useless to Codex (a coding agent) — if routed, selecting one would only error — and they
clutter the dashboard model list. So they are filtered out everywhere.

## Where they leak from

`registry.ts` hardcodes only text/vision chat models for `xai`, but `/api/models`,
`/v1/models`, and the catalog sync all read **live** provider `/models` via
`gatherRoutedModels()` (`src/codex-catalog.ts:323`). A live xAI fetch returns generation
models (`grok-2-image*`, video), and the jawcode metadata already carries image-gen ids
(`gpt-5-image`, `gemini-3-pro-image`, …). Any of these would surface.

## Change (single choke point)

`gatherRoutedModels()` is the one source of truth feeding the dashboard, `/v1/models`, and
`syncCatalogModels`. Filtering there hides media models in all three at once.

- `src/codex-catalog.ts`
  - `isMediaGenerationModelId(id)` (exported) — classifies by id, since metadata has no
    output-modality field. Matches an `image`/`video` id segment, or a generation family
    (`dall-e`, `imagen`, `sora`, `veo`, `flux`, `kling`, `seedance`, `hailuo`,
    `stable-diffusion`, `sdxl`, `midjourney`). Extend `MEDIA_GEN_FAMILIES` as needed.
  - `gatherRoutedModels()` — `.filter(m => !isMediaGenerationModelId(m.id))` after the
    jawcode augment, before the sort.

### Why id-classification is safe

Vision **input** chat models (`grok-2-vision`, `qwen3-vl-*`, `gpt-4o`,
`gemini-3-pro-preview`) carry no `image`/`video` id segment and no generation-family token,
so they are kept. `openrouter/aurora-alpha` is a **text** model and is deliberately not
matched (no bare `aurora` rule). Verified by test.

## Verification

- `tests/codex-catalog.test.ts` — added `media-generation model filtering` describe:
  16 positive ids flagged, 12 text/vision ids kept.
- `bun test tests` → **94 pass / 0 fail**. `bun x tsc --noEmit` → clean.
