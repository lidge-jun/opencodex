# Cycle 170 — gpt-5.6 Alias Registration

## Objective

Add `gpt-5.6` as the eighth OpenAI API model id alongside `gpt-5.5` and the six
GPT-5.6 family members. This is the generic alias for the GPT-5.6 family, matching
the official API surface.

## Scope

- `OPENAI_GPT56_MODELS` array in `src/providers/registry.ts` includes `gpt-5.6`
- Context window, max-input, input modalities, reasoning efforts all applied
- Registry entry `models` array has exactly 8 entries
- Key-login DTO reflects the 8-entry list
- Catalog augmentation includes gpt-5.6 in the exact-eight allowlist

## Activation tests

- `tests/provider-registry-parity.test.ts` `apiRegistry.models` has length 8
- `tests/provider-registry-parity.test.ts` key-login models list includes `gpt-5.6`

## Evidence

- Consolidated implementation and activation evidence is indexed in
  [`190_consolidated_finish_plan.md`](./190_consolidated_finish_plan.md), with the final
  Cycle-B integration and gate receipts in [`050_integration_verification.md`](./050_integration_verification.md).

## Status

`done — verified by consolidated Cycle A/B sweep, see 190 + 050 evidence`
