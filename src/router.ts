import type { OcxConfig, OcxProviderConfig } from "./types";
import { hasOwnProvider, resolveEnvValue } from "./config";
import { assertProviderDestinationAllowed } from "./lib/destination-policy";
import { PROVIDER_REGISTRY } from "./providers/registry";
import { tryPickComboModel, type ComboPick } from "./combos";

export interface RouteResult {
  providerName: string;
  provider: OcxProviderConfig;
  modelId: string;
  /** Present when the request was routed through a combo virtual model. */
  combo?: ComboPick;
}

const MODEL_PROVIDER_PATTERNS: Array<{ providerNames: string[]; prefixes: string[] }> = [
  {
    providerNames: ["anthropic"],
    prefixes: [
    "claude-", "claude-sonnet-", "claude-opus-", "claude-haiku-",
    ],
  },
  {
    providerNames: ["openai", "chatgpt", "openai-apikey"],
    prefixes: [
    "gpt-", "o1-", "o3-", "o4-",
    ],
  },
  {
    providerNames: ["groq"],
    prefixes: [
    "llama-", "mixtral-", "gemma-",
    ],
  },
];

// Merge registry-default effort maps under user values so built-in provider configs can
// carry real upstream aliases without a disk migration. User overrides win per-key.
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
  if (!registryEntry) {
    assertProviderDestinationAllowed(providerName, provider);
    return { ...provider, apiKey: resolveEnvValue(provider.apiKey) };
  }
  const explicitKeyOverride = registryEntry.authKind === "oauth"
    && registryEntry.allowKeyAuthOverride === true
    && provider.authMode === "key";
  const canonicalAuthMode = explicitKeyOverride
    ? "key"
    : registryEntry.authKind === "forward" || registryEntry.authKind === "oauth"
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
  const thinkingToggleModels = mergeStringArray(registryEntry.thinkingToggleModels, provider.thinkingToggleModels);
  const thinkingBudgetModels = mergeStringArray(registryEntry.thinkingBudgetModels, provider.thinkingBudgetModels);
  const registryBaseUrlIsTemplate = /\{[^}]*\}/.test(registryEntry.baseUrl);
  const userBaseUrl = typeof provider.baseUrl === "string" ? provider.baseUrl.trim() : "";
  const userBaseUrlIsResolved = userBaseUrl.length > 0 && !/\{[^}]*\}/.test(userBaseUrl);
  if (registryEntry.allowBaseUrlOverride && !userBaseUrlIsResolved) {
    throw new Error(`Invalid baseUrl for provider "${providerName}": expected a nonblank URL without unresolved placeholders`);
  }
  // Registry template URLs are presets; local/self-hosted entries opt in explicitly.
  const baseUrl = (registryBaseUrlIsTemplate || registryEntry.allowBaseUrlOverride) && userBaseUrlIsResolved
    ? userBaseUrl
    : registryEntry.baseUrl;
  assertProviderDestinationAllowed(providerName, { baseUrl, allowPrivateNetwork: provider.allowPrivateNetwork });

  return {
    ...provider,
    adapter: registryEntry.adapter,
    baseUrl,
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
    ...(provider.keyOptional === undefined && registryEntry.keyOptional !== undefined ? { keyOptional: registryEntry.keyOptional } : {}),
    ...(provider.modelSuffixBracketStrip === undefined && registryEntry.modelSuffixBracketStrip !== undefined ? { modelSuffixBracketStrip: registryEntry.modelSuffixBracketStrip } : {}),
    // Scalar backfill: a persisted config created before the flag shipped inherits the registry
    // opt-in, while an explicit user `false` keeps overriding registry `true`.
    ...(provider.parallelToolCalls === undefined && registryEntry.parallelToolCalls !== undefined ? { parallelToolCalls: registryEntry.parallelToolCalls } : {}),
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
    ...(thinkingToggleModels ? { thinkingToggleModels } : {}),
    ...(thinkingBudgetModels ? { thinkingBudgetModels } : {}),
  };
}

function activeProviderEntries(config: OcxConfig): [string, OcxProviderConfig][] {
  return Object.entries(config.providers).filter(([, provider]) => provider.disabled !== true);
}

export function routeModel(config: OcxConfig, modelId: string): RouteResult {
  // -1. Combo virtual models: `combo/<id>` → pick a concrete provider/model target.
  const comboPick = tryPickComboModel(config, modelId);
  if (comboPick) {
    const concrete = `${comboPick.target.provider}/${comboPick.target.model}`;
    const routed = routeModel(config, concrete);
    return { ...routed, combo: comboPick };
  }

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

  const patternRoute = routeByKnownModelPattern(config, modelId);
  if (patternRoute) return patternRoute;

  for (const [provName, prov] of activeProviderEntries(config)) {
    if (prov.models && Array.isArray(prov.models) && (prov.models as string[]).includes(modelId)) {
      return {
        providerName: provName,
        provider: routedProviderConfig(provName, prov),
        modelId,
      };
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

function routeByKnownModelPattern(config: OcxConfig, modelId: string): RouteResult | undefined {
  for (const { providerNames, prefixes } of MODEL_PROVIDER_PATTERNS) {
    if (prefixes.some(prefix => modelId.startsWith(prefix))) {
      const matchingProvider = Object.entries(config.providers).find(
        ([name]) => providerNames.some(providerName => name === providerName || name.startsWith(`${providerName}-`))
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
  return undefined;
}
