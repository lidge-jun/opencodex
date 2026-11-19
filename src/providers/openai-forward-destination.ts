export const CODEX_FORWARD_BASE_URL = "https://chatgpt.com/backend-api/codex";

export function normalizedBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.username || url.password || url.search || url.hash) return undefined;
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${path}`;
  } catch {
    return undefined;
  }
}

export function isCanonicalOpenAiForwardProvider(provider: { adapter?: string; authMode?: string; baseUrl?: string }): boolean {
  return provider.adapter === "openai-responses"
    && provider.authMode === "forward"
    && provider.baseUrl !== undefined
    && normalizedBaseUrl(provider.baseUrl) === CODEX_FORWARD_BASE_URL;
}
