# OpenAI single-provider account-mode reversal

Status: `PLAN ONLY`
Unit: `devlog/_plan/260717_openai_single_provider_option`
Grounded tree: `519a6a69`
Controls: `LEXICO-SPLIT-01`, `DIFFLEVEL-ROADMAP-01`, `C-ACTIVATION-GROUNDING-01`

## Objective

Replace the public `openai` / `openai-multi` provider split with one built-in Codex-login provider,
`openai`. Its persisted provider-level option is:

```ts
codexAccountMode: "pool" | "direct"
```

`"pool"` is the fresh-install and missing-field default. It rotates the main Codex login and every
added Codex account through the existing affinity, quota, cooldown, reauthentication, and failover
engine. `"direct"` pins the current/main Codex login and must short-circuit before any pool lookup or
pool-state mutation.

`openai-apikey` and its exact eight-model catalog, API-key/key-pool ownership, GPT-5.6 metadata,
Pro virtual aliases, selected-id preservation, and wire rewriting remain unchanged.

This unit is a diff-level implementation roadmap. It authorizes no production edit, live-proxy
restart, push, release, or mutation of `devlog/_fin/260717_openai_hardening`.

## User decision record

The following decisions are final for implementation:

1. `openai-multi` is removed as a public/configurable provider and model namespace.
2. `providers.openai.codexAccountMode` owns account selection for all bare native OpenAI ids.
3. The default is `"pool"`; pool mode includes the main login as an ordinary eligible member.
4. `"direct"` is main-only and never consults account affinity, account-store credentials, pool
   quota, cooldown, health, or active-account state.
5. `openai-apikey` and `openai-apikey/gpt-5.6-{sol,terra,luna}-pro` stay exactly as they are.
6. The Models page shows one `openai` group with bare ids; it must not synthesize
   `openai-multi/<model>` rows.
7. The Codex Auth banner reports the current `openai` option (`pool` or `direct`) and no longer asks
   the user to add/enable an `openai-multi` provider.
8. The live proxy on `127.0.0.1:10100` must never be stopped or restarted. All runtime and render
   verification uses isolated child processes with temporary homes and kernel-assigned ports.

## Locked contract

| Public provider id | Selected model identity | Credential owner | Account rule | Mutable setting |
| --- | --- | --- | --- | --- |
| `openai` | bare ids such as `gpt-5.6-sol` | Codex login/account store according to mode | `pool` rotates main + added accounts; `direct` uses caller/main only | `codexAccountMode`, default `pool` |
| `openai-apikey` | namespaced ids such as `openai-apikey/gpt-5.6-sol` and `...-pro` | configured API key or active key-pool entry only | never reads Codex accounts and never receives Codex-login fallback | unchanged |

Additional invariants:

- `openai-multi` is a migration-only legacy id. New registry, presets, management DTOs, catalog
  rows, sidecar candidates, provider cards, and docs do not publish it.
- A bare OpenAI-family model routes only through enabled `openai`; it does not silently fall into
  `openai-apikey`. API-key routing remains explicit through `openai-apikey/<model>`.
- Pool and direct are modes of the same canonical forward transport
  (`openai-responses`, `https://chatgpt.com/backend-api/codex`, `authMode: "forward"`). They are not
  alternative base URLs or auth modes.
- The option is persisted only on `providers.openai`. Supplying it on a custom provider or
  `openai-apikey` is rejected.
- Missing `providers.openai.codexAccountMode` resolves to `pool` at runtime so a manually authored
  minimal config follows the new default even before a save.
- `openai-apikey` never becomes the target of an `openai-multi/<model>` migration. Those selected
  ids become bare native ids.

## Constraints and non-goals

- Docs-only in this delegated task. Only this new plan directory may be written.
- No process action against `127.0.0.1:10100`; do not call lifecycle APIs for that process.
- No push, PR, publish, release, deployment, or git history rewrite.
- Preserve API-key isolation, API Pro aliases, compact semantics, request-log identity, usage
  identity, and API context/max-input metadata.
- Preserve the hardened no-replace backup algorithm and mode-0600/Windows hardening behavior.
- Do not rewrite archived `_fin` history. It remains evidence of the contract that shipped before
  this reversal.
- Do not use a UI-only default. Backend schema, migration, router, management DTO, and GUI must all
  agree on `pool`.
- Do not keep a hidden routable `openai-multi` alias after migration. Compatibility is a one-time
  config/model-id rewrite, not an indefinite second route.

## Planning controls

`LEXICO-SPLIT-01` is satisfied by separating semantic implementation (Cycles 1 and 2) from broad
verification/current-doc closeout (Cycle 3). Renames that remove false “three-tier” terminology are
listed explicitly and happen with their owning behavioral rewrite, not as an untracked cleanup.

`DIFFLEVEL-ROADMAP-01` is satisfied by the per-cycle documents: every planned path is marked
`NEW`, `MODIFY`, `RENAME`, or `DELETE`; named symbols and before/after behavior are included; every
conditional branch has an owning test or render scenario.

## Dependency-ordered work-phase map

| Cycle | Dependency | Deliverable | Gate before next cycle |
| --- | --- | --- | --- |
| 1 — core contract and migration | none | one registry provider, persisted mode, v1-to-v2 projection, id/reference rewrite, pool-default routing, direct short-circuit, catalog/sidecar/quota ownership | focused core/migration/router/auth/catalog tests pass; activation tests prove pool rotation and direct isolation |
| 2 — management and GUI surfaces | Cycle 1 DTO/runtime contract | mode-aware management reads/writes, one OpenAI card with Pool/Direct control, Codex Auth state banner, one Models group, four-locale copy | management/payload/state tests pass; isolated desktop/mobile render QA proves both modes |
| 3 — integration, smoke, docs, closeout | Cycles 1–2 | renamed E2E and runtime smoke, migration-from-three-tier fixture, full test/type/build gates, current SoT docs, evidence ledger, `_fin` move | all gates green, no `openai-multi` outside explicit legacy-migration/history contexts, live proxy hash/process untouched |

Cycle details are in `010_core_contract.md`, `020_surfaces.md`, and
`030_verification_closeout.md`.

## Compatibility and migration policy

### Version and backup

- Keep the existing persisted key `openaiProviderTierVersion` for backward readability and bump
  `OPENAI_PROVIDER_TIER_VERSION` from `1` to `2`.
- `configSchema` accepts `1 | 2` during the transition. Projection always writes `2`.
- Before the first v1/unmarked to v2 save, `backupConfigBeforeOpenAiTierMigration` creates the
  no-replace snapshot:

  ```text
  ~/.opencodex/config.json.pre-openai-tiers-v2.bak
  ```

- The existing `.pre-openai-tiers-v1.bak` is never overwritten, renamed, or deleted. It restores
  the pre-three-tier state; the v2 backup restores the immediately pre-reversal state.
- A byte-identical existing v2 backup is reused. A different existing v2 backup remains a hard
  collision and aborts before save, matching the current secret-safe backup policy.

### Projection rules

`projectOpenAiTierMigration` remains the startup projection owner because it must understand both
the historical v1 split and the v2 result. Rename `OPENAI_MULTI_PROVIDER_ID` to
`LEGACY_OPENAI_MULTI_PROVIDER_ID` so no current routing code treats it as public.

Projection is pure and ordered:

1. Clone input; never mutate caller state.
2. Validate any `providers["openai-multi"]` with the existing canonical-forward plus managed-overlay
   rules. A noncanonical row throws `OpenAiTierMigrationCollisionError`; no secret-bearing custom
   shape is silently discarded.
3. Ensure one canonical `providers.openai` entry ONLY when the config actually references the
   Codex-forward surface (audit fold-back A1): a marker-1 config may legitimately contain
   NEITHER `openai` nor `openai-multi` (management permits deleting reserved providers after
   changing the default, `src/server/management-api.ts:468`) — preserve that absence; do not
   resurrect a deleted provider. A disabled-Multi-only config absorbs into `openai` with
   `codexAccountMode: "pool"` and KEEPS `disabled: true`. Direct-only plus stale
   `activeCodexAccountId`, and no-provider plus stale pool state, must each be defined and
   tested; restoration happens only when a provider/default/model reference requires it.
   Preserve only supported OpenAI provider overlays:
   `disabled`, `selectedModels`, and the resulting `codexAccountMode`.
4. Resolve mode:
   - valid explicit `providers.openai.codexAccountMode` wins;
   - otherwise any enabled legacy `openai-multi` row, `defaultProvider === "openai-multi"`, or known
     selected-id reference beginning `openai-multi/` resolves to `pool`;
   - a v1 config containing only historical Direct `openai` resolves to `direct` to preserve its
     previously explicit behavior;
   - an unmarked legacy/fresh config resolves to the new default `pool`.
5. Merge `selectedModels` without duplicates, preserving `openai` order first and appending legacy
   Multi-only items. Resulting provider disablement is true only when every formerly usable Codex
   forward row was disabled.
6. Delete `providers["openai-multi"]` and `providers.chatgpt`; map either legacy default to
   `defaultProvider: "openai"`.
7. Rewrite known config references. `openai-multi/<model>` becomes bare `<model>` in:
   - `disabledModels`
   - `subagentModels`
   - `injectionModel`
   - `shadowCallIntercept.model`
   - `webSearchSidecar.model` and `visionSidecar.model`
   - `claudeCode.webSearchSidecar.model` and `claudeCode.visionSidecar.model`
   - `claudeCode.model` and `claudeCode.smallFastModel` (audit fold-back A2;
     `src/types.ts:274`)
   - `claudeCode.tierModels.{opus,sonnet,haiku,fable}` (`src/types.ts:311`)
   - `modelMap` DESTINATION values only — never source keys (management round-trips
     these at `src/server/management-api.ts:801,955`)
8. Move `providerContextCaps["openai-multi"]` to `providerContextCaps.openai`; when both exist, keep
   the stricter lower positive cap and emit a path-only warning.
9. Deduplicate rewritten arrays while preserving first occurrence. Do not rewrite
   `openai-apikey/...`, custom provider ids, usage history, or request logs.
10. Set `openaiProviderTierVersion: 2`. A second projection must be clone-only and `changed: false`.

The pre-v1 path is changed in place: it no longer creates `openai-multi` or moves the default to
that id. `chatgpt` and unmarked `openai` become one canonical `openai` row with mode `pool` by
default. This prevents a restored v1 backup from briefly recreating a provider the v2 contract has
removed.

### Warning policy

- Extend `OpenAiTierMigrationProjection` with `warnings: string[]` containing config paths and
  decisions only; never include values, tokens, headers, or account ids.
- Normal id rewrites are silent. Emit warnings only for deterministic conflict resolution (for
  example both context-cap keys) or an `openai-multi` occurrence under an unknown passthrough field
  that the migration cannot safely interpret.
- `runOpenAiTierStartupMigration` emits each warning once after successful backup/save. Projection,
  backup, or save failure emits no success warning and propagates the existing error.
- A noncanonical legacy Multi collision is a blocker, not a warning: backup/save remain untouched
  and the user retains the exact source config.

## Current SoT and archived-history policy

`structure/08_openai-provider-tiers.md` remains the stable structure path but is rewritten in Cycle
3 as the current single-provider-option SoT. Its first paragraph must say that it supersedes the
provider-identity/account-selection portions of
`devlog/_fin/260717_openai_hardening`, while the archived unit remains valid historical evidence for
the release that implemented three tiers.

No file under `devlog/_fin/260717_openai_hardening` is edited, moved, or annotated. Current README,
structure, and docs-site pages point to the new contract; history stays immutable.

## Completion definition

The work is complete only when all three cycles pass, current docs contain no active instruction to
configure/select `openai-multi`, migration fixtures prove v1 restore and v2 re-migration, isolated
runtime evidence proves both option modes and API isolation, render evidence shows the four-locale
surface contract, and the live `127.0.0.1:10100` process was never touched.

## Closeout receipt — 2026-07-18

- Cycle 1 landed at `4da9c167`; Cycle 2 landed at `14e57661`.
- Cycle 3 focused integration: 309 pass, 0 fail.
- Authoritative repository suite: 2,850 pass, 0 fail across 256 files; 12,188 assertions; 51.80s.
- Isolated runtime: Pool, Direct, API Pro, real Codex client history, user-state hashes, and live
  `127.0.0.1:10100` identity all PASS. See `evidence/030_runtime_smoke.json`.
- Current docs and SoT are synchronized; stale matches are limited to migration/history/rejection
  contexts. See `evidence/stale_contract_scan.txt`.
- No commit, push, release, live-proxy control, or `_fin` move was performed in Cycle 3.

Terminal status: **PASS — READY_FOR_PARENT_ARCHIVE**. The unit intentionally remains under `_plan`.
