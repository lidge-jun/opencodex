/** Fixed-key OpenCode Zen destinations supporting native model protocols. */
export interface OpenCodeZenDestination {
  readonly baseUrl?: unknown;
  readonly authMode?: unknown;
  readonly googleMode?: unknown;
}

/** Match the official Zen destination and API-key authentication. */
export function openCodeZenKeyBaseUrl(provider: OpenCodeZenDestination | undefined): string | undefined {
  if (!provider || typeof provider.baseUrl !== "string") return undefined;
  if (provider.authMode !== undefined && provider.authMode !== "key") return undefined;
  try {
    const url = new URL(provider.baseUrl.trim());
    const pathname = url.pathname.replace(/\/+$/, "");
    if (url.origin !== "https://opencode.ai" || url.username || url.password || url.search || url.hash) return undefined;
    if (pathname !== "/zen/v1" && pathname !== "/inference/v1") return undefined;
    return url.origin + pathname;
  } catch {
    return undefined;
  }
}

/** Gemini's native endpoint applies only in AI Studio mode. */
export function openCodeZenBaseUrl(provider: OpenCodeZenDestination | undefined): string | undefined {
  if (provider?.googleMode !== undefined && provider.googleMode !== "ai-studio") return undefined;
  return openCodeZenKeyBaseUrl(provider);
}

/** Keep the selected destination; Zen omits AI Studio's /v1beta segment. */
export function openCodeZenGeminiEndpoint(provider: OpenCodeZenDestination, modelId: string): string | undefined {
  const baseUrl = openCodeZenBaseUrl(provider);
  return baseUrl && modelId.toLowerCase().startsWith("gemini-")
    ? baseUrl + "/models/" + encodeURIComponent(modelId)
    : undefined;
}
