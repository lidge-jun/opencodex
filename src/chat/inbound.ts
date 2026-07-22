/**
 * Chat Completions inbound: OpenAI-compatible request -> internal /v1/responses body.
 *
 * Used by GitHub Copilot App (and other OpenAI-compatible clients) via POST /v1/chat/completions.
 * Same translate-and-replay pattern as Claude Messages: the produced body must pass
 * responsesRequestSchema so routing/OAuth/pool/sidecars are inherited unchanged.
 */
export class ChatCompletionsRequestError extends Error {}

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

const OUTPUT_CONFIG_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content) {
    if (typeof raw === "string") {
      parts.push(raw);
      continue;
    }
    if (!isRec(raw)) continue;
    if ((raw.type === "text" || raw.type === "input_text" || raw.type === "output_text") && typeof raw.text === "string") {
      parts.push(raw.text);
    }
  }
  return parts.join("\n");
}

function imageUrlFromPart(part: Rec): string | null {
  if (part.type !== "image_url") return null;
  const imageUrl = part.image_url;
  if (typeof imageUrl === "string" && imageUrl.length > 0) return imageUrl;
  if (isRec(imageUrl) && typeof imageUrl.url === "string" && imageUrl.url.length > 0) return imageUrl.url;
  return null;
}

function userContentToBlocks(content: unknown): Rec[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "input_text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: Rec[] = [];
  for (const raw of content) {
    if (typeof raw === "string") {
      if (raw.length > 0) blocks.push({ type: "input_text", text: raw });
      continue;
    }
    if (!isRec(raw)) continue;
    if ((raw.type === "text" || raw.type === "input_text") && typeof raw.text === "string") {
      blocks.push({ type: "input_text", text: raw.text });
      continue;
    }
    const imageUrl = imageUrlFromPart(raw);
    if (imageUrl) blocks.push({ type: "input_image", image_url: imageUrl });
  }
  return blocks;
}

function assistantContentToBlocks(content: unknown): Rec[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "output_text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: Rec[] = [];
  for (const raw of content) {
    if (typeof raw === "string") {
      if (raw.length > 0) blocks.push({ type: "output_text", text: raw });
      continue;
    }
    if (!isRec(raw)) continue;
    if ((raw.type === "text" || raw.type === "output_text") && typeof raw.text === "string") {
      blocks.push({ type: "output_text", text: raw.text });
    }
  }
  return blocks;
}

function pushSystemText(parts: string[], content: unknown): void {
  const text = contentToText(content).trim();
  if (text) parts.push(text);
}

function toolCallsToItems(toolCalls: unknown, input: Rec[]): void {
  if (!Array.isArray(toolCalls)) return;
  // Recover names from earlier function_call items in the same transcript when a client
  // re-sends tool_calls with only id/arguments (replace-style merge lost function.name).
  const knownNameByCallId = new Map<string, string>();
  for (const item of input) {
    if (!isRec(item) || item.type !== "function_call") continue;
    if (typeof item.call_id === "string" && typeof item.name === "string" && item.name.length > 0) {
      knownNameByCallId.set(item.call_id, item.name);
    }
  }
  for (const raw of toolCalls) {
    if (!isRec(raw)) continue;
    const fn = isRec(raw.function) ? raw.function : null;
    let name = typeof fn?.name === "string" ? fn.name : typeof raw.name === "string" ? raw.name : "";
    const args = typeof fn?.arguments === "string"
      ? fn.arguments
      : typeof raw.arguments === "string"
        ? raw.arguments
        : JSON.stringify(fn?.arguments ?? raw.arguments ?? {});
    const callId = typeof raw.id === "string" && raw.id.length > 0
      ? raw.id
      : typeof raw.call_id === "string" && raw.call_id.length > 0
        ? raw.call_id
        : `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    if (!name) name = knownNameByCallId.get(callId) ?? "";
    if (!name) throw new ChatCompletionsRequestError("tool_calls entries require function.name");
    knownNameByCallId.set(callId, name);
    input.push({ type: "function_call", call_id: callId, name, arguments: args });
  }
}

function toolsToResponses(tools: unknown): Rec[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const out: Rec[] = [];
  for (const raw of tools) {
    if (!isRec(raw)) continue;
    if (raw.type === "function" && typeof raw.name === "string" && raw.name.length > 0) {
      out.push({
        type: "function",
        name: raw.name,
        ...(typeof raw.description === "string" ? { description: raw.description } : {}),
        ...(isRec(raw.parameters) ? { parameters: raw.parameters } : {}),
        ...(typeof raw.strict === "boolean" ? { strict: raw.strict } : {}),
      });
      continue;
    }
    if (raw.type === "function" && isRec(raw.function) && typeof raw.function.name === "string" && raw.function.name.length > 0) {
      out.push({
        type: "function",
        name: raw.function.name,
        ...(typeof raw.function.description === "string" ? { description: raw.function.description } : {}),
        ...(isRec(raw.function.parameters) ? { parameters: raw.function.parameters } : {}),
        ...(typeof raw.function.strict === "boolean" ? { strict: raw.function.strict } : {}),
      });
      continue;
    }
    if (raw.type === "web_search" || raw.type === "web_search_preview") {
      out.push({ type: "web_search" });
    }
  }
  return out.length > 0 ? out : undefined;
}

function toolChoiceToResponses(choice: unknown, body: Rec): void {
  if (choice === undefined || choice === null) return;
  if (choice === "auto" || choice === "none" || choice === "required") {
    body.tool_choice = choice;
    return;
  }
  if (!isRec(choice)) return;
  if (choice.type === "function") {
    const name = typeof choice.name === "string"
      ? choice.name
      : isRec(choice.function) && typeof choice.function.name === "string"
        ? choice.function.name
        : "";
    if (!name) throw new ChatCompletionsRequestError("tool_choice.function requires a name");
    body.tool_choice = { type: "function", name };
    return;
  }
  if (isRec(choice.function) && typeof choice.function.name === "string") {
    body.tool_choice = { type: "function", name: choice.function.name };
  }
}

function responseFormatToText(format: unknown): Rec | undefined {
  if (format === undefined) return undefined;
  if (!isRec(format)) throw new ChatCompletionsRequestError("response_format must be an object");
  if (format.type === "json_object") return { format: { type: "json_object" } };
  if (format.type === "json_schema") {
    if (!isRec(format.json_schema)) {
      throw new ChatCompletionsRequestError("response_format.json_schema is required for type json_schema");
    }
    const schema = format.json_schema;
    return {
      format: {
        type: "json_schema",
        name: typeof schema.name === "string" ? schema.name : "response",
        ...(typeof schema.description === "string" ? { description: schema.description } : {}),
        ...(schema.schema !== undefined ? { schema: schema.schema } : {}),
        ...(typeof schema.strict === "boolean" ? { strict: schema.strict } : {}),
      },
    };
  }
  if (format.type === "text") return undefined;
  throw new ChatCompletionsRequestError(`unsupported response_format.type: ${String(format.type)}`);
}

function resolveReasoningEffort(raw: Rec): string | undefined {
  if (typeof raw.reasoning_effort === "string" && OUTPUT_CONFIG_EFFORTS.has(raw.reasoning_effort)) {
    return raw.reasoning_effort;
  }
  if (isRec(raw.reasoning) && typeof raw.reasoning.effort === "string" && OUTPUT_CONFIG_EFFORTS.has(raw.reasoning.effort)) {
    return raw.reasoning.effort;
  }
  return undefined;
}

/**
 * Translate an OpenAI Chat Completions request body into a /v1/responses request body.
 * Throws ChatCompletionsRequestError (-> 400) on malformed input.
 */
export function chatCompletionsToResponsesBody(raw: unknown): Rec {
  if (!isRec(raw)) throw new ChatCompletionsRequestError("request body must be a JSON object");
  if (typeof raw.model !== "string" || raw.model.length === 0) {
    throw new ChatCompletionsRequestError("model is required");
  }
  if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
    throw new ChatCompletionsRequestError("messages must be a non-empty array");
  }

  const systemParts: string[] = [];
  const input: Rec[] = [];

  for (const msg of raw.messages) {
    if (!isRec(msg)) continue;
    const role = typeof msg.role === "string" ? msg.role : "";
    switch (role) {
      case "system":
      case "developer":
        pushSystemText(systemParts, msg.content);
        break;
      case "user": {
        const blocks = userContentToBlocks(msg.content);
        if (blocks.length > 0) input.push({ type: "message", role: "user", content: blocks });
        break;
      }
      case "assistant": {
        const blocks = assistantContentToBlocks(msg.content);
        if (blocks.length > 0) input.push({ type: "message", role: "assistant", content: blocks });
        if (msg.tool_calls !== undefined) toolCallsToItems(msg.tool_calls, input);
        break;
      }
      case "tool": {
        const callId = typeof msg.tool_call_id === "string" ? msg.tool_call_id
          : typeof msg.tool_use_id === "string" ? msg.tool_use_id
          : "";
        if (!callId) throw new ChatCompletionsRequestError("tool messages require tool_call_id");
        const output = typeof msg.content === "string" ? msg.content : contentToText(msg.content);
        input.push({ type: "function_call_output", call_id: callId, output });
        break;
      }
      default:
        break;
    }
  }

  if (input.length === 0 && systemParts.length === 0) {
    throw new ChatCompletionsRequestError("messages must include at least one user/assistant/tool turn");
  }

  const body: Rec = {
    model: raw.model,
    input,
    stream: raw.stream === true,
    store: false,
  };

  if (systemParts.length > 0) body.instructions = systemParts.join("\n\n");

  const tools = toolsToResponses(raw.tools);
  if (tools) body.tools = tools;
  toolChoiceToResponses(raw.tool_choice, body);

  const maxTokens = typeof raw.max_completion_tokens === "number"
    ? raw.max_completion_tokens
    : typeof raw.max_tokens === "number"
      ? raw.max_tokens
      : undefined;
  if (typeof maxTokens === "number") body.max_output_tokens = maxTokens;
  if (typeof raw.temperature === "number") body.temperature = raw.temperature;
  if (typeof raw.top_p === "number") body.top_p = raw.top_p;
  if (raw.stop !== undefined) body.stop = raw.stop;
  if (typeof raw.user === "string") body.user = raw.user;
  if (typeof raw.parallel_tool_calls === "boolean") body.parallel_tool_calls = raw.parallel_tool_calls;
  if (typeof raw.prompt_cache_key === "string") body.prompt_cache_key = raw.prompt_cache_key;
  if (raw.metadata !== undefined) body.metadata = raw.metadata;

  const effort = resolveReasoningEffort(raw);
  if (effort) body.reasoning = { effort };

  const text = responseFormatToText(raw.response_format);
  if (text) body.text = text;

  return body;
}
