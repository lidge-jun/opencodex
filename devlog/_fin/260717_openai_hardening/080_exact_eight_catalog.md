# Cycle 080 — Exact-eight API Catalog Augmentation

## Objective

After live/static model gathering, `augmentRoutedModelsWithRegistryOpenAiApiRows`
rebuilds exactly eight trusted `openai-apikey` rows: gpt-5.5, gpt-5.6, gpt-5.6-sol,
gpt-5.6-terra, gpt-5.6-luna, gpt-5.6-sol-pro, gpt-5.6-terra-pro, gpt-5.6-luna-pro.
Unrelated live rows are removed. Conflicting live metadata is replaced with one
process-wide deduplicated warning.

## Scope

- `augmentRoutedModelsWithRegistryOpenAiApiRows(models, config)` in `src/codex/catalog.ts`
- `normalizedOpenAiApiSignature` for semantic equality comparison
- Process-wide warning set with `resetOpenAiApiCatalogWarningStateForTests`
- No-op when API tier is absent or disabled
- Direct/Multi rows never receive API virtuals or API context values
- User `modelContextWindows` / `modelMaxInputTokens` only lower official baselines

## Activation tests

- `tests/codex-catalog.test.ts` "OpenAI API trusted catalog augmentation" suite
- Exact eight rows after partial/conflicting live discovery
- User values only lower trusted baselines (context 350K, max-input 300K accepted; 2M / 945K rejected)
- No-op for absent or disabled API tier
- Semantic deduplication: identical live row no warning, repeated same mismatch warns once,
  changed mismatch warns again, differently-ordered equivalent arrays no warning

## Evidence

- Consolidated implementation and activation evidence is indexed in
  [`190_consolidated_finish_plan.md`](./190_consolidated_finish_plan.md), with the final
  Cycle-B integration and gate receipts in [`050_integration_verification.md`](./050_integration_verification.md).

## Status

`done — verified by consolidated Cycle A/B sweep, see 190 + 050 evidence`
