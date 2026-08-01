# Cycle 130 — Usage Summary Pro Alias Isolation

## Objective

Verify that usage summary grouping by `provider + model` keeps Pro aliases separate
from their resolved base models. Three Pro rows must not collapse into base rows.

## Scope

- `src/usage/summary.ts` `buildModels` groups by `provider + model` (selected id)
- `resolvedModel` is a routing detail, not a row identity
- Usage JSONL persists `requestedModel` for audit trail

## Activation tests

- `tests/usage-summary.test.ts` "three OpenAI API Pro selections stay separate from their resolved base models"
  - Three entries: sol-pro, terra-pro, luna-pro with different resolvedModel
  - Summary produces exactly 3 model rows, sorted by family

## Evidence

- Consolidated implementation and activation evidence is indexed in
  [`190_consolidated_finish_plan.md`](./190_consolidated_finish_plan.md), with the final
  Cycle-B integration and gate receipts in [`050_integration_verification.md`](./050_integration_verification.md).

## Status

`done — verified by consolidated Cycle A/B sweep, see 190 + 050 evidence`
