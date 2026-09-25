/**
 * Managed native Messages request builder (PF-08).
 *
 * The request a proxy-managed Anthropic key sends when the client already spoke Messages: the
 * caller's own body, cut to a fixed field allowlist, with the wire model and the provider's
 * credential. URL, `anthropic-version`, client identity and credential placement come from the
 * same helpers the Anthropic adapter uses, so the two lanes cannot drift apart.
 *
 * Authority: only the provider's configured key is ever placed on the request. No caller header
 * is read here at all — the caller-forward passthrough in `src/server/claude-messages.ts` is the
 * only place a caller's Anthropic credential may travel, and it does not come through here.
 */
import type { OcxConfig, OcxProviderConfig } from "../../types";
import { anthropicBaseRequestHeaders, applyAnthropicKeyAuth, resolveAnthropicMessagesUrl } from "../anthropic";

/**
 * Top-level Messages fields the native lane forwards. Everything else is dropped: an unknown or
 * beta-gated field would otherwise reach the provider unchecked. None of the dropped fields has
 * a name in the protocol feature vocabulary, so no feature effect is recorded for them.
 */
export const ANTHROPIC_MESSAGES_PASSTHROUGH_FIELDS = [
  "model",
  "messages",
  "system",
  "max_tokens",
  "metadata",
  "stop_sequences",
  "stream",
  "temperature",
  "top_p",
  "top_k",
  "tools",
  "tool_choice",
  "thinking",
  "output_config",
  "service_tier",
] as const;

const PASSTHROUGH_FIELD_SET: ReadonlySet<string> = new Set(ANTHROPIC_MESSAGES_PASSTHROUGH_FIELDS);

export interface AnthropicMessagesPassthroughRequest {
  url: string;
  headers: Record<string, string>;
  /** The serialized wire body. */
  body: string;
  /** The same body before serialization, for callers that count or inspect what is sent. */
  wireBody: Record<string, unknown>;
}

/** The allowlisted copy of `body` with `model` set to the wire model. Shallow: nothing is cloned. */
export function anthropicMessagesPassthroughBody(
  body: Readonly<Record<string, unknown>>,
  modelId: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (PASSTHROUGH_FIELD_SET.has(key) && value !== undefined) out[key] = value;
  }
  out.model = modelId;
  return out;
}

/**
 * Build the upstream request. Throws the adapter's own errors for a missing key or a malformed
 * or unresolved base URL. `config` is accepted for parity with the other passthrough builders;
 * no config key changes the wire today.
 */
export function buildAnthropicMessagesPassthroughRequest(
  provider: OcxProviderConfig,
  modelId: string,
  body: Readonly<Record<string, unknown>>,
  _config?: OcxConfig,
): AnthropicMessagesPassthroughRequest {
  if (provider.authMode !== undefined && provider.authMode !== "key") {
    throw new Error("managed native Messages requires a key-auth anthropic provider");
  }
  if (typeof provider.apiKey !== "string" || provider.apiKey.trim() === "") {
    throw new Error("anthropic provider requires a non-empty apiKey (authMode: key)");
  }
  const url = resolveAnthropicMessagesUrl(provider);
  const wireBody = anthropicMessagesPassthroughBody(body, modelId);
  const headers = anthropicBaseRequestHeaders(wireBody.stream === true);
  applyAnthropicKeyAuth(headers, provider);
  // Operator-configured provider headers apply exactly as the adapter applies them.
  if (provider.headers) Object.assign(headers, provider.headers);
  return { url, headers, body: JSON.stringify(wireBody), wireBody };
}
