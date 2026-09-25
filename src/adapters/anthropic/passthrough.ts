/**
 * Managed native Messages request builder (PF-08, PF-10).
 *
 * The request a proxy-managed Anthropic credential sends when the client already spoke Messages:
 * the caller's own body, cut to a fixed field allowlist, with the wire model and the provider's
 * credential. URL, `anthropic-version`, client identity and credential placement come from the
 * same helpers the Anthropic adapter uses, so the two lanes cannot drift apart.
 *
 * Authority: only the provider's own credential is ever placed on the request — a configured
 * key, or (PF-10) the access token of the OAuth account the lane resolved, which is sent only to
 * `api.anthropic.com`. The one caller header this builder sees is `anthropic-beta`, handed over
 * explicitly and reduced to `beta-allowlist.ts`; no other caller header is read here at all. The
 * caller-forward passthrough in `src/server/claude-messages.ts` is the only place a caller's
 * Anthropic credential may travel, and it does not come through here.
 *
 * Opaque state: thinking signatures and `redacted_thinking` blocks reach only first-party
 * Anthropic (`src/protocols/opaque-state.ts`). The source body is never mutated, so every build
 * for every destination decides from the full source again.
 */
import { mergeAnthropicBetaHeader } from "../../providers/anthropic-fast";
import { applyClaudeToolPrefix, CLAUDE_CODE_SYSTEM_INSTRUCTION } from "../../oauth/anthropic";
import { credentialDomainFor, opaqueStateForDestination } from "../../protocols/opaque-state";
import type { OcxConfig, OcxProviderConfig } from "../../types";
import {
  anthropicBaseRequestHeaders,
  applyAnthropicKeyAuth,
  applyAnthropicOAuthAuth,
  resolveAnthropicMessagesUrl,
} from "../anthropic";
import { allowlistAnthropicBetas } from "./beta-allowlist";

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
  /** Caller `anthropic-beta` values were left out. Which ones is never recorded. */
  droppedBetas: boolean;
  /** Thinking signatures or `redacted_thinking` blocks were removed for this destination. */
  strippedOpaqueState: boolean;
  /**
   * OAuth only: wire tool name to the caller's name, for every tool the OAuth prefix renamed.
   * The lane maps `tool_use` names in the answer back through it.
   */
  oauthToolNames?: ReadonlyMap<string, string>;
}

export interface AnthropicMessagesPassthroughOptions {
  /** The caller's `anthropic-beta` header, handed over by the ingress. */
  callerAnthropicBeta?: string | null;
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

type Rec = Record<string, unknown>;
function isRec(value: unknown): value is Rec {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A tool the caller executes (no `type`, or `custom`), as opposed to a typed server tool. */
function isClientTool(tool: unknown): tool is Rec & { name: string } {
  return isRec(tool) && typeof tool.name === "string" && (tool.type === undefined || tool.type === "custom");
}

/**
 * The Claude OAuth request shape the adapter produces, applied to a Messages body: the Claude
 * Code identity as the first system block, and declared client tool names under the OAuth
 * prefix — in `tools`, a named `tool_choice` and the history's `tool_use` blocks. Copy-on-write;
 * the input is not mutated. Two caller names that meet under the prefix are refused rather than
 * guessed at.
 */
export function anthropicOAuthWireBody(body: Rec): { body: Rec; toolNames: Map<string, string> } {
  const out: Rec = { ...body };
  const toolNames = new Map<string, string>();
  const owners = new Map<string, string>();
  const wireName = (name: string): string => {
    const wire = applyClaudeToolPrefix(name);
    const owner = owners.get(wire);
    if (owner !== undefined && owner !== name) throw new Error("tool names collide under the Claude OAuth tool prefix");
    owners.set(wire, name);
    if (wire !== name) toolNames.set(wire, name);
    return wire;
  };
  const identity = { type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION };
  if (typeof body.system === "string" && body.system.length > 0) {
    out.system = [identity, { type: "text", text: body.system }];
  } else if (Array.isArray(body.system)) {
    const first = body.system[0];
    const present = isRec(first) && first.type === "text" && first.text === CLAUDE_CODE_SYSTEM_INSTRUCTION;
    out.system = present ? body.system : [identity, ...body.system];
  } else {
    out.system = [identity];
  }
  // Only names the caller declared as its own tools are renamed. A typed tool (a server tool,
  // or a client-executed builtin such as `bash_*`) keeps the name its type fixes, and so do
  // its calls in the history.
  const declared = new Set<string>();
  if (Array.isArray(body.tools)) {
    out.tools = body.tools.map(tool => {
      if (!isClientTool(tool)) return tool;
      declared.add(tool.name);
      return { ...tool, name: wireName(tool.name) };
    });
  }
  const renames = (name: unknown): name is string => typeof name === "string" && declared.has(name);
  if (isRec(body.tool_choice) && body.tool_choice.type === "tool" && renames(body.tool_choice.name)) {
    out.tool_choice = { ...body.tool_choice, name: wireName(body.tool_choice.name) };
  }
  const isRenamedUse = (block: unknown): block is Rec & { name: string } => isRec(block) && block.type === "tool_use" && renames(block.name);
  if (Array.isArray(body.messages)) {
    out.messages = body.messages.map(message => {
      if (!isRec(message) || !Array.isArray(message.content) || !message.content.some(isRenamedUse)) return message;
      return {
        ...message,
        content: message.content.map(block => isRenamedUse(block) ? { ...block, name: wireName(block.name) } : block),
      };
    });
  }
  return { body: out, toolNames };
}

/**
 * What the native lane sends for this provider, without a credential: the allowlisted body,
 * opaque state kept only for first-party Anthropic, and the OAuth request shape for an OAuth
 * provider. `count_tokens` counts this; the builder below sends it.
 */
export function anthropicMessagesNativeWireBody(
  provider: Pick<OcxProviderConfig, "baseUrl" | "authMode">,
  modelId: string,
  body: Readonly<Record<string, unknown>>,
): { wireBody: Rec; strippedOpaqueState: boolean; oauthToolNames?: Map<string, string> } {
  const allowlisted = anthropicMessagesPassthroughBody(body, modelId);
  const opaque = opaqueStateForDestination(allowlisted, credentialDomainFor(provider));
  if (provider.authMode !== "oauth") return { wireBody: opaque.body, strippedOpaqueState: opaque.stripped };
  const oauth = anthropicOAuthWireBody(opaque.body);
  return { wireBody: oauth.body, strippedOpaqueState: opaque.stripped, oauthToolNames: oauth.toolNames };
}

/**
 * Build the upstream request. Throws the adapter's own errors for a missing credential or a
 * malformed or unresolved base URL, and refuses an OAuth credential for any destination other
 * than first-party Anthropic. `config` is accepted for parity with the other passthrough
 * builders; no config key changes the wire today.
 */
export function buildAnthropicMessagesPassthroughRequest(
  provider: OcxProviderConfig,
  modelId: string,
  body: Readonly<Record<string, unknown>>,
  _config?: OcxConfig,
  options: AnthropicMessagesPassthroughOptions = {},
): AnthropicMessagesPassthroughRequest {
  const oauth = provider.authMode === "oauth";
  if (provider.authMode !== undefined && provider.authMode !== "key" && !oauth) {
    throw new Error("managed native Messages requires a key-auth or OAuth anthropic provider");
  }
  const domain = credentialDomainFor(provider);
  if (oauth && !domain?.firstPartyAnthropic) {
    throw new Error("managed native Messages sends Anthropic OAuth credentials only to api.anthropic.com");
  }
  if (typeof provider.apiKey !== "string" || provider.apiKey.trim() === "") {
    throw new Error(oauth
      ? "anthropic oauth token missing — run ocx login anthropic"
      : "anthropic provider requires a non-empty apiKey (authMode: key)");
  }
  const url = resolveAnthropicMessagesUrl(provider);
  const { wireBody, strippedOpaqueState, oauthToolNames } = anthropicMessagesNativeWireBody(provider, modelId, body);
  const headers = anthropicBaseRequestHeaders(wireBody.stream === true);
  if (oauth) applyAnthropicOAuthAuth(headers, provider.apiKey);
  else applyAnthropicKeyAuth(headers, provider);
  // Operator-configured provider headers apply exactly as the adapter applies them.
  if (provider.headers) Object.assign(headers, provider.headers);
  const betas = allowlistAnthropicBetas(options.callerAnthropicBeta, domain?.firstPartyAnthropic ? "first-party" : "compatible");
  mergeAnthropicBetaHeader(headers, betas.betas);
  return {
    url,
    headers,
    body: JSON.stringify(wireBody),
    wireBody,
    droppedBetas: betas.dropped,
    strippedOpaqueState,
    ...(oauthToolNames ? { oauthToolNames } : {}),
  };
}
