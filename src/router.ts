import type { OcxConfig, OcxProviderConfig } from "./types";
import { resolveEnvValue } from "./config";

interface RouteResult {
  providerName: string;
  provider: OcxProviderConfig;
  modelId: string;
}

const MODEL_PROVIDER_PATTERNS: Record<string, string[]> = {
  anthropic: [
    "claude-", "claude-sonnet-", "claude-opus-", "claude-haiku-",
  ],
  openai: [
    "gpt-", "o1-", "o3-", "o4-",
  ],
  groq: [
    "llama-", "mixtral-", "gemma-",
  ],
};

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
        provider: { ...prov, apiKey: resolveEnvValue(prov.apiKey) },
        modelId: modelId.slice(slash + 1),
      };
    }
  }

  for (const [provName, prov] of Object.entries(config.providers)) {
    if (prov.defaultModel === modelId) {
      return {
        providerName: provName,
        provider: { ...prov, apiKey: resolveEnvValue(prov.apiKey) },
        modelId,
      };
    }
  }

  for (const [provName, prov] of Object.entries(config.providers)) {
    if (prov.models && Array.isArray(prov.models) && (prov.models as string[]).includes(modelId)) {
      return {
        providerName: provName,
        provider: { ...prov, apiKey: resolveEnvValue(prov.apiKey) },
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
          provider: { ...prov, apiKey: resolveEnvValue(prov.apiKey) },
          modelId,
        };
      }
    }
  }

  const defaultProv = config.providers[config.defaultProvider];
  if (defaultProv) {
    return {
      providerName: config.defaultProvider,
      provider: { ...defaultProv, apiKey: resolveEnvValue(defaultProv.apiKey) },
      modelId,
    };
  }

  throw new Error(`No provider configured for model: ${modelId}`);
}
