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
 * `api.anthropic.com`. Caller betas are reduced to `beta-allowlist.ts`; a bounded opaque
 * CLI identity handle carries only observed compatibility headers for first-party destinations. The
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
import { applyAnthropicClientIdentity, type AnthropicClientIdentity } from "./client-identity";
import { bindAnthropicAccountMetadata } from "./account-metadata";
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
  /** Provider UUID captured with the serving OAuth credential; never a local account slot id. */
  providerAccountUuid?: string;
  /** Internal request-local handle; never part of the serialized Messages body. */
  clientIdentity?: AnthropicClientIdentity;
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

/** Allocate only once the first changed item is encountered. */
function mapPreservingIdentity<T>(items: T[], mapItem: (item: T) => T): T[] {
  let out: T[] | undefined;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const mapped = mapItem(item);
    if (mapped !== item && !out) out = items.slice(0, i);
    if (out) out.push(mapped);
  }
  return out ?? items;
}

/** Collection and rewriting follow exactly the same typed content containers. */
function mapOAuthContentBlocks(blocks: unknown[], mapBlock: (block: Rec) => Rec): unknown[] {
  return mapPreservingIdentity(blocks, block => {
    if (!isRec(block)) return block;
    if (block.type === "tool_result" && Array.isArray(block.content)) {
      const content = mapOAuthContentBlocks(block.content, mapBlock);
      if (content !== block.content) block = { ...block, content };
    }
    return mapBlock(block);
  });
}

/**
 * The Claude OAuth request shape the adapter produces, applied to a Messages body: the Claude
 * Code identity as the first system block, and declared client tool names under the OAuth
 * prefix — in declarations, choices, uses and typed references, including tool-result content.
 * Copy-on-write; arguments, schemas, unknown containers and cache markers stay opaque.
 * Ambiguous original or wire names are refused before any history is rewritten.
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
  // Collect every declaration before mapping, including definitions after their references.
  // Typed server/client builtins keep fixed names and reserve them against client collisions.
  const declared = new Set<string>();
  const typedNames = new Set<string>();
  const inlineTypedNames = new Set<string>();
  const collectDeclaration = (tool: unknown, inline = false): void => {
    if (isClientTool(tool)) declared.add(tool.name);
    else if (isRec(tool) && typeof tool.name === "string") {
      typedNames.add(tool.name);
      if (inline) inlineTypedNames.add(tool.name);
    }
  };
  if (Array.isArray(body.tools)) body.tools.forEach(tool => collectDeclaration(tool));
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (!isRec(message) || !Array.isArray(message.content)) continue;
      mapOAuthContentBlocks(message.content, block => {
        if (block.type === "tool_addition" && isRec(block.tool) && block.tool.type === "tool_definition") {
          collectDeclaration(block.tool.definition, true);
        }
        return block;
      });
    }
  }
  for (const name of declared) {
    if (typedNames.has(name)) throw new Error(inlineTypedNames.has(name)
      ? "inline typed and client tool names collide" : "typed and client tool names collide");
    if (typedNames.has(applyClaudeToolPrefix(name))) throw new Error("typed and client wire tool names collide");
    wireName(name);
  }
  const renames = (name: unknown): name is string => typeof name === "string" && declared.has(name) && applyClaudeToolPrefix(name) !== name;
  const mapDeclaration = (tool: unknown): unknown => isClientTool(tool) && renames(tool.name)
    ? { ...tool, name: wireName(tool.name) } : tool;
  if (Array.isArray(body.tools)) {
    out.tools = mapPreservingIdentity(body.tools, mapDeclaration);
  }
  if (isRec(body.tool_choice) && body.tool_choice.type === "tool" && renames(body.tool_choice.name)) {
    out.tool_choice = { ...body.tool_choice, name: wireName(body.tool_choice.name) };
  }
  const mapBlock = (block: Rec): Rec => {
    if (block.type === "tool_use" && renames(block.name)) return { ...block, name: wireName(block.name) };
    if (block.type === "tool_reference" && renames(block.tool_name)) return { ...block, tool_name: wireName(block.tool_name) };
    if ((block.type === "tool_addition" || block.type === "tool_removal") && isRec(block.tool)) {
      const tool = block.tool;
      if (tool.type === "tool_reference" && renames(tool.name)) {
        return { ...block, tool: { ...tool, name: wireName(tool.name) } };
      }
      if (block.type === "tool_addition" && tool.type === "tool_definition") {
        const definition = mapDeclaration(tool.definition);
        if (definition !== tool.definition) return { ...block, tool: { ...tool, definition } };
      }
    }
    return block;
  };
  if (Array.isArray(body.messages)) {
    out.messages = mapPreservingIdentity(body.messages, message => {
      if (!isRec(message) || !Array.isArray(message.content)) return message;
      const content = mapOAuthContentBlocks(message.content, mapBlock);
      return content !== message.content ? { ...message, content } : message;
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
  const native = anthropicMessagesNativeWireBody(provider, modelId, body);
  const { strippedOpaqueState, oauthToolNames } = native;
  const wireBody = oauth ? bindAnthropicAccountMetadata(native.wireBody, options.providerAccountUuid) : native.wireBody;
  const headers = anthropicBaseRequestHeaders(wireBody.stream === true);
  if (oauth) applyAnthropicOAuthAuth(headers, provider.apiKey);
  else applyAnthropicKeyAuth(headers, provider);
  // Operator-configured provider headers apply exactly as the adapter applies them.
  if (provider.headers) {
    const configured = new Set(Object.keys(provider.headers).map(name => name.toLowerCase()));
    for (const name of Object.keys(headers)) if (configured.has(name.toLowerCase())) delete headers[name];
    Object.assign(headers, provider.headers);
  }
  if (oauth) {
    const wireHeaders = new Headers(headers);
    if (wireHeaders.get("authorization") !== `Bearer ${provider.apiKey}` || wireHeaders.has("x-api-key")) {
      throw new Error("native OAuth serving credential was overridden by provider headers");
    }
  }
  if (domain?.firstPartyAnthropic) applyAnthropicClientIdentity(headers, options.clientIdentity, provider.headers);
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
