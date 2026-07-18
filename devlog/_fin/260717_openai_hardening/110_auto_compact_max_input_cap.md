# Cycle 110 — Auto-compaction Bounded by Max Input Tokens

## Objective

Routed `auto_compact_token_limit` must respect `maxInputTokens` so it never exceeds
the model's real input capacity. Formula:
`min(floor(effectiveContextWindow * 0.9), maxInputTokens ?? Infinity)`.

## Scope

- `applyCatalogModelMetadata` in `src/codex/catalog.ts` uses `Math.min` with maxInputTokens
- `applyProviderConfigHints` threads `configuredMaxInputTokens` into CatalogModel
- User `modelMaxInputTokens` caps only lower the trusted baseline (same as context)
- 1.05M context with 922K max-input → auto-compact 922K (not 945K)
- 350K context with 922K max-input → auto-compact 315K (context * 0.9 wins)

## Activation tests

- `tests/codex-catalog.test.ts` "routed auto-compaction is bounded by max-input"
  - 1.05M/922K → 922K
  - 350K/922K → 315K

## Evidence

- Consolidated implementation and activation evidence is indexed in
  [`190_consolidated_finish_plan.md`](./190_consolidated_finish_plan.md), with the final
  Cycle-B integration and gate receipts in [`050_integration_verification.md`](./050_integration_verification.md).

## Status

`done — verified by consolidated Cycle A/B sweep, see 190 + 050 evidence`
