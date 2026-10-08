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
  `authMode: oauth`, explicit `anthropicOAuthInstance: "anthropic2"` for B). Login, OAuth upsert and config
  publication for `anthropic2` refuse a row that fails it; startup catalog reconciliation and registry
  enrichment (`src/providers/registry.ts` lookups for a configured row) leave such a row custom.
- `src/oauth/token-guardian.ts`: B participates only when configured and enabled.

## Tests (new files, registered in both layout inventories)

- `tests/providers/provider-anthropic-instance.test.ts` — exact IDs, `anthropic-apikey`/compatible adapters excluded, B seed is a deep copy, B absent from default config.
- `tests/config/config-anthropic-instance-pool.test.ts` — A/B locations, no inheritance, misplaced field rejected, `anthropicInstance` validation.
- `tests/oauth/oauth-anthropic-instance-registration.test.ts` — duplicate token / verified UUID rejected across instances, distinct accounts with equal IDs accepted, B local-cli refused, collision guard.

## wp2 execution

Shared leaf code (main writes it first, so both workers import a fixed contract):

```ts
// src/providers/anthropic-instance-id.ts — no imports (registry.ts may import this leaf; it must never import anthropic-instance.ts)
export const ANTHROPIC_INSTANCE_IDS = ["anthropic", "anthropic2"] as const;
export type AnthropicInstanceId = typeof ANTHROPIC_INSTANCE_IDS[number];
export function isAnthropicInstanceId(value: unknown): value is AnthropicInstanceId;
export function anthropicInstanceRowShapeMatches(name: string, row: { adapter?: string; authMode?: string; baseUrl?: string; anthropicOAuthInstance?: unknown } | undefined): boolean;
//   pure; "anthropic": true; "anthropic2": row present, adapter "anthropic", authMode "oauth",
//   own anthropicOAuthInstance marker equals "anthropic2"; endpoint is not ownership; other names: false

// src/providers/anthropic-instance.ts
export function isAnthropicOAuthInstance(id: string): id is AnthropicInstanceId;   // exact ID + registry oauthFamily/oauthId/authKind
export function isBuiltinAnthropicInstanceRow(name: string, row?: Partial<Pick<OcxProviderConfig, "adapter" | "authMode" | "baseUrl" | "anthropicOAuthInstance">>): boolean;
//   isAnthropicOAuthInstance(name) && anthropicInstanceRowShapeMatches(name, row); re-exports the leaf
export function configuredAnthropicInstance(config: Pick<OcxConfig, "providers">, name: string | undefined): AnthropicInstanceId | undefined;
//   anthropic: "anthropic" whenever name === "anthropic" — a compatibility identity result only; callers keep
//   every existing auth-mode, enabled-provider and eligibility check they apply to A today;
//   anthropic2: only when the row exists, is not disabled and passes isBuiltinAnthropicInstanceRow

// src/oauth/anthropic-pool-config.ts
export function rawAnthropicAccountPool(config, instance): unknown;          // A: config.anthropicAccountPool; B: providers.anthropic2.anthropicAccountPool
export function resolveAnthropicAccountPoolConfig(config, instance): AnthropicAccountPoolConfig; // object or {}
export function isAnthropicPoolEnabledFor(config, instance): boolean;
```

P3 fidelity refinement supersedes the initial endpoint-shaped rule: both registry rows keep
`allowBaseUrlOverride: true`. Explicit B creation seeds its ownership marker; config load, enrichment,
reconciliation and migrations never stamp it onto an existing custom row. Browser-only local credential
intake remains the owner-approved onboarding exception.

Registry ownership guard: `providerMatchesRegistryTransport` in `src/providers/registry.ts` today returns
`true` for every non-key entry. For `anthropic2` it must first return
`anthropicInstanceRowShapeMatches("anthropic2", provider)`, so a colliding custom row is never pinned or
enriched as the builtin. `registry.ts` stays within its 232-line cap (move code to a sibling if needed).

The pool config type leaf `src/types/anthropic-account-pool.ts` carries `AnthropicAccountPoolConfig`
together with the rotation-strategy, quota-window and model-route types it references; `config.ts` imports
and re-exports them, never the reverse.

W2-oauth keeps the old continuity and threshold signatures as A wrappers and adds distinct
`...ForInstance` variants; A's existing refresh and import behaviour is pinned by fixtures in its new tests.
Routing/native callers stay with wp3; wp2 proves the foundation contracts, not runtime B readiness.

| Worker | Owns (exclusive writes) | New tests |
|---|---|---|
| W2-config | `src/providers/registry/types.ts`, `registry/model-ids.ts`, `registry/entries-core.ts`, `src/providers/registry.ts` (232-line baseline cap: net growth 0), `src/providers/derive.ts`, `src/types/anthropic-account-pool.ts` (new), `src/types/config.ts`, `src/types/provider.ts`, `src/config/schema/*`, `src/config/diagnostics.ts`, `src/generated/model-metadata.ts` (generator output only) | `tests/providers/provider-anthropic-instance.test.ts`, `tests/config/config-anthropic-instance-pool.test.ts` |
| W2-oauth | `src/oauth/index.ts` (1996/1999: extract first), `src/oauth/anthropic-oauth-definitions.ts` (new), `src/oauth/store.ts`, `src/oauth/store-anthropic-instance.ts` (new, duplicate guard), `src/oauth/anthropic-continuity.ts`, `src/oauth/anthropic.ts`, `src/oauth/token-guardian.ts`, `src/oauth/login-cli.ts` | `tests/oauth/oauth-anthropic-instance-registration.test.ts`, `tests/oauth/oauth-anthropic-instance-refresh.test.ts` |

Main owns the leaf files above, both layout inventories and every `structure/` edit. Workers do not run tests,
typecheck, lint or builds; the only local command allowed besides read/search is the deterministic
model-metadata generator. Workers report the layout entries their new tests need.

### wp2 audit fold (reviewer near-pass)

- Ownership: main writes, before dispatch, exactly `src/providers/anthropic-instance-id.ts`,
  `src/providers/anthropic-instance.ts`, `src/oauth/anthropic-pool-config.ts` and
  `src/types/anthropic-account-pool.ts`. W2-config edits `src/types/config.ts` to import/re-export the type
  leaf and owns any sibling extracted from `src/providers/registry.ts` (e.g. `src/providers/registry-transport.ts`).
- Publication atomicity: B login publishes its provider row through `mutatePersistedConfig`, rechecking
  `anthropicInstanceRowShapeMatches` against the latest persisted row inside the callback. The shape is also
  checked before the browser opens and before credentials persist. If a competing writer claims the name in
  between, publication refuses with a typed error, the custom row is left untouched, and the B credential just
  written stays as an orphan auth row that no request can use (orphan rows are never execution candidates);
  the error tells the user to remove it or rename the custom provider. A deterministic competing-write case goes
  in `oauth-anthropic-instance-registration.test.ts`.
- Load versus write: the shared pool schema keeps A's tolerant load semantics exactly (malformed
  `nativeMessages` loads as `false`, a malformed pool container loads as absent, unrelated providers survive)
  and applies the same tolerance to B's nested field; strict rejection applies only to validated writes and
  diagnostics. W2-config adds A and B cases for both paths next to `tests/config/config-load-degrade.test.ts`
  behaviour in `tests/config/config-anthropic-instance-pool.test.ts`.
