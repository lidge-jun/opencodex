import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import type { AdapterEvent, OcxContentPart, OcxMessage, OcxParsedRequest, OcxProviderConfig, OcxTool, OcxUsage } from "../types";
import { namespacedToolName } from "../types";
import type { AdapterRequest, ProviderAdapter } from "./base";
import type { TranslatorBudget } from "../lib/translator-budget";

const COMMAND_CODE_MODEL_IDS: Record<string, string> = {
  "deepseek-v4-flash": "deepseek/deepseek-v4-flash",
  "kimi-k3": "moonshotai/Kimi-K3",
  "glm-5.2": "zai-org/GLM-5.2",
};

function textContent(content: string | OcxContentPart[]): string {
  return typeof content === "string" ? content : content.filter(part => part.type === "text").map(part => part.text).join("");
}

function wireMessages(messages: OcxMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      const content: Array<Record<string, unknown>> = [];
      for (const part of message.content) {
        if (part.type === "text") content.push({ type: "text", text: part.text });
        else if (part.type === "thinking") content.push({ type: "reasoning", text: part.thinking });
        else content.push({ type: "tool-call", toolCallId: part.id, toolName: namespacedToolName(part.namespace, part.name), input: part.arguments });
      }
      out.push({ role: "assistant", content });
      continue;
    }
    if (message.role === "toolResult") {
      out.push({ role: "tool", content: [{
        type: "tool-result",
        toolCallId: message.toolCallId,
        toolName: namespacedToolName(message.toolNamespace, message.toolName),
        output: { type: message.isError ? "error-text" : "text", value: textContent(message.content) },
      }] });
      continue;
    }
    const content: Array<Record<string, unknown>> = [];
    if (typeof message.content === "string") content.push({ type: "text", text: message.content });
    else for (const part of message.content) {
      if (part.type === "text") content.push({ type: "text", text: part.text });
      else content.push({ type: "image", image: part.imageUrl });
    }
    out.push({ role: "user", content });
  }
  return out;
}

function wireTools(tools: OcxTool[] | undefined): Array<Record<string, unknown>> {
  return (tools ?? []).map(tool => ({
    name: namespacedToolName(tool.namespace, tool.name),
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

function commandCodeConfig(): Record<string, unknown> {
  let structure: string[] = [];
  try { structure = readdirSync(process.cwd()).filter(name => !name.startsWith(".")); } catch { /* cwd may disappear */ }
  return {
    workingDir: process.cwd(),
    date: new Date().toISOString().slice(0, 10),
    environment: process.platform,
    structure,
    isGitRepo: false,
    currentBranch: "",
    mainBranch: "",
    gitStatus: "",
    recentCommits: [],
  };
}

function usage(value: unknown): OcxUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const inputTokens = typeof row.inputTokens === "number" ? row.inputTokens : 0;
  const outputTokens = typeof row.outputTokens === "number" ? row.outputTokens : 0;
  const details = row.inputTokenDetails && typeof row.inputTokenDetails === "object" && !Array.isArray(row.inputTokenDetails)
    ? row.inputTokenDetails as Record<string, unknown> : {};
  const cachedInputTokens = typeof details.cacheReadTokens === "number" ? details.cacheReadTokens : undefined;
  const cacheCreationInputTokens = typeof details.cacheWriteTokens === "number" ? details.cacheWriteTokens : undefined;
  return {
    inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens, cacheReadInputTokens: cachedInputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
  };
}

function eventError(value: unknown): string {
  if (typeof value === "string" && value) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const message = (value as Record<string, unknown>).message;
    if (typeof message === "string" && message) return message;
  }
  return "Command Code stream error";
}

async function*ndjson(response: Response): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) throw new Error("Command Code response body missing");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
      if (line) { try { yield JSON.parse(line) as Record<string, unknown>; } catch { /* ignore non-events */ } }
      newline = buffer.indexOf("\n");
    }
    if (done) break;
  }
  const final = buffer.trim();
  if (final) { try { yield JSON.parse(final) as Record<string, unknown>; } catch { /* ignore */ } }
}

export function createCommandCodeAdapter(provider: OcxProviderConfig): ProviderAdapter {
  return {
    name: "command-code",
    buildRequest(parsed: OcxParsedRequest): AdapterRequest {
      if (!provider.apiKey) throw new Error("Command Code credential missing — run ocx login command-code");
      const system = parsed.context.systemPrompt?.join("\n\n") ?? "";
      const body = {
        config: commandCodeConfig(), memory: null, taste: null, skills: null,
        permissionMode: "standard", mode: "agent",
        params: {
          model: COMMAND_CODE_MODEL_IDS[parsed.modelId] ?? parsed.modelId,
          messages: wireMessages(parsed.context.messages),
          tools: wireTools(parsed.context.tools),
          system,
          max_tokens: parsed.options.maxOutputTokens ?? provider.defaultMaxOutputTokens ?? 64_000,
          stream: true,
          ...(parsed.options.temperature !== undefined ? { temperature: parsed.options.temperature } : {}),
          ...(parsed.options.reasoning && parsed.options.reasoning !== "none" ? { reasoning_effort: parsed.options.reasoning } : {}),
        },
      };
      return {
        url: `${provider.baseUrl.replace(/\/$/, "")}/alpha/generate`, method: "POST",
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": "cli",
          "x-command-code-version": "1.12.0",
          "x-cli-environment": "production",
          "x-project-slug": process.cwd().replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase(),
          "x-taste-learning": "false",
          "x-co-flag": "false",
          "x-session-id": randomUUID(),
        },
        body: JSON.stringify(body),
      };
    },
    async *parseStream(response: Response, _budget: TranslatorBudget): AsyncGenerator<AdapterEvent> {
      for await (const event of ndjson(response)) {
        switch (event.type) {
          case "text-delta": if (typeof event.text === "string") yield { type: "text_delta", text: event.text }; break;
          case "reasoning-delta": if (typeof event.text === "string") yield { type: "thinking_delta", thinking: event.text }; break;
          case "tool-call": {
            const id = typeof event.toolCallId === "string" ? event.toolCallId : randomUUID();
            const name = typeof event.toolName === "string" ? event.toolName : "tool";
            const input = event.input ?? event.args ?? {};
            yield { type: "tool_call_start", id, name };
            yield { type: "tool_call_delta", arguments: typeof input === "string" ? input : JSON.stringify(input) };
            yield { type: "tool_call_end" };
            break;
          }
          case "finish": yield { type: "done", usage: usage(event.totalUsage), stopReason: typeof event.rawFinishReason === "string" ? event.rawFinishReason : undefined }; break;
          case "error": yield { type: "error", message: eventError(event.error), status: 502 }; break;
        }
      }
    },
    async parseResponse(response: Response, budget: TranslatorBudget): Promise<AdapterEvent[]> {
      const events: AdapterEvent[] = [];
      for await (const event of this.parseStream(response, budget)) events.push(event);
      return events;
    },
  };
}
