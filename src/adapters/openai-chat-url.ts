const TRAILING_SLASHES = /\/+$/;
const TRAILING_CHAT_COMPLETIONS = /\/chat\/completions\/?$/;

/** Build the openai-chat send URL from a configured baseUrl.
 *  Accepts /v1, /v1/, /v1/chat/completions, and /v1/chat/completions/.
 */
export function openaiChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(TRAILING_SLASHES, "");
  const withoutEndpoint = trimmed.replace(TRAILING_CHAT_COMPLETIONS, "");
  return `${withoutEndpoint}/chat/completions`;
}
