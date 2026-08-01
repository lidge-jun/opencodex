# Cycle 010 — Non-activating OpenAI Tier Foundation

## Objective and phase safety

Add reusable typed policy, pure migration projection, and native-catalog projection
without exposing `openai-multi` in registry, config, routing, CLI, management, or GUI.
After this cycle, user-visible behavior is byte-compatible with the baseline. Public
activation happens atomically in Cycle 020 with route-aware auth.

## File change map

### MODIFY `src/types.ts`

Add:

```ts
export type CodexAccountMode = "direct" | "pool";
export const OPENAI_PROVIDER_TIER_VERSION = 1;
```

Extend `OcxConfig` with `openaiProviderTierVersion?: 1`. Do not add
`codexAccountMode` to persisted `OcxProviderConfig`; built-in account ownership is
trusted code metadata, not user configuration.

Before: any forward Responses provider can consume the global pool.
After: the type vocabulary exists, but no current provider is assigned `pool` and no
runtime caller changes behavior in this cycle.

### NEW `src/providers/openai-tiers.ts`

Own these constants and pure functions:

```ts
export const OPENAI_DIRECT_PROVIDER_ID = "openai";
export const OPENAI_MULTI_PROVIDER_ID = "openai-multi";
export const OPENAI_API_PROVIDER_ID = "openai-apikey";
export const LEGACY_CHATGPT_PROVIDER_ID = "chatgpt";

export function builtInCodexAccountMode(providerName: string): CodexAccountMode | undefined;
export function isCanonicalOpenAiForwardProvider(provider: OcxProviderConfig): boolean;
export function projectOpenAiTierMigration(config: OcxConfig): { config: OcxConfig; changed: boolean; legacyPoolIntent: boolean };
```

Contracts:

- `builtInCodexAccountMode("openai")` is `direct`; `openai-multi` is `pool`;
  all other ids return `undefined`.
- `isCanonicalOpenAiForwardProvider` requires adapter `openai-responses`, auth mode
  `forward`, and normalized base exactly
  `https://chatgpt.com/backend-api/codex`.
- `projectOpenAiTierMigration` deep-clones the config and never writes disk.
- With marker absent, pool intent is true when `codexAccounts` is nonempty or
  `activeCodexAccountId` is set.
- It removes any own configured `chatgpt` provider row regardless of adapter, auth,
  base URL, or extra fields, then maps a `chatgpt` default to
  `openai-multi` when pool intent is true and otherwise `openai`, seeds canonical
  Direct, seeds Multi only for pool intent, preserves provider insertion order for
  all non-legacy rows, sets marker 1, and copies no credential values.
- Removing the provider row never deletes or edits the separate OAuth credential store.
  API keys/tokens found on a malformed or noncanonical row are discarded with that row
  and are never copied into Direct, Multi, or any other provider.
- When pool intent is true and the legacy default is `openai`, it rewrites
  `defaultProvider` to `openai-multi`. This preserves the old pooled behavior. With no
  pool intent, an `openai` default remains Direct.
- With marker 1, it is a no-op. Deliberately removed Multi is never resurrected.
- With marker absent and an existing exact canonical `openai-multi` row, preserve it
  even without inferred pool intent because it is explicit user configuration. If the
  reserved id has any noncanonical or extra-field shape, throw
  `OpenAiTierMigrationCollisionError` before projecting; never overwrite or discard
  that row's credentials/configuration.

### MODIFY `src/codex/catalog.ts`

Export a read-only/no-network, currently uncalled helper:

```ts
export function projectNativeModelsForOpenAiMulti(
  config: OcxConfig,
  provider: OcxProviderConfig,
  nativeSlugs?: readonly string[],
  nativeTemplate?: Record<string, unknown> | null,
): CatalogModel[];
```

The default `nativeSlugs` value is a snapshot from `nativeOpenAiSlugs()`; tests inject
a fixed snapshot so native catalog drift cannot make them nondeterministic. The default
`nativeTemplate` is `loadCatalogTemplate()`; a null test seam exercises the no-installed-
catalog fallback. Existing `buildCatalogEntries` authoritative/fallback logic plus native
context and upstream reasoning metadata helpers build the rows. Output rows use
provider `openai-multi` and retain native context/modalities/efforts; provider context
caps are applied by the existing hint/cap path. The helper is read-only and performs
no network request. It does not call ChatGPT `/models` and never reads OpenAI API
registry metadata. `gatherRoutedModels` does not call it until Cycle 020.

## Explicitly unchanged in 010

- `src/providers/registry.ts`
- `src/providers/derive.ts`
- `src/router.ts`
- `src/config.ts::loadConfig` and `src/server/index.ts::startServer`
- `src/codex/auth-context.ts`, HTTP, WS, compact, management, CLI, and GUI

This exclusion is the phase-safety gate: no selectable Multi row can exist while auth
is still route-blind.

## Tests

### NEW `tests/openai-provider-tiers.test.ts`

- exact id/mode constants;
- canonical forward shape accepts one exact transport and rejects changed adapter,
  auth mode, base, and trailing path;
- current registry/presets/config still expose no `openai-multi` after Cycle 010.

### NEW `tests/openai-provider-tier-migration.test.ts`

Drive the pure projection with fixtures for fresh config, no-pool legacy config,
added-account pool, explicit main id, canonical `chatgpt`, noncanonical key-auth/custom-
base `chatgpt`, extra-field `chatgpt`, legacy `chatgpt` default, custom default, marker
1, removed Multi, provider ordering, and redacted sentinel credentials.
The added-account and explicit-main fixtures both start with
`defaultProvider: "openai"` and assert projected Multi default; a second projection
asserts marker-1 idempotence.
Assert projected providers have no own `chatgpt` key, nonlegacy relative order is
unchanged, default mapping is correct with and without pool intent, input objects remain
byte-identical, and no row credential sentinel is copied. A separate OAuth-store
sentinel fixture proves the projection neither receives nor mutates credential storage.
Add exact-canonical preexisting Multi with no pool intent (preserved) and noncanonical
key/custom-base/extra-field Multi collisions (typed throw, serialized input and secret
sentinels unchanged).

### MODIFY `tests/codex-catalog.test.ts`

Call the helper with every supported slug, an injected fixed native-slug snapshot, and
both real and null native templates. Prove namespaced ids, native-source/fallback
context-modalities-efforts, provider caps, and API-metadata isolation. Also prove normal
`gatherRoutedModels` still emits no Multi rows in this cycle.

## Verification and acceptance

```sh
bun test tests/openai-provider-tiers.test.ts tests/openai-provider-tier-migration.test.ts tests/codex-catalog.test.ts
bun x tsc --noEmit
```

Accept only when all pure contracts pass and a catalog/preset snapshot proves no
user-visible Multi activation. Rollback is deletion of the new module/tests and the
two additive type members; no config has been persisted.

## Terminal closeout

`done` — landed in `3f6caeb2`; final cross-tier proof and terminal criteria are indexed in
[`050_integration_verification.md`](./050_integration_verification.md),
[`190_consolidated_finish_plan.md`](./190_consolidated_finish_plan.md), and the `051` audit.
