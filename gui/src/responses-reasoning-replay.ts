/** UI eligibility only; the existing provider capability owns wire serialization. */
export function canConfigureResponsesReasoningReplay(provider: {
  adapter: string; baseUrl: string; authMode?: string;
}): boolean {
  if (provider.adapter.trim() !== "openai-responses") return false;
  if (provider.authMode && provider.authMode !== "key" && provider.authMode !== "local") return false;
  try {
    const url = new URL(provider.baseUrl.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return false;
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    // Curated OpenAI/Azure surfaces retain their existing replay defaults.
    return host !== "api.openai.com" && host !== "chatgpt.com" && host !== "chat.openai.com"
      && ![".openai.azure.com", ".services.ai.azure.com", ".cognitiveservices.azure.com"].some(suffix => host.endsWith(suffix));
  } catch {
    return false;
  }
}
