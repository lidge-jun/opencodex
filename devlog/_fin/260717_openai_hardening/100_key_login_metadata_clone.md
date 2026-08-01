# Cycle 100 — Key-login DTO and CLI Config Metadata Clone

## Objective

Thread `modelMaxInputTokens` through the key-provider DTO and CLI-created provider
config using independent clones. `virtualModels` remains registry-private and must
be absent from both DTO and persisted config.

## Scope

- `DerivedKeyLoginProvider` in `src/providers/derive.ts` carries `modelMaxInputTokens`
- `KeyLoginProvider` extends `DerivedKeyLoginProvider` (single type)
- `deriveKeyLoginMap` clones `modelMaxInputTokens` from registry entry
- `providerConfigFromKeyLoginProvider` in `src/oauth/login-cli.ts` clones max-input map
- `providerConfigSeed` includes `modelMaxInputTokens` in `ProviderConfigSeed` type
- Neither DTO nor CLI config carries `virtualModels`
- Clone independence: mutating the derived map does not alter the source

## Activation tests

- `tests/provider-registry-parity.test.ts` "key-login export" assertions
  - 8 models in openai-apikey, no virtualModels on DTO, independent clone
- `tests/umans-provider.test.ts` "OpenAI API key-login clones max-input metadata"
  - Clone present, source untouched after mutation, no virtualModels

## Evidence

- Consolidated implementation and activation evidence is indexed in
  [`190_consolidated_finish_plan.md`](./190_consolidated_finish_plan.md), with the final
  Cycle-B integration and gate receipts in [`050_integration_verification.md`](./050_integration_verification.md).

## Status

`done — verified by consolidated Cycle A/B sweep, see 190 + 050 evidence`
