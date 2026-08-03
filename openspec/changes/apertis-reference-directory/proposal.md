## Why

The prior Apertis proposal registered an API-key preset and fixed upstream destination without
maintainer-visible evidence of routing/resale authorization. That would make a user-supplied key
and request flow through an unverified canonical integration.

## What Changes

- Remove the canonical Apertis provider preset and all derived key-login, CLI, dashboard, and
  model-discovery behavior.
- Add an inert `reference-only` directory row for Apertis that makes no pricing, entitlement,
  endpoint, documentation, or verification claim.
- Preserve a manually configured provider named `apertis` as an ordinary custom provider.

## Capabilities

### New Capabilities

- `provider-reference-directory`: represent unverified providers without registering a runtime
  route or claiming an access entitlement.

### Modified Capabilities

- None.

## Impact

- `src/providers/free-directory.ts` gains the reference-only directory category.
- Provider registry derivation, GUI preset classification, and request routing must not recognize
  Apertis as a catalog provider.
- Focused Bun tests replace the former canonical-provider behavior tests.
