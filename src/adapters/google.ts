import type { ProviderAdapter } from "./base";
import { debugDroppedFrame } from "../debug";
import type {
  AdapterEvent,
  OcxAssistantMessage,
  OcxContentPart,
  OcxParsedRequest,
  OcxProviderConfig,
  OcxTextContent,
  OcxToolCall,
  OcxUsage,
} from "../types";
import { isAllowedToolChoice, namespacedToolName, toolAllowedByChoice } from "../types";
import { contentPartsToText, parseDataUrl } from "./image";

/**
 * Inline image parts (Gemini `inline_data`) extracted from tool-result content. Only base64 data URLs
 * can be inlined; a remote URL has no mime type we can supply, so it is skipped here (the textual
 * result already carries an "[image]" marker via contentPartsToText).
 */
function toolResultImageParts(content: string | OcxContentPart[]): unknown[] {
  if (typeof content === "string") return [];
  const parts: unknown[] = [];
  for (const p of content) {
    if (p.type !== "image") continue;
    const data = parseDataUrl(p.imageUrl);
    if (data) parts.push({ inline_data: { mime_type: data.mediaType, data: data.base64 } });
  }
  return parts;
}

function messagesToGeminiFormat(parsed: OcxParsedRequest): { systemInstruction?: unknown; contents: unknown[] } {
  const systemInstruction = parsed.context.systemPrompt?.length
    ? { parts: [{ text: parsed.context.systemPrompt.join("\n\n") }] }
    : undefined;

  const contents: unknown[] = [];

  for (const msg of parsed.context.messages) {
    switch (msg.role) {
      case "user":
      case "developer": {
        if (typeof msg.content === "string") {
          contents.push({ role: "user", parts: [{ text: msg.content }] });
        } else {
          const parts = (msg.content as OcxContentPart[]).map(p => {
            if (p.type === "image") {
              const data = parseDataUrl(p.imageUrl);
              // Gemini takes base64 via inline_data; a remote URL needs a mime type we don't have, so
              // fall back to a short marker rather than inlining the URL as a huge text blob.
              return data ? { inline_data: { mime_type: data.mediaType, data: data.base64 } } : { text: `[image: ${p.imageUrl}]` };
            }
            return { text: p.text };
          });
          contents.push({ role: "user", parts });
        }
        break;
      }
      case "assistant": {
        const aMsg = msg as OcxAssistantMessage;
        const parts: unknown[] = [];
        for (const p of aMsg.content) {
          if (p.type === "text") parts.push({ text: (p as OcxTextContent).text });
          else if (p.type === "toolCall") {
            const tc = p as OcxToolCall;
            parts.push({ functionCall: { name: namespacedToolName(tc.namespace, tc.name), args: tc.arguments } });
          }
        }
        contents.push({ role: "model", parts });
        break;
      }
      case "toolResult": {
        // The functionResponse part carries the textual result. Gemini cannot embed images inside a
        // functionResponse, but it does accept sibling inline_data parts in the same user turn, so
        // tool-result screenshots (e.g. Computer Use) ride along as inline_data instead of being
        // flattened to a "[image]" marker the model can't actually see.
        const parts: unknown[] = [
          { functionResponse: { name: namespacedToolName(msg.toolNamespace, msg.toolName), response: { result: contentPartsToText(msg.content) } } },
        ];
        for (const part of toolResultImageParts(msg.content)) parts.push(part);
        contents.push({ role: "user", parts });
        break;
      }
    }
  }

  return { systemInstruction, contents };
}

function toolsToGeminiFormat(parsed: OcxParsedRequest): unknown[] | undefined {
  if (!parsed.context.tools?.length) return undefined;
  const allowed = isAllowedToolChoice(parsed.options.toolChoice)
    ? new Set(parsed.options.toolChoice.allowedTools)
    : undefined;
  const tools = allowed
    ? parsed.context.tools.filter(t => toolAllowedByChoice(t, allowed))
    : parsed.context.tools;
  if (tools.length === 0) return undefined;
  return [{
    functionDeclarations: tools.map(t => ({
      name: namespacedToolName(t.namespace, t.name),
      description: t.description,
      parameters: t.parameters,
    })),
  }];
}

function usageFromGemini(usage: Record<string, number> | undefined): OcxUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.promptTokenCount ?? 0,
    outputTokens: usage.candidatesTokenCount ?? 0,
    ...(usage.cachedContentTokenCount !== undefined ? { cachedInputTokens: usage.cachedContentTokenCount } : {}),
    ...(usage.thoughtsTokenCount !== undefined ? { reasoningOutputTokens: usage.thoughtsTokenCount } : {}),
  };
}

export function createGoogleAdapter(provider: OcxProviderConfig): ProviderAdapter {
  return {
    name: "google",

    buildRequest(parsed: OcxParsedRequest) {
      const { systemInstruction, contents } = messagesToGeminiFormat(parsed);
      const tools = toolsToGeminiFormat(parsed);

      const body: Record<string, unknown> = { contents };
      if (systemInstruction) body.systemInstruction = systemInstruction;
      if (tools) body.tools = tools;

      const generationConfig: Record<string, unknown> = {};
      if (parsed.options.maxOutputTokens) generationConfig.maxOutputTokens = parsed.options.maxOutputTokens;
      if (parsed.options.temperature !== undefined) generationConfig.temperature = parsed.options.temperature;
      if (parsed.options.topP !== undefined) generationConfig.topP = parsed.options.topP;
      if (parsed.options.stopSequences) generationConfig.stopSequences = parsed.options.stopSequences;
      if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

      const method = parsed.stream ? "streamGenerateContent" : "generateContent";
      const streamParam = parsed.stream ? "?alt=sse" : "";
      const url = `${provider.baseUrl}/v1beta/models/${parsed.modelId}:${method}${streamParam}`;

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (provider.apiKey) headers["x-goog-api-key"] = provider.apiKey;
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
            if (!payload) continue;

            let chunk: Record<string, unknown>;
            try { chunk = JSON.parse(payload); } catch { debugDroppedFrame("google", payload); continue; }

            // Inline provider error inside a 200 stream → terminal error (see openai-chat.ts).
            if (chunk.error) {
              const err = chunk.error as { message?: string } | undefined;
              yield { type: "error", message: err?.message ?? "upstream error" };
              return;
            }

            const candidates = chunk.candidates as { content?: { parts?: unknown[] }; finishReason?: string }[] | undefined;
            if (!candidates?.length) continue;

            const parts = candidates[0].content?.parts as { text?: string; functionCall?: { name: string; args: unknown } }[] | undefined;
            if (parts) {
              for (const part of parts) {
                if (part.text) {
                  yield { type: "text_delta", text: part.text };
                }
                if (part.functionCall) {
                  const id = `call_${crypto.randomUUID().slice(0, 8)}`;
                  yield { type: "tool_call_start", id, name: part.functionCall.name };
                  yield { type: "tool_call_delta", arguments: JSON.stringify(part.functionCall.args ?? {}) };
                  yield { type: "tool_call_end" };
                }
              }
            }

            const usageMeta = chunk.usageMetadata as Record<string, number> | undefined;
            if (usageMeta) {
              // Accumulate usage; emit a single terminal `done` post-loop so usage is never
              // dropped on EOF and the stream never yields two `done` events.
              pendingUsage = usageFromGemini(usageMeta);
            }
          }
        }
        yield { type: "done", usage: pendingUsage };
      } finally {
        reader.releaseLock();
      }
    },

    async parseResponse(response: Response): Promise<AdapterEvent[]> {
      const json = await response.json() as Record<string, unknown>;
      const events: AdapterEvent[] = [];

      const candidates = json.candidates as { content?: { parts?: { text?: string; functionCall?: { name: string; args: unknown } }[] } }[] | undefined;
      if (candidates?.[0]?.content?.parts) {
        for (const part of candidates[0].content.parts) {
          if (part.text) events.push({ type: "text_delta", text: part.text });
          if (part.functionCall) {
            const id = `call_${crypto.randomUUID().slice(0, 8)}`;
            events.push({ type: "tool_call_start", id, name: part.functionCall.name });
            events.push({ type: "tool_call_delta", arguments: JSON.stringify(part.functionCall.args ?? {}) });
            events.push({ type: "tool_call_end" });
          }
        }
      }

      const usage = json.usageMetadata as Record<string, number> | undefined;
      events.push({
        type: "done",
        usage: usageFromGemini(usage),
      });
      return events;
    },
  };
}
