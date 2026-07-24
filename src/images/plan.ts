import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../types";
import type { ImageBridgePlan } from "./types";
import { getValidAccessToken } from "../oauth/index";
import { resolveEnvValue } from "../config";
import { getProviderRegistryEntry } from "../providers/registry";
import { IMAGE_GEN_TOOL_NAME } from "./synthetic-tool";

const DEFAULT_MODEL = "grok-imagine-image-quality";

export function findXaiProvider(config: OcxConfig): { name: string; provider: OcxProviderConfig } | undefined {
  // Primary: well-known name "xai"
  const xai = config.providers["xai"];
  if (xai && xai.disabled !== true) return { name: "xai", provider: xai };
  // Fallback: hostname match for custom-named xAI configs
  for (const [name, p] of Object.entries(config.providers)) {
    if (p.disabled) continue;
    try {
      const host = new URL(p.baseUrl).hostname;
      if (host === "api.x.ai" || host === "cli-chat-proxy.grok.com") return { name, provider: p };
    } catch { /* invalid baseUrl */ }
  }
  return undefined;
}

export async function resolveXaiToken(providerName: string, provider: OcxProviderConfig): Promise<string | undefined> {
  const apiKey = resolveEnvValue(provider.apiKey)?.trim();
  if (apiKey) return apiKey;
  // Built-in OAuth token only for the canonical "xai" provider — never for custom-named configs.
  if (providerName !== "xai") return undefined;
  try {
    return await getValidAccessToken("xai");
  } catch {
    return undefined;
  }
}

export async function planImageBridge(
  config: OcxConfig,
  parsed: OcxParsedRequest,
  routedProvider: OcxProviderConfig,
): Promise<ImageBridgePlan | undefined> {
  if (config.images?.bridgeEnabled !== true) return undefined;
  if (!parsed._imageGeneration) return undefined;
  // Don't intercept for OpenAI native passthrough
  const host = (() => { try { return new URL(routedProvider.baseUrl).hostname; } catch { return ""; } })();
  if (host === "api.openai.com") return undefined;
  const found = findXaiProvider(config);
  if (!found) return undefined;
  const token = await resolveXaiToken(found.name, found.provider);
  if (!token) return undefined;
  // Pin the baseUrl to the registry entry, ignoring any config-level baseUrl override.
  const registryEntry = getProviderRegistryEntry("xai");
  const pinnedBaseUrl = (registryEntry?.baseUrl ?? "https://api.x.ai/v1").replace(/\/+$/, "");
  // The synthetic tool injected into the conversation is named IMAGE_GEN_TOOL_NAME,
  // which is what the model will actually call. Merge it with any original hosted tool names.
  const toolNames = new Set(parsed._imageGeneration.toolNames);
  toolNames.add(IMAGE_GEN_TOOL_NAME);
  return {
    provider: found.provider,
    auth: { baseUrl: pinnedBaseUrl, token },
    model: config.images?.bridgeModel ?? DEFAULT_MODEL,
    toolNames,
  };
}
