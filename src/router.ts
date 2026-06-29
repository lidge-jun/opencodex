import type { OcxConfig, OcxProviderConfig } from "./types";
import { hasOwnProvider, resolveEnvValue } from "./config";
import { PROVIDER_REGISTRY } from "./providers/registry";

interface RouteResult {
  providerName: string;
  provider: OcxProviderConfig;
  modelId: string;
}

const MODEL_PROVIDER_PATTERNS: Record<string, string[]> = {
  anthropic: [
    "claude-", "claude-sonnet-", "claude-opus-", "claude-haiku-",
  ],
  chatgpt: [
    "gpt-", "o1-", "o3-", "o4-",
  ],
  groq: [
    "llama-", "mixtral-", "gemma-",
  ],
};

// Merge registry-default effort maps under user values so persisted built-in provider configs
// that predate reasoningEffortMap/modelReasoningEffortMap still get correct wire translations
// (e.g. ollama-cloud xhigh -> max) without a disk migration. User overrides win per-key.
function mergeRecord(
  seed: Record<string, string> | undefined,
  user: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!seed && !user) return undefined;
  return { ...(seed ?? {}), ...(user ?? {}) };
}

function mergeNestedRecord(
  seed: Record<string, Record<string, string>> | undefined,
  user: Record<string, Record<string, string>> | undefined,
): Record<string, Record<string, string>> | undefined {
  if (!seed && !user) return undefined;
  const out: Record<string, Record<string, string>> = {};
  for (const [key, value] of Object.entries(seed ?? {})) out[key] = { ...value };
  for (const [key, value] of Object.entries(user ?? {})) out[key] = { ...(out[key] ?? {}), ...value };
  return out;
}

function mergeStringArray(
  seed: string[] | undefined,
  user: string[] | undefined,
): string[] | undefined {
  if (!seed && !user) return undefined;
  return [...new Set([...(seed ?? []), ...(user ?? [])])];
}

function mergeRecordFill<T>(
  seed: Record<string, T> | undefined,
  user: Record<string, T> | undefined,
): Record<string, T> | undefined {
  if (!seed && !user) return undefined;
  return { ...(seed ?? {}), ...(user ?? {}) };
}

function mergeStringArrayRecord(
  seed: Record<string, string[]> | undefined,
  user: Record<string, string[]> | undefined,
): Record<string, string[]> | undefined {
  if (!seed && !user) return undefined;
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(seed ?? {})) out[key] = [...value];
  for (const [key, value] of Object.entries(user ?? {})) out[key] = [...value];
  return out;
}

function routedProviderConfig(providerName: string, provider: OcxProviderConfig): OcxProviderConfig {
  const registryEntry = PROVIDER_REGISTRY.find(entry => entry.id === providerName);
  if (!registryEntry) return { ...provider, apiKey: resolveEnvValue(provider.apiKey) };
  const canonicalAuthMode = registryEntry.authKind === "forward" || registryEntry.authKind === "oauth"
    ? registryEntry.authKind
    : provider.authMode === "forward" ? undefined : provider.authMode;
  const reasoningEffortMap = mergeRecord(registryEntry.reasoningEffortMap, provider.reasoningEffortMap);
  const modelReasoningEffortMap = mergeNestedRecord(registryEntry.modelReasoningEffortMap, provider.modelReasoningEffortMap);
  const modelReasoningEfforts = mergeStringArrayRecord(registryEntry.modelReasoningEfforts, provider.modelReasoningEfforts);
  const modelContextWindows = mergeRecordFill(registryEntry.modelContextWindows, provider.modelContextWindows);
  const modelInputModalities = mergeRecordFill(registryEntry.modelInputModalities, provider.modelInputModalities);
  const noVisionModels = mergeStringArray(registryEntry.noVisionModels, provider.noVisionModels);
  const noReasoningModels = mergeStringArray(registryEntry.noReasoningModels, provider.noReasoningModels);
  const noTemperatureModels = mergeStringArray(registryEntry.noTemperatureModels, provider.noTemperatureModels);
  const noTopPModels = mergeStringArray(registryEntry.noTopPModels, provider.noTopPModels);
  const noPenaltyModels = mergeStringArray(registryEntry.noPenaltyModels, provider.noPenaltyModels);
  const autoToolChoiceOnlyModels = mergeStringArray(registryEntry.autoToolChoiceOnlyModels, provider.autoToolChoiceOnlyModels);
  const preserveReasoningContentModels = mergeStringArray(registryEntry.preserveReasoningContentModels, provider.preserveReasoningContentModels);

  return {
    ...provider,
    adapter: registryEntry.adapter,
    baseUrl: registryEntry.baseUrl,
    authMode: canonicalAuthMode,
    apiKey: resolveEnvValue(provider.apiKey),
    // Backfill the Google wire mode + Vertex project/location from the registry when the user
    // config omits them, so a minimal `google-vertex`/`google-antigravity` entry still routes
    // through the correct branch (CCA/Vertex) instead of falling back to AI Studio.
    ...(provider.googleMode === undefined && registryEntry.googleMode !== undefined ? { googleMode: registryEntry.googleMode } : {}),
    ...(provider.project === undefined && registryEntry.project !== undefined ? { project: registryEntry.project } : {}),
    ...(provider.location === undefined && registryEntry.location !== undefined ? { location: registryEntry.location } : {}),
    ...(provider.contextWindow === undefined && registryEntry.contextWindow !== undefined ? { contextWindow: registryEntry.contextWindow } : {}),
    ...(provider.reasoningEfforts === undefined && registryEntry.reasoningEfforts !== undefined ? { reasoningEfforts: registryEntry.reasoningEfforts } : {}),
    ...(provider.escapeBuiltinToolNames === undefined && registryEntry.escapeBuiltinToolNames !== undefined ? { escapeBuiltinToolNames: registryEntry.escapeBuiltinToolNames } : {}),
    ...(modelContextWindows ? { modelContextWindows } : {}),
    ...(modelInputModalities ? { modelInputModalities } : {}),
    ...(modelReasoningEfforts ? { modelReasoningEfforts } : {}),
    ...(reasoningEffortMap ? { reasoningEffortMap } : {}),
    ...(modelReasoningEffortMap ? { modelReasoningEffortMap } : {}),
    ...(noVisionModels ? { noVisionModels } : {}),
    ...(noReasoningModels ? { noReasoningModels } : {}),
    ...(noTemperatureModels ? { noTemperatureModels } : {}),
    ...(noTopPModels ? { noTopPModels } : {}),
    ...(noPenaltyModels ? { noPenaltyModels } : {}),
    ...(autoToolChoiceOnlyModels ? { autoToolChoiceOnlyModels } : {}),
    ...(preserveReasoningContentModels ? { preserveReasoningContentModels } : {}),
  };
}

function activeProviderEntries(config: OcxConfig): [string, OcxProviderConfig][] {
  return Object.entries(config.providers).filter(([, provider]) => provider.disabled !== true);
}

export function routeModel(config: OcxConfig, modelId: string): RouteResult {
  // 0. Explicit "<provider>/<model>" namespace (e.g. "opencode-go/deepseek-v4-pro").
  //    Only triggers when the prefix matches a CONFIGURED provider, so genuine
  //    slash-containing model ids (e.g. "anthropic/claude-...") fall through when
  //    no such provider exists.
  const slash = modelId.indexOf("/");
  if (slash > 0) {
    const provName = modelId.slice(0, slash);
    if (hasOwnProvider(config.providers, provName)) {
      const prov = config.providers[provName];
      if (prov.disabled === true) throw new Error(`Provider is disabled: ${provName}`);
      return {
        providerName: provName,
        provider: routedProviderConfig(provName, prov),
        modelId: modelId.slice(slash + 1),
      };
    }
  }

  for (const [provName, prov] of activeProviderEntries(config)) {
    if (prov.defaultModel === modelId) {
      return {
        providerName: provName,
        provider: routedProviderConfig(provName, prov),
        modelId,
      };
    }
  }

  for (const [provName, prov] of activeProviderEntries(config)) {
    if (prov.models && Array.isArray(prov.models) && (prov.models as string[]).includes(modelId)) {
      return {
        providerName: provName,
        provider: routedProviderConfig(provName, prov),
        modelId,
      };
    }
  }

  for (const [patternKey, prefixes] of Object.entries(MODEL_PROVIDER_PATTERNS)) {
    if (prefixes.some(prefix => modelId.startsWith(prefix))) {
      const matchingProvider = activeProviderEntries(config).find(
        ([name]) => name === patternKey || name.startsWith(patternKey)
      );
      if (matchingProvider) {
        const [provName, prov] = matchingProvider;
        return {
          providerName: provName,
          provider: routedProviderConfig(provName, prov),
          modelId,
        };
      }
    }
  }

  if (hasOwnProvider(config.providers, config.defaultProvider)) {
    const defaultProv = config.providers[config.defaultProvider];
    if (defaultProv.disabled === true) throw new Error(`Default provider is disabled: ${config.defaultProvider}`);
    return {
      providerName: config.defaultProvider,
      provider: routedProviderConfig(config.defaultProvider, defaultProv),
      modelId,
    };
  }

  throw new Error(`No provider configured for model: ${modelId}`);
}
