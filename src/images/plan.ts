import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../types";
import type { ImageBridgePlan } from "./types";
import { resolveEnvValue } from "../config";
import { getProviderRegistryEntry } from "../providers/registry";
import { IMAGE_GEN_TOOL_NAME } from "./synthetic-tool";

const DEFAULT_MODEL = "grok-imagine-image-quality";
/** Absolute ceiling for `images.timeoutMs` (matches /v1/images relay budget). */
export const MAX_IMAGE_TIMEOUT_MS = 300_000;

function clampImageTimeoutMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.max(1, Math.min(MAX_IMAGE_TIMEOUT_MS, Math.floor(value)));
}

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

/**
 * Image Bridge fulfillment talks to the public Images API on api.x.ai with a Bearer API key.
 * OAuth / Grok CLI proxy transport is not used here (that path is chat-oriented and not a
 * supported Images transport), so oauth-only configs deliberately do not arm the bridge.
 */
export function resolveXaiImageApiKey(provider: OcxProviderConfig): string | undefined {
  if (provider.authMode === "oauth") return undefined;
  const apiKey = resolveEnvValue(provider.apiKey)?.trim();
  return apiKey || undefined;
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
  const token = resolveXaiImageApiKey(found.provider);
  if (!token) return undefined;
  // Pin the baseUrl to the registry entry, ignoring any config-level baseUrl override.
  const registryEntry = getProviderRegistryEntry("xai");
  const pinnedBaseUrl = (registryEntry?.baseUrl ?? "https://api.x.ai/v1").replace(/\/+$/, "");
  // The synthetic tool injected into the conversation is named IMAGE_GEN_TOOL_NAME,
  // which is what the model will actually call. Merge it with any original hosted tool names.
  const toolNames = new Set(parsed._imageGeneration.toolNames);
  toolNames.add(IMAGE_GEN_TOOL_NAME);
  const original = parsed._imageGeneration.originalTool;
  const hostedSize = typeof original?.size === "string" ? original.size : undefined;
  const hostedQuality = typeof original?.quality === "string" ? original.quality : undefined;
  const timeoutMs = clampImageTimeoutMs(config.images?.timeoutMs);
  const keepRaw = config.images?.artifactsKeepCount;
  const artifactsKeepCount =
    typeof keepRaw === "number" && Number.isFinite(keepRaw) ? Math.floor(keepRaw) : undefined;
  return {
    provider: found.provider,
    auth: { baseUrl: pinnedBaseUrl, token },
    model: config.images?.bridgeModel ?? DEFAULT_MODEL,
    toolNames,
    ...(hostedSize ? { defaultSize: hostedSize } : {}),
    ...(hostedQuality ? { defaultQuality: hostedQuality } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(artifactsKeepCount !== undefined ? { artifactsKeepCount } : {}),
  };
}
