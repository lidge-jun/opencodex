import { createHash } from "node:crypto";
import { namespacedToolName, type OcxParsedRequest, type OcxTool } from "../../types";
import { frameAgentRouterMessages } from "../agentrouter";

const MAX_CHAT_TOOL_NAME_LENGTH = 64;
const ALIAS_HINT_CHARS = 16;
const RESERVED_ALIAS_PATTERN = /^ocx_[a-zA-Z0-9_-]{16}_[a-zA-Z0-9_-]{43}$/;
type ToolIdentity = Readonly<Pick<OcxTool, "namespace" | "name">>;

export interface OpenAIChatToolNameRegistry {
  alias(tool: ToolIdentity): string;
  aliasWireName(wireName: string): string;
  restore(wireName: string): string;
}

interface OpenAIChatToolNameScope {
  messages(parsed: OcxParsedRequest, baseUrl: string, messages: readonly unknown[]): unknown;
  registry(): OpenAIChatToolNameRegistry;
  restore(wireName: string): string;
}

function identityKey(tool: ToolIdentity): string {
  return JSON.stringify([tool.namespace ?? null, tool.name]);
}

function boundedAlias(tool: ToolIdentity, wireName: string): string {
  const hint = wireName
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(-ALIAS_HINT_CHARS)
    .padStart(ALIAS_HINT_CHARS, "_");
  const key = identityKey(tool);
  const digest = createHash("sha256")
    .update(key)
    .digest("base64url");
  return `ocx_${hint}_${digest}`;
}

/** Catalog declarations plus structured calls retained in replay history. */
export function openAIChatToolNameIdentities(parsed: OcxParsedRequest): ToolIdentity[] {
  const identities: ToolIdentity[] = [...(parsed.context.tools ?? [])];
  for (const message of parsed.context.messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== "toolCall") continue;
      identities.push({
        name: part.name,
        ...(part.namespace === undefined ? {} : { namespace: part.namespace }),
      });
    }
  }
  return identities;
}

/**
 * One collision domain for a translated Chat Completions request.
 *
 * Namespaced names whose flattened spelling exceeds Chat Completions' 64-character function-name
 * bound are rewritten. Ordinary names and bare names pass through byte-for-byte unless they occupy
 * the reserved alias spelling; those are re-aliased so no declaration can shadow another identity's
 * deterministic alias. Distinct identities sharing one flattened spelling each keep an identity
 * alias, while replay rewriting leaves that ambiguous spelling untouched. Echoed aliases restore to
 * the original flattened name consumed by the Responses bridge's existing namespace map.
 */
export function createOpenAIChatToolNameRegistry(
  tools: readonly ToolIdentity[] | undefined,
): OpenAIChatToolNameRegistry {
  const identities = new Map<string, ToolIdentity>();
  for (const tool of tools ?? []) identities.set(identityKey(tool), tool);
  const sortedIdentities = [...identities.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);

  const aliasesByIdentity = new Map<string, string>();
  const aliasesByWireName = new Map<string, string>();
  const originalsByAlias = new Map<string, string>();
  const wireOwners = new Map<string, string | null>();
  for (const [key, tool] of sortedIdentities) {
    const wireName = namespacedToolName(tool.namespace, tool.name);
    const owner = wireOwners.get(wireName);
    if (owner === undefined) wireOwners.set(wireName, key);
    else if (owner !== key) wireOwners.set(wireName, null);
  }

  const aliasOwners = new Map<string, string>();
  const wireClaims = new Map<string, { key: string; alias: string } | null>();
  for (const [key, tool] of sortedIdentities) {
    const wireName = namespacedToolName(tool.namespace, tool.name);
    const candidate = (tool.namespace !== undefined && wireName.length > MAX_CHAT_TOOL_NAME_LENGTH)
      || RESERVED_ALIAS_PATTERN.test(wireName)
      || wireOwners.get(wireName) === null
      ? boundedAlias(tool, wireName)
      : wireName;
    // A full SHA-256 collision is not safely attributable. Keep the later identity's native
    // spelling instead of failing the request or stealing the first identity's restore entry.
    const alias = aliasOwners.has(candidate) ? wireName : candidate;
    aliasesByIdentity.set(key, alias);
    if (!aliasOwners.has(alias)) aliasOwners.set(alias, key);
    if (alias !== wireName) originalsByAlias.set(alias, wireName);

    const claim = wireClaims.get(wireName);
    if (claim === undefined) wireClaims.set(wireName, { key, alias });
    else if (claim !== null && claim.key !== key) wireClaims.set(wireName, null);
  }
  for (const [wireName, claim] of wireClaims) {
    if (claim !== null) aliasesByWireName.set(wireName, claim.alias);
  }

  return {
    alias(tool: ToolIdentity): string {
      const key = identityKey(tool);
      const known = aliasesByIdentity.get(key);
      if (known !== undefined) return known;
      return namespacedToolName(tool.namespace, tool.name);
    },
    aliasWireName(wireName: string): string {
      return aliasesByWireName.get(wireName) ?? wireName;
    },
    restore(wireName: string): string {
      return originalsByAlias.get(wireName) ?? wireName;
    },
  };
}

export function restoreOpenAIChatToolName(
  registry: OpenAIChatToolNameRegistry,
  wireName: string,
): string {
  return registry.restore(wireName);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Rewrite replayed assistant tool calls after the ordinary message converter has flattened them. */
export function aliasOpenAIChatMessageToolNames(
  messages: readonly unknown[],
  registry: OpenAIChatToolNameRegistry,
): unknown[] {
  return messages.map(message => {
    if (!isRecord(message) || !Array.isArray(message.tool_calls)) return message;
    let changed = false;
    const toolCalls = message.tool_calls.map(toolCall => {
      if (!isRecord(toolCall) || !isRecord(toolCall.function)
          || typeof toolCall.function.name !== "string") return toolCall;
      const name = registry.aliasWireName(toolCall.function.name);
      if (name === toolCall.function.name) return toolCall;
      changed = true;
      return { ...toolCall, function: { ...toolCall.function, name } };
    });
    return changed ? { ...message, tool_calls: toolCalls } : message;
  });
}

export function withOpenAIChatToolNames<T>(
  build: (scope: OpenAIChatToolNameScope) => T,
): T {
  let registry = createOpenAIChatToolNameRegistry(undefined);
  return build({
    messages(parsed, baseUrl, messages): unknown {
      registry = createOpenAIChatToolNameRegistry(openAIChatToolNameIdentities(parsed));
      return frameAgentRouterMessages(baseUrl, aliasOpenAIChatMessageToolNames(messages, registry));
    },
    registry: () => registry,
    restore: wireName => restoreOpenAIChatToolName(registry, wireName),
  });
}
