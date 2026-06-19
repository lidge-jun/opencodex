import type { ProviderAdapter } from "./base";
import type { AdapterEvent, OcxAssistantMessage, OcxContentPart, OcxMessage, OcxParsedRequest, OcxProviderConfig, OcxTextContent, OcxToolCall } from "../types";
import { namespacedToolName } from "../types";
import { contentPartsToText } from "./image";

function messagesToChatFormat(parsed: OcxParsedRequest): unknown[] {
  const out: unknown[] = [];
  const { context, options } = parsed;

  if (context.systemPrompt && context.systemPrompt.length > 0) {
    // Codex sends its GPT-5 identity prompt for EVERY model (the per-model catalog
    // base_instructions is ignored at request time). Neutralize that one identity line
    // so routed, non-OpenAI models don't misreport themselves as GPT-5 / OpenAI.
    const sys = context.systemPrompt.join("\n\n").replace(
      "You are Codex, a coding agent based on GPT-5.",
      `You are a coding agent (underlying model: ${parsed.modelId}) running via the opencodex proxy. Do not claim to be GPT-5 or to be made by OpenAI.`,
    );
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
        break;
      }
      case "assistant": {
        const aMsg = msg as OcxAssistantMessage;
        const textParts = aMsg.content.filter(p => p.type === "text") as OcxTextContent[];
        const toolCalls = aMsg.content.filter(p => p.type === "toolCall") as OcxToolCall[];
        const chatMsg: Record<string, unknown> = { role: "assistant" };
        if (textParts.length > 0) {
          chatMsg.content = textParts.map(p => p.text).join("");
        }
        if (toolCalls.length > 0) {
          chatMsg.tool_calls = toolCalls.map(tc => ({
            id: tc.id,
            type: "function",
            function: { name: namespacedToolName(tc.namespace, tc.name), arguments: JSON.stringify(tc.arguments) },
          }));
          if (!chatMsg.content) chatMsg.content = null;
        }
        // Skip empty assistant messages (e.g. reasoning-only history items): chat APIs
        // like DeepSeek reject an assistant message with neither content nor tool_calls.
        if (chatMsg.content === undefined && chatMsg.tool_calls === undefined) break;
        out.push(chatMsg);
        break;
      }
      case "toolResult": {
        out.push({
          role: "tool",
          tool_call_id: msg.toolCallId,
          content: contentPartsToText(msg.content),
        });
        break;
      }
    }
  }

  return out;
}

function toolsToChatFormat(parsed: OcxParsedRequest): unknown[] | undefined {
  if (!parsed.context.tools || parsed.context.tools.length === 0) return undefined;
  return parsed.context.tools.map(t => ({
    type: "function",
    function: {
      name: namespacedToolName(t.namespace, t.name),
      description: t.description,
      parameters: t.parameters,
      ...(t.strict !== undefined ? { strict: t.strict } : {}),
    },
  }));
}

function toolChoiceToChatFormat(tc: OcxParsedRequest["options"]["toolChoice"]): unknown {
  if (!tc) return undefined;
  if (tc === "auto" || tc === "none" || tc === "required") return tc;
  if ("name" in tc) return { type: "function", function: { name: tc.name } };
  return undefined;
}

export function createOpenAIChatAdapter(provider: OcxProviderConfig): ProviderAdapter {
  return {
    name: "openai-chat",

    buildRequest(parsed: OcxParsedRequest) {
      const messages = messagesToChatFormat(parsed);
      const tools = toolsToChatFormat(parsed);
      const toolChoice = toolChoiceToChatFormat(parsed.options.toolChoice);

      const body: Record<string, unknown> = {
        model: parsed.modelId,
        messages,
        stream: parsed.stream,
      };
      if (tools) body.tools = tools;
      if (toolChoice !== undefined) body.tool_choice = toolChoice;
      if (parsed.options.maxOutputTokens !== undefined) body.max_tokens = parsed.options.maxOutputTokens;
      if (parsed.options.temperature !== undefined) body.temperature = parsed.options.temperature;
      if (parsed.options.topP !== undefined) body.top_p = parsed.options.topP;
      if (parsed.options.stopSequences !== undefined) body.stop = parsed.options.stopSequences;
      // Some models reject a reasoning/thinking param entirely (e.g. xAI grok-build-0.1,
      // grok-composer-2.5-fast). Drop reasoning_effort for them even if Codex selected an effort.
      if (parsed.options.reasoning !== undefined && !provider.noReasoningModels?.includes(parsed.modelId)) {
        // Forward the reasoning ladder (low/medium/high/xhigh) as-is. "minimal" (Codex-native lowest,
        // widely unsupported downstream) maps to "low"; "max" isn't a real tier (no longer advertised)
        // so it folds to "xhigh".
        const r = parsed.options.reasoning;
        body.reasoning_effort = r === "minimal" ? "low" : r === "max" ? "xhigh" : r;
      }
      if (parsed.options.presencePenalty !== undefined) body.presence_penalty = parsed.options.presencePenalty;
      if (parsed.options.frequencyPenalty !== undefined) body.frequency_penalty = parsed.options.frequencyPenalty;

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
      let pendingUsage: { inputTokens: number; outputTokens: number } | undefined;

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
              continue;
            }

            if (chunk.usage) {
              const u = chunk.usage as Record<string, number>;
              pendingUsage = {
                inputTokens: u.prompt_tokens ?? 0,
                outputTokens: u.completion_tokens ?? 0,
              };
              continue;
            }

            const choices = chunk.choices as { delta?: Record<string, unknown>; finish_reason?: string }[] | undefined;
            if (!choices || choices.length === 0) continue;
            const delta = choices[0].delta;
            if (!delta) continue;

            if (typeof delta.content === "string" && delta.content.length > 0) {
              yield { type: "text_delta", text: delta.content };
            }

            if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
              yield { type: "thinking_delta", thinking: delta.reasoning_content };
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
        yield { type: "done" };
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
      const usage = json.usage as Record<string, number> | undefined;
      events.push({
        type: "done",
        usage: usage ? { inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 } : undefined,
      });
      return events;
    },
  };
}
