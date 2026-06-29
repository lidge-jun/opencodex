export interface OcxParsedRequest {
  modelId: string;
  previousResponseId?: string;
  context: OcxContext;
  stream: boolean;
  options: OcxRequestOptions;
  _rawBody?: unknown;
  /**
   * The hosted `{type:"web_search", ...}` tool config, stashed when Codex enables web search. Routed
   * (non-OpenAI) providers can't run it server-side, so the proxy re-exposes it as a function tool and
   * executes searches via the gpt-5.4-mini sidecar (see src/web-search). Absent when not requested.
   */
  _webSearch?: Record<string, unknown>;
  /**
   * True when Codex requested structured output (`text.format` = json_schema/json_object). The
   * web-search tool_result is then rendered as compact JSON instead of markdown prose, so its
   * answer/"Sources:" text can't bleed into and corrupt the model's schema-constrained output.
   */
  _structuredOutput?: boolean;
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
  content: string | OcxContentPart[];
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
  content: string | OcxContentPart[];
  timestamp: number;
}

export interface OcxToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  /** MCP namespace from the originating tool call, if any. */
  toolNamespace?: string;
  /** Text, or content parts when a tool (e.g. Codex view_image) returns an image in its output. */
  content: string | OcxContentPart[];
  isError: boolean;
  timestamp: number;
}

export interface OcxTextContent {
  type: "text";
  text: string;
}

export interface OcxImageContent {
  type: "image";
  /** A `data:` URL (base64) or a remote https URL — passed through from Codex verbatim, NEVER inlined as text. */
  imageUrl: string;
  /** Fidelity hint from Codex: "low" | "high" | "auto". */
  detail?: string;
}

/** A user/developer message content part: text or an image (vision). */
export type OcxContentPart = OcxTextContent | OcxImageContent;

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
  /** Synthetic web_search tool: the model's call is executed by the gpt-5.4-mini sidecar, not relayed to Codex. */
  webSearch?: boolean;
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

export function toolChoiceAliases(tool: Pick<OcxTool, "namespace" | "name">): string[] {
  const wireName = namespacedToolName(tool.namespace, tool.name);
  return tool.namespace ? [wireName, `${tool.namespace}.${tool.name}`] : [wireName];
}

export function toolAllowedByChoice(tool: Pick<OcxTool, "namespace" | "name">, allowedTools: ReadonlySet<string>): boolean {
  return toolChoiceAliases(tool).some(name => allowedTools.has(name));
}

export function resolveToolChoiceWireName(tools: readonly Pick<OcxTool, "namespace" | "name">[] | undefined, name: string): string {
  const match = tools?.find(tool => toolChoiceAliases(tool).includes(name));
  return match ? namespacedToolName(match.namespace, match.name) : name;
}

/**
 * Whether `modelId` is in a per-provider classification list (e.g. `noVisionModels`). Matches the full
 * id, OR — for Ollama-style ids — the family before the ":size" tag, so a `gpt-oss` entry covers
 * `gpt-oss:120b`/`gpt-oss:20b`. Colon-less ids (e.g. `grok-build-0.1`) still match exactly only.
 */
export function modelInList(list: string[] | undefined, modelId: string): boolean {
  if (!list || list.length === 0) return false;
  if (list.includes(modelId)) return true;
  const colon = modelId.indexOf(":");
  return colon > 0 && list.includes(modelId.slice(0, colon));
}

export type OcxToolChoice =
  | "auto"
  | "none"
  | "required"
  | { name: string }
  | { allowedTools: string[]; mode: "auto" | "required" };

export function isAllowedToolChoice(value: OcxToolChoice | undefined): value is { allowedTools: string[]; mode: "auto" | "required" } {
  return typeof value === "object" && value !== null && "allowedTools" in value;
}

export interface OcxRequestOptions {
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  toolChoice?: OcxToolChoice;
  reasoning?: string;
  hideThinkingSummary?: boolean;
  serviceTier?: string;
  presencePenalty?: number;
  frequencyPenalty?: number;
  promptCacheKey?: string;
}

export type AdapterEvent =
  | { type: "heartbeat" }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "reasoning_raw_delta"; text: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; arguments: string }
  | { type: "tool_call_end" }
  | { type: "done"; usage?: OcxUsage }
  | { type: "error"; message: string };

export interface OcxUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
  estimated?: boolean;
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
  /** Provider-level Codex-visible context caps. Values only lower known model context windows. */
  providerContextCaps?: Record<string, number>;
  /** Global Codex-visible context cap value (tokens). Falls back to DEFAULT_PROVIDER_CONTEXT_CAP. */
  contextCapValue?: number;
  /** Bind hostname. Default "127.0.0.1" (loopback only). Set "0.0.0.0" to expose on all interfaces. */
  hostname?: string;
  /** Upstream stall timeout (seconds). After this many seconds of no upstream data, emits response.incomplete. Default 90. Min 1. */
  stallTimeoutSec?: number;
  /** Connect timeout (ms) for upstream fetch — covers DNS, TCP, TLS, and response header. Default 30000. */
  connectTimeoutMs?: number;
  /** Graceful shutdown drain timeout (ms). Active turns are aborted after this deadline. Default 5000. */
  shutdownTimeoutMs?: number;
  /** Advertise supports_websockets so Codex opens the WS endpoint. Default false; set true to opt in. */
  websockets?: boolean;
  /** Auto-start/sync the proxy from the Codex shim before launching Codex. Default true. */
  codexAutoStart?: boolean;
  /**
   * Compatibility mode: temporarily rewrite Codex resume-history metadata while the proxy is active
   * so Codex App can show old OpenAI chats and opencodex-created exec chats under its default
   * interactive-source/provider filters. Default true; originals are backed up and restored by
   * `ocx stop` / `ocx restore`. Set false to opt out of history remapping.
   */
  syncResumeHistory?: boolean;
  /** Freshness window (ms) for the per-provider live `/models` cache. Defaults to 5 min. */
  modelCacheTtlMs?: number;
  /** Web-search sidecar: route web_search for non-OpenAI models through a gpt-mini via ChatGPT passthrough. */
  webSearchSidecar?: OcxWebSearchSidecarConfig;
  /** Vision sidecar: describe images via a gpt vision model so text-only models can "see" them. */
  visionSidecar?: OcxVisionSidecarConfig;
  /** Codex multi-account pool. */
  codexAccounts?: CodexAccount[];
  /** Active pool account id for next session. undefined = main (passthrough as-is). */
  activeCodexAccountId?: string;
  /** Auto-switch threshold (0-100). Default 80. 0 = disabled. */
  autoSwitchThreshold?: number;
  /** Consecutive non-2xx upstream responses before switching future new threads. Default 3. 0 = disabled. */
  upstreamFailoverThreshold?: number;
}

export interface OcxVisionSidecarConfig {
  /** Master switch. Default: enabled when a forward (ChatGPT) provider exists and the caller is logged in. */
  enabled?: boolean;
  /** Vision model that describes images (must be a native ChatGPT model with image input). */
  model?: string;
  /** Sidecar fetch timeout (ms). */
  timeoutMs?: number;
}

export interface OcxWebSearchSidecarConfig {
  /** Master switch. Default: enabled when a forward (ChatGPT) provider exists and the caller is logged in. */
  enabled?: boolean;
  /** Sidecar model that runs the real server-side web_search (must be a native ChatGPT model). */
  model?: string;
  /** Reasoning effort for the sidecar — "minimal" (non-thinking) keeps it fast/cheap. */
  reasoning?: string;
  /** Max searches executed per main-model turn (loop guard). */
  maxSearchesPerTurn?: number;
  /** Sidecar fetch timeout (ms). */
  timeoutMs?: number;
}

export interface OcxProviderConfig {
  adapter: string;
  baseUrl: string;
  /** Keep provider settings on disk but exclude it from routing and model/catalog listings. */
  disabled?: boolean;
  apiKey?: string;
  defaultModel?: string;
  models?: string[];
  /**
   * Fetch the provider's live `/models` endpoint. Defaults to true.
   * Set false when `models` is an intentional allowlist or a provider's live catalog is too large
   * or too flaky for startup/catalog sync.
   */
  liveModels?: boolean;
  /** Provider-wide Codex-visible context-window cap for routed catalog entries. */
  contextWindow?: number;
  /** Model-specific Codex-visible context-window caps. Values cap live metadata, never raise it. */
  modelContextWindows?: Record<string, number>;
  /** Model-specific Codex catalog input modalities, e.g. ["text"] or ["text", "image"]. */
  modelInputModalities?: Record<string, string[]>;
  headers?: Record<string, string>;
  /**
   * "key" (default): authenticate upstream with `apiKey`.
   * "forward": relay the caller's incoming auth headers verbatim (OAuth passthrough; gpt only).
   * "oauth": resolve a stored OAuth access token (auto-refreshed) and use it as the Bearer key.
   * Only the openai-responses adapter implements "forward"; openai-chat uses its own key/token.
   */
  authMode?: "key" | "forward" | "oauth";
  /**
   * Provider-wide Codex-visible reasoning tiers for routed models. Use only Codex-supported labels
   * here (`low`, `medium`, `high`, `xhigh`); translate to provider-specific wire values with
   * `reasoningEffortMap` / `modelReasoningEffortMap` below.
   */
  reasoningEfforts?: string[];
  /** Model-specific Codex-visible reasoning tiers. An empty array means “do not expose effort”. */
  modelReasoningEfforts?: Record<string, string[]>;
  /** Provider-wide mapping from Codex effort labels to upstream `reasoning_effort` values. */
  reasoningEffortMap?: Record<string, string>;
  /** Model-specific mapping from Codex effort labels to upstream `reasoning_effort` values. */
  modelReasoningEffortMap?: Record<string, Record<string, string>>;
  /**
   * Model ids that do NOT support a reasoning/thinking parameter. The openai-chat adapter drops
   * reasoning_effort for these even when Codex selects a reasoning level (e.g. xAI grok-build-0.1).
   */
  noReasoningModels?: string[];
  /** Model ids that reject caller-specified temperature. */
  noTemperatureModels?: string[];
  /** Model ids that reject caller-specified top_p. */
  noTopPModels?: string[];
  /** Model ids that reject caller-specified presence/frequency penalty values. */
  noPenaltyModels?: string[];
  /** Model ids whose tool_choice only accepts `auto` or `none`; forced/named choices are downgraded. */
  autoToolChoiceOnlyModels?: string[];
  /** Model ids that expect prior assistant `reasoning_content` to be preserved in chat history. */
  preserveReasoningContentModels?: string[];
  /** Anthropic-compatible gateways that need custom tool names escaped on the wire. */
  escapeBuiltinToolNames?: boolean;
  /**
   * Model ids that do NOT accept image inputs. The proxy gives them "eyes" via the vision sidecar:
   * attached images are described by a gpt vision model and replaced with text before the call.
   */
  noVisionModels?: string[];
  /**
   * Google adapter mode. "ai-studio" (default) = Generative Language API + x-goog-api-key.
   * "vertex" = Vertex AI project/location endpoints with GCP ADC (or x-goog-api-key).
   * "cloud-code-assist" = Google Antigravity (Cloud Code Assist) OAuth + CCA envelope.
   */
  googleMode?: "ai-studio" | "vertex" | "cloud-code-assist";
  /** Vertex AI GCP project id (or GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT env). */
  project?: string;
  /** Vertex AI location, e.g. "us-central1" or "global" (or GOOGLE_CLOUD_LOCATION env). */
  location?: string;
}

export interface CodexAccount {
  id: string;
  email: string;
  plan?: string;
  chatgptAccountId?: string;
  logLabel?: string;
  isMain: boolean;
}

export interface CodexAccountCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  chatgptAccountId: string;
}

export interface CodexAccountCredentialRecord {
  credential?: CodexAccountCredentials;
  generation: number;
  refreshGrantFingerprint?: string;
  deletedAt?: number;
  replacedAt?: number;
}
