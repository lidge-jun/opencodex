# Cycle 1 — core contract, migration, routing, and auth

Depends on: `000_plan.md`
Exit gate: focused core suite green, including both `C-ACTIVATION-GROUNDING-01` scenarios
Change class: semantic production changes plus their owning tests

## Cycle objective

Make the backend incapable of publishing or routing a second Codex-login provider. Persist and
resolve `providers.openai.codexAccountMode`, migrate the shipped v1 split to version 2, keep the
existing pool engine intact for `pool`, and prove that `direct` returns before any pool path runs.

## Production diff manifest

### `MODIFY src/types.ts`

- Add `codexAccountMode?: CodexAccountMode` to `OcxProviderConfig` beside `authMode`; document that
  it is valid only on the canonical built-in `openai` forward provider and defaults to `pool`.
- Change `OcxConfig.openaiProviderTierVersion?: 1` to `?: 1 | 2`. Keep the property name for
  on-disk backward compatibility; its comment becomes “OpenAI provider-contract migration marker.”
- Change `OPENAI_PROVIDER_TIER_VERSION` from `1` to `2`.
- Keep `CodexAccountMode = "direct" | "pool"`; do not add a third/fallback state.

Before: account mode is registry-owned runtime metadata and is forbidden in provider JSON.
After: it is a validated, persisted policy on `providers.openai`; registry metadata supplies only
the default.

### `MODIFY src/config.ts`

- Extend `providerConfigSchema` with
  `codexAccountMode: z.enum(["pool", "direct"]).optional()` so invalid strings fail schema parsing
  instead of leaking through `.passthrough()`.
- Change `configSchema.openaiProviderTierVersion` to accept literals `1` and `2`.
- In `configSchema.superRefine`, reject `codexAccountMode` on every provider except canonical
  `openai`; reject it on `openai` when adapter/base URL/auth mode are not the built-in forward
  shape. Old `openai-multi` rows must remain parseable while marker is absent/1 so startup can
  migrate rather than dropping the config.
- Add `codexAccountMode: "pool"` to `getDefaultConfig().providers.openai`.
- Generalize `backupConfigBeforeOpenAiTierMigration` to target
  `${source}.pre-openai-tiers-v2.bak`. Preserve `OpenAiTierBackupIO`, byte-identity reuse,
  no-replace publication, mode 0600, Windows ACL hardening, rollback, and secret-residual errors.
  The v1 backup path is read only by restore docs/fixtures and is never reused as the v2 snapshot.
- Keep `mergeConfigDefaults` provider merging behavior; the runtime resolver must still default a
  manually authored mode-less `openai` row to pool before it is next saved.

### `MODIFY src/providers/registry.ts`

- Delete the `PROVIDER_REGISTRY` entry whose id is `openai-multi`.
- Change the `openai` entry from label `Codex Direct`, mode `direct`, and direct-only note to one
  Codex-login entry with `codexAccountMode: "pool"` and a note that Pool is default and Direct is
  selectable.
- (Symbol correction, audit fold-back A6) `providerConfigSeed` is owned by
  `src/providers/derive.ts:76`, not registry.ts — the two `providerConfigSeed` items below belong
  to the derive manifest: add `"codexAccountMode"` to `ProviderConfigSeed` so
  `providerConfigSeed(openaiEntry)` produces an explicit persisted `pool` seed, and update
  `providerConfigSeed` to copy `entry.codexAccountMode`.
- Change `providerCodexAccountMode` to accept the actual provider config:

  ```ts
  providerCodexAccountMode(id: string, provider?: OcxProviderConfig): CodexAccountMode | undefined
  ```

  For `id === "openai"`, return a valid persisted value or `"pool"`; for other entries preserve
  registry behavior (there is no mode for `openai-apikey`). Callers must pass the provider when
  resolving a runtime/DTO mode.

### `MODIFY src/providers/derive.ts`

- Update the `DerivedProviderPreset.provider` comment: only the canonical `openai` forward preset
  is reserved; there is no `openai-multi` preset.
- `deriveInitProviders`, `deriveProviderPresets`, `deriveFeaturedProviderIds`, and `entryToPreset`
  automatically emit one OpenAI Codex-login row after registry removal; verify its canonical seed
  includes `codexAccountMode: "pool"`.
- Update `formatInitLabel` for the forward entry to say the same provider supports Pool (default)
  and Direct; do not infer a separate choice from provider id.
- `enrichProviderFromRegistry` must not overwrite an explicit direct mode. If this function is used
  to hydrate mode, fill only when `prov.codexAccountMode === undefined`.

### `MODIFY src/providers/openai-tiers.ts`

This remains the migration/constant module; “tier” in the filename/property is retained solely for
backward compatibility.

- Rename `OPENAI_DIRECT_PROVIDER_ID` to `OPENAI_CODEX_PROVIDER_ID` (`"openai"`).
- Rename `OPENAI_MULTI_PROVIDER_ID` to `LEGACY_OPENAI_MULTI_PROVIDER_ID`
  (`"openai-multi"`). No non-migration module may import the legacy constant after this cycle.
- Keep `OPENAI_API_PROVIDER_ID` and `LEGACY_CHATGPT_PROVIDER_ID` values unchanged.
- Change `canonicalCodexForwardProvider()` to accept a mode and return the canonical transport plus
  `codexAccountMode`.
- Keep `isCanonicalOpenAiForwardProvider` transport-focused: it accepts either valid mode and still
  rejects key auth, custom base URLs, query/fragment credentials, or another adapter.
- Replace `managedMultiOverlay` with a migration-only parser for a legacy canonical Multi row. Its
  allowlist remains `adapter`, `authMode`, `baseUrl`, `disabled`, `selectedModels`; a persisted mode
  on the legacy id is not accepted.
- Extend `OpenAiTierMigrationProjection` with `warnings: string[]`; retain `legacyPoolIntent` only if
  tests/callers still need it, otherwise replace it with `resolvedMode: CodexAccountMode`.
- Rewrite `projectOpenAiTierMigration` according to `000_plan.md`:
  - marker 2 + canonical one-provider config is clone-only/idempotent;
  - marker 1 with `openai-multi` absorbs the row, resolves mode, maps defaults and all known model
    references, removes the row, and writes marker 2;
  - marker 1 with historical Direct only resolves to direct;
  - unmarked `chatgpt`/`openai` resolves directly to one pool-default `openai` row and never creates
    a transient Multi row;
  - noncanonical legacy Multi throws `OpenAiTierMigrationCollisionError` before mutation;
  - provider order is preserved at the original `openai` position, or inserted where the first
    legacy ChatGPT/Multi row occurred; unrelated providers remain byte-equivalent after JSON
    projection.
- Add private helpers with narrow responsibilities and direct unit coverage:
  `rewriteLegacyOpenAiSelectedId`, `rewriteLegacyOpenAiModelList`,
  `mergeLegacyOpenAiProviderRows`, and `rewriteLegacyOpenAiReferences` (exact names locked for the
  implementation unless an existing equivalent is found during the pre-write search).
- Unknown passthrough-field occurrences generate path-only warnings; never recursively rewrite
  arbitrary strings because provider secrets and free-form prompts are allowed in passthrough
  config.

### `MODIFY src/providers/openai-tier-startup.ts`

- Keep `runOpenAiTierStartupMigration` and `OpenAiTierStartupDeps` as the server startup boundary.
- Preserve strict order `project -> backup -> save` when `changed` is true and zero backup/save on
  collision or idempotent input.
- Make `DEFAULT_DEPS.backup` use the v2 backup path.
- After a successful save, emit `projection.warnings` through one path-only `console.warn` per
  warning. Do not warn before persistence succeeds.

### `MODIFY src/router.ts`

- Remove `OPENAI_MULTI_PROVIDER_ID` and the three-entry `OPENAI_TIER_ORDER`.
- In `routeResult`, call `providerCodexAccountMode(providerName, provider)` so explicit direct wins
  and a missing mode defaults to pool.
- In `routeModel`'s `isBareOpenAiFamilyModel` branch, select enabled `openai` only. If it is absent
  or disabled, throw `NoEnabledOpenAiTierError` (rename to `NoEnabledOpenAiProviderError` and update
  its message). Do not fall through to `openai-apikey`.
- Explicit `openai-apikey/<model>` keeps the current `routeResult` path and receives no
  `codexAccountMode`.
- Explicit `openai-multi/<model>` no longer matches after migration and returns the normal
  no-provider error. There is no runtime compatibility alias.

### `MODIFY src/codex/auth-context.ts`

- Keep the first branch of `resolveCodexAuthContext` as the direct-pin boundary:

  ```ts
  if (mode === "direct") {
    if (!hasCallerCodexBearer(headers)) throw new CodexDirectAuthenticationError();
    return { kind: "main", accountId: null };
  }
  ```

  It must remain before reading `x-codex-parent-thread-id`, calling
  `resolveCodexAccountForThreadDetailed`, reading quota, checking cooldown, importing
  `primeCodexPoolQuotas`, reading `getMainAccountToken`, or calling `getValidCodexToken`.
- The pool branch remains the only branch that calls `resolveCodexAccountForThreadDetailed`; it
  continues to produce `main-pool` for the main login and `pool` for added credentials.
- Keep `applyCodexAuthContextToProvider` guarded by `mode === "pool"`, so direct never receives
  `_codexAccountOverride` or `_codexAccountRequired`.
- Keep `headersForCodexAuthContext` forwarding caller headers for `kind: "main"` and replacing auth
  only for `pool`/`main-pool`.
- Rename user-facing `CodexPoolAuthenticationError` text from “Codex Multi-account” to “OpenAI
  account pool”; class renaming is optional only if every response/test import changes atomically.

### `MODIFY src/codex/routing.ts`

The selection algorithm is reused, not redesigned.

- Update comments/log text that call the pool a provider tier; it is now the `openai` pool mode.
- Preserve `getEligiblePoolAccounts` including `MAIN_CODEX_ACCOUNT_ID`,
  `resolveCodexAccountForThreadDetailed` affinity handling, `applyQuotaAutoSwitch`,
  `applyFailureFailover`, and `recordCodexUpstreamOutcome` unchanged semantically.
- Direct mode must never call this module from `resolveCodexAuthContext`. Do not add mode checks
  inside these functions; the auth-context branch is the single ownership boundary.
- Keep `formatCodexProviderForLog(providerName, accountId, config)` so pool requests aggregate under
  `openai` (or `openai-<safe-label>` for an added account), never under `openai-multi`.

### `MODIFY src/codex/catalog.ts`

- Delete `projectNativeModelsForOpenAiMulti` and its `OPENAI_MULTI_PROVIDER_ID` import.
- In `gatherRoutedModels`, delete `multiProvider` discovery and `multiModels` concatenation. Native
  OpenAI rows remain owned by the existing native-catalog path and are bare.
- Keep `augmentRoutedModelsWithRegistryOpenAiApiRows` unchanged for `openai-apikey`, including the
  exact eight rows and Pro aliases.
- A config containing only migrated `openai` produces no routed duplicate of a native slug.

### `MODIFY src/providers/openai-sidecar.ts`

- Narrow `OpenAiForwardSidecarCandidate.providerName` to `OPENAI_CODEX_PROVIDER_ID` only.
- `listOpenAiForwardSidecarCandidates` reads only `config.providers.openai`; when canonical and
  enabled it returns exactly one candidate whose `accountMode` comes from
  `providerCodexAccountMode("openai", provider)`.
- Preserve `resolveFirstUsableOpenAiSidecar` admission-bearer protection and outcome recording. In
  direct mode it requires a caller bearer; in pool mode it may inject the selected main/added
  credential. It never tries a second Codex provider.
- `selectOpenAiImagesProvider` keeps the independent keyed candidate unchanged. A configured pool
  auth failure still owns its auth failure rather than silently charging the API key.

### `MODIFY src/codex/auth-api.ts`

- In `primeCodexPoolQuotas`, replace the `config.providers[OPENAI_MULTI_PROVIDER_ID]` gate with a
  canonical enabled `openai` whose resolved mode is `pool`.
- Direct mode returns before WHAM fetches, pool account iteration, or `primeInFlight` creation.
- Preserve single-flight, TTL, timeout, and best-effort failure behavior.

### `MODIFY src/providers/quota.ts`

- Change `isBuiltInChatGptForwardProvider` to recognize canonical `openai`, not legacy Multi.
- `maybeFetchProviderQuota` returns one report keyed `openai`.
- In `fetchChatGptForwardQuota`, pool mode reports the active eligible account; direct mode reports
  `MAIN_CODEX_ACCOUNT_ID` only and ignores `activeCodexAccountId`.
- Mode-aware Direct isolation (audit fold-back A3): the current owner at
  `src/providers/quota.ts:111` calls `listCodexAuthAccounts`, which reads and may refresh EVERY
  added account (`src/codex/auth-api.ts:353`). In direct mode the quota path must resolve
  main-only without touching the added-account store. The quota cache key
  (`src/providers/quota.ts:50`) must include the resolved account mode, and the management mode
  PATCH must invalidate this cache (mirrored in 020's PATCH behavior) so a stale Pool report is
  never displayed under Direct.
- Keep all non-OpenAI provider reports and API-key behavior unchanged.

### `MODIFY src/oauth/token-guardian.ts`

- (Audit fold-back A3) The guardian warmup at `src/oauth/token-guardian.ts:150` is still keyed to
  the removed internal id `chatgpt` and iterates the added-account store unconditionally. Re-key
  it to canonical `openai` and make it mode-aware: pool mode warms main plus added accounts;
  direct mode warms main only and never iterates the added-account store.
- Add `tests/token-guardian.test.ts` coverage: pool-mode warmup touches added accounts, direct-mode
  warmup provably does not (spy/counter on the account-store read).

### `MODIFY src/providers/label.ts` and usage read-time tolerance

- (Audit fold-back A4) `baseProviderLabel` (`src/providers/label.ts:3`) canonicalizes `chatgpt`
  but not `openai-multi`, and all usage grouping flows through it
  (`src/usage/summary.ts:177,253`). Add read-time canonicalization: historical `openai-multi`
  (and safe account-labelled variants) map to `openai` so pre-migration Pool usage merges with
  post-migration usage under one identity. Usage and request-log FILES are never mutated.
- Add `tests/usage-provider-label.test.ts`: historical `openai-multi` rows group under `openai`;
  `openai-apikey` rows remain distinct.

### `MODIFY src/server/index.ts`

- Replace the startup literal `config.providers["openai-multi"]` gate with enabled canonical
  `openai` + resolved mode `pool` before calling `primeCodexPoolQuotas(config, "startup")`.
- Do not change listener selection or lifecycle. Runtime smoke must use `port: 0`; the live 10100
  process is out of scope.

### `MODIFY src/server/images.ts` and `MODIFY src/server/search.ts`

- Replace literal `formatCodexProviderForLog("openai-multi", ...)` with the resolved candidate's
  `providerName` (`openai`) in `CodexAuthContextError` handling.
- Rewrite comments/error copy from “configured Multi tier” to “configured OpenAI pool mode.”
- Keep image API-key fallback rules and search’s forward-only rule unchanged.

## Migration test matrix

The projection suite must cover all of these inputs and exact outputs:

| Input | Result |
| --- | --- |
| unmarked minimal `openai` | one canonical `openai`, explicit `pool`, marker 2 |
| unmarked `chatgpt` with/without added accounts | one canonical `openai`, `pool`, hidden `chatgpt`, no transient Multi |
| marker 1, Direct-only `openai` | one `openai`, `direct`, marker 2 |
| marker 1, enabled `openai-multi` | one `openai`, `pool`, legacy row removed |
| marker 1, default `openai-multi` | default mapped to `openai`, mode `pool` |
| marker 1, disabled Multi + enabled Direct and no Multi references | one enabled `openai`, mode `direct` |
| marker 1, NEITHER `openai` nor `openai-multi` present (fold-back A1) | absence preserved — no `openai` created, marker 2 |
| marker 1, disabled-Multi-ONLY (no `openai` row) (fold-back A1) | one `openai`, mode `pool`, `disabled: true` preserved |
| marker 1, Direct-only + stale `activeCodexAccountId` (fold-back A1) | one `openai`, `direct`; stale active id cleared or ignored, defined and tested |
| marker 1, no provider + stale pool state (fold-back A1) | absence preserved; pool state untouched |
| `claudeCode.model` / `smallFastModel` / `tierModels.*` / `modelMap` destinations containing Multi ids (fold-back A2) | exact bare-id rewrite; `modelMap` source keys never rewritten |
| both rows with `selectedModels` | stable union, no duplicates |
| both provider context caps | lower positive cap on `openai`, path-only warning |
| `disabledModels` / `subagentModels` arrays containing namespaced Multi ids | bare ids, stable order, deduplicated |
| injection/shadow/global sidecar/Claude sidecar model references | exact bare id rewrite |
| canonical row plus unknown passthrough path containing Multi id | known paths migrate, unknown path remains, path-only warning |
| noncanonical/secret-bearing Multi row | collision, input unchanged, no backup/save |
| marker 2 canonical result | `changed: false`, deep-equal clone, no warning |
| restore v2 backup | marker 1/old split parses, next startup recreates same marker-2 bytes and reuses backup only when byte-identical |

## Existing test-file changes (exhaustive current inventory)

The following existing tests contain the old contract or must own a new branch. Renames are
performed with history preservation; no stale duplicate remains.

| Existing path | Required change |
| --- | --- |
| `tests/openai-provider-tiers.test.ts` | Rename to `tests/openai-provider-option.test.ts`; assert only `openai` + `openai-apikey`, pool default, direct override, marker 2, no Multi registry/preset/init row. |
| `tests/openai-provider-tier-migration.test.ts` | Rename to `tests/openai-provider-option-migration.test.ts`; replace split creation tests with the full matrix above, including all selected-id/sidecar rewrites and collision/idempotence. |
| `tests/openai-tier-startup.test.ts` | Rename to `tests/openai-provider-option-startup.test.ts`; retain atomic/secret-safe tests but use `.pre-openai-tiers-v2.bak`, marker 2, warnings-after-save, and v1 backup non-overwrite. |
| `tests/router.test.ts` | Remove explicit Multi route/order assertions; assert bare ids use `openai` mode (missing=>pool, explicit direct=>direct), API stays namespaced, and legacy namespace fails. |
| `tests/codex-routing.test.ts` | Add main-vs-added quota-pressure case and retain affinity/quota/cooldown/failover behavior as the pool-mode engine. |
| `tests/server-auth.test.ts` | Rewrite management and auth matrices for one provider; add the two activation tests below; keep API auth, HTTP/SSE/compact/WS isolation. |
| `tests/codex-catalog.test.ts` | Delete Multi projection/context-cap rows; assert one bare native group, no `openai-multi/*`, and unchanged API rows. |
| `tests/codex-quota-prime.test.ts` | Gate priming on `openai` pool mode; assert direct mode makes zero prime fetches. |
| `tests/provider-quota.test.ts` | Expect one `openai` report; assert pool reports active member and direct reports main. |
| `tests/server-images.test.ts` | Replace Direct-then-Multi fixtures with one mode-aware forward candidate; keep API fallback and pool-auth ownership cases. |
| `tests/server-search.test.ts` | Use `openai` pool/direct fixtures and log owner `openai`; legacy namespace is absent. |
| `tests/web-search.test.ts` | Replace the old candidate provider name with `openai` pool mode. |
| `tests/vision-sidecar-e2e.test.ts` | Update marker/config fixtures and prove the single candidate’s mode controls credentials. |
| `tests/openai-api-virtual-models.test.ts` | Remove Multi from non-API matrices; keep all API Pro identity/context/max-input assertions byte-for-byte equivalent. |
| `tests/oauth-public-surface.test.ts` | Update marker-1 fixture to marker 2 or explicitly label it as migration input; no public Multi id. |
| `tests/claude-models-discovery.test.ts` | Update config marker/shape; expected model list has only bare `openai` plus namespaced API. |
| `tests/claude-messages-endpoint.test.ts` | Replace Multi default fixture with `openai` pool mode and bare selected ids. |

Cycle 2 owns `tests/provider-registry-parity.test.ts`, `tests/provider-payload.test.ts`, and
`tests/codex-multi-state.test.ts`. Cycle 3 owns the integration/tooling files and renamed child
fixtures listed in `030_verification_closeout.md`.

## Activation scenarios (`C-ACTIVATION-GROUNDING-01`)

### A. Missing mode defaults to pool and rotates to a non-main eligible account

Owner: `tests/server-auth.test.ts`, backed by the account-ranking assertion in
`tests/codex-routing.test.ts`.

Fixture:

- temporary `OPENCODEX_HOME` and `CODEX_HOME`;
- canonical `providers.openai` with no `codexAccountMode` field;
- usable main auth token and one usable added account credential;
- main quota above `autoSwitchThreshold`, added account quota below it;
- `activeCodexAccountId` initially main;
- intercepted ChatGPT upstream, no public network.

Action: POST a bare `gpt-5.6-sol` request to an isolated server.
Proof: upstream receives the added account bearer/account id, config active id changes to that
account, requested/wire model stays bare, and no `openai-multi` string appears in route/log/catalog.
This test fails if missing mode resolves direct or if the pool engine never activates.

### B. Explicit direct never touches pool state

Owner: `tests/server-auth.test.ts` with a focused `resolveCodexAuthContext` assertion.

Fixture:

- `providers.openai.codexAccountMode: "direct"`;
- a valid caller bearer;
- populated added-account store, active id, quota, cooldown, reauth, and thread-affinity state;
- hashes/snapshots of `config.json`, `codex-accounts.json`, account credential files, quota/health
  maps, and active id before request.

Action: send HTTP, compact, and one Responses WebSocket turn with a bare model. When the mode is
set through the management PATCH, take the no-mutation baseline snapshots AFTER the PATCH
completes (audit fold-back: the PATCH itself intentionally saves config and clears affinity, so a
pre-PATCH baseline would produce false mutation diffs).
Proof: every upstream call uses the caller bearer with no injected `chatgpt-account-id`; all pool
snapshots/hashes and active id are unchanged; no quota-prime fetch occurs; the request succeeds even
when every pool account is unusable. This test fails if the direct branch moves below thread-id,
quota, cooldown, main-pool-token, or account-store resolution.

## Cycle 1 acceptance criteria

- Registry/presets/init expose no `openai-multi`.
- Fresh/mode-less `openai` resolves pool; explicit direct resolves direct.
- V1 split migrates to one row with a v2 backup and idempotent marker 2.
- Every known selected-id sidecar location is rewritten to bare ids.
- Bare ids never credential-fallback to `openai-apikey`.
- Pool mode demonstrably rotates main + added accounts under quota pressure.
- Direct mode demonstrably leaves all pool state untouched.
- Native catalog has no namespaced Multi duplicates; API rows/aliases/metadata are unchanged.
- Focused command exits 0 before Cycle 2:

  ```sh
  bun test --isolate \
    tests/openai-provider-option.test.ts \
    tests/openai-provider-option-migration.test.ts \
    tests/openai-provider-option-startup.test.ts \
    tests/router.test.ts \
    tests/codex-routing.test.ts \
    tests/server-auth.test.ts \
    tests/codex-catalog.test.ts \
    tests/codex-quota-prime.test.ts \
    tests/provider-quota.test.ts \
    tests/server-images.test.ts \
    tests/server-search.test.ts
  ```

## Cycle 1 closeout receipt — 2026-07-18

- Implementation commit: `4da9c167`.
- The Cycle 3 superset focused command re-ran every Cycle 1 owner and completed with 309 pass,
  0 fail.
- Full isolated suite completed with 2,850 pass, 0 fail.
- The renamed migration child additionally proves shipped-v1 absorption, marker 2, v2 backup mode
  and byte identity, v1-backup preservation, every known selected-id rewrite, stable deduplication,
  lower context cap, path-only warnings, actual restore/re-migration, no-save idempotence,
  absence preservation, and pre-save backup collision.

Terminal status: **PASS**.
