/**
 * Devin / Cognition / Windsurf adapter.
 *
 * Uses the unofficial cloud-direct Connect-RPC client (GetChatMessage) from
 * pi-devin-auth. OpenCodex injects the OAuth API key onto provider.apiKey
 * before runTurn. This adapter maps OcxContext <-> ChatHistoryItem and
 * streams CloudChatEvent into AdapterEvent.
 */
import type { AdapterEvent, OcxAssistantMessage, OcxContentPart, OcxMessage, OcxParsedRequest, OcxProviderConfig, OcxTool, OcxToolCall, OcxToolResultMessage, OcxUsage } from "../types";
import type { IncomingMeta, ProviderAdapter } from "./base";
import { streamChatEvents, allocateCascadeId, CloudChatError, type ChatHistoryItem, type ToolDef } from "./devin/cloud-direct";
import { DEVIN_DEFAULT_API_SERVER } from "../oauth/devin";

export const DEVIN_API_SERVER = DEVIN_DEFAULT_API_SERVER;

export class DevinMissingCredentialError extends Error {
  constructor() {
    super("Devin live transport requires a Devin API key. Run ocx login devin (imports ~/.pi/agent/auth.json by default).");
    this.name = "DevinMissingCredentialError";
  }
}

export function resolveDevinToken(provider: OcxProviderConfig, headers?: Headers): string {
  const providerKey = provider.apiKey?.trim();
  if (providerKey) return providerKey;
  const forwarded = headers?.get("authorization") ?? headers?.get("Authorization");
  if (forwarded?.toLowerCase().startsWith("bearer ")) return forwarded.slice("bearer ".length).trim();
  const envToken = process.env.OPENCODEX_DEVIN_TEST_TOKEN?.trim();
  if (envToken) return envToken;
  throw new DevinMissingCredentialError();
}

function textFromParts(content: string | OcxContentPart[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part.type === "text" ? part.text : "")).filter(Boolean).join("\n");
}

function toolResultText(message: OcxToolResultMessage): string {
  const body = textFromParts(message.content);
  return message.isError ? ("ERROR: " + body) : body;
}

function assistantToolCalls(message: OcxAssistantMessage): Array<{ id: string; name: string; arguments: string }> {
  return message.content
    .filter((part): part is OcxToolCall => part.type === "toolCall")
    .map((part) => ({
      id: part.id,
      name: part.name,
      arguments: JSON.stringify(part.arguments ?? {}),
    }));
}

function assistantText(message: OcxAssistantMessage): string {
  return message.content
    .map((part) => (part.type === "text" ? part.text : part.type === "thinking" ? part.thinking : ""))
    .filter(Boolean)
    .join("\n");
}

export function mapOcxMessagesToDevin(parsed: OcxParsedRequest): ChatHistoryItem[] {
  const items: ChatHistoryItem[] = [];
  const system = parsed.context.systemPrompt?.filter((line) => line.trim().length > 0).join("\n");
  if (system) items.push({ role: "system", content: system });

  for (const message of parsed.context.messages) {
    const mapped = mapOneMessage(message);
    if (mapped) items.push(mapped);
  }
  return items;
}

function mapOneMessage(message: OcxMessage): ChatHistoryItem | undefined {
  if (message.role === "user" || message.role === "developer") {
    const text = textFromParts(message.content).trim();
    if (!text) return undefined;
    return { role: message.role === "developer" ? "system" : "user", content: text };
  }
  if (message.role === "assistant") {
    const toolCalls = assistantToolCalls(message);
    const text = assistantText(message);
    if (!text && toolCalls.length === 0) return undefined;
    return {
      role: "assistant",
      content: text || "",
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
  }
  if (message.role === "toolResult") {
    return {
      role: "tool",
      content: toolResultText(message),
      tool_call_id: message.toolCallId,
    };
  }
  return undefined;
}

export function mapOcxToolsToDevin(tools: OcxTool[] | undefined): ToolDef[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    parameters: tool.parameters ?? { type: "object", properties: {} },
  }));
}

export function createDevinAdapter(provider: OcxProviderConfig): ProviderAdapter {
  const cascadeIds = new Map<string, string>();

  return {
    name: "devin",

    buildRequest() {
      return {
        url: provider.baseUrl || DEVIN_API_SERVER,
        method: "POST",
        headers: {},
        body: "",
      };
    },

    async *parseStream(): AsyncGenerator<AdapterEvent> {
      yield {
        type: "error",
        message: "Devin adapter uses runTurn; the fetch/parseStream path is disabled.",
      };
    },

    async runTurn(parsed: OcxParsedRequest, incoming: IncomingMeta, emit: (event: AdapterEvent) => void) {
      if (incoming.abortSignal?.aborted) {
        emit({ type: "error", message: "Devin turn was aborted before start." });
        return;
      }
      let apiKey: string;
      try {
        apiKey = resolveDevinToken(provider, incoming.headers);
      } catch (error) {
        emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
        return;
      }

      const threadKey = parsed._clientThreadId || parsed.previousResponseId || "default";
      let cascadeId = cascadeIds.get(threadKey);
      if (!cascadeId) {
        cascadeId = allocateCascadeId();
        cascadeIds.set(threadKey, cascadeId);
      }

      const modelUid = parsed.modelId.includes("/") ? parsed.modelId.slice(parsed.modelId.lastIndexOf("/") + 1) : parsed.modelId;
      let openToolId: string | undefined;
      let usage: OcxUsage | undefined;
      let stopReason: string | undefined;

      const closeOpenTool = () => {
        if (!openToolId) return;
        emit({ type: "tool_call_end" });
        openToolId = undefined;
      };

      try {
        for await (const event of streamChatEvents({
          apiKey,
          apiServerUrl: provider.baseUrl || DEVIN_API_SERVER,
          modelUid,
          messages: mapOcxMessagesToDevin(parsed),
          tools: mapOcxToolsToDevin(parsed.context.tools),
          cascadeId,
          signal: incoming.abortSignal,
        })) {
          if (incoming.abortSignal?.aborted) break;
          if (event.kind === "text") {
            closeOpenTool();
            if (event.text) emit({ type: "text_delta", text: event.text });
            continue;
          }
          if (event.kind === "reasoning") {
            if (event.text) emit({ type: "thinking_delta", thinking: event.text });
            continue;
          }
          if (event.kind === "tool_call_start") {
            closeOpenTool();
            openToolId = event.id;
            emit({ type: "tool_call_start", id: event.id, name: event.name });
            continue;
          }
          if (event.kind === "tool_call_args") {
            if (event.argsDelta) emit({ type: "tool_call_delta", arguments: event.argsDelta });
            continue;
          }
          if (event.kind === "finish") {
            closeOpenTool();
            stopReason = event.reason === "length" ? "max_tokens" : event.reason;
            continue;
          }
          if (event.kind === "usage") {
            const total = event.totalTokens ?? ((event.promptTokens ?? 0) + (event.completionTokens ?? 0));
            usage = {
              inputTokens: event.promptTokens ?? 0,
              outputTokens: event.completionTokens ?? 0,
              ...(total > 0 ? { totalTokens: total } : {}),
              ...(event.cachedInputTokens !== undefined ? { cachedInputTokens: event.cachedInputTokens } : {}),
              ...(event.cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens: event.cacheCreationInputTokens } : {}),
              ...(event.reasoningTokens !== undefined ? { reasoningOutputTokens: event.reasoningTokens } : {}),
            };
            continue;
          }
        }
        closeOpenTool();
        if (!incoming.abortSignal?.aborted) {
          emit({ type: "done", ...(usage ? { usage } : {}), ...(stopReason ? { stopReason } : {}) });
        }
      } catch (error) {
        closeOpenTool();
        const message = error instanceof CloudChatError
          ? ("Devin cloud error" + (error.code ? " " + error.code : "") + ": " + error.message)
          : error instanceof Error ? error.message : String(error);
        emit({ type: "error", message });
      }
    },
  };
}

