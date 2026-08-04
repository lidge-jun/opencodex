# WP8 — vision sidecar #349/#344 investigate + fix if feasible (070)

Issues #349/#344: vision sidecar unusable from Codex App because the injected
catalog advertised text-only `inputModalities` for `noVisionModels`-tagged models,
so Codex App rejected image upload client-side before the proxy ran the sidecar.

## Findings (Sol explorer, read-only)

**Standard-path bug is ALREADY FIXED on this branch (commit fb363e6e).**
- `applyProviderConfigHints()` appends `"image"` when the model matches
  `noVisionModels` (`provider-fetch.ts:91,95-103`); becomes emitted
  `input_modalities` (`effort.ts:133`) written to `opencodex-catalog.json`
  (`sync.ts:455,492,495`), pointed at via `model_catalog_json` (`inject.ts:381`).
- `gatherRoutedModels()` registry-enriches persisted clones (`provider-fetch.ts:447`).
- Ordinary noVisionModels rows now advertise `["text","image"]`.
- No raw-image-forward risk: with a plan images become descriptions
  (`core.ts:910,933`); without a plan it fails closed and strips images
  (`core.ts:940`, `vision/index.ts:359-365`). Covered by
  `tests/catalog-vision-sidecar-modalities.test.ts`, `vision-sidecar-e2e.test.ts`,
  `vision-fail-closed.test.ts`.

**Residual gap:** `customModels` replace discovered rows AFTER enrichment and copy
`cm.inputModalities` directly without `applyProviderConfigHints()`
(`provider-fetch.ts:528,541`) — a custom override can reintroduce the rejection.

## Plan

MODIFY `src/codex/catalog/provider-fetch.ts` — in `gatherRoutedModels()`
custom-model mapping (`:528-539`), run each custom row through
`applyProviderConfigHints()` using the REGISTRY-ENRICHED provider clone
(`activeProviders`, enriched at `:447-461`), NOT the raw `config.providers`.
Reason (A-gate blocker #2 fold): the raw provider lacks registry-only
`noVisionModels`, so hinting off it would leave registry-derived rows broken.
Build/use an enriched-provider lookup keyed by provider id for the custom path.

TESTS: extend `tests/catalog-vision-sidecar-modalities.test.ts` with (a) full
registry-enrichment coverage and (b) a custom-model override regression asserting
final `["text","image"]`. The custom-override regression MUST omit locally
persisted `noVisionModels` and rely on REGISTRY-derived classification, proving
the enriched-clone path (not local config) supplies the hint.

Activation (C-ACTIVATION-GROUNDING-01): the custom-override test must show a
noVisionModels custom row emerging with `["text","image"]`.

Terminal: DONE = custom-model hardening landed + tests green + comment on
#349/#344 (standard path fixed fb363e6e, custom gap closed). Maintainer may close
#344 as implemented and #349 as fixed.
