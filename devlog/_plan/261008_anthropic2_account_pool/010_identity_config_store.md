# 010 — Identity, configuration, auth store, OAuth (wp2)

## Registry and identity

- `src/providers/registry/types.ts`: add `oauthFamily?: "anthropic"` to the registry entry type;
  classify it `NONE` in `src/providers/registry/model-ids.ts` (exhaustive field map).
- `src/providers/anthropic-instance.ts` (new): the contract from 000. The predicate reads the registry
  entry by exact ID and requires `authKind: "oauth"`, `oauthId === id`, `oauthFamily === "anthropic"`.
- `src/providers/registry/entries-core.ts`: replace the inline `anthropic` row with
  `anthropicOAuthEntry(id, label)`; add `anthropic2` with label "Anthropic · Pool 2", note
  "Independent Claude account pool", `featured`/preset exposure as for A, fresh copies of every array
  and map. `jawcodeBundle` stays `anthropic` so generated metadata aliases B to the family.
- `src/generated/model-metadata.ts`: regenerated alias only through `scripts/generate-model-metadata.ts`
  semantics (`anthropic2 -> anthropic`), not a hand-written bundle.

## Configuration

- `src/types/anthropic-account-pool.ts` (new leaf): `AnthropicAccountPoolConfig` extracted from
  `OcxConfig.anthropicAccountPool`; `OcxProviderConfig.anthropicAccountPool?` added for B.
- `src/oauth/anthropic-pool-config.ts` (new): `resolveAnthropicAccountPoolConfig(config, instance)`
  returns the raw object of that instance (or `{}`); `isAnthropicPoolEnabledFor(config, instance)`.
- `src/config/schema/*`: one shared pool schema for both locations; B's nested field validated;
  validated writes reject the field on `providers.anthropic` and on non-B providers.
- `src/config/diagnostics.ts`: pool diagnostics run per location; a misplaced field is a reported
  error, never silently ignored. B is not added to defaults or created by migrations.
- `src/types/config.ts`: optional `anthropicInstance?: AnthropicInstanceId` on `webSearchSidecar`,
  `visionSidecar` and the Claude-origin sidecar overrides; validation rejects it with a
  non-Anthropic backend. Absence is preserved on save.

## Auth store and OAuth

- `src/oauth/index.ts` is at 1996/1999 lines: the OAuth provider definition for both instances moves to
  a sibling (`src/oauth/anthropic-oauth-definitions.ts`) built by one factory. B's definition passes
  `importLocal: "off"` always; refresh dispatch uses `isAnthropicOAuthInstance(provider)` and keeps the
  real provider argument.
- `src/oauth/anthropic-continuity.ts`: `captureAnthropicCredentialOwner(instance, ...)` reads
  `store[instance]`; `newerClaudeCredential` returns nothing for B before touching disk/Keychain.
- `src/oauth/store.ts`: `setAnthropicAccountThresholdForInstance(instance, ...)` (old name kept as A wrapper);
  `assertNoCrossAnthropicRegistration(store, instance, credential)` runs inside
  `saveCredentialWithReceipt`, `saveAccountCredential` and `upsertCredentialByIdentity` before any row
  changes. It compares SHA-256 fingerprints of non-empty access/refresh tokens against every row of the
  other instance (paused included) and verified UUIDs only when both proofs validate against their own
  bearer. Email, alias and unverified account IDs are ignored. It throws a credential-free typed error.
  B `local-cli` provenance is rejected. Refresh-time merges are not blocked (rotations of an already
  admitted row must not strand A).
- Collision (D-09): every config-aware decision uses `isBuiltinAnthropicInstanceRow` (adapter `anthropic`,
  `authMode: oauth`, `baseUrl` absent or `https://api.anthropic.com`). Login, OAuth upsert and config
  publication for `anthropic2` refuse a row that fails it; startup catalog reconciliation and registry
  enrichment (`src/providers/registry.ts` lookups for a configured row) leave such a row custom.
- `src/oauth/token-guardian.ts`: B participates only when configured and enabled.

## Tests (new files, registered in both layout inventories)

- `tests/providers/anthropic-instance.test.ts` — exact IDs, `anthropic-apikey`/compatible adapters excluded, B seed is a deep copy, B absent from default config.
- `tests/config/anthropic-instance-pool-config.test.ts` — A/B locations, no inheritance, misplaced field rejected, `anthropicInstance` validation.
- `tests/oauth/oauth-anthropic-instance-registration.test.ts` — duplicate token / verified UUID rejected across instances, distinct accounts with equal IDs accepted, B local-cli refused, collision guard.
