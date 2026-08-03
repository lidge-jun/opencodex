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
- Run GUI ESLint commands under Bun so the repository's TypeScript local lint plugin loads during
  the documented validation and pre-push paths.

## Capabilities

### New Capabilities

- `provider-reference-directory`: represent unverified providers without registering a runtime
  route or claiming an access entitlement.
- `gui-lint-runtime`: execute GUI lint commands with a runtime that supports the repository's
  TypeScript ESLint configuration and local plugins.

### Modified Capabilities

- None.

## Impact

- `src/providers/free-directory.ts` gains the reference-only directory category.
- Provider registry derivation, GUI preset classification, and request routing must not recognize
  Apertis as a catalog provider.
- Focused Bun tests replace the former canonical-provider behavior tests.
- `gui/package.json` lint commands use Bun's runtime bridge instead of a Node-only ESLint launch.
