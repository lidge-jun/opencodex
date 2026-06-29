import type { OcxProviderConfig } from "../types";
import { PROVIDER_REGISTRY, type ProviderRegistryEntry } from "./registry";

export interface DerivedKeyLoginProvider {
  label: string;
  baseUrl: string;
  adapter: string;
  dashboardUrl: string;
  models?: string[];
  defaultModel?: string;
  contextWindow?: number;
  modelContextWindows?: Record<string, number>;
  modelInputModalities?: Record<string, string[]>;
  reasoningEfforts?: string[];
  modelReasoningEfforts?: Record<string, string[]>;
  reasoningEffortMap?: Record<string, string>;
  modelReasoningEffortMap?: Record<string, Record<string, string>>;
  noVisionModels?: string[];
  noReasoningModels?: string[];
  noTemperatureModels?: string[];
  noTopPModels?: string[];
  noPenaltyModels?: string[];
  autoToolChoiceOnlyModels?: string[];
  preserveReasoningContentModels?: string[];
  escapeBuiltinToolNames?: boolean;
}

export interface DerivedInitProvider {
  id: string;
  label: string;
  adapter: string;
  baseUrl: string;
  kind: "forward" | "oauth" | "key" | "local";
  dashboardUrl?: string;
  defaultModel?: string;
}

export interface DerivedProviderPreset {
  id: string;
  label: string;
  adapter: string;
  baseUrl: string;
  defaultModel?: string;
  auth: "oauth" | "forward" | "key";
  oauthProvider?: string;
  dashboardUrl?: string;
  note?: string;
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
    ...(entry.defaultModel ? { defaultModel: entry.defaultModel } : {}),
    ...(entry.models ? { models: [...entry.models] } : {}),
    ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
    ...(entry.modelContextWindows ? { modelContextWindows: { ...entry.modelContextWindows } } : {}),
    ...(entry.modelInputModalities ? { modelInputModalities: cloneRecordOfArrays(entry.modelInputModalities) } : {}),
    ...(entry.reasoningEfforts ? { reasoningEfforts: [...entry.reasoningEfforts] } : {}),
    ...(entry.modelReasoningEfforts ? { modelReasoningEfforts: cloneRecordOfArrays(entry.modelReasoningEfforts) } : {}),
    ...(entry.reasoningEffortMap ? { reasoningEffortMap: { ...entry.reasoningEffortMap } } : {}),
    ...(entry.modelReasoningEffortMap ? { modelReasoningEffortMap: cloneNestedRecord(entry.modelReasoningEffortMap) } : {}),
    ...(entry.noVisionModels ? { noVisionModels: [...entry.noVisionModels] } : {}),
    ...(entry.noReasoningModels ? { noReasoningModels: [...entry.noReasoningModels] } : {}),
    ...(entry.noTemperatureModels ? { noTemperatureModels: [...entry.noTemperatureModels] } : {}),
    ...(entry.noTopPModels ? { noTopPModels: [...entry.noTopPModels] } : {}),
    ...(entry.noPenaltyModels ? { noPenaltyModels: [...entry.noPenaltyModels] } : {}),
    ...(entry.autoToolChoiceOnlyModels ? { autoToolChoiceOnlyModels: [...entry.autoToolChoiceOnlyModels] } : {}),
    ...(entry.preserveReasoningContentModels ? { preserveReasoningContentModels: [...entry.preserveReasoningContentModels] } : {}),
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
      ...(entry.defaultModel ? { defaultModel: entry.defaultModel } : {}),
      ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
      ...(entry.modelContextWindows ? { modelContextWindows: { ...entry.modelContextWindows } } : {}),
      ...(entry.modelInputModalities ? { modelInputModalities: cloneRecordOfArrays(entry.modelInputModalities) } : {}),
      ...(entry.reasoningEfforts ? { reasoningEfforts: [...entry.reasoningEfforts] } : {}),
      ...(entry.modelReasoningEfforts ? { modelReasoningEfforts: cloneRecordOfArrays(entry.modelReasoningEfforts) } : {}),
      ...(entry.reasoningEffortMap ? { reasoningEffortMap: { ...entry.reasoningEffortMap } } : {}),
      ...(entry.modelReasoningEffortMap ? { modelReasoningEffortMap: cloneNestedRecord(entry.modelReasoningEffortMap) } : {}),
      ...(entry.noVisionModels ? { noVisionModels: [...entry.noVisionModels] } : {}),
      ...(entry.noReasoningModels ? { noReasoningModels: [...entry.noReasoningModels] } : {}),
      ...(entry.noTemperatureModels ? { noTemperatureModels: [...entry.noTemperatureModels] } : {}),
      ...(entry.noTopPModels ? { noTopPModels: [...entry.noTopPModels] } : {}),
      ...(entry.noPenaltyModels ? { noPenaltyModels: [...entry.noPenaltyModels] } : {}),
      ...(entry.autoToolChoiceOnlyModels ? { autoToolChoiceOnlyModels: [...entry.autoToolChoiceOnlyModels] } : {}),
      ...(entry.preserveReasoningContentModels ? { preserveReasoningContentModels: [...entry.preserveReasoningContentModels] } : {}),
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
    .filter(entry => entry.featured || entry.authKind === "key")
    .map(entryToPreset);
  return [...dedupePresets(presets), customPreset()];
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
    auth: entry.authKind === "forward" ? "forward" : entry.authKind === "oauth" ? "oauth" : "key",
    ...(entry.defaultModel ? { defaultModel: entry.defaultModel } : {}),
    ...(entry.authKind === "oauth" ? { oauthProvider: entry.oauthId ?? entry.id } : {}),
    ...(entry.dashboardUrl ? { dashboardUrl: entry.dashboardUrl } : {}),
    ...(entry.note ? { note: entry.note } : {}),
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
  if (entry.authKind === "forward") return "OpenAI — ChatGPT login (no key)";
  if (entry.authKind === "oauth") {
    if (entry.id === "xai") return "xAI (Grok) — account login";
    if (entry.id === "anthropic") return "Anthropic (Claude) — account login";
    if (entry.id === "kimi") return "Kimi (Moonshot) — account login";
    return `${entry.label} — account login`;
  }
  return entry.label;
}
