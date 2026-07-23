# 020 — Phase 2: split `src/codex/catalog.ts` (2408) into internal modules + facade

`catalog.ts` is the foundational data module: `management-api.ts`,
`responses.ts`, `server/index.ts`, `cli/index.ts`, and 20+ test files import
~50 exported symbols from it. The facade must preserve every exported name at
the path `src/codex/catalog.ts`.

## Module map (NEW `src/codex/catalog/*.ts`)

### `metadata.ts` — native OpenAI model metadata

`NATIVE_OPENAI_MODELS` `:93-99`, `DOCUMENTED_NATIVE_OPENAI_ADDITIONS`
`:98-105`, `SUPPORTED_NATIVE_OPENAI_SLUGS` `:109`,
`isUnsupportedOpenAiNativeSlug` `:117-121`, `NATIVE_GPT56_CONTEXT_WINDOW`
`:123`, `NATIVE_OPENAI_CONTEXT_OVERRIDES` `:125-133`,
`nativeOpenAiContextWindow` `:135-141`, `nativeInputModalities` `:145-153`,
`nativeReasoningEfforts` `:156-176`, `nativeParallelToolCalls` `:178-182`,
`hasComboTargets` `:184-193`, `disabledNativeSlugs` `:195-201`,
`visibleNativeSlugs` `:205-211`, `nativeModelRows` `:215-225`,
`applyNativeVisibility` `:228-245`, `UPSTREAM_NATIVE_ENTRIES` `:247-260`,
`upstreamNativeEntry` `:263-277`, `shouldUpgradeToUpstreamEntry` `:327-338`,
`nativeOpenAiSlugs` `:459-462`.

### `parsing.ts` — catalog read/parse/normalize

`CatalogModel` `:464-490` (EXPORTED interface — the shared model contract;
importers: `src/server/management-api.ts:3`, `src/claude/context-windows.ts:13`,
`src/claude/model-info.ts:18`, `tests/selected-models.test.ts:2`,
`tests/slug-codec.test.ts:18`; re-export from facade),
`RawEntry`/`RawCatalog` `:491-492`, `JAWCODE_CATALOG_AUGMENT_PROVIDERS` `:493`,
`ROUTED_MODEL_COMPATIBILITY_EXCLUSIONS` `:500-503`,
`isRoutedModelCompatibilityExcluded` `:505-513`, `MEDIA_GEN_FAMILIES`/
`MEDIA_GEN_ID_RE` `:515-527`, `isMediaGenerationModelId` `:529-531`,
`shouldExposeRoutedModel` `:533-538`, `readCodexCatalogPath` `:540-550`,
`parseCatalogJson` `:552-557`, `readCatalog` `:559-564`, `findNativeTemplate`
`:566-570`, `normalizeServiceTiers` `:572-585`, `ensureAutoCompactTokenLimit`
`:587-596`, `isNativeOpenAiEntry` `:598-600`,
`applyNativeOpenAiContextOverride` `:602-613`, `ensureStrictCatalogFields`
`:615-646`, `MultiAgentMode` `:648`, `applyMultiAgentMode` `:658-678`,
`normalizeRoutedCatalogEntry` `:680-712`, `applyJawcodeCatalogMetadata`
`:714-729`, `catalogModelSlug` `:1101-1103`, `filterSupportedNativeSlugs`
`:1274-1283`.

### `effort.ts` — reasoning-effort clamping

`ROUTED_REASONING_LEVELS` `:902`, `applyCatalogModelMetadata` `:904-931`,
`applyReasoningLevels` `:933-970`, `isGpt56NativeSlug` `:972-980`,
`ensureGpt56ReasoningLevels` `:982-999`, `ensureUltraReasoningLevel`
`:1001-1016`, `codexSupportedReasoningEfforts` `:1018-1033`,
`clampedDefaultEffort` `:1035-1044`, `clampEntryToCodexSupportedEfforts`
`:1046-1068`, `clampCatalogModelsToCodexSupport` `:1070-1082`,
`nativeEffortClamp` `:280-308`, `shouldApplyNativeEffortClamp` `:310-325`,
`catalogEntryEfforts` `:386-391`, `catalogModelEfforts` `:340-358`.

### `provider-fetch.ts` — provider model fetching (owns `lastDropWarnSignature`)

`ProviderModelsApiItem` `:1325-1334`, `isProviderModelsApiItems` `:1336-1344`,
`configuredContextWindow`/`configuredInputModalities`/
`configuredMaxInputTokens` `:1346-1359`, `applyProviderConfigHints`
`:1361-1407`, `catalogHintsFromProviderConfig` `:1409-1413`,
`applyConfigHintsToCachedModels` `:1415-1421`, `isDatedVariantId` `:1423-1428`,
`lastDropWarnSignature` `:1430`, `QUIET_AUTHORITATIVE_CATALOG_PROVIDERS`
`:1432`, `CALLABLE_CONFIGURED_COMPATIBILITY_MODELS` `:1434-1452`,
`warnDroppedConfiguredIdsOnce` `:1454-1461`, `isGlm52ModelId` `:1463-1466`,
`catalogHintsFromModelsApiItem` `:1468-1498`, `fetchProviderModels`
`:1500-1676`, `shouldExposeProviderModel` `:1678-1681`,
`shouldRetainConfiguredProviderModel` `:1683-1694`, `filterCatalogVisibleModels`
`:1696-1723`, `gatherRoutedModels` `:1725-1818`,
`augmentRoutedModelsWithRegistryOpenAiApiRows` `:2073-2124`,
`augmentRoutedModelsWithJawcodeMetadata` `:2126-2164`.

### `aggregation.ts` — combo/routed aggregation + dedup (owns the 4 collision/warning states)

`deriveComboCatalogModel` `:1845-1889`, `safeCatalogWarningLabel` `:1891-1895`,
`comboCatalogWarningSignature` `:1897-1917`, `warnUncataloguedComboOnce`
`:1919-1933`, `exactComboCatalogSlugs` `:1935-1947`,
`normalizedOpenAiApiSignature` `:1949-1960`, `openAiApiCollisionWarnings`
`:1820`, `comboCatalogWarningSignatures` `:1821`, `intersectStrings`
`:1823-1827`, `effectiveComboDefault` `:1829-1843`,
`slugAliasCollisionWarnings` `:1973`, `comboMasqueradeCollisionWarnings`
`:1974`, `warnComboMasqueradeCollisionOnce` `:1976-1982`,
`resolveSlugAliasCollisions` `:1984-2014`, `uniqueCatalogModelsForPublicList`
`:2016-2040`, `uniqueCatalogModelsForRawPublicList` `:2042-2061`,
`resetOpenAiApiCatalogWarningStateForTests` `:1962-1971`, `orderForSubagents`
`:2166-2178`.

### `sync.ts` — orchestration: bundled discovery, backup/persistence, entry build/merge, subagent roster (owns `bundledCatalogCache`)

Bundled discovery: `BUNDLED_CATALOG_CACHE_MS` `:33`, `bundledCatalogCache`
`:34`, `ExecFile` `:731-740`, `BundledCatalogDeps` `:743-746`, `unique`
`:748-750`, `codexCommandCandidates` `:752-770`, `isSpawnableCodexCandidate`
`:772-775`, `codexShimCommandCandidates` `:777-806`, `codexExecInvocation`
`:808-816`, `runCodexDebugModels` `:818-828`, `loadBundledCodexCatalog`
`:830-848`, `materializeBundledCodexCatalog` `:850-860`, `loadCatalogForSync`
`:862-872`, `readCurrentCatalogOrCache` `:874-884`, `loadCatalogTemplate`
`:886-900`, `finishUpstreamNativeEntry` `:1084-1092`,
`isExactComboCatalogModel` `:1094-1099`, `deriveEntry` `:1105-1196`,
`buildCatalogEntries` `:1198-1258`, `listCatalogNativeSlugs` `:1260-1272`.
Backup/persistence: path helpers `:36-91`, `readCatalogBackup` `:1285-1288`,
`catalogHasRoutedEntries` `:1290-1292`, `writePristineCatalogBackup`
`:1294-1304`, `ensureCatalogBackup` `:1306-1311`, `readNativeBaseline`
`:1313-1323`. Sync/merge: `mergeCatalogEntriesForSync` `:2180-2329`,
`syncCatalogModels` `:2331-2378`, `restoreCodexCatalog` `:2380-2411`,
`invalidateCodexModelsCache` `:2413-2428`. Subagent roster:
`MAX_SPAWN_AGENT_MODEL_OVERRIDES` `:360`, `SpawnAgentSurface` `:362`,
`SubagentRosterExclusionReason` `:363-368`, `EffectiveSubagentModel`
`:369-372`, `SubagentRosterExclusion` `:374-378`, `EffectiveSubagentRoster`
`:380-384`, `effectiveSubagentRoster` `:405-457`. Reset:
`resetCatalogRuntimeStateForTests` `:2063-2071` (clears `bundledCatalogCache`
here AND calls the provider-fetch + aggregation reset helpers).

## Mutable-state single-owner rule (critical)

Six module-level mutable states must each live in exactly one module (above):
`bundledCatalogCache`→sync, `lastDropWarnSignature`→provider-fetch,
`openAiApiCollisionWarnings`/`comboCatalogWarningSignatures`/
`slugAliasCollisionWarnings`/`comboMasqueradeCollisionWarnings`→aggregation.
The two reset-for-tests exports (`resetCatalogRuntimeStateForTests`,
`resetOpenAiApiCatalogWarningStateForTests`) are composed through the facade
so test behavior is byte-identical.

## Facade (MODIFY `src/codex/catalog.ts`)

Re-export the full ~50-symbol public surface from the six modules. Target
< ~150 lines. No caller changes its import specifier.

## P-reverify flag (resolve before B)

`RawEntry`/`RawCatalog` are NON-exported `type` declarations at `:491-492`
(verified: no `export` keyword), yet `tests/slug-codec.test.ts:18` does
`import type { RawEntry } from "../src/codex/catalog"`. This is a pre-existing
contradiction in the current tree. The split MUST preserve the EXACT current
declaration form: move `type RawEntry`/`type RawCatalog` to `parsing.ts`
verbatim with NO added/removed `export` keyword, and the facade re-exports only
what is currently exported (so the relative import surface is byte-identical).
Do NOT "fix" the contradiction by exporting RawEntry — that would change the
public surface. The C-phase `bun run typecheck` (after `bun install`) is the
proof that the surface is unchanged: whatever compiles today must compile
identically after the move. `CatalogModel` (exported) moves to `parsing.ts`
and IS re-exported from the facade.

## Verification (C)

1. `bun run typecheck`; `bun run test` (esp. codex-catalog, codex-v2-gate,
   slug-codec, provider-registry-parity, reasoning-effort, multi-agent-compat,
   effort-policy, selected-models, google-models-listing, cursor suites);
   `bun run privacy:scan`.
2. Import-surface check: `rg "from .*codex/catalog"` (excluding the new
   `catalog/` subdir) shows only pre-existing names.
3. `wc -l src/codex/catalog.ts` < 800 (facade).
4. Dynamic imports (`server/index.ts`, `cli/index.ts`, `responses.ts`,
   `system-env.ts` use `await import(".../catalog")`) still resolve — the
   facade path is unchanged, so they do; confirm via typecheck + those suites.

## SoT sync

Update the `structure/` note describing the catalog subsystem if present;
otherwise record the new `src/codex/catalog/` layout in D.
