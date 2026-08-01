# 002 — Research: the Alibaba region split and issue #457

Research behind WP2. No diffs; the implementation design is in
`020_wp2_alibaba_region_migration_457.md`.

## The refused fix, and the exact history

`allowBaseUrlOverride` on `alibaba-token-plan` is not an unexplored idea. It
shipped and was backed out twice:

| Commit | Meaning |
|--------|---------|
| `165f1a83` | `fix: preserve configured Alibaba Token Plan base URL (#189)` |
| `b9b73f71` | revert of `165f1a83` |
| `9b412d8e` | cherry-pick reapplying `165f1a83` |
| `a9b9048a` | revert again |

It returned as PR #459 (`64a8753e`, Fjordfall) and was closed unmerged on
2026-07-26. The maintainer's rationale is the constraint this phase inherits:

> Current `dev` deliberately models Beijing and International as separate
> providers. […] Adding `allowBaseUrlOverride` to the Beijing entry collapses
> that split back together: you'd get the international endpoint while routing
> and the catalog still describe the provider as Beijing Personal Edition — its
> dashboard link, its note, its default model, its capability maps. […] Worse,
> that provider's API key would then be sendable to whatever destination happens
> to be saved.

and it names the correct shape explicitly: *"it's a migration, not an override
flag."*

## The registry asymmetry is intentional

| | `alibaba-token-plan` | `alibaba-token-plan-intl` |
|---|---|---|
| line | `src/providers/registry.ts:836` | `:862` |
| endpoint | `token-plan.cn-beijing…` (pinned) | `token-plan.ap-southeast-1…` |
| override | none | `allowBaseUrlOverride` + `baseUrlChoices` |
| models | 6 (`registry.ts:205`) | 15 (`registry.ts:225`) |
| product | Personal Edition, Beijing | Team Edition, Singapore |

Different model lists, context windows, modality maps, reasoning metadata and
dashboard URLs. Two products.

## What is already fixed

`warnIfBaseUrlDiscarded` (`src/router.ts:165-190`, landed via #464) now names the
discarded origin and the effective endpoint, so the silent 401 is at least
diagnosable. What remains open is the recovery path: nothing moves a
mis-migrated entry to the id that matches its endpoint.

## Every config location that names a provider id

The audit found the first design missed most of these. `openai-tiers.ts` already
maintains the authoritative inventory — `hasKnownLegacyOpenAiReference` at
`src/providers/openai-tiers.ts:116` and `isKnownLegacyValuePath` at `:179` — and
it is the list to mirror:

| Location | Shape | Source |
|----------|-------|--------|
| `defaultProvider` | provider id | `types.ts:468` |
| `disabledModels[]` | `provider/model` | `types.ts:544` |
| `subagentModels[]` | `provider/model` | `types.ts:477` |
| `subagentModelFallback[]` | `provider/model` | `types.ts:483` |
| `injectionModel` | `provider/model` | `types.ts:488` |
| `shadowCallIntercept.model` | `provider/model` | `types.ts:553` |
| `webSearchSidecar.model`, `visionSidecar.model` | `provider/model` | `types.ts:609`, `:611` |
| `claudeCode.model`, `.smallFastModel`, `.tierModels.*`, `.modelMap.*` | `provider/model` | `types.ts:472` |
| `claudeCode.webSearchSidecar.model`, `.visionSidecar.model` | `provider/model` | `types.ts:421`, `:423` |
| `providers[id].selectedModels[]` | `provider/model` | per-provider |
| **`providerContextCaps`** | **key is a bare provider id, not a route** | `src/providers/context-cap.ts:9` |
| **`customModels[].provider`** | bare provider id | `types.ts:448-452` |
| **`combos[*].targets[].provider`** | bare provider id | `types.ts:635-637` |
| `claudeCode.desktopProfile` route keys | `provider/model` | `types.ts:425` |

The three bolded rows are the ones a `"<id>/"`-prefix rewrite silently misses.
`providerContextCaps` is keyed by provider id, so a prefix rewrite leaves the cap
orphaned. `customModels[].provider` and `combos[*].targets[].provider` are bare
ids too — and a stale combo target is worse than orphaned: it fails validation
at `src/combos/types.ts:220`, so `loadConfig` backs up the migrated file as
invalid and falls back to defaults (`src/config.ts:764`). A migration that misses
combos therefore destroys the whole config it was trying to repair.

## Why the destination row cannot simply be moved

`ocx provider add` and the GUI persist registry-derived fields onto the config
row (`src/cli/provider.ts:163`, `src/providers/derive.ts:102`), and registry
enrichment only fills fields that are *absent* (`derive.ts:220`). Moving the
Beijing row wholesale therefore carries its 6-model list, its default model, and
its capability maps onto the international id — the international provider would
keep the Beijing catalog while claiming to be Team Edition, which is the exact
"working endpoint wearing the wrong identity" the maintainer refused. The
destination must be seeded from the international registry entry, with only
credentials and genuinely user-owned fields carried across.

## Backup

`runOpenAiTierStartupMigration` backs up before saving
(`src/providers/openai-tier-startup.ts:21` → `backupConfigBeforeOpenAiTierMigration`,
`src/config.ts:189`), using an exclusive-create + link-no-replace scheme so the
snapshot is immutable. A migration that rewrites a dozen reference sites needs
the same protection.
