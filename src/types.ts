export interface OcxParsedRequest {
  modelId: string;
  context: OcxContext;
  stream: boolean;
  options: OcxRequestOptions;
  _rawBody?: unknown;
}

export interface OcxContext {
  systemPrompt?: string[];
  messages: OcxMessage[];
  tools?: OcxTool[];
}

export type OcxMessage =
  | OcxUserMessage
  | OcxAssistantMessage
  | OcxDeveloperMessage
  | OcxToolResultMessage;

export interface OcxUserMessage {
  role: "user";
  content: string | OcxTextContent[];
  timestamp: number;
}

export interface OcxAssistantMessage {
  role: "assistant";
  content: OcxAssistantContentPart[];
  model?: string;
  timestamp: number;
}

export interface OcxDeveloperMessage {
  role: "developer";
  content: string | OcxTextContent[];
  timestamp: number;
}

export interface OcxToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: string;
  isError: boolean;
  timestamp: number;
}

export interface OcxTextContent {
  type: "text";
  text: string;
}

export interface OcxThinkingContent {
  type: "thinking";
  thinking: string;
  signature?: string;
  itemId?: string;
}

export interface OcxToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  customWireName?: string;
  thoughtSignature?: string;
  /** MCP namespace (e.g. "mcp__context7") when this call targets a namespaced tool. */
  namespace?: string;
}

export type OcxAssistantContentPart = OcxTextContent | OcxThinkingContent | OcxToolCall;

export interface OcxTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
  /** MCP namespace (e.g. "mcp__context7") for tools flattened out of a Responses "namespace" tool. */
  namespace?: string;
  /** Freeform/custom tool (e.g. apply_patch): the model's call must be relayed as a custom_tool_call. */
  freeform?: boolean;
  /** Client-executed tool discovery (tool_search): the model's call must be relayed as a tool_search_call. */
  toolSearch?: boolean;
}

/**
 * Wire name a chat model sees for a tool. Namespaced (MCP) tools are flattened to
 * "<namespace>__<name>" so they survive the chat-completions function-tool format;
 * the proxy maps this back to {namespace, name} on the return trip (Codex routes MCP
 * calls by an explicit `namespace` field, not by parsing the name).
 */
export function namespacedToolName(namespace: string | undefined, name: string): string {
  return namespace ? `${namespace}__${name}` : name;
}

export interface OcxRequestOptions {
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  toolChoice?: "auto" | "none" | "required" | { name: string };
  reasoning?: string;
  hideThinkingSummary?: boolean;
  serviceTier?: string;
  presencePenalty?: number;
  frequencyPenalty?: number;
  promptCacheKey?: string;
}

export type AdapterEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; arguments: string }
  | { type: "tool_call_end" }
  | { type: "done"; usage?: OcxUsage }
  | { type: "error"; message: string };

export interface OcxUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface OcxConfig {
  port: number;
  providers: Record<string, OcxProviderConfig>;
  defaultProvider: string;
  /**
   * Up to 5 routed model ids ("<provider>/<model>") to feature FIRST in the injected Codex catalog.
   * Codex's spawn_agent only advertises the first 5 routed models, so this picks which 5 appear.
   */
  subagentModels?: string[];
  /** Routed model ids ("<provider>/<model>") hidden from Codex (excluded from the catalog + /v1/models). */
  disabledModels?: string[];
  /** Freshness window (ms) for the per-provider live `/models` cache. Defaults to 5 min. */
  modelCacheTtlMs?: number;
}

export interface OcxProviderConfig {
  adapter: string;
  baseUrl: string;
  apiKey?: string;
  defaultModel?: string;
  models?: string[];
  headers?: Record<string, string>;
  /**
   * "key" (default): authenticate upstream with `apiKey`.
   * "forward": relay the caller's incoming auth headers verbatim (OAuth passthrough; gpt only).
   * "oauth": resolve a stored OAuth access token (auto-refreshed) and use it as the Bearer key.
   * Only the openai-responses adapter implements "forward"; openai-chat uses its own key/token.
   */
  authMode?: "key" | "forward" | "oauth";
  /**
   * Model ids that do NOT support a reasoning/thinking parameter. The openai-chat adapter drops
   * reasoning_effort for these even when Codex selects a reasoning level (e.g. xAI grok-build-0.1).
   */
  noReasoningModels?: string[];
}
