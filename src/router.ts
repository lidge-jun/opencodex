import type { CodexAccountMode, OcxConfig, OcxProviderConfig } from "./types";
import { COMBO_NAMESPACE, tryPickComboModel, type ComboPick } from "./combos";
import { hasOwnProvider, resolveEnvValue } from "./config";
import { assertProviderDestinationAllowed } from "./lib/destination-policy";
import { PROVIDER_REGISTRY, providerCodexAccountMode } from "./providers/registry";
import { LEGACY_CHATGPT_PROVIDER_ID, LEGACY_OPENAI_MULTI_PROVIDER_ID, OPENAI_API_PROVIDER_ID, OPENAI_CODEX_PROVIDER_ID } from "./providers/openai-tiers";
import { decodeRoutedModelId, encodeRoutedModelId } from "./providers/slug-codec";
import { getStaleCached } from "./codex/model-cache";

export interface RouteResult {
  providerName: string;
  provider: OcxProviderConfig;
  modelId: string;
  codexAccountMode?: CodexAccountMode;
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
    providerNames: ["groq"],
    prefixes: [
    "llama-", "mixtral-", "gemma-",
    ],
  },
];

/**
 * Known native model ids for a provider — the decode source for the Codex slug codec
 * (src/providers/slug-codec.ts). Union of static config ids, registry seeds, and the
 * last-known-good live /models cache (may be empty on a cold start; decode then passes
 * unknown ids through unchanged for an honest upstream error).
 */
export function knownModelIdsForProvider(provName: string, prov: OcxProviderConfig): string[] {
  const ids = new Set<string>();
  for (const id of prov.models ?? []) ids.add(id);
  const registry = PROVIDER_REGISTRY.find(entry => entry.id === provName);
  for (const id of registry?.models ?? []) ids.add(id);
  // Registry model-keyed hint maps double as known native ids (e.g. NVIDIA carries no
  // static models list but names `moonshotai/kimi-k2.6` in its effort/window maps).
  for (const map of [
    registry?.modelContextWindows,
    registry?.modelInputModalities,
    registry?.modelReasoningEfforts,
    registry?.modelDefaultReasoningEfforts,
    registry?.modelReasoningEffortMap,
  ]) {
    for (const id of Object.keys(map ?? {})) ids.add(id);
  }
  for (const cached of getStaleCached(provName) ?? []) ids.add(cached.id);
  return [...ids];
}

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

function mergePositiveNumberCaps(
  seed: Record<string, number> | undefined,
  user: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (!seed && !user) return undefined;
  const out = { ...(seed ?? {}) };
  for (const [key, value] of Object.entries(user ?? {})) {
    out[key] = typeof out[key] === "number" ? Math.min(out[key]!, value) : value;
  }
  return out;
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
  const modelDefaultReasoningEfforts = mergeRecordFill(registryEntry.modelDefaultReasoningEfforts, provider.modelDefaultReasoningEfforts);
  const modelContextWindows = providerName === OPENAI_API_PROVIDER_ID
    ? mergePositiveNumberCaps(registryEntry.modelContextWindows, provider.modelContextWindows)
    : mergeRecordFill(registryEntry.modelContextWindows, provider.modelContextWindows);
  const modelInputModalities = mergeRecordFill(registryEntry.modelInputModalities, provider.modelInputModalities);
  const modelMaxInputTokens = providerName === OPENAI_API_PROVIDER_ID
    ? mergePositiveNumberCaps(registryEntry.modelMaxInputTokens, provider.modelMaxInputTokens)
    : mergeRecordFill(registryEntry.modelMaxInputTokens, provider.modelMaxInputTokens);
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
    adapter: provider.adapter || registryEntry.adapter,
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
    ...(modelMaxInputTokens ? { modelMaxInputTokens } : {}),
    ...(modelReasoningEfforts ? { modelReasoningEfforts } : {}),
    ...(modelDefaultReasoningEfforts ? { modelDefaultReasoningEfforts } : {}),
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
  return Object.entries(config.providers)
    .filter(([name, provider]) => name !== LEGACY_CHATGPT_PROVIDER_ID && provider.disabled !== true);
}

export class NoEnabledOpenAiProviderError extends Error {
  constructor(modelId: string) {
    super(`No enabled canonical OpenAI provider for model: ${modelId}`);
    this.name = "NoEnabledOpenAiProviderError";
  }
}

function isBareOpenAiFamilyModel(modelId: string): boolean {
  return !modelId.includes("/") && /^(?:gpt-|o1-|o3-|o4-)/.test(modelId);
}

function routeResult(providerName: string, provider: OcxProviderConfig, modelId: string): RouteResult {
  const codexAccountMode = providerCodexAccountMode(providerName, provider);
  return {
    providerName,
    provider: routedProviderConfig(providerName, provider),
    modelId,
    ...(codexAccountMode ? { codexAccountMode } : {}),
  };
}

export function routeModel(config: OcxConfig, modelId: string): RouteResult {
  const preservePhysicalComboProvider =
    hasOwnProvider(config.providers, COMBO_NAMESPACE)
    && Object.keys(config.combos ?? {}).length === 0;
  if (!preservePhysicalComboProvider) {
    const combo = tryPickComboModel(config, modelId);
    if (combo) {
      const concrete = `${combo.target.provider}/${combo.target.model}`;
      const routed = routeModel(config, concrete);
      return { ...routed, combo };
    }
  }

  // 0. Explicit "<provider>/<model>" namespace (e.g. "opencode-go/deepseek-v4-pro").
  //    Only triggers when the prefix matches a CONFIGURED provider, so genuine
  //    slash-containing model ids (e.g. "anthropic/claude-...") fall through when
  //    no such provider exists.
  const slash = modelId.indexOf("/");
  if (slash > 0) {
    const provName = modelId.slice(0, slash);
    if (provName === LEGACY_CHATGPT_PROVIDER_ID || provName === LEGACY_OPENAI_MULTI_PROVIDER_ID) {
      throw new Error(`No provider configured for model: ${modelId}`);
    }
    if (hasOwnProvider(config.providers, provName)) {
      const prov = config.providers[provName];
      if (prov.disabled === true) throw new Error(`Provider is disabled: ${provName}`);
      const known = knownModelIdsForProvider(provName, prov);
      // Self-namespaced native id — the vendor segment equals the provider id, so the FULL ref is
      // itself a known model (e.g. orcarouter/auto). Route it whole instead of stripping to the
      // remainder, which would send a bare `auto` the upstream cannot resolve.
      if (known.includes(modelId)) return routeResult(provName, prov, modelId);
      // Codex-facing alias ids (`provider/vendor-model`) decode back to the native
      // slash id via an exact known-id lookup; raw full-slash selectors keep working.
      return routeResult(provName, prov, decodeRoutedModelId(modelId.slice(slash + 1), known));
    }
  }

  if (isBareOpenAiFamilyModel(modelId)) {
    const provider = config.providers[OPENAI_CODEX_PROVIDER_ID];
    if (provider && provider.disabled !== true) return routeResult(OPENAI_CODEX_PROVIDER_ID, provider, modelId);
    throw new NoEnabledOpenAiProviderError(modelId);
  }

  for (const [provName, prov] of activeProviderEntries(config)) {
    if (prov.defaultModel === modelId
      || (typeof prov.defaultModel === "string" && encodeRoutedModelId(prov.defaultModel) === modelId)) {
      return routeResult(provName, prov, prov.defaultModel as string);
    }
  }

  const patternRoute = routeByKnownModelPattern(config, modelId);
  if (patternRoute) return patternRoute;

  for (const [provName, prov] of activeProviderEntries(config)) {
    if (prov.models && Array.isArray(prov.models)) {
      const hit = (prov.models as string[]).find(id => id === modelId || encodeRoutedModelId(id) === modelId);
      if (hit !== undefined) return routeResult(provName, prov, hit);
    }
  }

  if (config.defaultProvider === LEGACY_CHATGPT_PROVIDER_ID) {
    throw new Error(`No provider configured for model: ${modelId}`);
  }
  if (hasOwnProvider(config.providers, config.defaultProvider)) {
    const defaultProv = config.providers[config.defaultProvider];
    if (defaultProv.disabled === true) throw new Error(`Default provider is disabled: ${config.defaultProvider}`);
    return routeResult(config.defaultProvider, defaultProv, modelId);
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
        return routeResult(provName, prov, modelId);
      }
    }
  }
  return undefined;
}
