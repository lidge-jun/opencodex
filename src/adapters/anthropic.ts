import type { ProviderAdapter } from "./base";
import { debugDroppedFrame } from "../debug";
import type {
  AdapterEvent,
  OcxAssistantMessage,
  OcxContentPart,
  OcxMessage,
  OcxParsedRequest,
  OcxProviderConfig,
  OcxTextContent,
  OcxThinkingContent,
  OcxToolCall,
  OcxToolResultMessage,
  OcxUsage,
} from "../types";
import { isAllowedToolChoice, namespacedToolName, resolveToolChoiceWireName, toolAllowedByChoice } from "../types";
import { ANTHROPIC_OAUTH_BETA, CLAUDE_CODE_SYSTEM_INSTRUCTION, applyClaudeToolPrefix, stripClaudeToolPrefix } from "../oauth/anthropic";
import { parseDataUrl } from "./image";
import { neutralizeIdentity } from "./identity";
import { CLAUDE_CODE_HEADERS, claudeCodeSessionId } from "./client-fingerprint";

/** Map a user content part to an Anthropic content block (text or image source). */
function toAnthropicContentPart(p: OcxContentPart): unknown {
  if (p.type === "image") {
    const data = parseDataUrl(p.imageUrl);
    return data
      ? { type: "image", source: { type: "base64", media_type: data.mediaType, data: data.base64 } }
      : { type: "image", source: { type: "url", url: p.imageUrl } };
  }
  return { type: "text", text: p.text };
}

/** Default `max_tokens` when Codex omits `max_output_tokens`. */
const DEFAULT_MAX_TOKENS = 8192;
/** Safe ceiling for `max_tokens` (thinking + visible output) across current Claude 4.x models. */
const REASONING_MAX_TOKENS_CEILING = 32_000;
/** Anthropic's documented minimum `thinking.budget_tokens`. */
const MIN_THINKING_BUDGET = 1024;
/** Visible-output room added above the thinking budget when sizing `max_tokens`. */
const OUTPUT_HEADROOM = 8192;
/** Minimum visible-output room kept below `max_tokens` (so `max_tokens > budget_tokens` always holds). */
const OUTPUT_FLOOR = 4096;
const COMPAT_TOOL_PREFIX = "ocx_";

/** Map a Responses reasoning effort to an Anthropic extended-thinking budget (tokens, >= 1024). */
function reasoningBudget(effort: string): number {
  switch (effort) {
    case "minimal": return 1024;
    case "low": return 4096;
    case "high": return 16384;
    case "xhigh": return 24576;
    case "max": return 32000;
    case "medium":
    default: return 8192;
  }
}

function usageFromAnthropic(usage: Record<string, number> | undefined): OcxUsage | undefined {
  if (!usage) return undefined;
  const hasCache = usage.cache_read_input_tokens !== undefined || usage.cache_creation_input_tokens !== undefined;
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    ...(hasCache ? { cachedInputTokens: (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) } : {}),
  };
}

function mergeAnthropicUsage(
  base: Record<string, number> | undefined,
  next: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (!next) return base;
  if (!base) return { ...next };
  const merged = { ...base };
  for (const [k, v] of Object.entries(next)) {
    merged[k] = (merged[k] ?? 0) + v;
  }
  return merged;
}

function buildToolNameTransforms(provider: OcxProviderConfig): { toWire: (name: string) => string; fromWire: (name: string) => string } {
  if (provider.authMode === "oauth") {
    return { toWire: applyClaudeToolPrefix, fromWire: stripClaudeToolPrefix };
  }
  if (provider.escapeBuiltinToolNames === true) {
    return {
      toWire: (name) => name.startsWith(COMPAT_TOOL_PREFIX) ? name : COMPAT_TOOL_PREFIX + name,
      fromWire: (name) => name.startsWith(COMPAT_TOOL_PREFIX) ? name.slice(COMPAT_TOOL_PREFIX.length) : name,
    };
  }
  return { toWire: (name) => name, fromWire: (name) => name };
}

function toAnthropicToolResult(msg: OcxToolResultMessage): Record<string, unknown> {
  // Anthropic tool_result accepts a string OR content blocks — render images natively
  // (e.g. Codex view_image output) instead of dropping them.
  const content = typeof msg.content === "string"
    ? msg.content
    : (msg.content as OcxContentPart[]).map(toAnthropicContentPart);
  return {
    type: "tool_result",
    tool_use_id: msg.toolCallId,
    content,
    ...(msg.isError ? { is_error: true } : {}),
  };
}

function orphanToolResultText(msg: OcxToolResultMessage): string {
  const label = msg.toolName ? `${msg.toolName} (${msg.toolCallId})` : msg.toolCallId;
  const content = typeof msg.content === "string"
    ? msg.content
    : JSON.stringify(msg.content);
  return `[tool_result without adjacent tool_use: ${label}]\n${content}`;
}

function messagesToAnthropicFormat(
  parsed: OcxParsedRequest,
  toolNames: { toWire: (name: string) => string },
): { system: string | undefined; messages: unknown[] } {
  const system = parsed.context.systemPrompt?.length
    ? neutralizeIdentity(parsed.context.systemPrompt.join("\n\n")) || undefined
    : undefined;
  const messages: unknown[] = [];

  for (let i = 0; i < parsed.context.messages.length; i++) {
    const msg = parsed.context.messages[i];
    switch (msg.role) {
      case "user":
      case "developer": {
        const content = typeof msg.content === "string"
          ? msg.content
          : (msg.content as OcxContentPart[]).map(toAnthropicContentPart);
        messages.push({ role: "user", content });
        break;
      }
      case "assistant": {
        const aMsg = msg as OcxAssistantMessage;
        const content: unknown[] = [];
        const toolUseIds: string[] = [];
        for (const part of aMsg.content) {
          if (part.type === "text") {
            content.push({ type: "text", text: (part as OcxTextContent).text });
          } else if (part.type === "thinking") {
            const t = part as OcxThinkingContent;
            content.push({ type: "thinking", thinking: t.thinking, ...(t.signature ? { signature: t.signature } : {}) });
          } else if (part.type === "toolCall") {
            const tc = part as OcxToolCall;
            const flatName = namespacedToolName(tc.namespace, tc.name);
            toolUseIds.push(tc.id);
            content.push({ type: "tool_use", id: tc.id, name: toolNames.toWire(flatName), input: tc.arguments });
          }
        }
        messages.push({ role: "assistant", content });
        if (toolUseIds.length > 0) {
          const requiredIds = new Set(toolUseIds);
          const resultBlocks: Record<string, unknown>[] = [];
          const orphanBlocks: Record<string, unknown>[] = [];
          const seen = new Set<string>();
          let j = i + 1;
          while (j < parsed.context.messages.length && parsed.context.messages[j].role === "toolResult") {
            const tr = parsed.context.messages[j] as OcxToolResultMessage;
            if (requiredIds.has(tr.toolCallId) && !seen.has(tr.toolCallId)) {
              resultBlocks.push(toAnthropicToolResult(tr));
              seen.add(tr.toolCallId);
            } else {
              orphanBlocks.push({ type: "text", text: orphanToolResultText(tr) });
            }
            j++;
          }
          for (const id of toolUseIds) {
            if (!seen.has(id)) {
              resultBlocks.push({
                type: "tool_result",
                tool_use_id: id,
                content: "[opencodex: missing tool_result for this tool_use in Codex history]",
                is_error: true,
              });
            }
          }
          messages.push({ role: "user", content: [...resultBlocks, ...orphanBlocks] });
          i = j - 1;
        }
        break;
      }
      case "toolResult": {
        // A standalone Anthropic tool_result is invalid unless it immediately follows an
        // assistant tool_use. Preserve the information as text instead of sending a 400-prone block.
        messages.push({ role: "user", content: orphanToolResultText(msg as OcxToolResultMessage) });
        break;
      }
    }
  }

  return { system, messages };
}

function toolsToAnthropicFormat(parsed: OcxParsedRequest, toolNames: { toWire: (name: string) => string }): unknown[] | undefined {
  if (!parsed.context.tools || parsed.context.tools.length === 0) return undefined;
  const allowed = isAllowedToolChoice(parsed.options.toolChoice)
    ? new Set(parsed.options.toolChoice.allowedTools)
    : undefined;
  const tools = allowed
    ? parsed.context.tools.filter(t => toolAllowedByChoice(t, allowed))
    : parsed.context.tools;
  if (tools.length === 0) return undefined;
  return tools.map(t => ({
    name: toolNames.toWire(namespacedToolName(t.namespace, t.name)),
    description: t.description,
    input_schema: t.parameters,
  }));
}

export function createAnthropicAdapter(provider: OcxProviderConfig): ProviderAdapter {
  const isOAuth = provider.authMode === "oauth";
  const toolNames = buildToolNameTransforms(provider);
  return {
    name: "anthropic",

    buildRequest(parsed: OcxParsedRequest) {
      const { system, messages } = messagesToAnthropicFormat(parsed, toolNames);
      const tools = toolsToAnthropicFormat(parsed, toolNames);

      const body: Record<string, unknown> = {
        model: parsed.modelId,
        messages,
        stream: parsed.stream,
        max_tokens: parsed.options.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      };
      if (isOAuth) {
        // Claude OAuth (Pro/Max) requires the first system block to be the Claude Code identity.
        body.system = [
          { type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION },
          ...(system ? [{ type: "text", text: system }] : []),
        ];
      } else if (system) {
        body.system = system;
      }
      if (tools) body.tools = tools;
      if (parsed.options.temperature !== undefined) body.temperature = parsed.options.temperature;
      if (parsed.options.topP !== undefined) body.top_p = parsed.options.topP;
      if (parsed.options.stopSequences) body.stop_sequences = parsed.options.stopSequences;

      if (parsed.options.reasoning) {
        // Anthropic requires max_tokens > thinking.budget_tokens (max_tokens caps thinking +
        // visible output) and budget_tokens >= 1024. Codex sends the SAME value for both, which
        // 400s ("max_tokens must be greater than thinking.budget_tokens"). Size them so max_tokens
        // always exceeds the budget within a model-safe ceiling, reserving room for visible output.
        const maxOut = parsed.options.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
        const wantBudget = reasoningBudget(parsed.options.reasoning);
        const maxTokens = Math.min(REASONING_MAX_TOKENS_CEILING, Math.max(maxOut, wantBudget + OUTPUT_HEADROOM));
        const budget = Math.max(MIN_THINKING_BUDGET, Math.min(wantBudget, maxTokens - OUTPUT_FLOOR));
        body.max_tokens = maxTokens;
        body.thinking = { type: "enabled", budget_tokens: budget };
        // Extended thinking disallows temperature != 1 and top_p — drop both or the API 400s.
        delete body.temperature;
        delete body.top_p;
      }

      if (parsed.options.toolChoice && (tools || parsed.options.toolChoice === "none")) {
        const tc = parsed.options.toolChoice;
        if (tc === "auto") body.tool_choice = { type: "auto" };
        else if (tc === "none") body.tool_choice = { type: "none" };
        else if (tc === "required") body.tool_choice = { type: "any" };
        else if (isAllowedToolChoice(tc)) body.tool_choice = { type: tc.mode === "required" ? "any" : "auto" };
        else if (typeof tc === "object" && "name" in tc) body.tool_choice = { type: "tool", name: toolNames.toWire(resolveToolChoiceWireName(parsed.context.tools, tc.name)) };
      }

      const base = provider.baseUrl.replace(/\/v1\/?$/, "");
      const url = `${base}/v1/messages`;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      };
      if (isOAuth) {
        if (provider.apiKey) headers["Authorization"] = `Bearer ${provider.apiKey}`;
        headers["anthropic-beta"] = ANTHROPIC_OAUTH_BETA;
        // Match the real Claude Code CLI request fingerprint: a valid OAuth token with an empty
        // header set is a non-first-party signature. (cch billing-header signing is intentionally
        // out of scope — brittle and version-coupled.)
        Object.assign(headers, CLAUDE_CODE_HEADERS);
        headers["X-Claude-Code-Session-Id"] = claudeCodeSessionId(provider.apiKey);
        headers["x-client-request-id"] = crypto.randomUUID();
      } else if (provider.apiKey) {
        headers["x-api-key"] = provider.apiKey;
      }
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
      let currentBlockType = "";
      let currentToolCallId = "";
      let currentToolCallName = "";
      let pendingUsage: Record<string, number> | undefined;
      let emittedDone = false;

      const emitDone = function* (): Generator<AdapterEvent> {
        if (emittedDone) return;
        emittedDone = true;
        yield { type: "done", usage: usageFromAnthropic(pendingUsage) };
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          let currentEventType = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) {
              currentEventType = line.slice(7).trim();
              continue;
            }
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6).trim();
            if (!payload) continue;

            let data: Record<string, unknown>;
            try {
              data = JSON.parse(payload) as Record<string, unknown>;
            } catch {
              debugDroppedFrame("anthropic", payload);
              continue;
            }

            switch (currentEventType || data.type) {
              case "message_start": {
                const message = data.message as { usage?: Record<string, number> } | undefined;
                pendingUsage = mergeAnthropicUsage(pendingUsage, message?.usage);
                break;
              }
              case "content_block_start": {
                const block = data.content_block as { type: string; id?: string; name?: string } | undefined;
                if (!block) break;
                currentBlockType = block.type;
                if (block.type === "tool_use") {
                  currentToolCallId = block.id ?? "";
                  currentToolCallName = toolNames.fromWire(block.name ?? "");
                  yield { type: "tool_call_start", id: currentToolCallId, name: currentToolCallName };
                }
                break;
              }
              case "content_block_delta": {
                const delta = data.delta as Record<string, unknown> | undefined;
                if (!delta) break;
                if (delta.type === "text_delta" && typeof delta.text === "string") {
                  yield { type: "text_delta", text: delta.text };
                } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
                  yield { type: "thinking_delta", thinking: delta.thinking };
                } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
                  yield { type: "tool_call_delta", arguments: delta.partial_json };
                }
                break;
              }
              case "content_block_stop": {
                if (currentBlockType === "tool_use") {
                  yield { type: "tool_call_end" };
                  currentToolCallId = "";
                  currentBlockType = "";
                }
                break;
              }
              case "message_delta": {
                const usage = data.usage as Record<string, number> | undefined;
                pendingUsage = mergeAnthropicUsage(pendingUsage, usage);
                break;
              }
              case "message_stop": {
                yield* emitDone();
                break;
              }
              case "error": {
                const err = data.error as { message?: string } | undefined;
                yield { type: "error", message: err?.message ?? "Anthropic error" };
                return;
              }
            }
            currentEventType = "";
          }
        }
        if (pendingUsage && !emittedDone) yield* emitDone();
      } finally {
        reader.releaseLock();
      }
    },

    async parseResponse(response: Response): Promise<AdapterEvent[]> {
      const json = await response.json() as Record<string, unknown>;
      const events: AdapterEvent[] = [];
      const content = json.content as { type: string; text?: string; id?: string; name?: string; input?: unknown }[] | undefined;
      if (content) {
        for (const block of content) {
          if (block.type === "text" && block.text) {
            events.push({ type: "text_delta", text: block.text });
          } else if (block.type === "tool_use") {
            events.push({ type: "tool_call_start", id: block.id ?? "", name: toolNames.fromWire(block.name ?? "") });
            events.push({ type: "tool_call_delta", arguments: JSON.stringify(block.input ?? {}) });
            events.push({ type: "tool_call_end" });
          }
        }
      }
      const usage = json.usage as Record<string, number> | undefined;
      events.push({
        type: "done",
        usage: usageFromAnthropic(usage),
      });
      return events;
    },

  };
}
