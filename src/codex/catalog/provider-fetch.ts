export type { CatalogGatherProviderAuthEvidence } from "./filesystem-evidence";

export type {
  CatalogGatherProviderAuthOutcome,
  CatalogGatherProviderModelOutcome,
} from "./gather-capture";
export { createCatalogGatherAuthorityIdentity } from "./gather-capture";

export {
  applyConfigHintsToCachedModels,
  applyProviderConfigHints,
  applyRegistryCapabilitySeedFill,
  CALLABLE_CONFIGURED_COMPATIBILITY_MODELS,
  catalogHintsFromModelsApiItem,
  catalogHintsFromProviderConfig,
  configuredAutoCompactTokenLimit,
  configuredContextWindow,
  configuredInputModalities,
  configuredMaxInputTokens,
  configuredModelDisplayName,
  discoveredPricingStatus,
  isGlm52ModelId,
  isGlm53ModelId,
  QUIET_AUTHORITATIVE_CATALOG_PROVIDERS,
} from "./model-hints";

export {
  configuredComboTargetModelsByProvider,
  resolveComboCatalogMember,
} from "./combo-member";

export {
  filterCatalogVisibleModels,
  isDatedVariantId,
  lastDropWarnSignature,
  mergeConfiguredModelsIntoLiveCatalog,
  reconcileProviderFetchWarnings,
  shouldExposeProviderModel,
  shouldRetainConfiguredProviderModel,
  warnDroppedConfiguredIdsOnce,
} from "./model-visibility";

export { fetchProviderModels } from "./provider-models";

export type { GatherRoutedModelsOptions } from "./routed-gather";
export {
  augmentRoutedModelsWithMetadata,
  augmentRoutedModelsWithRegistryOpenAiApiRows,
  CatalogGatherBusyError,
  catalogGatherAdmissionMetrics,
  clearGatherRoutedModelsInflight,
  gatherRoutedModels,
  gatherRoutedModelsForCatalogGather,
} from "./routed-gather";
