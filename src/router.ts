import type { OcxConfig, OcxProviderConfig } from "./types";
import { resolveEnvValue } from "./config";
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

function routedProviderConfig(providerName: string, provider: OcxProviderConfig): OcxProviderConfig {
  const registryEntry = PROVIDER_REGISTRY.find(entry => entry.id === providerName);
  if (!registryEntry) return { ...provider, apiKey: resolveEnvValue(provider.apiKey) };
  const reasoningEffortMap = mergeRecord(registryEntry.reasoningEffortMap, provider.reasoningEffortMap);
  const modelReasoningEffortMap = mergeNestedRecord(registryEntry.modelReasoningEffortMap, provider.modelReasoningEffortMap);

  return {
    ...provider,
    apiKey: resolveEnvValue(provider.apiKey),
    ...(reasoningEffortMap ? { reasoningEffortMap } : {}),
    ...(modelReasoningEffortMap ? { modelReasoningEffortMap } : {}),
  };
}

export function routeModel(config: OcxConfig, modelId: string): RouteResult {
  // 0. Explicit "<provider>/<model>" namespace (e.g. "opencode-go/deepseek-v4-pro").
  //    Only triggers when the prefix matches a CONFIGURED provider, so genuine
  //    slash-containing model ids (e.g. "anthropic/claude-...") fall through when
  //    no such provider exists.
  const slash = modelId.indexOf("/");
  if (slash > 0) {
    const provName = modelId.slice(0, slash);
    const prov = config.providers[provName];
    if (prov) {
      return {
        providerName: provName,
        provider: routedProviderConfig(provName, prov),
        modelId: modelId.slice(slash + 1),
      };
    }
  }

  for (const [provName, prov] of Object.entries(config.providers)) {
    if (prov.defaultModel === modelId) {
      return {
        providerName: provName,
        provider: routedProviderConfig(provName, prov),
        modelId,
      };
    }
  }

  for (const [provName, prov] of Object.entries(config.providers)) {
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
      const matchingProvider = Object.entries(config.providers).find(
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

  const defaultProv = config.providers[config.defaultProvider];
  if (defaultProv) {
    return {
      providerName: config.defaultProvider,
      provider: routedProviderConfig(config.defaultProvider, defaultProv),
      modelId,
    };
  }

  throw new Error(`No provider configured for model: ${modelId}`);
}
