import type { ProviderRegistryEntry } from "./types";

/**
 * What a registry field's KEYS mean for selector decoding.
 *
 * An encoded selector is decoded against the native model ids a provider is known to accept.
 * That set used to be a hand-written list of eight registry maps, so an id declared only in an
 * unlisted map could not be decoded, and every new model-keyed field had to be remembered.
 *
 * Every field of ProviderRegistryEntry is classified below, including the ones that carry no
 * model identity at all. That is deliberate: the "satisfies" check makes a new registry field a
 * TYPE error until somebody decides what its keys mean, rather than letting it default to
 * invisible. The two checks are different and both matter - the satisfies clause proves the
 * classification is exhaustive when this compiles, and the parity test proves the fields the
 * shipped registry actually carries are the ones classified here.
 *
 * These are decode hints and nothing more. A hint does not publish a catalog row, grant
 * availability or entitlement, and it does not confer transport authority: the caller still
 * checks registry transport identity before asking for them, and an ambiguous selector is still
 * rejected rather than guessed.
 */
type RegistryFieldModelIdRole =
  | { readonly kind: "none" }
  | { readonly kind: "record-keys" }
  | { readonly kind: "nested-record-keys"; readonly key: "modelSupportsServiceTier" };

const NONE = { kind: "none" } as const;
const RECORD_KEYS = { kind: "record-keys" } as const;
/**
 * Key-auth declares its own service-tier support under a nested map.
 *
 * Reading its keys is identity evidence only. It does not activate the key-auth service tier,
 * which stays the business of the service-tier resolver.
 */
const KEY_AUTH_SERVICE_TIER = { kind: "nested-record-keys", key: "modelSupportsServiceTier" } as const;

/**
 * Not a configuration surface. Exported so the parity suite can compare this classification
 * against the fields the shipped registry entries actually carry at runtime.
 */
export const REGISTRY_FIELD_MODEL_ID_ROLES = {
  id: NONE,
  label: NONE,
  adapter: NONE,
  baseUrl: NONE,
  apiKeyTransport: NONE,
  alias: NONE,
  authKind: NONE,
  codexAccountMode: NONE,
  allowKeyAuthOverride: NONE,
  allowPrivateNetworkByDefault: NONE,
  keyOptional: NONE,
  apiKeyValidation: NONE,
  freeTier: NONE,
  allowBaseUrlOverride: NONE,
  preserveCustomDestination: NONE,
  baseUrlChoices: NONE,
  staticHeaders: NONE,
  modelSuffixBracketStrip: NONE,
  featured: NONE,
  sponsor: NONE,
  dashboardPreset: NONE,
  note: NONE,
  dashboardUrl: NONE,
  defaultModel: NONE,
  models: NONE,
  liveModels: NONE,
  modelWireDefaults: RECORD_KEYS,
  fastWire: NONE,
  modelResponsesUpstreamStreaming: RECORD_KEYS,
  modelResponsesTerminalRepair: RECORD_KEYS,
  responsesItemIdRepair: NONE,
  responsesPath: NONE,
  chatCompletionsPath: NONE,
  destinationAliases: NONE,
  statelessResponses: NONE,
  requiresAdjacentResponsesToolResults: NONE,
  requiresPairedResponsesToolResults: NONE,
  annotateEmptyToolOutputs: NONE,
  supportsServiceTier: NONE,
  supportsOpenAiWebSearchToolFields: NONE,
  supportsResponsesCustomTools: NONE,
  modelSupportsServiceTier: RECORD_KEYS,
  keyAuthServiceTier: KEY_AUTH_SERVICE_TIER,
  fastTierDescription: NONE,
  modelServiceTierCapabilityBaseUrlGuard: NONE,
  preserveResponsesReasoningContent: NONE,
  dropResponsesReasoningItems: NONE,
  modelSupportsReasoningSummaries: RECORD_KEYS,
  modelSupportsVerbosity: RECORD_KEYS,
  supportsVerbosity: NONE,
  modelDiscovery: NONE,
  contextWindow: NONE,
  modelContextWindows: RECORD_KEYS,
  modelDisplayNames: RECORD_KEYS,
  modelInputModalities: RECORD_KEYS,
  defaultMaxOutputTokens: NONE,
  modelMaxOutputTokens: RECORD_KEYS,
  reasoningEfforts: NONE,
  modelReasoningEfforts: RECORD_KEYS,
  modelDefaultReasoningEfforts: RECORD_KEYS,
  reasoningEffortMap: NONE,
  modelReasoningEffortMap: RECORD_KEYS,
  directReasoningEffortModels: NONE,
  reasoningWireFormat: NONE,
  noVisionModels: NONE,
  noReasoningModels: NONE,
  noTemperatureModels: NONE,
  noTopPModels: NONE,
  noStopModels: NONE,
  noPenaltyModels: NONE,
  noJsonSchemaModels: NONE,
  parallelToolCalls: NONE,
  promptCacheKey: NONE,
  chatServiceTier: NONE,
  openaiChatEofTolerance: NONE,
  autoToolChoiceOnlyModels: NONE,
  preserveReasoningContentModels: NONE,
  requiresReasoningPlaceholderModels: NONE,
  showThinkingSummary: NONE,
  reasoningSplitModels: NONE,
  inlineThinkTagModels: NONE,
  reasoningDetailsModels: NONE,
  thinkingToggleModels: NONE,
  thinkingBudgetModels: NONE,
  escapeBuiltinToolNames: NONE,
  oauthId: NONE,
  virtualModels: RECORD_KEYS,
  modelMaxInputTokens: RECORD_KEYS,
  jawcodeBundle: NONE,
  extraMetadataAliases: NONE,
  metadataModelIdNormalize: NONE,
  googleMode: NONE,
  project: NONE,
  location: NONE,
} satisfies Record<keyof ProviderRegistryEntry, RegistryFieldModelIdRole>;

/**
 * The native model ids this registry entry names, in registry-field order, first seen wins.
 *
 * Only KEYS are collected. virtualModels is a map whose keys are the selected identities and
 * whose values name a transport target, so its wireModelId values are deliberately not read:
 * a wire target is not something a client may select by name.
 */
export function registryModelIdKeys(entry: ProviderRegistryEntry): readonly string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (key: string): void => {
    if (key.length === 0 || seen.has(key)) return;
    seen.add(key);
    ids.push(key);
  };
  for (const field of Object.keys(REGISTRY_FIELD_MODEL_ID_ROLES) as (keyof ProviderRegistryEntry)[]) {
    const role = REGISTRY_FIELD_MODEL_ID_ROLES[field];
    if (role.kind === "none") continue;
    if (role.kind === "record-keys") {
      const map = entry[field];
      if (typeof map !== "object" || map === null) continue;
      for (const key of Object.keys(map)) add(key);
      continue;
    }
    // The nested role belongs to keyAuthServiceTier alone, so its owner is read by name.
    // ProviderRegistryEntry is an interface and carries no implicit index signature, so a
    // by-name read is what keeps this loop typed instead of asserted through unknown.
    const nested = entry.keyAuthServiceTier?.[role.key];
    if (typeof nested !== "object" || nested === null) continue;
    for (const key of Object.keys(nested)) add(key);
  }
  return Object.freeze(ids);
}
