import type { ProviderAdapter } from "./base";
import { debugDroppedFrame } from "../debug";
import type { AdapterEvent, OcxAssistantMessage, OcxContentPart, OcxMessage, OcxParsedRequest, OcxProviderConfig, OcxTextContent, OcxThinkingContent, OcxToolCall, OcxUsage } from "../types";
import { isAllowedToolChoice, modelInList, namespacedToolName, resolveToolChoiceWireName, toolAllowedByChoice } from "../types";
import { mapReasoningEffort } from "../reasoning-effort";
import { contentPartsToText } from "./image";
import { neutralizeIdentity } from "./identity";

// Z.AI's "glm-5.2[1m]" 1M-context id is a Claude-Code / Anthropic-endpoint-only
// convention; OpenAI-compatible chat-completions endpoints reject the bracketed
// suffix (Z.AI 400 code 1211 "Unknown Model"). Strip a single trailing "[...]"
// group from the wire model id so the bare id is sent. Applies to the
// openai-chat path only — the anthropic adapter keeps the suffix verbatim.
export function stripBracketedModelSuffix(modelId: string): string {
  return modelId.replace(/\[[^\]]*\]\s*$/, "");
}

function messagesToChatFormat(parsed: OcxParsedRequest, provider: OcxProviderConfig): unknown[] {
  const out: unknown[] = [];
  const { context, options } = parsed;
  let pendingToolCallIds = new Set<string>();

  if (context.systemPrompt && context.systemPrompt.length > 0) {
    // Codex sends its GPT-5 identity prompt for EVERY model (the per-model catalog
    // base_instructions is ignored at request time). Neutralize that one identity line
    // so routed, non-OpenAI models don't misreport themselves as GPT-5 / OpenAI — without
    // leaking the proxy identity into the payload.
    const sys = neutralizeIdentity(context.systemPrompt.join("\n\n"));
    out.push({ role: "system", content: sys });
  }

  for (const msg of context.messages) {
    switch (msg.role) {
      case "user":
      case "developer": {
        const role = msg.role === "developer" ? "system" : "user";
        if (typeof msg.content === "string") {
          out.push({ role, content: msg.content });
        } else {
          const parts = msg.content as OcxContentPart[];
          if (!parts.some(p => p.type === "image")) {
            out.push({ role, content: parts.map(p => (p as OcxTextContent).text).join("") });
          } else {
            // Vision: chat-completions content-parts array. Images are only valid on the user role,
            // and the data URL goes straight into image_url.url (never the token-exploding text path).
            const chatParts = parts.map(p => p.type === "image"
              ? { type: "image_url", image_url: { url: p.imageUrl, ...(p.detail ? { detail: p.detail } : {}) } }
              : { type: "text", text: (p as OcxTextContent).text });
            out.push({ role: "user", content: chatParts });
          }
        }
        pendingToolCallIds = new Set();
        break;
      }
      case "assistant": {
        const aMsg = msg as OcxAssistantMessage;
        const textParts = aMsg.content.filter(p => p.type === "text") as OcxTextContent[];
        const thinkingParts = aMsg.content.filter(p => p.type === "thinking") as OcxThinkingContent[];
        const toolCalls = aMsg.content.filter(p => p.type === "toolCall") as OcxToolCall[];
        const chatMsg: Record<string, unknown> = { role: "assistant" };
        if (textParts.length > 0) {
          chatMsg.content = textParts.map(p => p.text).join("");
        }
        const reasoningContent = thinkingParts.map(p => p.thinking).join("");
        if (reasoningContent.length > 0 && modelInList(provider.preserveReasoningContentModels, parsed.modelId)) {
          chatMsg.reasoning_content = reasoningContent;
        }
        if (toolCalls.length > 0) {
          chatMsg.tool_calls = toolCalls.map(tc => ({
            id: tc.id,
            type: "function",
            function: { name: namespacedToolName(tc.namespace, tc.name), arguments: JSON.stringify(tc.arguments) },
          }));
          if (!chatMsg.content) chatMsg.content = null;
        }
        if (chatMsg.reasoning_content !== undefined && chatMsg.content === undefined && chatMsg.tool_calls === undefined) {
          chatMsg.content = "";
        }
        // Skip empty assistant messages: chat APIs like DeepSeek reject an assistant message
        // with neither content, tool calls, nor a provider-supported reasoning_content field.
        if (chatMsg.content === undefined && chatMsg.tool_calls === undefined && chatMsg.reasoning_content === undefined) break;
        out.push(chatMsg);
        pendingToolCallIds = new Set(toolCalls.map(tc => tc.id).filter(Boolean));
        break;
      }
      case "toolResult": {
        let toolCallId = msg.toolCallId;
        if (!toolCallId) toolCallId = `call_orphan_${out.length}`;
        if (!pendingToolCallIds.has(toolCallId)) {
          // WS turns can arrive with only tool outputs; chat-completions providers reject a bare
          // role:"tool" message unless an assistant tool_call with the same id immediately precedes it.
          const name = safeToolName(msg.toolName);
          out.push({
            role: "assistant",
            content: null,
            tool_calls: [{
              id: toolCallId,
              type: "function",
              function: { name, arguments: "{}" },
            }],
          });
          pendingToolCallIds = new Set([toolCallId]);
        }
        out.push({
          role: "tool",
          tool_call_id: toolCallId,
          content: contentPartsToText(msg.content),
        });
        pendingToolCallIds.delete(toolCallId);
        break;
      }
    }
  }

  return out;
}

function safeToolName(name: string | undefined): string {
  const raw = name && name.trim().length > 0 ? name : "tool_result";
  const sanitized = raw.replace(/[^A-Za-z0-9_-]/g, "_");
  return sanitized.length > 0 ? sanitized : "tool_result";
}

function toolsToChatFormat(parsed: OcxParsedRequest): unknown[] | undefined {
  if (!parsed.context.tools || parsed.context.tools.length === 0) return undefined;
  const allowed = isAllowedToolChoice(parsed.options.toolChoice)
    ? new Set(parsed.options.toolChoice.allowedTools)
    : undefined;
  const tools = allowed
    ? parsed.context.tools.filter(t => toolAllowedByChoice(t, allowed))
    : parsed.context.tools;
  if (tools.length === 0) return undefined;
  return tools.map(t => ({
    type: "function",
    function: {
      name: namespacedToolName(t.namespace, t.name),
      description: t.description,
      parameters: t.parameters,
      ...(t.strict !== undefined ? { strict: t.strict } : {}),
    },
  }));
}

function toolChoiceToChatFormat(tc: OcxParsedRequest["options"]["toolChoice"], tools: OcxParsedRequest["context"]["tools"]): unknown {
  if (!tc) return undefined;
  if (isAllowedToolChoice(tc)) return tc.mode === "required" ? "required" : "auto";
  if (tc === "auto" || tc === "none" || tc === "required") return tc;
  if ("name" in tc) return { type: "function", function: { name: resolveToolChoiceWireName(tools, tc.name) } };
  return undefined;
}

function usageFromOpenAIChat(usage: Record<string, unknown> | undefined): OcxUsage | undefined {
  if (!usage) return undefined;
  const promptDetails = usage.prompt_tokens_details as Record<string, number> | undefined;
  const completionDetails = usage.completion_tokens_details as Record<string, number> | undefined;
  return {
    inputTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
    outputTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
    ...(promptDetails?.cached_tokens !== undefined ? { cachedInputTokens: promptDetails.cached_tokens } : {}),
    ...(completionDetails?.reasoning_tokens !== undefined ? { reasoningOutputTokens: completionDetails.reasoning_tokens } : {}),
  };
}

export function createOpenAIChatAdapter(provider: OcxProviderConfig): ProviderAdapter {
  return {
    name: "openai-chat",

    buildRequest(parsed: OcxParsedRequest) {
      const messages = messagesToChatFormat(parsed, provider);
      const tools = toolsToChatFormat(parsed);
      const toolChoice = toolChoiceToChatFormat(parsed.options.toolChoice, parsed.context.tools);

      const body: Record<string, unknown> = {
        model: stripBracketedModelSuffix(parsed.modelId),
        messages,
        stream: parsed.stream,
      };
      if (tools) body.tools = tools;
      if (tools && toolChoice !== undefined) {
        body.tool_choice = modelInList(provider.autoToolChoiceOnlyModels, parsed.modelId)
          ? (toolChoice === "none" ? "none" : "auto")
          : toolChoice;
      }
      if (parsed.options.maxOutputTokens !== undefined) body.max_tokens = parsed.options.maxOutputTokens;
      if (parsed.options.temperature !== undefined && !modelInList(provider.noTemperatureModels, parsed.modelId)) {
        body.temperature = parsed.options.temperature;
      }
      if (parsed.options.topP !== undefined && !modelInList(provider.noTopPModels, parsed.modelId)) {
        body.top_p = parsed.options.topP;
      }
      if (parsed.options.stopSequences !== undefined) body.stop = parsed.options.stopSequences;
      const reasoningEffort = mapReasoningEffort(provider, parsed.modelId, parsed.options.reasoning);
      if (reasoningEffort !== undefined) body.reasoning_effort = reasoningEffort;
      if (parsed.options.presencePenalty !== undefined && !modelInList(provider.noPenaltyModels, parsed.modelId)) {
        body.presence_penalty = parsed.options.presencePenalty;
      }
      if (parsed.options.frequencyPenalty !== undefined && !modelInList(provider.noPenaltyModels, parsed.modelId)) {
        body.frequency_penalty = parsed.options.frequencyPenalty;
      }

      if (tools) body.parallel_tool_calls = false;
      if (parsed.stream) {
        body.stream_options = { include_usage: true };
      }

      const url = `${provider.baseUrl}/chat/completions`;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (provider.apiKey) headers["Authorization"] = `Bearer ${provider.apiKey}`;
      if (provider.headers) Object.assign(headers, provider.headers);

      return { url, method: "POST", headers, body: JSON.stringify(body) };
    },

    async *parseStream(response: Response): AsyncGenerator<AdapterEvent> {
      if (!response.body) {
        yield { type: "error", message: "No response body" };
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentToolCallId = "";
      let currentToolCallName = "";
      let pendingUsage: OcxUsage | undefined;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6).trim();
            if (payload === "[DONE]") {
              if (currentToolCallId) {
                yield { type: "tool_call_end" };
                currentToolCallId = "";
              }
              yield { type: "done", usage: pendingUsage };
              return;
            }

            let chunk: Record<string, unknown>;
            try {
              chunk = JSON.parse(payload) as Record<string, unknown>;
            } catch {
              debugDroppedFrame("openai-chat", payload);
              continue;
            }

            // A 200/OK chat-completions stream may carry an inline provider error envelope
            // instead of a clean [DONE]. Surface it as a terminal error so the bridge emits a
            // classified response.failed (bridge case "error") — never a truncated completion.
            if (chunk.error) {
              const err = chunk.error as { message?: string } | undefined;
              if (currentToolCallId) yield { type: "tool_call_end" };
              yield { type: "error", message: err?.message ?? "upstream error" };
              return;
            }

            if (chunk.usage) {
              // Record usage but keep parsing: some providers send usage and the final content
              // delta in the SAME chunk; a `continue` here would drop that content. The choices
              // guard below no-ops a usage-only chunk.
              pendingUsage = usageFromOpenAIChat(chunk.usage as Record<string, unknown>);
            }

            const choices = chunk.choices as { delta?: Record<string, unknown>; finish_reason?: string }[] | undefined;
            if (!choices || choices.length === 0) continue;
            const delta = choices[0].delta;
            if (!delta) continue;

            if (typeof delta.content === "string" && delta.content.length > 0) {
              yield { type: "text_delta", text: delta.content };
            }

            if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
              yield { type: "reasoning_raw_delta", text: delta.reasoning_content };
            }

            const toolCalls = delta.tool_calls as { index: number; id?: string; function?: { name?: string; arguments?: string } }[] | undefined;
            if (toolCalls) {
              for (const tc of toolCalls) {
                if (tc.id && tc.id !== currentToolCallId) {
                  if (currentToolCallId) yield { type: "tool_call_end" };
                  currentToolCallId = tc.id;
                  currentToolCallName = tc.function?.name ?? "";
                  yield { type: "tool_call_start", id: tc.id, name: currentToolCallName };
                }
                if (tc.function?.arguments) {
                  yield { type: "tool_call_delta", arguments: tc.function.arguments };
                }
              }
            }

            if (choices[0].finish_reason === "tool_calls" && currentToolCallId) {
              yield { type: "tool_call_end" };
              currentToolCallId = "";
            }
          }
        }

        if (currentToolCallId) {
          yield { type: "tool_call_end" };
        }
        // EOF without a [DONE] sentinel: still surface any usage accumulated mid-stream.
        yield { type: "done", usage: pendingUsage };
      } finally {
        reader.releaseLock();
      }
    },

    async parseResponse(response: Response): Promise<AdapterEvent[]> {
      const json = await response.json() as Record<string, unknown>;
      const events: AdapterEvent[] = [];
      const choices = json.choices as { message?: Record<string, unknown> }[] | undefined;
      if (choices && choices.length > 0) {
        const msg = choices[0].message;
        if (msg) {
          if (typeof msg.content === "string") {
            events.push({ type: "text_delta", text: msg.content });
          }
          if (typeof msg.reasoning_content === "string" && msg.reasoning_content.length > 0) {
            events.push({ type: "reasoning_raw_delta", text: msg.reasoning_content });
          }
          const toolCalls = msg.tool_calls as { id: string; function: { name: string; arguments: string } }[] | undefined;
          if (toolCalls) {
            for (const tc of toolCalls) {
              events.push({ type: "tool_call_start", id: tc.id, name: tc.function.name });
              events.push({ type: "tool_call_delta", arguments: tc.function.arguments });
              events.push({ type: "tool_call_end" });
            }
          }
        }
      }
      const usage = json.usage as Record<string, unknown> | undefined;
      events.push({
        type: "done",
        usage: usageFromOpenAIChat(usage),
      });
      return events;
    },
  };
}
