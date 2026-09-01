import type { CodexAccountMode, OcxProviderConfig } from "../types";
import { cloneFastWire } from "./fastwire";
import {
  PROVIDER_REGISTRY,
  registryEntryForProviderDestination,
  registryModelServiceTierCapabilityApplies,
  type ProviderRegistryEntry,
} from "./registry";
import {
  providerMatchesRegistryTransportWithStaticGuards,
  registryEntrySupportsLiveModelDiscovery,
  repairStaticModelCatalogProvider,
} from "./static-model-discovery";

export interface DerivedKeyLoginProvider {
  label: string;
  baseUrl: string;
  responsesPath?: string;
  adapter: string;
  apiKeyValidation?: "unknown";
  apiKeyTransport?: OcxProviderConfig["apiKeyTransport"];
  dashboardUrl: string;
  models?: string[];
  liveModels?: boolean;
  defaultModel?: string;
  contextWindow?: number;
  modelContextWindows?: Record<string, number>;
  modelInputModalities?: Record<string, string[]>;
  modelMaxInputTokens?: Record<string, number>;
  defaultMaxOutputTokens?: number;
  modelMaxOutputTokens?: Record<string, number>;
  reasoningEfforts?: string[];
  modelReasoningEfforts?: Record<string, string[]>;
  modelDefaultReasoningEfforts?: Record<string, string>;
  reasoningEffortMap?: Record<string, string>;
  modelReasoningEffortMap?: Record<string, Record<string, string>>;
  reasoningWireFormat?: OcxProviderConfig["reasoningWireFormat"];
  noVisionModels?: string[];
  noReasoningModels?: string[];
  noTemperatureModels?: string[];
  noTopPModels?: string[];
  noPenaltyModels?: string[];
  autoToolChoiceOnlyModels?: string[];
  preserveReasoningContentModels?: string[];
  requiresReasoningPlaceholderModels?: string[];
  reasoningSplitModels?: string[];
  reasoningDetailsModels?: string[];
  thinkingToggleModels?: string[];
  thinkingBudgetModels?: string[];
  escapeBuiltinToolNames?: boolean;
  openaiChatEofTolerance?: boolean;
  googleMode?: "ai-studio" | "vertex" | "cloud-code-assist";
  project?: string;
  location?: string;
}

export interface DerivedInitProvider {
  id: string;
  label: string;
  adapter: string;
  baseUrl: string;
  kind: "forward" | "oauth" | "key" | "local";
  codexAccountMode?: CodexAccountMode;
  dashboardUrl?: string;
  defaultModel?: string;
}

export interface DerivedProviderPreset {
  id: string;
  label: string;
  adapter: string;
  baseUrl: string;
  responsesPath?: string;
  defaultModel?: string;
  auth: "oauth" | "forward" | "key" | "local";
  codexAccountMode?: CodexAccountMode;
  oauthProvider?: string;
  dashboardUrl?: string;
  note?: string;
  keyOptional?: boolean;
  /** Free pricing (may still require a key). */
  freeTier?: boolean;
  /**
   * Endpoint picker rows (token plan / payg / custom). When present, the add-provider
   * form shows a dropdown; `custom` reveals a free-text base URL field.
   */
  baseUrlChoices?: Array<{ id: string; label: string; baseUrl?: string }>;
  /** Immutable canonical provider config seed for the reserved canonical `openai` forward preset. */
  provider?: OcxProviderConfig;
}

export function listRegistryEntries(): readonly ProviderRegistryEntry[] {
  return PROVIDER_REGISTRY;
}

function cloneRecordOfArrays(input: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, [...value]]));
}

/**
 * Fill registry defaults BENEATH the user's per-model entries.
 *
 * Capability maps are keyed per model, so an all-or-nothing fill lets a single
 * customized model hide the registry's knowledge about every other model. That
 * is how a partially customized `modelInputModalities` could leave a
 * vision-capable model advertising no image support, which in turn collapses any
 * combo containing it to text-only. Routing already merges these maps per key
 * (`mergeRecordFill` in src/router.ts); catalog enrichment now matches.
 */
function fillRecordOfArrays(
  seed: Record<string, string[]>,
  user: Record<string, string[]> | undefined,
): Record<string, string[]> {
  return { ...cloneRecordOfArrays(seed), ...(user ? cloneRecordOfArrays(user) : {}) };
}

function cloneNestedRecord(input: Record<string, Record<string, string>>): Record<string, Record<string, string>> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, { ...value }]));
}

function sameStringArray(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return left?.length === right.length && left.every((value, index) => value === right[index]);
}

type DirectReasoningEffortOverrides = Pick<
  OcxProviderConfig,
  "thinkingBudgetModels" | "modelReasoningEfforts" | "modelDefaultReasoningEfforts" | "modelReasoningEffortMap"
>;

function fillFoldedModelDefault<T>(
  merged: Record<string, T> | undefined,
  explicit: Record<string, T> | undefined,
  model: string,
  registryDefault: T | undefined,
  clone: (value: T) => T,
): Record<string, T> | undefined {
  const folded = model.toLowerCase();
  const explicitEntries = Object.entries(explicit ?? {}).filter(([key]) => key.toLowerCase() === folded);
  if (explicitEntries.length === 0) {
    return registryDefault === undefined ? merged : { ...(merged ?? {}), [model]: clone(registryDefault) };
  }

  const next = Object.fromEntries(
    Object.entries(merged ?? {}).filter(([key]) => key.toLowerCase() !== folded),
  ) as Record<string, T>;
  for (const [key, value] of explicitEntries) next[key] = clone(value);
  return next;
}

/**
 * Apply a registry-owned direct `reasoning_effort` contract after user/seed metadata is merged.
 *
 * Provider presets are persisted with capability metadata, so an existing config can retain an
 * obsolete thinking-budget classification after the registry learns that a model has a native
 * effort field. The registry opts only verified model contracts into this repair; providers that
 * do not resolve through the matching registry entry keep their user-supplied classification.
 */
export function applyDirectReasoningEffortContracts(
  entry: ProviderRegistryEntry,
  prov: OcxProviderConfig,
  explicit: DirectReasoningEffortOverrides = prov,
): void {
  const models = entry.directReasoningEffortModels;
  if (!models || models.length === 0) return;

  for (const model of models) {
    // Old generated presets persisted the direct model at the front of the registry's budget
    // list. Routing merges registry-first, which moves that one stale entry to the end. Repair
    // only those two exact generated shapes; any partial, reordered, or case-varied list is a
    // deliberate user value and remains untouched.
    const currentBudgetModels = entry.thinkingBudgetModels ?? [];
    const staleSeedShape = [model, ...currentBudgetModels];
    const staleRoutedShape = [...currentBudgetModels, model];
    if (sameStringArray(explicit.thinkingBudgetModels, staleSeedShape)
      || sameStringArray(explicit.thinkingBudgetModels, staleRoutedShape)) {
      prov.thinkingBudgetModels = [...currentBudgetModels];
    }

    const efforts = entry.modelReasoningEfforts?.[model];
    prov.modelReasoningEfforts = fillFoldedModelDefault(
      prov.modelReasoningEfforts,
      explicit.modelReasoningEfforts,
      model,
      efforts,
      value => [...value],
    );

    const defaultEffort = entry.modelDefaultReasoningEfforts?.[model];
    prov.modelDefaultReasoningEfforts = fillFoldedModelDefault(
      prov.modelDefaultReasoningEfforts,
      explicit.modelDefaultReasoningEfforts,
      model,
      defaultEffort,
      value => value,
    );

    // An explicit empty model map masks any provider-wide aliases. Without it, a stale global
    // mapping such as xhigh -> max would win before the verified direct ladder can clamp it.
    prov.modelReasoningEffortMap = fillFoldedModelDefault(
      prov.modelReasoningEffortMap,
      explicit.modelReasoningEffortMap,
      model,
      {},
      value => ({ ...value }),
    );
  }
}

/**
 * Build the provider config a registry entry contributes when a preset is materialized.
 * The registry auth kind is preserved verbatim (including `"local"`) so fail-closed gates
 * keep distinguishing local runtimes from API-key providers after the seed round-trip.
 */
export function providerConfigSeed(entry: ProviderRegistryEntry): OcxProviderConfig {
  const liveModels = registryEntrySupportsLiveModelDiscovery(entry) ? entry.liveModels : false;
  return {
    adapter: entry.adapter,
    baseUrl: entry.baseUrl,
    ...(entry.apiKeyTransport !== undefined ? { apiKeyTransport: entry.apiKeyTransport } : {}),
    ...(entry.responsesPath ? { responsesPath: entry.responsesPath } : {}),
    // Preserve the registry auth kind verbatim (including "local") so fail-closed gates that
    // distinguish local runtimes from API-key providers keep working after the seed round-trip.
    authMode: entry.authKind,
    ...(entry.codexAccountMode ? { codexAccountMode: entry.codexAccountMode } : {}),
    ...(entry.keyOptional !== undefined ? { keyOptional: entry.keyOptional } : {}),
    ...(entry.freeTier !== undefined ? { freeTier: entry.freeTier } : {}),
    ...(entry.modelSuffixBracketStrip !== undefined ? { modelSuffixBracketStrip: entry.modelSuffixBracketStrip } : {}),
    ...(entry.staticHeaders ? { headers: { ...entry.staticHeaders } } : {}),
    ...(entry.defaultModel ? { defaultModel: entry.defaultModel } : {}),
    ...(entry.models ? { models: [...entry.models] } : {}),
    ...(liveModels !== undefined ? { liveModels } : {}),
    ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
    ...(entry.modelContextWindows ? { modelContextWindows: { ...entry.modelContextWindows } } : {}),
    ...(entry.modelDisplayNames ? { modelDisplayNames: { ...entry.modelDisplayNames } } : {}),
    ...(entry.modelInputModalities ? { modelInputModalities: cloneRecordOfArrays(entry.modelInputModalities) } : {}),
    ...(entry.modelMaxInputTokens ? { modelMaxInputTokens: { ...entry.modelMaxInputTokens } } : {}),
    ...(entry.defaultMaxOutputTokens !== undefined ? { defaultMaxOutputTokens: entry.defaultMaxOutputTokens } : {}),
    ...(entry.modelMaxOutputTokens ? { modelMaxOutputTokens: { ...entry.modelMaxOutputTokens } } : {}),
    ...(entry.reasoningEfforts ? { reasoningEfforts: [...entry.reasoningEfforts] } : {}),
    ...(entry.modelReasoningEfforts ? { modelReasoningEfforts: cloneRecordOfArrays(entry.modelReasoningEfforts) } : {}),
    ...(entry.modelDefaultReasoningEfforts ? { modelDefaultReasoningEfforts: { ...entry.modelDefaultReasoningEfforts } } : {}),
    ...(entry.reasoningEffortMap ? { reasoningEffortMap: { ...entry.reasoningEffortMap } } : {}),
    ...(entry.modelReasoningEffortMap ? { modelReasoningEffortMap: cloneNestedRecord(entry.modelReasoningEffortMap) } : {}),
    ...(entry.reasoningWireFormat ? { reasoningWireFormat: entry.reasoningWireFormat } : {}),
    ...(entry.noVisionModels ? { noVisionModels: [...entry.noVisionModels] } : {}),
    ...(entry.noReasoningModels ? { noReasoningModels: [...entry.noReasoningModels] } : {}),
    ...(entry.noTemperatureModels ? { noTemperatureModels: [...entry.noTemperatureModels] } : {}),
    ...(entry.noTopPModels ? { noTopPModels: [...entry.noTopPModels] } : {}),
    ...(entry.noPenaltyModels ? { noPenaltyModels: [...entry.noPenaltyModels] } : {}),
    ...(entry.parallelToolCalls !== undefined ? { parallelToolCalls: entry.parallelToolCalls } : {}),
    ...(entry.promptCacheKey !== undefined ? { promptCacheKey: entry.promptCacheKey } : {}),
    ...(entry.chatServiceTier !== undefined ? { chatServiceTier: entry.chatServiceTier } : {}),
    ...(entry.openaiChatEofTolerance !== undefined ? { openaiChatEofTolerance: entry.openaiChatEofTolerance } : {}),
    ...(entry.responsesPath !== undefined ? { responsesPath: entry.responsesPath } : {}),
    ...(entry.statelessResponses !== undefined ? { statelessResponses: entry.statelessResponses } : {}),
    ...(entry.requiresAdjacentResponsesToolResults !== undefined
      ? { requiresAdjacentResponsesToolResults: entry.requiresAdjacentResponsesToolResults }
      : {}),
    ...(entry.annotateEmptyToolOutputs !== undefined
      ? { annotateEmptyToolOutputs: entry.annotateEmptyToolOutputs }
      : {}),
    ...(entry.autoToolChoiceOnlyModels ? { autoToolChoiceOnlyModels: [...entry.autoToolChoiceOnlyModels] } : {}),
    ...(entry.preserveReasoningContentModels ? { preserveReasoningContentModels: [...entry.preserveReasoningContentModels] } : {}),
    ...(entry.requiresReasoningPlaceholderModels ? { requiresReasoningPlaceholderModels: [...entry.requiresReasoningPlaceholderModels] } : {}),
    ...(entry.reasoningSplitModels ? { reasoningSplitModels: [...entry.reasoningSplitModels] } : {}),
    ...(entry.reasoningDetailsModels ? { reasoningDetailsModels: [...entry.reasoningDetailsModels] } : {}),
    ...(entry.thinkingToggleModels ? { thinkingToggleModels: [...entry.thinkingToggleModels] } : {}),
    ...(entry.thinkingBudgetModels ? { thinkingBudgetModels: [...entry.thinkingBudgetModels] } : {}),
    ...(entry.escapeBuiltinToolNames !== undefined ? { escapeBuiltinToolNames: entry.escapeBuiltinToolNames } : {}),
    ...(entry.googleMode ? { googleMode: entry.googleMode } : {}),
    ...(entry.project ? { project: entry.project } : {}),
    ...(entry.location ? { location: entry.location } : {}),
  };
}

export function deriveKeyLoginMap(): Record<string, DerivedKeyLoginProvider> {
  const out: Record<string, DerivedKeyLoginProvider> = {};
  for (const entry of PROVIDER_REGISTRY) {
    if (entry.authKind !== "key") continue;
    if (!entry.dashboardUrl) throw new Error(`Registry key provider missing dashboardUrl: ${entry.id}`);
    const liveModels = registryEntrySupportsLiveModelDiscovery(entry) ? entry.liveModels : false;
    out[entry.id] = {
      label: entry.label,
      baseUrl: entry.baseUrl,
      ...(entry.responsesPath ? { responsesPath: entry.responsesPath } : {}),
      adapter: entry.adapter,
      ...(entry.apiKeyValidation !== undefined ? { apiKeyValidation: entry.apiKeyValidation } : {}),
      ...(entry.apiKeyTransport !== undefined ? { apiKeyTransport: entry.apiKeyTransport } : {}),
      dashboardUrl: entry.dashboardUrl,
      ...(entry.models ? { models: [...entry.models] } : {}),
      ...(liveModels !== undefined ? { liveModels } : {}),
      ...(entry.defaultModel ? { defaultModel: entry.defaultModel } : {}),
      ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
      ...(entry.modelContextWindows ? { modelContextWindows: { ...entry.modelContextWindows } } : {}),
      ...(entry.modelInputModalities ? { modelInputModalities: cloneRecordOfArrays(entry.modelInputModalities) } : {}),
      ...(entry.modelMaxInputTokens ? { modelMaxInputTokens: { ...entry.modelMaxInputTokens } } : {}),
      ...(entry.defaultMaxOutputTokens !== undefined ? { defaultMaxOutputTokens: entry.defaultMaxOutputTokens } : {}),
      ...(entry.modelMaxOutputTokens ? { modelMaxOutputTokens: { ...entry.modelMaxOutputTokens } } : {}),
      ...(entry.reasoningEfforts ? { reasoningEfforts: [...entry.reasoningEfforts] } : {}),
      ...(entry.modelReasoningEfforts ? { modelReasoningEfforts: cloneRecordOfArrays(entry.modelReasoningEfforts) } : {}),
      ...(entry.modelDefaultReasoningEfforts ? { modelDefaultReasoningEfforts: { ...entry.modelDefaultReasoningEfforts } } : {}),
      ...(entry.reasoningEffortMap ? { reasoningEffortMap: { ...entry.reasoningEffortMap } } : {}),
      ...(entry.modelReasoningEffortMap ? { modelReasoningEffortMap: cloneNestedRecord(entry.modelReasoningEffortMap) } : {}),
      ...(entry.reasoningWireFormat ? { reasoningWireFormat: entry.reasoningWireFormat } : {}),
      ...(entry.noVisionModels ? { noVisionModels: [...entry.noVisionModels] } : {}),
      ...(entry.noReasoningModels ? { noReasoningModels: [...entry.noReasoningModels] } : {}),
      ...(entry.noTemperatureModels ? { noTemperatureModels: [...entry.noTemperatureModels] } : {}),
      ...(entry.noTopPModels ? { noTopPModels: [...entry.noTopPModels] } : {}),
      ...(entry.noPenaltyModels ? { noPenaltyModels: [...entry.noPenaltyModels] } : {}),
      ...(entry.autoToolChoiceOnlyModels ? { autoToolChoiceOnlyModels: [...entry.autoToolChoiceOnlyModels] } : {}),
      ...(entry.preserveReasoningContentModels ? { preserveReasoningContentModels: [...entry.preserveReasoningContentModels] } : {}),
      ...(entry.requiresReasoningPlaceholderModels ? { requiresReasoningPlaceholderModels: [...entry.requiresReasoningPlaceholderModels] } : {}),
      ...(entry.reasoningSplitModels ? { reasoningSplitModels: [...entry.reasoningSplitModels] } : {}),
      ...(entry.reasoningDetailsModels ? { reasoningDetailsModels: [...entry.reasoningDetailsModels] } : {}),
      ...(entry.thinkingToggleModels ? { thinkingToggleModels: [...entry.thinkingToggleModels] } : {}),
      ...(entry.thinkingBudgetModels ? { thinkingBudgetModels: [...entry.thinkingBudgetModels] } : {}),
      ...(entry.escapeBuiltinToolNames !== undefined ? { escapeBuiltinToolNames: entry.escapeBuiltinToolNames } : {}),
      ...(entry.openaiChatEofTolerance !== undefined ? { openaiChatEofTolerance: entry.openaiChatEofTolerance } : {}),
      ...(entry.googleMode ? { googleMode: entry.googleMode } : {}),
      ...(entry.project ? { project: entry.project } : {}),
      ...(entry.location ? { location: entry.location } : {}),
    };
  }
  return out;
}

export function deriveInitProviders(): DerivedInitProvider[] {
  return PROVIDER_REGISTRY.map(entry => ({
    id: entry.id,
    label: formatInitLabel(entry),
    adapter: entry.adapter,
    baseUrl: entry.baseUrl,
    kind: entry.authKind,
    ...(entry.codexAccountMode ? { codexAccountMode: entry.codexAccountMode } : {}),
    ...(entry.dashboardUrl ? { dashboardUrl: entry.dashboardUrl } : {}),
    ...(entry.defaultModel ? { defaultModel: entry.defaultModel } : {}),
  }));
}

export function deriveOAuthProviderConfig(id: string): OcxProviderConfig | undefined {
  const entry = PROVIDER_REGISTRY.find(row => row.id === id && row.authKind === "oauth");
  return entry ? providerConfigSeed(entry) : undefined;
}

export function deriveOAuthDefaultModel(id: string): string | undefined {
  return PROVIDER_REGISTRY.find(row => row.id === id && row.authKind === "oauth")?.defaultModel;
}

export function deriveOAuthIds(): string[] {
  return PROVIDER_REGISTRY.filter(entry => entry.authKind === "oauth").map(entry => entry.oauthId ?? entry.id);
}

export function deriveProviderPresets(): DerivedProviderPreset[] {
  const presets = PROVIDER_REGISTRY
    .filter(entry => entry.featured || entry.authKind === "key" || entry.dashboardPreset)
    .map(entryToPreset);
  return [...dedupePresets(presets), customPreset()];
}

/**
 * Merge registry reasoning-summary defaults PER KEY, letting explicit user values win.
 *
 * Not a whole-Record `=== undefined` fill like the scalars around it: a user who sets one
 * model's flag creates a defined Record, and a whole-object check would then suppress every
 * registry default for that provider. Spreading registry-first also preserves an explicit
 * `false` — someone who disabled summaries for a model because their backend 400s on it keeps
 * that. The result is a fresh object, so saved config never aliases the registry constant.
 */
function applyReasoningSummaryDefaults(
  prov: OcxProviderConfig,
  defaults: Readonly<Record<string, boolean>> | undefined,
): void {
  if (!defaults) return;
  prov.modelSupportsReasoningSummaries = {
    ...defaults,
    ...(prov.modelSupportsReasoningSummaries ?? {}),
  };
}

function applyServiceTierModelDefaults(
  prov: OcxProviderConfig,
  defaults: Readonly<Record<string, boolean>> | undefined,
): void {
  if (!defaults) return;
  prov.modelSupportsServiceTier = {
    ...defaults,
    ...(prov.modelSupportsServiceTier ?? {}),
  };
}

function serviceTierModelDefaultsFor(
  entry: ProviderRegistryEntry | undefined,
  prov: OcxProviderConfig,
): Readonly<Record<string, boolean>> | undefined {
  return entry && registryModelServiceTierCapabilityApplies(entry, prov)
    ? entry.modelSupportsServiceTier
    : undefined;
}

/**
 * Materialize the registry's verbosity opt-out into the provider config at seed/enrich time.
 *
 * The catalog hint pass must not read PROVIDER_REGISTRY: a gather flight captures its registry
 * authority up front and forbids any later read, so consulting the registry per model turned
 * every hint pass into a post-lookup read and dropped a custom-destination flight's own
 * discovery result (tests/codex-gather-authority.test.ts).
 *
 * Registry values go in first so an explicit user entry still wins, matching
 * `applyReasoningSummaryDefaults`. `supportsVerbosity` is the provider-wide default, expanded
 * across the seeded model list so an id discovered later still inherits it through the same
 * Record the hint pass already reads.
 */
function applyVerbosityDefaults(prov: OcxProviderConfig, entry: ProviderRegistryEntry | undefined): void {
  if (!entry) return;
  const perModel = entry.modelSupportsVerbosity;
  if (!perModel && entry.supportsVerbosity === undefined) return;
  prov.modelSupportsVerbosity = {
    ...(perModel ?? {}),
    ...(prov.modelSupportsVerbosity ?? {}),
  };
  if (entry.supportsVerbosity !== undefined) {
    prov.supportsVerbosity ??= entry.supportsVerbosity;
  }
}

/**
 * Last-resort enrichment for a provider whose NAME matches no registry id.
 *
 * #1100 was reported against a hand-added provider called "GLM" pointing at a vendor endpoint
 * we recognize. Routing worked, so the row looked healthy, but every piece of registry metadata
 * was skipped and the reasoning ladder was advertised without summary support — exactly the
 * inconsistency that makes Codex drop the inbound reasoning object.
 *
 * Deliberately narrow: only the reasoning-summary map, and only via
 * `registryEntryForProviderDestination`, which matches fixed key destinations and refuses
 * templated or overridable base URLs. A custom row keeps its own identity for everything else.
 */
function enrichReasoningSummariesByDestination(prov: OcxProviderConfig): void {
  const destination = registryEntryForProviderDestination(prov);
  applyReasoningSummaryDefaults(prov, destination?.modelSupportsReasoningSummaries);
}

/** Repair the exact low-only ClinePass ladder generated by older key-login presets. */
export function hasLegacyClinePassReasoningEfforts(name: string, prov: OcxProviderConfig): boolean {
  return name === "cline-pass"
    && prov.reasoningWireFormat === "gateway-object"
    && prov.reasoningEfforts?.length === 1
    && prov.reasoningEfforts[0] === "low";
}

export function enrichProviderFromRegistry(name: string, prov: OcxProviderConfig): void {
  const entry = PROVIDER_REGISTRY.find(row => row.id === name);
  if (!entry || !providerMatchesRegistryTransportWithStaticGuards(name, prov)) {
    // Name lookup failed, but the row may still point at a vendor route we know. #1100 was
    // reported against a hand-added provider literally named "GLM": routing worked, yet every
    // piece of registry metadata was skipped because no registry id is called "GLM".
    // `registryEntryForProviderDestination` answers the question that actually matters here —
    // which vendor endpoint is this row talking to — and is already restricted to fixed key
    // destinations, so a templated or overridable base URL cannot be claimed by it.
    enrichReasoningSummariesByDestination(prov);
    applyServiceTierModelDefaults(prov, serviceTierModelDefaultsFor(registryEntryForProviderDestination(prov), prov));
    applyVerbosityDefaults(prov, registryEntryForProviderDestination(prov));
    return;
  }
  const explicitDirectReasoning: DirectReasoningEffortOverrides = {
    thinkingBudgetModels: prov.thinkingBudgetModels,
    modelReasoningEfforts: prov.modelReasoningEfforts,
    modelDefaultReasoningEfforts: prov.modelDefaultReasoningEfforts,
    modelReasoningEffortMap: prov.modelReasoningEffortMap,
  };
  const seed = providerConfigSeed(entry);
  repairStaticModelCatalogProvider(name, prov);
  if (prov.apiKeyTransport === undefined && seed.apiKeyTransport !== undefined) prov.apiKeyTransport = seed.apiKeyTransport;
  if (!prov.defaultModel && seed.defaultModel) prov.defaultModel = seed.defaultModel;
  if (prov.responsesPath === undefined && seed.responsesPath !== undefined) prov.responsesPath = seed.responsesPath;
  // Fill mode only when absent: an explicit persisted `direct` must never be overwritten.
  if (prov.codexAccountMode === undefined && seed.codexAccountMode !== undefined) prov.codexAccountMode = seed.codexAccountMode;
  if (!prov.models && seed.models) prov.models = [...seed.models];
  if (prov.liveModels === undefined && seed.liveModels !== undefined) prov.liveModels = seed.liveModels;
  if (prov.contextWindow === undefined && seed.contextWindow !== undefined) prov.contextWindow = seed.contextWindow;
  if (!prov.modelContextWindows && seed.modelContextWindows) prov.modelContextWindows = { ...seed.modelContextWindows };
  // Per-model fill, not all-or-nothing: an operator who renamed ONE model must still receive
  // labels for the rest, and an existing install must pick up newly seeded rows on enrich.
  if (seed.modelDisplayNames) {
    prov.modelDisplayNames = { ...seed.modelDisplayNames, ...(prov.modelDisplayNames ?? {}) };
  }
  if (seed.modelInputModalities) prov.modelInputModalities = fillRecordOfArrays(seed.modelInputModalities, prov.modelInputModalities);
  if (prov.defaultMaxOutputTokens === undefined && seed.defaultMaxOutputTokens !== undefined) prov.defaultMaxOutputTokens = seed.defaultMaxOutputTokens;
  if (!prov.modelMaxOutputTokens && seed.modelMaxOutputTokens) prov.modelMaxOutputTokens = { ...seed.modelMaxOutputTokens };
  if ((!prov.reasoningEfforts || hasLegacyClinePassReasoningEfforts(name, prov)) && seed.reasoningEfforts) {
    prov.reasoningEfforts = [...seed.reasoningEfforts];
  }
  if (!prov.modelReasoningEfforts && seed.modelReasoningEfforts) prov.modelReasoningEfforts = cloneRecordOfArrays(seed.modelReasoningEfforts);
  if (!prov.modelDefaultReasoningEfforts && seed.modelDefaultReasoningEfforts) prov.modelDefaultReasoningEfforts = { ...seed.modelDefaultReasoningEfforts };
  if (!prov.reasoningEffortMap && seed.reasoningEffortMap) prov.reasoningEffortMap = { ...seed.reasoningEffortMap };
  if (!prov.modelReasoningEffortMap && seed.modelReasoningEffortMap) prov.modelReasoningEffortMap = cloneNestedRecord(seed.modelReasoningEffortMap);
  if (prov.reasoningWireFormat === undefined && seed.reasoningWireFormat !== undefined) prov.reasoningWireFormat = seed.reasoningWireFormat;
  if (!prov.noVisionModels && seed.noVisionModels) prov.noVisionModels = [...seed.noVisionModels];
  if (!prov.noReasoningModels && seed.noReasoningModels) prov.noReasoningModels = [...seed.noReasoningModels];
  if (!prov.noTemperatureModels && seed.noTemperatureModels) prov.noTemperatureModels = [...seed.noTemperatureModels];
  if (!prov.noTopPModels && seed.noTopPModels) prov.noTopPModels = [...seed.noTopPModels];
  if (!prov.noPenaltyModels && seed.noPenaltyModels) prov.noPenaltyModels = [...seed.noPenaltyModels];
  if (prov.parallelToolCalls === undefined && seed.parallelToolCalls !== undefined) prov.parallelToolCalls = seed.parallelToolCalls;
  if (prov.promptCacheKey === undefined && seed.promptCacheKey !== undefined) prov.promptCacheKey = seed.promptCacheKey;
  if (prov.chatServiceTier === undefined && seed.chatServiceTier !== undefined) prov.chatServiceTier = seed.chatServiceTier;
  if (prov.openaiChatEofTolerance === undefined && seed.openaiChatEofTolerance !== undefined) {
    prov.openaiChatEofTolerance = seed.openaiChatEofTolerance;
  }
  // Fill-only: a hand-edited path must survive, and a config saved before the registry
  // learned this route still gets backfilled.
  if (prov.responsesPath === undefined && seed.responsesPath !== undefined) prov.responsesPath = seed.responsesPath;
  if (prov.statelessResponses === undefined && seed.statelessResponses !== undefined) prov.statelessResponses = seed.statelessResponses;
  if (prov.requiresAdjacentResponsesToolResults === undefined && seed.requiresAdjacentResponsesToolResults !== undefined) {
    prov.requiresAdjacentResponsesToolResults = seed.requiresAdjacentResponsesToolResults;
  }
  if (prov.annotateEmptyToolOutputs === undefined && seed.annotateEmptyToolOutputs !== undefined) {
    prov.annotateEmptyToolOutputs = seed.annotateEmptyToolOutputs;
  }
  // Registry-only metadata (never seeded into saved config): backfill straight from
  // the entry so an explicit user value stays distinguishable from the default.
  if (prov.fastWire === undefined && entry.fastWire !== undefined) {
    prov.fastWire = cloneFastWire(entry.fastWire);
  }
  if (prov.supportsServiceTier === undefined && entry.supportsServiceTier !== undefined) prov.supportsServiceTier = entry.supportsServiceTier;
  if (prov.supportsOpenAiWebSearchToolFields === undefined && entry.supportsOpenAiWebSearchToolFields !== undefined) {
    prov.supportsOpenAiWebSearchToolFields = entry.supportsOpenAiWebSearchToolFields;
  }
  if (prov.supportsResponsesCustomTools === undefined && entry.supportsResponsesCustomTools !== undefined) {
    prov.supportsResponsesCustomTools = entry.supportsResponsesCustomTools;
  }
  if (prov.preserveResponsesReasoningContent === undefined && entry.preserveResponsesReasoningContent !== undefined) prov.preserveResponsesReasoningContent = entry.preserveResponsesReasoningContent;
  applyReasoningSummaryDefaults(prov, entry.modelSupportsReasoningSummaries);
  applyServiceTierModelDefaults(prov, serviceTierModelDefaultsFor(entry, prov));
  applyVerbosityDefaults(prov, entry);
  // Registry-only repair policy (#938): fill only when the runtime provider has
  // no explicit policy, and deep-clone so saved/user values never alias the
  // registry constant.
  if (prov.responsesItemIdRepair === undefined && entry.responsesItemIdRepair) {
    prov.responsesItemIdRepair = {
      ...(entry.responsesItemIdRepair.message ? { message: [...entry.responsesItemIdRepair.message] } : {}),
      ...(entry.responsesItemIdRepair.reasoning ? { reasoning: [...entry.responsesItemIdRepair.reasoning] } : {}),
      ...(entry.responsesItemIdRepair.repairMissingTerminalIds !== undefined
        ? { repairMissingTerminalIds: entry.responsesItemIdRepair.repairMissingTerminalIds }
        : {}),
      ...(entry.responsesItemIdRepair.repairInvalidIds !== undefined
        ? { repairInvalidIds: entry.responsesItemIdRepair.repairInvalidIds }
        : {}),
    };
  }
  if (!prov.autoToolChoiceOnlyModels && seed.autoToolChoiceOnlyModels) prov.autoToolChoiceOnlyModels = [...seed.autoToolChoiceOnlyModels];
  if (!prov.preserveReasoningContentModels && seed.preserveReasoningContentModels) prov.preserveReasoningContentModels = [...seed.preserveReasoningContentModels];
  if (!prov.requiresReasoningPlaceholderModels && seed.requiresReasoningPlaceholderModels) prov.requiresReasoningPlaceholderModels = [...seed.requiresReasoningPlaceholderModels];
  if (!prov.reasoningSplitModels && seed.reasoningSplitModels) prov.reasoningSplitModels = [...seed.reasoningSplitModels];
  if (!prov.reasoningDetailsModels && seed.reasoningDetailsModels) prov.reasoningDetailsModels = [...seed.reasoningDetailsModels];
  if (!prov.thinkingToggleModels && seed.thinkingToggleModels) prov.thinkingToggleModels = [...seed.thinkingToggleModels];
  if (!prov.thinkingBudgetModels && seed.thinkingBudgetModels) prov.thinkingBudgetModels = [...seed.thinkingBudgetModels];
  if (prov.escapeBuiltinToolNames === undefined && seed.escapeBuiltinToolNames !== undefined) prov.escapeBuiltinToolNames = seed.escapeBuiltinToolNames;
  if (prov.keyOptional === undefined && seed.keyOptional !== undefined) prov.keyOptional = seed.keyOptional;
  if (prov.freeTier === undefined && seed.freeTier !== undefined) prov.freeTier = seed.freeTier;
  if (prov.modelSuffixBracketStrip === undefined && seed.modelSuffixBracketStrip !== undefined) prov.modelSuffixBracketStrip = seed.modelSuffixBracketStrip;
  if (!prov.headers && seed.headers) prov.headers = { ...seed.headers };
  applyDirectReasoningEffortContracts(entry, prov, explicitDirectReasoning);
}

export function deriveFeaturedProviderIds(): string[] {
  return PROVIDER_REGISTRY.filter(entry => entry.featured).map(entry => entry.id);
}

export function deriveJawcodeAliases(): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const entry of PROVIDER_REGISTRY) {
    if (!entry.jawcodeBundle) continue;
    aliases[entry.id] = entry.jawcodeBundle;
    for (const alias of entry.extraMetadataAliases ?? []) {
      aliases[alias] = entry.jawcodeBundle;
    }
  }
  return aliases;
}

export function shouldCaseFoldMetadataModelId(providerId: string): boolean {
  const entry = PROVIDER_REGISTRY.find(row => row.id === providerId);
  return entry?.metadataModelIdNormalize === "case-insensitive";
}

function entryToPreset(entry: ProviderRegistryEntry): DerivedProviderPreset {
  return {
    id: entry.id,
    label: entry.label,
    adapter: entry.adapter,
    baseUrl: entry.baseUrl,
    ...(entry.responsesPath ? { responsesPath: entry.responsesPath } : {}),
    auth: entry.authKind === "forward" ? "forward" : entry.authKind === "oauth" ? "oauth" : entry.authKind === "local" ? "local" : "key",
    ...(entry.codexAccountMode ? { codexAccountMode: entry.codexAccountMode } : {}),
    ...(entry.codexAccountMode ? { provider: providerConfigSeed(entry) } : {}),
    ...(entry.defaultModel ? { defaultModel: entry.defaultModel } : {}),
    ...(entry.authKind === "oauth" ? { oauthProvider: entry.oauthId ?? entry.id } : {}),
    ...(entry.dashboardUrl ? { dashboardUrl: entry.dashboardUrl } : {}),
    ...(entry.note ? { note: entry.note } : {}),
    ...(entry.keyOptional ? { keyOptional: true } : {}),
    ...(entry.freeTier ? { freeTier: true } : {}),
    ...(entry.baseUrlChoices ? { baseUrlChoices: entry.baseUrlChoices.map(c => ({ ...c })) } : {}),
  };
}

function dedupePresets(presets: DerivedProviderPreset[]): DerivedProviderPreset[] {
  const seen = new Set<string>();
  const out: DerivedProviderPreset[] = [];
  for (const preset of presets) {
    if (seen.has(preset.id)) continue;
    seen.add(preset.id);
    out.push(preset);
  }
  return out;
}

function customPreset(): DerivedProviderPreset {
  return { id: "custom", label: "Custom provider", adapter: "openai-chat", baseUrl: "", auth: "key" };
}

function formatInitLabel(entry: ProviderRegistryEntry): string {
  if (entry.authKind === "forward") return "OpenAI — ChatGPT login (no key; account pool default, Direct selectable)";
  if (entry.authKind === "oauth") {
    if (entry.id === "xai") return "xAI (Grok) — account login";
    if (entry.id === "anthropic") return "Anthropic (Claude) — account login";
    if (entry.id === "kimi") return "Kimi (Moonshot) — account login";
    return `${entry.label} — account login`;
  }
  return entry.label;
}
