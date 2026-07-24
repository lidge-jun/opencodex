import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../types";
import type { ImageBridgePlan } from "./types";
import { getCredential } from "../oauth/store";
import { IMAGE_GEN_TOOL_NAME } from "./synthetic-tool";

const DEFAULT_MODEL = "grok-imagine-image-quality";

export function findXaiProvider(config: OcxConfig): OcxProviderConfig | undefined {
  // Primary: well-known name "xai"
  const xai = config.providers["xai"];
  if (xai && xai.disabled !== true) return xai;
  // Fallback: hostname match for custom-named xAI configs
  for (const p of Object.values(config.providers)) {
    if (p.disabled) continue;
    try {
      const host = new URL(p.baseUrl).hostname;
      if (host === "api.x.ai" || host === "cli-chat-proxy.grok.com") return p;
    } catch { /* invalid baseUrl */ }
  }
  return undefined;
}

export function resolveXaiToken(provider: OcxProviderConfig): string | undefined {
  const apiKey = provider.apiKey?.trim();
  if (apiKey) return apiKey;
  const cred = getCredential("xai");
  return cred?.access ?? undefined;
}

export function planImageBridge(
  config: OcxConfig,
  parsed: OcxParsedRequest,
  routedProvider: OcxProviderConfig,
): ImageBridgePlan | undefined {
  if (config.images?.bridgeEnabled === false) return undefined;
  if (!parsed._imageGeneration) return undefined;
  // Don't intercept for OpenAI native passthrough
  const host = (() => { try { return new URL(routedProvider.baseUrl).hostname; } catch { return ""; } })();
  if (host === "api.openai.com") return undefined;
  const xai = findXaiProvider(config);
  if (!xai) return undefined;
  const token = resolveXaiToken(xai);
  if (!token) return undefined;
  // The synthetic tool injected into the conversation is named IMAGE_GEN_TOOL_NAME,
  // which is what the model will actually call. Merge it with any original hosted tool names.
  const toolNames = new Set(parsed._imageGeneration.toolNames);
  toolNames.add(IMAGE_GEN_TOOL_NAME);
  return {
    provider: xai,
    auth: { baseUrl: xai.baseUrl.replace(/\/+$/, ""), token },
    model: config.images?.bridgeModel ?? DEFAULT_MODEL,
    toolNames,
  };
}
