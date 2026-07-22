import type { CodexAccountMode, OcxProviderConfig } from "../types";
import { PROVIDER_REGISTRY, type ProviderRegistryEntry } from "./registry";

export interface DerivedKeyLoginProvider {
  label: string;
  baseUrl: string;
  adapter: string;
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
  noVisionModels?: string[];
  noReasoningModels?: string[];
  noTemperatureModels?: string[];
  noTopPModels?: string[];
  noPenaltyModels?: string[];
  autoToolChoiceOnlyModels?: string[];
  preserveReasoningContentModels?: string[];
  thinkingToggleModels?: string[];
  thinkingBudgetModels?: string[];
  escapeBuiltinToolNames?: boolean;
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

function cloneNestedRecord(input: Record<string, Record<string, string>>): Record<string, Record<string, string>> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, { ...value }]));
}

export function providerConfigSeed(entry: ProviderRegistryEntry): OcxProviderConfig {
  return {
    adapter: entry.adapter,
    baseUrl: entry.baseUrl,
    authMode: entry.authKind === "local" ? undefined : entry.authKind,
    ...(entry.codexAccountMode ? { codexAccountMode: entry.codexAccountMode } : {}),
    ...(entry.keyOptional !== undefined ? { keyOptional: entry.keyOptional } : {}),
    ...(entry.freeTier !== undefined ? { freeTier: entry.freeTier } : {}),
    ...(entry.modelSuffixBracketStrip !== undefined ? { modelSuffixBracketStrip: entry.modelSuffixBracketStrip } : {}),
    ...(entry.staticHeaders ? { headers: { ...entry.staticHeaders } } : {}),
    ...(entry.defaultModel ? { defaultModel: entry.defaultModel } : {}),
    ...(entry.models ? { models: [...entry.models] } : {}),
    ...(entry.liveModels !== undefined ? { liveModels: entry.liveModels } : {}),
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
    ...(entry.noVisionModels ? { noVisionModels: [...entry.noVisionModels] } : {}),
    ...(entry.noReasoningModels ? { noReasoningModels: [...entry.noReasoningModels] } : {}),
    ...(entry.noTemperatureModels ? { noTemperatureModels: [...entry.noTemperatureModels] } : {}),
    ...(entry.noTopPModels ? { noTopPModels: [...entry.noTopPModels] } : {}),
    ...(entry.noPenaltyModels ? { noPenaltyModels: [...entry.noPenaltyModels] } : {}),
    ...(entry.parallelToolCalls !== undefined ? { parallelToolCalls: entry.parallelToolCalls } : {}),
    ...(entry.autoToolChoiceOnlyModels ? { autoToolChoiceOnlyModels: [...entry.autoToolChoiceOnlyModels] } : {}),
    ...(entry.preserveReasoningContentModels ? { preserveReasoningContentModels: [...entry.preserveReasoningContentModels] } : {}),
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
    out[entry.id] = {
      label: entry.label,
      baseUrl: entry.baseUrl,
      adapter: entry.adapter,
      dashboardUrl: entry.dashboardUrl,
      ...(entry.models ? { models: [...entry.models] } : {}),
      ...(entry.liveModels !== undefined ? { liveModels: entry.liveModels } : {}),
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
      ...(entry.noVisionModels ? { noVisionModels: [...entry.noVisionModels] } : {}),
      ...(entry.noReasoningModels ? { noReasoningModels: [...entry.noReasoningModels] } : {}),
      ...(entry.noTemperatureModels ? { noTemperatureModels: [...entry.noTemperatureModels] } : {}),
      ...(entry.noTopPModels ? { noTopPModels: [...entry.noTopPModels] } : {}),
      ...(entry.noPenaltyModels ? { noPenaltyModels: [...entry.noPenaltyModels] } : {}),
      ...(entry.autoToolChoiceOnlyModels ? { autoToolChoiceOnlyModels: [...entry.autoToolChoiceOnlyModels] } : {}),
      ...(entry.preserveReasoningContentModels ? { preserveReasoningContentModels: [...entry.preserveReasoningContentModels] } : {}),
      ...(entry.thinkingToggleModels ? { thinkingToggleModels: [...entry.thinkingToggleModels] } : {}),
      ...(entry.thinkingBudgetModels ? { thinkingBudgetModels: [...entry.thinkingBudgetModels] } : {}),
      ...(entry.escapeBuiltinToolNames !== undefined ? { escapeBuiltinToolNames: entry.escapeBuiltinToolNames } : {}),
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

export function enrichProviderFromRegistry(name: string, prov: OcxProviderConfig): void {
  const entry = PROVIDER_REGISTRY.find(row => row.id === name);
  if (!entry) return;
  const seed = providerConfigSeed(entry);
  if (!prov.defaultModel && seed.defaultModel) prov.defaultModel = seed.defaultModel;
  // Fill mode only when absent: an explicit persisted `direct` must never be overwritten.
  if (prov.codexAccountMode === undefined && seed.codexAccountMode !== undefined) prov.codexAccountMode = seed.codexAccountMode;
  if (!prov.models && seed.models) prov.models = [...seed.models];
  if (prov.liveModels === undefined && seed.liveModels !== undefined) prov.liveModels = seed.liveModels;
  if (prov.contextWindow === undefined && seed.contextWindow !== undefined) prov.contextWindow = seed.contextWindow;
  if (!prov.modelContextWindows && seed.modelContextWindows) prov.modelContextWindows = { ...seed.modelContextWindows };
  if (!prov.modelInputModalities && seed.modelInputModalities) prov.modelInputModalities = cloneRecordOfArrays(seed.modelInputModalities);
  if (prov.defaultMaxOutputTokens === undefined && seed.defaultMaxOutputTokens !== undefined) prov.defaultMaxOutputTokens = seed.defaultMaxOutputTokens;
  if (!prov.modelMaxOutputTokens && seed.modelMaxOutputTokens) prov.modelMaxOutputTokens = { ...seed.modelMaxOutputTokens };
  if (!prov.reasoningEfforts && seed.reasoningEfforts) prov.reasoningEfforts = [...seed.reasoningEfforts];
  if (!prov.modelReasoningEfforts && seed.modelReasoningEfforts) prov.modelReasoningEfforts = cloneRecordOfArrays(seed.modelReasoningEfforts);
  if (!prov.modelDefaultReasoningEfforts && seed.modelDefaultReasoningEfforts) prov.modelDefaultReasoningEfforts = { ...seed.modelDefaultReasoningEfforts };
  if (!prov.reasoningEffortMap && seed.reasoningEffortMap) prov.reasoningEffortMap = { ...seed.reasoningEffortMap };
  if (!prov.modelReasoningEffortMap && seed.modelReasoningEffortMap) prov.modelReasoningEffortMap = cloneNestedRecord(seed.modelReasoningEffortMap);
  if (!prov.noVisionModels && seed.noVisionModels) prov.noVisionModels = [...seed.noVisionModels];
  if (!prov.noReasoningModels && seed.noReasoningModels) prov.noReasoningModels = [...seed.noReasoningModels];
  if (!prov.noTemperatureModels && seed.noTemperatureModels) prov.noTemperatureModels = [...seed.noTemperatureModels];
  if (!prov.noTopPModels && seed.noTopPModels) prov.noTopPModels = [...seed.noTopPModels];
  if (!prov.noPenaltyModels && seed.noPenaltyModels) prov.noPenaltyModels = [...seed.noPenaltyModels];
  if (prov.parallelToolCalls === undefined && seed.parallelToolCalls !== undefined) prov.parallelToolCalls = seed.parallelToolCalls;
  if (!prov.autoToolChoiceOnlyModels && seed.autoToolChoiceOnlyModels) prov.autoToolChoiceOnlyModels = [...seed.autoToolChoiceOnlyModels];
  if (!prov.preserveReasoningContentModels && seed.preserveReasoningContentModels) prov.preserveReasoningContentModels = [...seed.preserveReasoningContentModels];
  if (!prov.thinkingToggleModels && seed.thinkingToggleModels) prov.thinkingToggleModels = [...seed.thinkingToggleModels];
  if (!prov.thinkingBudgetModels && seed.thinkingBudgetModels) prov.thinkingBudgetModels = [...seed.thinkingBudgetModels];
  if (prov.escapeBuiltinToolNames === undefined && seed.escapeBuiltinToolNames !== undefined) prov.escapeBuiltinToolNames = seed.escapeBuiltinToolNames;
  if (prov.keyOptional === undefined && seed.keyOptional !== undefined) prov.keyOptional = seed.keyOptional;
  if (prov.freeTier === undefined && seed.freeTier !== undefined) prov.freeTier = seed.freeTier;
  if (prov.modelSuffixBracketStrip === undefined && seed.modelSuffixBracketStrip !== undefined) prov.modelSuffixBracketStrip = seed.modelSuffixBracketStrip;
  if (!prov.headers && seed.headers) prov.headers = { ...seed.headers };
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
