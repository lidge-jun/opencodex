# Cycle 160 — Router Max-input Trusted Baseline and Lowering

## Objective

For the API provider, router merging of `modelMaxInputTokens` uses
`mergePositiveNumberCaps` (min-wins) so user values can never raise the registry
baseline of 922K. Context windows for the API provider also use min-wins. Other
providers retain fill semantics.

## Scope

- `src/router.ts` `routedProviderConfig`: API provider uses `mergePositiveNumberCaps`
  for both `modelContextWindows` and `modelMaxInputTokens`
- Other providers use `mergeRecordFill` (user values can raise)
- Virtual model maps never appear on the route provider

## Activation tests

- `tests/provider-registry-parity.test.ts` "OpenAI API route max-input metadata"
  - User 1M → capped to 922K
  - User 300K → 300K (lowering allowed)
  - User context 2M → capped to 1.05M
  - User context 350K → 350K (lowering allowed)
  - No virtualModels on route provider

## Evidence

- See the Cycle A closure evidence below for the API-only min-wins correction and
  non-API regression; consolidated/final receipts are indexed by 190 and 050.

## Status

`done — closed by the Cycle A closure evidence below; see 190 + 050 evidence`

## Cycle A closure evidence (2026-07-17)

- `src/router.ts` now applies min-wins max-input merging only to `openai-apikey`;
  every other registry-backed provider uses normal user-override/registry-fill semantics.
- Regression `non-API route max-input metadata keeps user overrides and fills registry defaults`
  failed before the router fix (`100,000` received versus user `200,000`) and passes
  afterward; the existing API 1M→922K and 300K lowering assertions remain green in the
  266-test Cycle A matrix.
- This closes a routed-provider configuration latent contract defect only. No production
  consumer reads the merged routed `modelMaxInputTokens`; the effective catalog consumer
  remains the separate path in `src/codex/catalog.ts`.
