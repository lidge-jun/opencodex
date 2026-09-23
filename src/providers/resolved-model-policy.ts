import type { ModelCapabilities, OcxProviderConfig } from "../types";
import { MODEL_ADAPTER_OVERRIDE_ALLOWED, pinnedWireAdapter } from "../types";
import { isCanonicalOpenAiForwardProvider } from "./openai-tiers";
import { resolveProviderAuthTransport } from "./fastwire";
import { registryEntrySupportsLiveModelDiscovery } from "./static-model-discovery";
import type { InboundWire, ProviderRegistryEntry, ResponsesTerminalRepairPolicy } from "./registry/types";
import {
  anthropicFamilyContextWindow,
  detachedClone,
  legacyModelValue,
  legacyModelSource,
  mapFill,
  nestedMapFill,
  positiveCapMap,
  recursivelyFreeze,
  resolvedBaseUrl,
  sameStringArray,
  scalar,
  stableUnion,
  staticHeaders,
  wireDefault,
  type StaticPolicySource,
} from "./resolved-model-policy-merge";
export type { StaticPolicySource } from "./resolved-model-policy-merge";
export type StaticProviderPolicyField =
  | "adapter" | "baseUrl" | "apiKeyTransport" | "headers" | "authMode" | "codexAccountMode"
  | "responsesPath" | "chatCompletionsPath" | "keyOptional" | "freeTier" | "modelSuffixBracketStrip"
  | "defaultModel" | "models" | "liveModels" | "contextWindow" | "modelContextWindows"
  | "modelDisplayNames" | "modelInputModalities" | "modelMaxInputTokens" | "defaultMaxOutputTokens"
  | "modelMaxOutputTokens" | "reasoningEfforts" | "modelReasoningEfforts" | "modelReasoningEffortsAuthoritative"
  | "modelDefaultReasoningEfforts" | "reasoningEffortMap" | "modelReasoningEffortMap"
  | "reasoningWireFormat" | "noVisionModels" | "noReasoningModels" | "noTemperatureModels"
  | "noTopPModels" | "noStopModels" | "noPenaltyModels" | "noJsonSchemaModels" | "parallelToolCalls"
  | "promptCacheKey" | "chatServiceTier" | "openaiChatEofTolerance" | "statelessResponses"
  | "requiresAdjacentResponsesToolResults" | "requiresPairedResponsesToolResults" | "annotateEmptyToolOutputs"
  | "fastWire" | "supportsServiceTier" | "modelSupportsServiceTier" | "supportsOpenAiWebSearchToolFields"
  | "supportsResponsesCustomTools" | "preserveResponsesReasoningContent" | "dropResponsesReasoningItems"
  | "modelSupportsReasoningSummaries"
  | "supportsVerbosity" | "modelSupportsVerbosity" | "responsesItemIdRepair" | "autoToolChoiceOnlyModels"
  | "preserveReasoningContentModels" | "requiresReasoningPlaceholderModels" | "reasoningSplitModels" | "inlineThinkTagModels"
  | "reasoningDetailsModels" | "thinkingToggleModels" | "thinkingBudgetModels" | "showThinkingSummary"
  | "escapeBuiltinToolNames" | "googleMode" | "project" | "location" | "modelCapabilities"
  | "modelAutoCompactTokenLimits" | "modelSuppressSyntheticMax" | "modelReasoningSummaryDelivery"
  | "codexToolMode" | "modelAdapters";
type StaticProviderPolicyShape = Pick<OcxProviderConfig, StaticProviderPolicyField>;
export type ResolvedProviderStaticPolicy = Readonly<Partial<StaticProviderPolicyShape>> & Readonly<{
  adapter: string;
  baseUrl: string;
}>;
export interface ResolvedPerModelStaticPolicy {
  readonly adapter: string;
  readonly contextWindow?: number;
  readonly inputModalities?: readonly string[];
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly reasoningEfforts?: readonly string[];
  readonly defaultReasoningEffort?: string;
  readonly supportsReasoningSummaries?: boolean;
  readonly supportsVerbosity?: boolean;
  readonly supportsServiceTier?: boolean;
  readonly fastTierDescription?: string;
  readonly directReasoningEffort?: boolean;
  readonly responsesUpstreamStreaming?: boolean;
  readonly responsesTerminalRepair?: Readonly<ResponsesTerminalRepairPolicy>;
}
export interface ResolvedModelPolicy {
  readonly version: 1;
  readonly providerName: string;
  readonly modelId: string;
  readonly transportMatchedRegistry: boolean;
  readonly effectiveAlias?: string | null;
  readonly provider: ResolvedProviderStaticPolicy;
  readonly model: Readonly<ResolvedPerModelStaticPolicy>;
  readonly provenance: Readonly<{
    alias: StaticPolicySource;
    provider: Readonly<Partial<Record<StaticProviderPolicyField, StaticPolicySource>>>;
    model: Readonly<Partial<Record<keyof ResolvedPerModelStaticPolicy, StaticPolicySource>>>;
  }>;
}
export interface ResolveModelPolicyInput {
  readonly providerName: string;
  /** Final wire identity after resolveModelAlias and resolveOpenAiVirtualModel; public selection stays diagnostic-only. */
  readonly modelId: string;
  readonly provider: Readonly<OcxProviderConfig>;
  readonly registryEntry?: Readonly<ProviderRegistryEntry>;
  readonly transportMatchedRegistry: boolean;
  readonly inboundWire?: InboundWire;
  /** Exact post-rewrite model capability declaration captured by the caller. */
  readonly modelCapabilities?: Readonly<ModelCapabilities>;
  /** Credential-free live admission result: key only after a usable override, otherwise the registry mode. */
  readonly effectiveAuth?: Readonly<{ authMode: NonNullable<OcxProviderConfig["authMode"]> }>;
  /** Capture-time collision-aware alias decision. Omit to use provider then registry fallback. */
  readonly effectiveAlias?: string | null;
  readonly effectiveAliasSource?: Exclude<StaticPolicySource, "hard-pin" | "provider-default">;
}
export interface ObservedModelLimits {
  readonly contextWindow?: number;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
}
/** Call-local projection: observed values stay outside ResolvedModelPolicy and may only narrow caps. */
export function clampObservedModelLimits(
  policy: Readonly<Pick<ResolvedPerModelStaticPolicy, "contextWindow" | "maxInputTokens" | "maxOutputTokens">>,
  observed: Readonly<ObservedModelLimits>,
): Readonly<ObservedModelLimits> {
  const clamp = (staticCap: number | undefined, observedValue: number | undefined): number | undefined => {
    if (observedValue === undefined) return staticCap;
    return staticCap === undefined ? observedValue : Math.min(staticCap, observedValue);
  };
  const contextWindow = clamp(policy.contextWindow, observed.contextWindow);
  const clampedMaxInputTokens = clamp(policy.maxInputTokens, observed.maxInputTokens);
  const maxInputTokens = clampedMaxInputTokens !== undefined && contextWindow !== undefined
    ? Math.min(clampedMaxInputTokens, contextWindow)
    : clampedMaxInputTokens;
  const maxOutputTokens = clamp(policy.maxOutputTokens, observed.maxOutputTokens);
  return Object.freeze({
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  });
}
export function resolveModelPolicy(input: ResolveModelPolicyInput): ResolvedModelPolicy {
  const entry = input.transportMatchedRegistry ? input.registryEntry : undefined;
  const provider = input.provider;
  const providerPolicy: Partial<StaticProviderPolicyShape> = {};
  const providerProvenance: Partial<Record<StaticProviderPolicyField, StaticPolicySource>> = {};
  const [baseUrl, baseUrlSource] = resolvedBaseUrl(entry, provider);
  const put = <K extends StaticProviderPolicyField>(key: K, value: StaticProviderPolicyShape[K] | undefined, source: StaticPolicySource): void => {
    if (value !== undefined) providerPolicy[key] = detachedClone(value) as never;
    providerProvenance[key] = source;
  };
  const putScalar = <K extends StaticProviderPolicyField>(key: K, registryValue: StaticProviderPolicyShape[K] | undefined): void => {
    const [value, source] = scalar(provider[key], registryValue);
    put(key, value, source);
  };
  const putUnion = (key: StaticProviderPolicyField, registryValue: readonly string[] | undefined): void => {
    const [value, source] = stableUnion(registryValue, provider[key] as string[] | undefined);
    put(key, value as never, source);
  };
  const putMergedMap = <K extends StaticProviderPolicyField, T>(
    key: K,
    registryValue: Readonly<Record<string, T>> | undefined,
    operatorValue: Readonly<Record<string, T>> | undefined,
  ): void => {
    const [value, source] = mapFill(registryValue, operatorValue);
    put(key, value as StaticProviderPolicyShape[K], source);
  };
  put("adapter", entry?.adapter ?? provider.adapter, entry ? "registry" : "operator");
  put("baseUrl", baseUrl, baseUrlSource);
  putScalar("apiKeyTransport", entry?.apiKeyTransport);
  const [headers, headersSource] = staticHeaders(entry?.staticHeaders, provider.headers);
  put("headers", headers, headersSource);
  const resolvedAuthMode = input.effectiveAuth?.authMode
    ?? (entry?.authKind === "forward" || entry?.authKind === "oauth"
      ? entry.authKind
      : provider.authMode === "forward" ? undefined : provider.authMode ?? entry?.authKind);
  put("authMode", resolvedAuthMode, input.effectiveAuth
    ? "captured-auth"
    : entry?.authKind === "forward" || entry?.authKind === "oauth" ? "registry"
    : provider.authMode !== undefined ? "operator" : entry ? "registry" : "unknown");
  putScalar("codexAccountMode", entry?.codexAccountMode);
  const keyAuthDefaults = entry?.allowKeyAuthOverride === true
    && resolvedAuthMode === "key"
    && ["authorization_bearer", "x_api_key"].includes(resolveProviderAuthTransport(
      provider.adapter,
      resolvedAuthMode,
      provider.apiKeyTransport,
    ))
    ? entry.keyAuthServiceTier
    : undefined;
  for (const key of [
    "responsesPath", "chatCompletionsPath", "keyOptional", "freeTier", "modelSuffixBracketStrip",
    "defaultModel", "models", "liveModels", "contextWindow", "defaultMaxOutputTokens",
    "reasoningWireFormat", "parallelToolCalls", "promptCacheKey",
    "openaiChatEofTolerance", "statelessResponses",
    "requiresAdjacentResponsesToolResults", "requiresPairedResponsesToolResults",
    "annotateEmptyToolOutputs", "fastWire", "supportsServiceTier",
    "supportsOpenAiWebSearchToolFields", "supportsResponsesCustomTools",
    "preserveResponsesReasoningContent", "dropResponsesReasoningItems",
    "supportsVerbosity", "responsesItemIdRepair",
    "showThinkingSummary", "escapeBuiltinToolNames", "googleMode", "project", "location",
  ] as const) putScalar(key, entry?.[key] as StaticProviderPolicyShape[typeof key] | undefined);
  const legacyClinePassLadder = entry !== undefined && input.providerName === "cline-pass"
    && provider.reasoningWireFormat === "gateway-object"
    && sameStringArray(provider.reasoningEfforts, ["low"]);
  put("reasoningEfforts", legacyClinePassLadder ? entry?.reasoningEfforts : provider.reasoningEfforts ?? entry?.reasoningEfforts,
    legacyClinePassLadder || provider.reasoningEfforts === undefined ? entry?.reasoningEfforts ? "registry" : "unknown" : "operator");
  put("chatServiceTier", provider.chatServiceTier ?? keyAuthDefaults?.chatServiceTier ?? entry?.chatServiceTier,
    provider.chatServiceTier !== undefined ? "operator" : keyAuthDefaults?.chatServiceTier !== undefined ? "registry" : entry?.chatServiceTier !== undefined ? "registry" : "unknown");
  put("supportsServiceTier", provider.supportsServiceTier ?? keyAuthDefaults?.supportsServiceTier ?? entry?.supportsServiceTier,
    provider.supportsServiceTier !== undefined ? "operator" : keyAuthDefaults?.supportsServiceTier !== undefined ? "registry" : entry?.supportsServiceTier !== undefined ? "registry" : "unknown");
  if (entry && !registryEntrySupportsLiveModelDiscovery(entry)) put("liveModels", false, "registry");
  putMergedMap("modelDisplayNames", entry?.modelDisplayNames, provider.modelDisplayNames);
  putMergedMap("modelInputModalities", entry?.modelInputModalities, provider.modelInputModalities);
  putMergedMap("modelMaxOutputTokens", entry?.modelMaxOutputTokens, provider.modelMaxOutputTokens);
  putMergedMap("modelReasoningEfforts", entry?.modelReasoningEfforts, provider.modelReasoningEfforts);
  // Operator-only: no registry entry declares it, and it decides whether the map above is the
  // wire contract or only the catalog's. A policy reader that omitted it would report the same
  // effective ladder for two providers that send different efforts.
  put("modelReasoningEffortsAuthoritative", provider.modelReasoningEffortsAuthoritative,
    provider.modelReasoningEffortsAuthoritative !== undefined ? "operator" : "unknown");
  putMergedMap("modelDefaultReasoningEfforts", entry?.modelDefaultReasoningEfforts, provider.modelDefaultReasoningEfforts);
  const registryServiceTier = !entry?.modelServiceTierCapabilityBaseUrlGuard
    || entry.modelServiceTierCapabilityBaseUrlGuard(provider.baseUrl)
    ? entry?.modelSupportsServiceTier
    : undefined;
  const registryServiceTierDefaults = registryServiceTier || keyAuthDefaults?.modelSupportsServiceTier
    ? { ...(registryServiceTier ?? {}), ...(keyAuthDefaults?.modelSupportsServiceTier ?? {}) }
    : undefined;
  putMergedMap("modelSupportsServiceTier", registryServiceTierDefaults, provider.modelSupportsServiceTier);
  putMergedMap("modelSupportsReasoningSummaries", entry?.modelSupportsReasoningSummaries, provider.modelSupportsReasoningSummaries);
  putMergedMap("modelSupportsVerbosity", entry?.modelSupportsVerbosity, provider.modelSupportsVerbosity);
  for (const key of [
    "modelCapabilities", "modelAutoCompactTokenLimits", "modelSuppressSyntheticMax",
    "modelReasoningSummaryDelivery", "codexToolMode", "modelAdapters",
  ] as const) putScalar(key, undefined);
  for (const key of ["modelContextWindows", "modelMaxInputTokens"] as const) {
    const [value, source] = input.providerName === "openai-apikey"
      ? positiveCapMap(entry?.[key], provider[key])
      : mapFill(entry?.[key], provider[key]);
    put(key, value, source);
  }
  const [effortMap, effortMapSource] = mapFill(entry?.reasoningEffortMap, provider.reasoningEffortMap);
  put("reasoningEffortMap", effortMap, effortMapSource);
  const [modelEffortMap, modelEffortMapSource] = nestedMapFill(entry?.modelReasoningEffortMap, provider.modelReasoningEffortMap);
  put("modelReasoningEffortMap", modelEffortMap, modelEffortMapSource);
  for (const key of [
    "noVisionModels", "noReasoningModels", "noTemperatureModels", "noTopPModels",
    "noStopModels",
    "noPenaltyModels", "noJsonSchemaModels", "autoToolChoiceOnlyModels",
    "preserveReasoningContentModels", "requiresReasoningPlaceholderModels",
    "reasoningSplitModels", "reasoningDetailsModels", "thinkingToggleModels", "thinkingBudgetModels",
  ] as const) putUnion(key, entry?.[key]);
  // This parser is opt-in: an explicit list, including [], overrides registry defaults.
  putScalar("inlineThinkTagModels", entry?.inlineThinkTagModels);
  for (const directModel of entry?.directReasoningEffortModels ?? []) {
    const staleBudget = [directModel, ...(entry?.thinkingBudgetModels ?? [])];
    const routedStaleBudget = [...(entry?.thinkingBudgetModels ?? []), directModel];
    if (sameStringArray(provider.thinkingBudgetModels, staleBudget)
      || sameStringArray(provider.thinkingBudgetModels, routedStaleBudget)) {
      providerPolicy.thinkingBudgetModels = [...(entry?.thinkingBudgetModels ?? [])];
      providerProvenance.thinkingBudgetModels = "registry";
    }
    const explicitEfforts = Object.entries(provider.modelReasoningEfforts ?? {})
      .filter(([key]) => key.toLowerCase() === directModel.toLowerCase());
    if (explicitEfforts.length > 0) {
      for (const key of Object.keys(providerPolicy.modelReasoningEfforts ?? {})) {
        if (key.toLowerCase() === directModel.toLowerCase()) delete providerPolicy.modelReasoningEfforts![key];
      }
      for (const [key, value] of explicitEfforts) (providerPolicy.modelReasoningEfforts ??= {})[key] = [...value];
    } else if (entry?.modelReasoningEfforts?.[directModel] !== undefined) {
      (providerPolicy.modelReasoningEfforts ??= {})[directModel] = [...entry.modelReasoningEfforts[directModel]!];
    }
    const explicitDefault = Object.entries(provider.modelDefaultReasoningEfforts ?? {})
      .filter(([key]) => key.toLowerCase() === directModel.toLowerCase());
    if (explicitDefault.length > 0) {
      for (const key of Object.keys(providerPolicy.modelDefaultReasoningEfforts ?? {})) {
        if (key.toLowerCase() === directModel.toLowerCase()) delete providerPolicy.modelDefaultReasoningEfforts![key];
      }
      for (const [key, value] of explicitDefault) (providerPolicy.modelDefaultReasoningEfforts ??= {})[key] = value;
    } else if (entry?.modelDefaultReasoningEfforts?.[directModel] !== undefined) {
      (providerPolicy.modelDefaultReasoningEfforts ??= {})[directModel] = entry.modelDefaultReasoningEfforts[directModel]!;
    }
    const explicitMap = Object.entries(provider.modelReasoningEffortMap ?? {})
      .filter(([key]) => key.toLowerCase() === directModel.toLowerCase());
    for (const key of Object.keys(providerPolicy.modelReasoningEffortMap ?? {})) {
      if (key.toLowerCase() === directModel.toLowerCase()) delete providerPolicy.modelReasoningEffortMap![key];
    }
    if (explicitMap.length > 0) {
      for (const [key, value] of explicitMap) (providerPolicy.modelReasoningEffortMap ??= {})[key] = { ...value };
    } else {
      (providerPolicy.modelReasoningEffortMap ??= {})[directModel] = {};
    }
  }
  const modelValue = <T>(record: Readonly<Record<string, T>> | undefined): T | undefined =>
    legacyModelValue(record, input.modelId);
  const modelSource = <T>(operator: Readonly<Record<string, T>> | undefined, registry: Readonly<Record<string, T>> | undefined): StaticPolicySource =>
    legacyModelSource(operator, registry, input.modelId);
  const modelOrProviderSource = <T>(
    operatorMap: Readonly<Record<string, T>> | undefined, registryMap: Readonly<Record<string, T>> | undefined,
    operatorDefault: T | undefined, registryDefault: T | undefined,
  ): StaticPolicySource => {
    const exact = modelSource(operatorMap, registryMap);
    return exact !== "unknown" ? exact : operatorDefault !== undefined ? "operator" : registryDefault !== undefined ? "registry" : "unknown";
  };
  const configuredAdapter = provider.modelAdapters?.[input.modelId];
  const pin = pinnedWireAdapter(input.providerName, input.modelId, provider);
  const normalizedModelId = input.modelId.trim().toLowerCase();
  const registryWire = wireDefault(entry?.modelWireDefaults?.[normalizedModelId], provider, entry,
    input.inboundWire ?? "responses", resolvedAuthMode);
  const explicitWire = configuredAdapter && MODEL_ADAPTER_OVERRIDE_ALLOWED.has(configuredAdapter)
    ? configuredAdapter
    : undefined;
  const providerAdapter = providerPolicy.adapter ?? provider.adapter;
  const effectiveProviderForWire = resolvedAuthMode === provider.authMode
    ? provider
    : { ...provider, authMode: resolvedAuthMode };
  const canonicalForward = isCanonicalOpenAiForwardProvider(effectiveProviderForWire);
  const adapter = pin
    ?? (!canonicalForward ? explicitWire ?? registryWire : undefined)
    ?? providerAdapter;
  const adapterSource: StaticPolicySource = pin
    ? "hard-pin"
    : explicitWire && !canonicalForward
      ? "operator"
      : registryWire && !canonicalForward
        ? "registry"
        : "provider-default";
  const declaredModalities = input.modelCapabilities?.inputModalities;
  const capabilityModalities = Array.isArray(declaredModalities) && declaredModalities.length > 0
    ? [...declaredModalities]
    : undefined;
  const exactContextWindow = modelValue(providerPolicy.modelContextWindows);
  const familyContextWindow = providerPolicy.adapter === "anthropic"
    ? anthropicFamilyContextWindow(providerPolicy.modelContextWindows, input.modelId)
    : undefined;
  const modelContextWindow = exactContextWindow ?? familyContextWindow ?? providerPolicy.contextWindow;
  const exactMaxInputTokens = modelValue(providerPolicy.modelMaxInputTokens);
  const modelMaxInputTokens = exactMaxInputTokens !== undefined && modelContextWindow !== undefined
    ? Math.min(exactMaxInputTokens, modelContextWindow)
    : exactMaxInputTokens;
  const exactMaxOutputTokens = modelValue(providerPolicy.modelMaxOutputTokens);
  const modelMaxOutputTokens = exactMaxOutputTokens ?? providerPolicy.defaultMaxOutputTokens;
  const modelReasoningEfforts = modelValue(providerPolicy.modelReasoningEfforts) ?? providerPolicy.reasoningEfforts;
  const modelSupportsReasoningSummaries = modelValue(providerPolicy.modelSupportsReasoningSummaries)
    ?? (modelValue(providerPolicy.modelReasoningSummaryDelivery) !== undefined ? true : undefined);
  const modelSupportsVerbosity = modelValue(providerPolicy.modelSupportsVerbosity) ?? providerPolicy.supportsVerbosity;
  const modelSupportsServiceTier = modelValue(providerPolicy.modelSupportsServiceTier) ?? providerPolicy.supportsServiceTier;
  const model: ResolvedPerModelStaticPolicy = {
    adapter,
    ...(modelContextWindow !== undefined ? { contextWindow: modelContextWindow } : {}),
    ...(capabilityModalities ?? modelValue(providerPolicy.modelInputModalities) !== undefined
      ? { inputModalities: capabilityModalities ?? modelValue(providerPolicy.modelInputModalities) }
      : {}),
    ...(modelMaxInputTokens !== undefined ? { maxInputTokens: modelMaxInputTokens } : {}),
    ...(modelMaxOutputTokens !== undefined ? { maxOutputTokens: modelMaxOutputTokens } : {}),
    ...(modelReasoningEfforts !== undefined ? { reasoningEfforts: modelReasoningEfforts } : {}),
    ...(modelValue(providerPolicy.modelDefaultReasoningEfforts) !== undefined ? { defaultReasoningEffort: modelValue(providerPolicy.modelDefaultReasoningEfforts) } : {}),
    ...(modelSupportsReasoningSummaries !== undefined ? { supportsReasoningSummaries: modelSupportsReasoningSummaries } : {}),
    ...(modelSupportsVerbosity !== undefined ? { supportsVerbosity: modelSupportsVerbosity } : {}),
    ...(modelSupportsServiceTier !== undefined ? { supportsServiceTier: modelSupportsServiceTier } : {}),
    ...(modelSupportsServiceTier === true && entry?.fastTierDescription !== undefined
      ? { fastTierDescription: entry.fastTierDescription }
      : {}),
    ...(entry?.directReasoningEffortModels?.includes(input.modelId) ? { directReasoningEffort: true } : {}),
    ...(entry?.modelResponsesUpstreamStreaming?.[normalizedModelId] !== undefined
      ? { responsesUpstreamStreaming: entry.modelResponsesUpstreamStreaming[normalizedModelId] }
      : {}),
    ...(entry?.modelResponsesTerminalRepair?.[normalizedModelId] !== undefined
      ? { responsesTerminalRepair: entry.modelResponsesTerminalRepair[normalizedModelId] }
      : {}),
  };
  const modelProvenance: Partial<Record<keyof ResolvedPerModelStaticPolicy, StaticPolicySource>> = {
    adapter: adapterSource,
  };
  modelProvenance.contextWindow = modelOrProviderSource(provider.modelContextWindows, entry?.modelContextWindows, provider.contextWindow, entry?.contextWindow);
  if (modelProvenance.contextWindow === "unknown" && familyContextWindow !== undefined) {
    modelProvenance.contextWindow = anthropicFamilyContextWindow(provider.modelContextWindows, input.modelId) !== undefined
      ? "operator"
      : "registry";
  }
  modelProvenance.inputModalities = capabilityModalities
    ? "operator-capability"
    : modelSource(provider.modelInputModalities, entry?.modelInputModalities);
  modelProvenance.maxInputTokens = modelSource(provider.modelMaxInputTokens, entry?.modelMaxInputTokens);
  modelProvenance.maxOutputTokens = modelOrProviderSource(
    provider.modelMaxOutputTokens,
    entry?.modelMaxOutputTokens,
    provider.defaultMaxOutputTokens,
    entry?.defaultMaxOutputTokens,
  );
  modelProvenance.reasoningEfforts = modelOrProviderSource(provider.modelReasoningEfforts, entry?.modelReasoningEfforts, provider.reasoningEfforts, entry?.reasoningEfforts);
  modelProvenance.defaultReasoningEffort = modelSource(
    provider.modelDefaultReasoningEfforts,
    entry?.modelDefaultReasoningEfforts,
  );
  modelProvenance.supportsReasoningSummaries = modelSource(provider.modelSupportsReasoningSummaries, entry?.modelSupportsReasoningSummaries);
  if (modelProvenance.supportsReasoningSummaries === "unknown" && modelValue(provider.modelReasoningSummaryDelivery) !== undefined) {
    modelProvenance.supportsReasoningSummaries = "operator";
  }
  modelProvenance.supportsVerbosity = modelOrProviderSource(provider.modelSupportsVerbosity, entry?.modelSupportsVerbosity, provider.supportsVerbosity, entry?.supportsVerbosity);
  const exactServiceTierSource = modelSource(provider.modelSupportsServiceTier, registryServiceTierDefaults);
  modelProvenance.supportsServiceTier = exactServiceTierSource !== "unknown" ? exactServiceTierSource
    : providerProvenance.supportsServiceTier ?? "unknown";
  modelProvenance.responsesUpstreamStreaming = model.responsesUpstreamStreaming === undefined ? "unknown" : "registry";
  modelProvenance.responsesTerminalRepair = model.responsesTerminalRepair === undefined ? "unknown" : "registry";
  modelProvenance.fastTierDescription = model.fastTierDescription === undefined ? "unknown" : "registry";
  modelProvenance.directReasoningEffort = model.directReasoningEffort === undefined ? "unknown" : "registry";
  const alias = input.effectiveAlias !== undefined
    ? input.effectiveAlias
    : provider.alias !== undefined
      ? provider.alias
      : entry?.alias;
  const aliasSource: StaticPolicySource = input.effectiveAlias !== undefined
    ? input.effectiveAliasSource ?? "operator"
    : provider.alias !== undefined
      ? "operator"
    : entry?.alias !== undefined ? "registry" : "unknown";
  return recursivelyFreeze(detachedClone({
    version: 1 as const,
    providerName: input.providerName,
    modelId: input.modelId,
    transportMatchedRegistry: entry !== undefined,
    ...(alias !== undefined ? { effectiveAlias: alias } : {}),
    provider: providerPolicy as ResolvedProviderStaticPolicy,
    model,
    provenance: { alias: aliasSource, provider: providerProvenance, model: modelProvenance },
  }));
}
