/** Exact Go Gemini contract: https://opencode.ai/docs/go/#endpoints (#7097). */
export const OPENCODE_GO_GEMINI_MODEL = "gemini-4-argon-contributor";

export interface OpenCodeGoDestination {
  readonly baseUrl?: unknown;
  readonly authMode?: unknown;
  readonly googleMode?: unknown;
}

/** A provider name alone must never authorize redirecting a credential to OpenCode. */
export function isOpenCodeGoGeminiDestination(provider: OpenCodeGoDestination | undefined): boolean {
  if (!provider || typeof provider.baseUrl !== "string") return false;
  if (provider.authMode !== undefined && provider.authMode !== "key") return false;
  if (provider.googleMode !== undefined && provider.googleMode !== "ai-studio") return false;
  try {
    const url = new URL(provider.baseUrl.trim());
    return url.origin === "https://opencode.ai"
      && !url.username && !url.password && !url.search && !url.hash
      && ["/zen/go/v1", "/inference/go/v1"].includes(url.pathname.replace(/\/+$/, ""));
  } catch {
    return false;
  }
}

/** Return the fixed Gemini endpoint only for the exact model and an eligible Go destination. */
export function openCodeGoGeminiEndpoint(provider: OpenCodeGoDestination, modelId: string): string | undefined {
  return modelId === OPENCODE_GO_GEMINI_MODEL && isOpenCodeGoGeminiDestination(provider)
    ? `https://opencode.ai/inference/go/v1/models/${OPENCODE_GO_GEMINI_MODEL}`
    : undefined;
}
