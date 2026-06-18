import type {
  OcxAssistantMessage,
  OcxContext,
  OcxMessage,
  OcxParsedRequest,
  OcxRequestOptions,
  OcxTextContent,
  OcxThinkingContent,
  OcxTool,
  OcxToolCall,
} from "../types";
import { namespacedToolName } from "../types";
import { responsesRequestSchema } from "./schema";

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

type InputBlock =
  | { type: "input_text"; text: string }
  | { type: "text"; text: string }
  | { type: "input_image"; image_url?: string; file_id?: string }
  | { type: "input_file"; file_id?: string; filename?: string };

function inputContentParts(blocks: unknown[] | string | undefined): string | OcxTextContent[] {
  if (typeof blocks === "string") return blocks;
  if (!blocks) return [];
  const parts: OcxTextContent[] = [];
  for (const raw of blocks) {
    const block = raw as InputBlock;
    if (block.type === "input_text" || block.type === "text") {
      parts.push({ type: "text", text: (block as { text: string }).text });
    } else if (block.type === "input_image") {
      const ref = (block as { image_url?: string; file_id?: string }).image_url ?? (block as { file_id?: string }).file_id ?? "?";
      parts.push({ type: "text", text: `[image: ${ref}]` });
    } else if (block.type === "input_file") {
      const ref = (block as { file_id?: string; filename?: string }).file_id ?? (block as { filename?: string }).filename ?? "?";
      parts.push({ type: "text", text: `[file: ${ref}]` });
    }
  }
  return parts.length === 1 ? parts[0].text : parts;
}

type OutputBlock = { type: "output_text"; text: string } | { type: "text"; text: string } | { type: "refusal"; refusal: string };

function outputTextOf(blocks: unknown[] | string | undefined): OcxTextContent[] {
  if (typeof blocks === "string") return blocks.length > 0 ? [{ type: "text", text: blocks }] : [];
  if (!blocks) return [];
  const out: OcxTextContent[] = [];
  for (const raw of blocks) {
    const b = raw as OutputBlock;
    if (b.type === "output_text" || b.type === "text") out.push({ type: "text", text: (b as { text: string }).text });
    else if (b.type === "refusal") out.push({ type: "text", text: `[refusal: ${(b as { refusal: string }).refusal}]` });
  }
  return out;
}

function mapToolChoice(value: unknown): OcxRequestOptions["toolChoice"] {
  if (value === undefined || value === null) return undefined;
  if (value === "auto" || value === "none" || value === "required") return value;
  if (isObj(value) && "type" in value) {
    const t = (value as { type: string }).type;
    if ((t === "function" || t === "custom") && "name" in value) {
      return { name: (value as { name: string }).name };
    }
    return "auto";
  }
  return undefined;
}

function buildTools(tools: unknown[] | undefined): OcxTool[] | undefined {
  if (!tools) return undefined;
  const out: OcxTool[] = [];
  const pushFn = (t: Record<string, unknown>, namespace?: string) => {
    const tool: OcxTool = {
      name: t.name as string,
      description: (t.description as string) ?? "",
      parameters: (t.parameters ?? {}) as Record<string, unknown>,
    };
    if (t.strict !== undefined) tool.strict = t.strict as boolean;
    if (namespace) tool.namespace = namespace;
    out.push(tool);
  };
  for (const t of tools) {
    if (!isObj(t)) continue;
    if (t.type === "function" && typeof t.name === "string") {
      pushFn(t);
    } else if (t.type === "namespace" && Array.isArray(t.tools)) {
      // MCP tools arrive grouped under a namespace tool; flatten the inner function tools so
      // chat-completions models receive them (round-trip restores the namespace in the bridge).
      const ns = typeof t.name === "string" ? t.name : undefined;
      for (const inner of t.tools as unknown[]) {
        if (isObj(inner) && inner.type === "function" && typeof inner.name === "string") pushFn(inner, ns);
      }
    }
    else if (t.type === "custom" && typeof t.name === "string") {
      // Freeform custom tool (e.g. apply_patch). Chat models can't emit a lark grammar, so expose a
      // function with a single string `input` carrying the raw tool body; the bridge relays the model's
      // call back as a custom_tool_call (Codex's freeform handler rejects a function_call → fatal abort).
      out.push({
        name: t.name,
        description: (t.description as string) ?? "",
        parameters: { type: "object", properties: { input: { type: "string", description: "Raw tool input (verbatim body, e.g. the apply_patch envelope)." } }, required: ["input"] },
        freeform: true,
      });
    }
    else if (t.type === "tool_search") {
      // Client-executed tool discovery — the gateway to deferred tools (subagents, extra MCP tools).
      // Expose as a function so chat models can call it; the bridge relays it as a tool_search_call.
      out.push({
        name: "tool_search",
        description: (t.description as string) ?? "Search for additional tools to load for the next turn.",
        parameters: (isObj(t.parameters) ? t.parameters : {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query for tools to load." },
            limit: { type: "number", description: "Maximum number of tools to return." },
          },
          required: ["query"],
        }) as Record<string, unknown>,
        toolSearch: true,
      });
    }
    // web_search and image_generation are OpenAI-hosted (executed server-side) with no opencode.ai
    // equivalent, so they cannot be relayed to a chat model and are intentionally dropped.
  }
  return out.length > 0 ? out : undefined;
}

function ensureAssistantPlaceholder(messages: OcxMessage[], modelId: string, now: number): OcxAssistantMessage {
  const last = messages[messages.length - 1];
  if (last && last.role === "assistant") return last;
  const placeholder: OcxAssistantMessage = { role: "assistant", content: [], model: modelId, timestamp: now };
  messages.push(placeholder);
  return placeholder;
}

function flattenOutputArray(blocks: readonly unknown[]): string {
  const parts: string[] = [];
  for (const raw of blocks) {
    if (!isObj(raw)) continue;
    if (raw.type === "output_text" || raw.type === "text") {
      if (typeof raw.text === "string") parts.push(raw.text);
    } else if (raw.type === "refusal") {
      if (typeof raw.refusal === "string") parts.push(`[refusal: ${raw.refusal}]`);
    }
  }
  return parts.join("");
}

function findToolNameById(messages: OcxMessage[], callId: string): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    for (const part of m.content) {
      if (part.type === "toolCall" && part.id === callId) return part.name;
    }
  }
  return "";
}

const REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

export function parseRequest(body: unknown): OcxParsedRequest {
  const parsed = responsesRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`responses parse error: ${parsed.error.message}`);
  }
  const data = parsed.data;
  const now = Date.now();
  const messages: OcxMessage[] = [];
  const systemPrompt: string[] = [];
  // Tool specs surfaced by a prior tool_search (deferred tools, e.g. subagents). Codex does not
  // re-list these in `tools`, but chat models can only call listed tools — so we re-inject them.
  const loadedToolSpecs: unknown[] = [];

  if (typeof data.instructions === "string" && data.instructions.length > 0) {
    systemPrompt.push(data.instructions);
  }

  if (typeof data.input === "string") {
    messages.push({ role: "user", content: data.input, timestamp: now });
  } else if (data.input) {
    for (const item of data.input) {
      const effectiveType = (item as { type?: string }).type ?? ("role" in item ? "message" : undefined);

      if (effectiveType === "message") {
        const msg = item as { role?: string; content?: unknown };
        switch (msg.role) {
          case "system": {
            const text = inputContentParts(msg.content as unknown[] | string | undefined);
            const flat = typeof text === "string" ? text : text.map(p => p.text).join("");
            if (flat.length > 0) systemPrompt.push(flat);
            break;
          }
          case "user":
          case "developer": {
            const content = inputContentParts(msg.content as unknown[] | string | undefined);
            messages.push({ role: msg.role, content, timestamp: now });
            break;
          }
          case "assistant": {
            const parts = outputTextOf(msg.content as unknown[] | string | undefined);
            messages.push({ role: "assistant", content: parts, model: data.model, timestamp: now });
            break;
          }
        }
        continue;
      }

      if (effectiveType === "reasoning") {
        const reasoning = item as { id?: string; summary?: { text: string }[]; content?: { text: string }[] };
        const fromSummary = (reasoning.summary ?? []).map(c => c.text).join("");
        const text = fromSummary || (reasoning.content ?? []).map(c => c.text).join("");
        const thinking: OcxThinkingContent = {
          type: "thinking",
          thinking: text,
          signature: JSON.stringify(reasoning),
          ...(reasoning.id ? { itemId: reasoning.id } : {}),
        };
        ensureAssistantPlaceholder(messages, data.model, now).content.push(thinking);
        continue;
      }

      if (effectiveType === "function_call") {
        const call = item as { id?: string; call_id: string; name: string; arguments?: string; namespace?: string };
        let args: Record<string, unknown>;
        try {
          const raw: unknown = JSON.parse(call.arguments ?? "{}");
          args = isObj(raw) ? raw : {};
        } catch {
          throw new Error(`function_call ${call.call_id} has invalid JSON arguments`);
        }
        const toolCall: OcxToolCall = {
          type: "toolCall", id: call.call_id, name: call.name, arguments: args,
          ...(call.id ? { thoughtSignature: call.id } : {}),
          ...(call.namespace ? { namespace: call.namespace } : {}),
        };
        ensureAssistantPlaceholder(messages, data.model, now).content.push(toolCall);
        continue;
      }

      if (effectiveType === "custom_tool_call") {
        const call = item as { id?: string; call_id: string; name: string; input: string };
        const toolCall: OcxToolCall = {
          type: "toolCall", id: call.call_id, name: call.name,
          arguments: { input: call.input ?? "" },
          customWireName: call.name,
          ...(call.id ? { thoughtSignature: call.id } : {}),
        };
        ensureAssistantPlaceholder(messages, data.model, now).content.push(toolCall);
        continue;
      }

      if (effectiveType === "tool_search_call") {
        // Preserve the model's prior tool_search call as an assistant tool call so multi-turn
        // history stays complete (otherwise the model re-issues tool_search forever).
        const call = item as { id?: string; call_id?: string; arguments?: unknown };
        const callId = call.call_id ?? call.id ?? "";
        ensureAssistantPlaceholder(messages, data.model, now).content.push({
          type: "toolCall", id: callId, name: "tool_search",
          arguments: isObj(call.arguments) ? call.arguments : {},
        });
        continue;
      }

      if (effectiveType === "tool_search_output") {
        // Pair the tool_search call with its result so the model sees what was loaded.
        const out = item as { call_id?: string; tools?: { name?: string }[] };
        if (Array.isArray(out.tools)) loadedToolSpecs.push(...out.tools);
        const names = Array.isArray(out.tools) ? out.tools.map(t => t?.name).filter((n): n is string => !!n) : [];
        messages.push({
          role: "toolResult", toolCallId: out.call_id ?? "", toolName: "tool_search",
          content: names.length
            ? `Tool search loaded ${names.length} tool(s): ${names.join(", ")}. They are now in your available tools — call the appropriate one directly.`
            : "Tool search returned no tools.",
          isError: false, timestamp: now,
        });
        continue;
      }

      if (effectiveType === "function_call_output") {
        const output = item as { call_id: string; output?: string | unknown[] };
        const text = typeof output.output === "string"
          ? output.output
          : Array.isArray(output.output) ? flattenOutputArray(output.output) : "";
        messages.push({
          role: "toolResult", toolCallId: output.call_id,
          toolName: findToolNameById(messages, output.call_id),
          content: text, isError: false, timestamp: now,
        });
        continue;
      }

      if (effectiveType === "custom_tool_call_output") {
        const output = item as { call_id: string; output: string };
        messages.push({
          role: "toolResult", toolCallId: output.call_id,
          toolName: findToolNameById(messages, output.call_id),
          content: output.output ?? "", isError: false, timestamp: now,
        });
      }
    }
  }

  const declaredTools = buildTools(data.tools as unknown[] | undefined) ?? [];
  const loadedTools = buildTools(loadedToolSpecs) ?? [];
  const seenTools = new Set<string>();
  const mergedTools = [...declaredTools, ...loadedTools].filter(t => {
    const k = namespacedToolName(t.namespace, t.name);
    if (seenTools.has(k)) return false;
    seenTools.add(k);
    return true;
  });
  const context: OcxContext = {
    ...(systemPrompt.length > 0 ? { systemPrompt } : {}),
    messages,
    ...(mergedTools.length > 0 ? { tools: mergedTools } : {}),
  };

  const options: OcxRequestOptions = {};
  if (data.max_output_tokens !== undefined) options.maxOutputTokens = data.max_output_tokens;
  if (data.temperature !== undefined) options.temperature = data.temperature;
  if (data.top_p !== undefined) options.topP = data.top_p;
  if (data.stop !== undefined && data.stop !== null) {
    options.stopSequences = typeof data.stop === "string" ? [data.stop] : data.stop;
  }
  const tc = mapToolChoice(data.tool_choice);
  if (tc !== undefined) options.toolChoice = tc;
  if (data.reasoning?.effort && REASONING_EFFORTS.has(data.reasoning.effort)) {
    options.reasoning = data.reasoning.effort;
  }
  if (data.reasoning?.summary === "none") options.hideThinkingSummary = true;
  if (data.presence_penalty !== undefined) options.presencePenalty = data.presence_penalty;
  if (data.frequency_penalty !== undefined) options.frequencyPenalty = data.frequency_penalty;

  return { modelId: data.model, context, stream: data.stream === true, options, _rawBody: body };
}
