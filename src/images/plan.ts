import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../types";
import { toolChoiceToolPredicate } from "../types";
import type { ImageBridgePlan, VideoBridgePlan } from "./types";
import { resolveProviderApiKey } from "../providers/key-store";
import { getValidAccessToken } from "../oauth/index";
import { getProviderRegistryEntry } from "../providers/registry";
import { IMAGE_GEN_TOOL_NAME, VIDEO_GEN_TOOL_NAME, isVideoGenName } from "./synthetic-tool";

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
  const apiKey = resolveProviderApiKey(provider.apiKey)?.trim();
  return apiKey || undefined;
}

/** Token for the /v1/images → Imagine relay. OAuth reuses the Grok CLI grant. */
export async function resolveXaiImageAuthToken(provider: OcxProviderConfig): Promise<string | undefined> {
  if (provider.authMode === "oauth") {
    try {
      const token = (await getValidAccessToken("xai"))?.trim();
      return token || undefined;
    } catch {
      return undefined;
    }
  }
  return resolveXaiImageApiKey(provider);
}

export async function planImageBridge(
  config: OcxConfig,
  parsed: OcxParsedRequest,
  routedProvider: OcxProviderConfig,
): Promise<ImageBridgePlan | undefined> {
  if (config.images?.bridgeEnabled !== true) return undefined;
  if (!parsed._imageGeneration) return undefined;
  const toolAllowed = toolChoiceToolPredicate(parsed.options.toolChoice);
  const toolNames = new Set([...parsed._imageGeneration.toolNames].filter(name => toolAllowed({ name })));
  if (toolAllowed({ name: IMAGE_GEN_TOOL_NAME })) toolNames.add(IMAGE_GEN_TOOL_NAME);
  if (toolNames.size === 0) return undefined;
  // Responses advertises and rewrites authorized aliases to this synthetic name, so the loop
  // must always intercept it once any image-generation name has armed the bridge.
  toolNames.add(IMAGE_GEN_TOOL_NAME);
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
  // which is what the model will actually call. toolNames also retains authorized hosted aliases.
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

const DEFAULT_VIDEO_MODEL = "grok-imagine-video";

/**
 * What `images.videoProvider` asks for: unset, resolved to a destination, or present-but-unusable.
 */
type VideoProviderSelection =
  | { kind: "unset" }
  | { kind: "unusable" }
  | { kind: "resolved"; baseUrl: string; token: string; provider: OcxProviderConfig };

/**
 * Classify `images.videoProvider`, mirroring `images.provider`'s relay-side semantics
 * (src/providers/openai-sidecar.ts selectImagesProvider). A blank string is treated as unset.
 * Any other present value that does not resolve to a usable destination is `unusable`, which
 * leaves the bridge unarmed — it never falls back to xAI, and an xAI credential is never sent to
 * another host (the owner decision on #8175).
 */
function resolveVideoProviderDestination(config: OcxConfig): VideoProviderSelection {
  // Config is schema-validated, but this block can be hand-edited JSON, so read it as unknown.
  const raw = (config.images as { videoProvider?: unknown } | undefined)?.videoProvider;
  if (raw === undefined) return { kind: "unset" };
  if (typeof raw !== "string") return { kind: "unusable" }; // a non-string names nothing
  if (!raw.trim()) return { kind: "unset" }; // blank is treated as unset: keeps the pinned-xAI default
  const providerName = raw.trim();
  // Registry ids are built-ins this bridge must not repurpose as a destination; naming one
  // ("xai" included) fails closed instead of following its baseUrl override with its key.
  if (getProviderRegistryEntry(providerName)) return { kind: "unusable" };
  const provider = Object.prototype.hasOwnProperty.call(config.providers, providerName)
    ? config.providers[providerName]
    : undefined;
  if (!provider || provider.disabled === true) return { kind: "unusable" };
  // The video client sends a static bearer key, so OAuth and forward auth cannot carry it.
  if (provider.authMode === "oauth" || provider.authMode === "forward") return { kind: "unusable" };
  const token = resolveProviderApiKey(provider.apiKey)?.trim();
  if (!token) return { kind: "unusable" };
  let parsed: URL;
  try {
    parsed = new URL(provider.baseUrl.trim());
  } catch {
    return { kind: "unusable" }; // invalid baseUrl; config validation reports it separately
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { kind: "unusable" };
  return { kind: "resolved", baseUrl: provider.baseUrl.trim().replace(/\/+$/, ""), token, provider };
}

/**
 * Decide whether the video bridge should activate for this request. Unlike images, video
 * generation has no hosted OpenAI tool type — the synthetic `video_gen` tool is unconditionally
 * injected when `videoBridgeEnabled` is true. The bridge activates only when:
 *   1. videoBridgeEnabled is explicitly true (opt-in)
 *   2. the routed provider is NOT api.openai.com (native passthrough)
 *   3. either `images.videoProvider` names a usable custom provider, or an xAI provider with a
 *      valid API key is available; a present-but-unusable `videoProvider` disarms the bridge
 *      rather than falling back to xAI
 */
export async function planVideoBridge(
  config: OcxConfig,
  parsed: OcxParsedRequest,
  routedProvider: OcxProviderConfig,
): Promise<VideoBridgePlan | undefined> {
  if (config.images?.videoBridgeEnabled !== true) return undefined;
  const toolNames = new Set<string>();
  toolNames.add(VIDEO_GEN_TOOL_NAME);
  // Collect any existing function tools whose name matches a video_gen alias
  // so the loop can intercept and replace them (image-bridge parity).
  for (const t of parsed.context?.tools ?? []) {
    // Skip namespaced tools — a namespaced MCP video_gen must not be intercepted.
    if (t.namespace) continue;
    const fnName = typeof t.name === "string" ? t.name
      : (t as unknown as { function?: { name?: string } }).function?.name;
    if (typeof fnName === "string" && isVideoGenName(fnName)) {
      toolNames.add(fnName);
    }
  }
  const toolAllowed = toolChoiceToolPredicate(parsed.options?.toolChoice);
  for (const name of toolNames) {
    if (!toolAllowed({ name })) toolNames.delete(name);
  }
  if (toolNames.size === 0) return undefined;
  // Don't intercept for OpenAI native passthrough
  const host = (() => { try { return new URL(routedProvider.baseUrl).hostname; } catch { return ""; } })();
  if (host === "api.openai.com") return undefined;
  const selection = resolveVideoProviderDestination(config);
  if (selection.kind === "unusable") {
    // A set-but-unusable videoProvider leaves the bridge unarmed: never silently arm xAI (#8175).
    return undefined;
  }
  if (selection.kind === "resolved") {
    // `images.videoProvider` owns the destination: only the named provider's baseUrl and key
    // are used (#8175). The registry pin below stays the default (and the guard) for the xAI
    // path, so an xAI key never follows a baseUrl override without this explicit opt-in.
    const timeoutMsCustom = clampImageTimeoutMs(config.images?.videoTimeoutMs);
    const keepRawCustom = config.images?.artifactsKeepCount;
    const artifactsKeepCountCustom =
      typeof keepRawCustom === "number" && Number.isFinite(keepRawCustom) ? Math.floor(keepRawCustom) : undefined;
    return {
      provider: selection.provider,
      auth: { baseUrl: selection.baseUrl, token: selection.token },
      model: config.images?.videoBridgeModel ?? DEFAULT_VIDEO_MODEL,
      toolNames,
      ...(timeoutMsCustom !== undefined ? { timeoutMs: timeoutMsCustom } : {}),
      ...(artifactsKeepCountCustom !== undefined ? { artifactsKeepCount: artifactsKeepCountCustom } : {}),
    };
  }
  // "unset": the pinned-xAI default below.
  const found = findXaiProvider(config);
  if (!found) return undefined;
  const token = resolveXaiImageApiKey(found.provider);
  if (!token) return undefined;
  // Pin the baseUrl to the registry entry, ignoring any config-level baseUrl override.
  const registryEntry = getProviderRegistryEntry("xai");
  const pinnedBaseUrl = (registryEntry?.baseUrl ?? "https://api.x.ai/v1").replace(/\/+$/, "");
  const timeoutMs = clampImageTimeoutMs(config.images?.videoTimeoutMs);
  const keepRaw = config.images?.artifactsKeepCount;
  const artifactsKeepCount =
    typeof keepRaw === "number" && Number.isFinite(keepRaw) ? Math.floor(keepRaw) : undefined;
  return {
    provider: found.provider,
    auth: { baseUrl: pinnedBaseUrl, token },
    model: config.images?.videoBridgeModel ?? DEFAULT_VIDEO_MODEL,
    toolNames,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(artifactsKeepCount !== undefined ? { artifactsKeepCount } : {}),
  };
}
