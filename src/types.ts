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
}

export type OcxAssistantContentPart = OcxTextContent | OcxThinkingContent | OcxToolCall;

export interface OcxTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
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
   * "forward": relay the caller's incoming auth headers verbatim (OAuth passthrough).
   * Only the openai-responses adapter implements "forward"; openai-chat always uses its own key.
   */
  authMode?: "key" | "forward";
}
