// AUTO-SPLIT facade: original catalog.ts body moved into ./catalog/* modules.
// Public surface preserved exactly; importers keep using "src/codex/catalog".
export { isMediaGenerationModelId, shouldExposeRoutedModel, readCodexCatalogPath, readCatalog, normalizeRoutedCatalogEntry, catalogModelSlug, filterSupportedNativeSlugs, catalogModelSupportsReasoningSummaries } from "./catalog/parsing";
export type { CatalogModel, MultiAgentMode } from "./catalog/parsing";
export { NATIVE_OPENAI_MODELS, nativeOpenAiContextWindow, disabledNativeSlugs, visibleNativeSlugs, desktopVisibleNativeSlugs, nativeModelRows, applyNativeVisibility, upstreamNativeEntry, nativeOpenAiSlugs, listCatalogNativeSlugs } from "./catalog/metadata";
export { isSpawnableCodexCandidate, codexExecInvocation, loadBundledCodexCatalog, materializeBundledCodexCatalog, loadCatalogTemplate } from "./catalog/bundled";
export { nativeEffortClamp, shouldApplyNativeEffortClamp, catalogModelEfforts, codexSupportedReasoningEfforts, clampedDefaultEffort, clampEntryToCodexSupportedEfforts, clampCatalogModelsToCodexSupport } from "./catalog/effort";
export { applyProviderConfigHints, isDatedVariantId, filterCatalogVisibleModels, gatherRoutedModels, clearGatherRoutedModelsInflight, augmentRoutedModelsWithRegistryOpenAiApiRows, augmentRoutedModelsWithJawcodeMetadata } from "./catalog/provider-fetch";
export { deriveComboCatalogModel, exactComboCatalogSlugs, getLastComboCatalogOmissions, resetOpenAiApiCatalogWarningStateForTests, uniqueCatalogModelsForPublicList, uniqueCatalogModelsForRawPublicList, buildComboCatalogOmission, comboCatalogOmissionReason, summarizeComboCatalogOmissions } from "./catalog/aggregation";
export type { ComboCatalogOmission, ComboCatalogOmissionReason } from "./catalog/aggregation";
export { MAX_SPAWN_AGENT_MODEL_OVERRIDES, effectiveSubagentRoster, buildCatalogEntries, resetCatalogRuntimeStateForTests, orderForSubagents, mergeCatalogEntriesForSync, syncCatalogModels, restoreCodexCatalog, invalidateCodexModelsCache } from "./catalog/sync";
export type { SpawnAgentSurface, SubagentRosterExclusionReason, EffectiveSubagentModel, SubagentRosterExclusion, EffectiveSubagentRoster } from "./catalog/sync";
