/**
 * OpenAI-backend-only request metadata strip.
 *
 * codex >= 0.151 attaches `internal_chat_message_metadata_passthrough` (content_item_kinds) to
 * Responses input items when the configured provider name is "openai" — codex-rs
 * core/src/client.rs only clears it for `!is_openai()` providers. opencodex reuses the built-in
 * openai provider via `openai_base_url`, so the field arrives here; routed upstreams (Joybuilder
 * etc.) whitelist parameters strictly and reject it with 400 `unknown_parameter`
 * ('input[0].internal_chat_message_metadata_passthrough.content_item_kinds').
 *
 * Mirror the codex-rs non-openai normalization at the proxy boundary: a flat loop over `input`,
 * matching `build_responses_request`'s own stripping, so combo/chat/anthropic replays and the
 * compact endpoint are all covered without touching per-provider forwarding code.
 */
export function stripOpenAiInternalRequestMetadata(body: unknown): void {
  const input = (body as { input?: unknown } | undefined)?.input;
  if (!Array.isArray(input)) return;
  for (const item of input) {
    if (item && typeof item === "object") {
      delete (item as Record<string, unknown>).internal_chat_message_metadata_passthrough;
    }
  }
}
