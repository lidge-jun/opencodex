/**
 * Pure Gemini generateContent request and Chat Completions response projections.
 *
 * Request side: a Gemini body becomes one Chat Completions body. Unknown fields are ignored (the
 * Gemini API grows them often); a field this proxy cannot honor and that would change the answer
 * (a second candidate, a non-image inline part) is a typed 400 instead of a silent drop.
 * Response side: a buffered Chat completion or a Chat SSE chunk sequence becomes Gemini
 * GenerateContentResponse objects. A streamed tool call is accumulated and emitted as one
 * complete functionCall part, because Gemini clients expect whole calls.
 */
type Obj = Record<string, unknown>;

export const MAX_GEMINI_TOOL_CALLS = 1_024;
export const MAX_GEMINI_SCHEMA_DEPTH = 64;

export class GeminiCodecError extends Error {
  readonly status = 400;
  readonly code = "invalid_gemini_request";
  constructor(message: string) { super(message); this.name = "GeminiCodecError"; }
}

function fail(message: string): never { throw new GeminiCodecError(message); }
const isObj = (value: unknown): value is Obj => !!value && typeof value === "object" && !Array.isArray(value);
function object(value: unknown, label: string): Obj {
  if (!isObj(value)) fail(`Invalid ${label}`);
  return value;
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`Invalid ${label}`);
  return value;
}
function text(value: unknown, label: string, nonempty = false): string {
  if (typeof value !== "string" || (nonempty && !value.trim())) fail(`Invalid ${label}`);
  return value;
}
function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`Invalid ${label}`);
  return value;
}
const snake = (key: string) => key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
/** Gemini JSON is camelCase, but the REST surface also accepts snake_case; read either. */
function field(source: Obj, key: string): unknown {
  return source[key] !== undefined ? source[key] : source[snake(key)];
}

/** Gemini declares schema types in upper case ("OBJECT"); Chat tools want JSON Schema's lower case. */
function normalizeSchema(value: unknown, depth = 0): unknown {
  if (depth > MAX_GEMINI_SCHEMA_DEPTH) fail("Schema nesting too deep");
  if (Array.isArray(value)) return value.map(item => normalizeSchema(item, depth + 1));
  if (!isObj(value)) return value;
  const out: Obj = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = key === "type" && typeof item === "string" ? item.toLowerCase() : normalizeSchema(item, depth + 1);
  }
  return out;
}

function chatTools(value: unknown): Obj[] {
  const tools: Obj[] = [];
  for (const raw of array(value, "tools")) {
    const declarations = field(object(raw, "tool"), "functionDeclarations");
    // Hosted Gemini tools (search, code execution) have no Chat equivalent and are not declarations.
    if (declarations === undefined) continue;
    for (const rawDeclaration of array(declarations, "functionDeclarations")) {
      const declaration = object(rawDeclaration, "function declaration");
      const name = text(declaration.name, "function name", true);
      if (declaration.description !== undefined) text(declaration.description, "function description");
      const schema = field(declaration, "parametersJsonSchema") ?? declaration.parameters ?? { type: "object", properties: {} };
      object(schema, "function parameters");
      tools.push({
        type: "function",
        function: {
          name,
          ...(typeof declaration.description === "string" ? { description: declaration.description } : {}),
          parameters: normalizeSchema(schema),
        },
      });
    }
  }
  return tools;
}

function toolChoice(toolConfig: unknown): unknown {
  if (toolConfig === undefined) return undefined;
  const config = field(object(toolConfig, "toolConfig"), "functionCallingConfig");
  if (config === undefined) return undefined;
  const calling = object(config, "functionCallingConfig");
  const mode = calling.mode === undefined ? "AUTO" : text(calling.mode, "function calling mode").toUpperCase();
  const namesRaw = field(calling, "allowedFunctionNames");
  const names = namesRaw === undefined ? [] : array(namesRaw, "allowedFunctionNames").map(name => text(name, "allowed function name", true));
  const entries = names.map(name => ({ type: "function", function: { name } }));
  if (mode === "NONE") return "none";
  if (mode === "AUTO" || mode === "MODE_UNSPECIFIED") return entries.length ? { type: "allowed_tools", allowed_tools: { mode: "auto", tools: entries } } : undefined;
  if (mode === "ANY" || mode === "VALIDATED") {
    if (entries.length === 1) return entries[0];
    return entries.length ? { type: "allowed_tools", allowed_tools: { mode: "required", tools: entries } } : "required";
  }
  return fail("Unsupported function calling mode");
}

function responseFormat(config: Obj): Obj | undefined {
  const mime = config.responseMimeType === undefined && config.response_mime_type === undefined ? undefined : text(field(config, "responseMimeType"), "responseMimeType");
  const schema = field(config, "responseJsonSchema") ?? field(config, "responseSchema");
  if (mime !== undefined && mime !== "application/json" && mime !== "text/plain") fail("Unsupported responseMimeType");
  if (mime === "text/plain" || (mime === undefined && schema === undefined)) return undefined;
  if (schema === undefined) return { type: "json_object" };
  object(schema, "response schema");
  return { type: "json_schema", json_schema: { name: "response", schema: normalizeSchema(schema) } };
}

const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
function reasoning(config: unknown): Obj {
  if (config === undefined) return {};
  const thinking = object(config, "thinkingConfig");
  const out: Obj = {};
  const level = field(thinking, "thinkingLevel");
  const budget = field(thinking, "thinkingBudget");
  if (level !== undefined) {
    const effort = text(level, "thinkingLevel").toLowerCase();
    if (REASONING_EFFORTS.has(effort)) out.reasoning_effort = effort;
  } else if (budget !== undefined) {
    const tokens = finiteNumber(budget, "thinkingBudget");
    // -1 asks the model to decide, which is the upstream default.
    if (tokens === 0) out.reasoning_effort = "none";
    else if (tokens > 0) out.reasoning_effort = tokens <= 2_048 ? "low" : tokens <= 12_288 ? "medium" : "high";
  }
  if (field(thinking, "includeThoughts") === true) out.include_reasoning = true;
  return out;
}

function generationSettings(raw: unknown, result: Obj): void {
  if (raw === undefined) return;
  const config = object(raw, "generationConfig");
  const numeric: ReadonlyArray<readonly [string, string]> = [
    ["temperature", "temperature"], ["topP", "top_p"], ["presencePenalty", "presence_penalty"], ["frequencyPenalty", "frequency_penalty"],
  ];
  for (const [key, chatKey] of numeric) {
    const value = field(config, key);
    if (value !== undefined) result[chatKey] = finiteNumber(value, key);
  }
  const maxTokens = field(config, "maxOutputTokens");
  if (maxTokens !== undefined) {
    if (typeof maxTokens !== "number" || !Number.isSafeInteger(maxTokens) || maxTokens < 1) fail("Invalid maxOutputTokens");
    result.max_tokens = maxTokens;
  }
  const seed = field(config, "seed");
  if (seed !== undefined) {
    if (typeof seed !== "number" || !Number.isSafeInteger(seed)) fail("Invalid seed");
    result.seed = seed;
  }
  const stops = field(config, "stopSequences");
  if (stops !== undefined) result.stop = array(stops, "stopSequences").map(stop => text(stop, "stop sequence"));
  const candidates = field(config, "candidateCount");
  if (candidates !== undefined && candidates !== 1) fail("candidateCount other than 1 is unsupported");
  const format = responseFormat(config);
  if (format) result.response_format = format;
  Object.assign(result, reasoning(field(config, "thinkingConfig")));
}

function partsOf(content: Obj): Obj[] {
  return array(field(content, "parts"), "parts").map(part => object(part, "part"));
}

function systemText(value: unknown): string {
  if (typeof value === "string") return value;
  return partsOf(object(value, "systemInstruction")).map(part => (part.text === undefined ? "" : text(part.text, "system text"))).join("\n");
}

const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;
function inlineImage(raw: unknown): Obj {
  const data = object(raw, "inlineData");
  const mime = text(field(data, "mimeType"), "inline data media type", true).toLowerCase();
  if (!/^image\/[a-z0-9.+-]+$/.test(mime)) fail("Unsupported inline data media type");
  const bytes = text(data.data, "inline data", true);
  if (!BASE64.test(bytes)) fail("Invalid inline data encoding");
  return { type: "image_url", image_url: { url: `data:${mime};base64,${bytes}` } };
}

interface PendingCall { id: string; name: string; matched: boolean }

/** Convert Gemini contents to Chat messages, matching each functionResponse to a prior functionCall. */
function chatMessages(contents: unknown, system: unknown): Obj[] {
  const messages: Obj[] = [];
  if (system !== undefined) {
    const instruction = systemText(system);
    if (instruction) messages.push({ role: "system", content: instruction });
  }
  const byId = new Map<string, PendingCall>();
  const byName = new Map<string, PendingCall[]>();
  let callCount = 0;
  array(contents, "contents").forEach((rawContent, ci) => {
    const content = object(rawContent, "content");
    const role = content.role === undefined ? "user" : text(content.role, "role");
    if (role !== "user" && role !== "model" && role !== "function" && role !== "tool") fail("Unsupported role");
    const parts = partsOf(content);
    for (const part of parts) {
      if (field(part, "fileData") !== undefined || field(part, "executableCode") !== undefined || field(part, "codeExecutionResult") !== undefined) fail("Unsupported part");
    }
    if (role === "model") {
      const texts: string[] = [];
      const calls: Obj[] = [];
      parts.forEach((part, pi) => {
        if (typeof part.text === "string") {
          // Replayed thought summaries are not conversation content.
          if (part.thought !== true) texts.push(part.text);
          return;
        }
        const rawCall = field(part, "functionCall");
        if (rawCall === undefined) {
          if (field(part, "inlineData") !== undefined || field(part, "functionResponse") !== undefined) fail("Unsupported model part");
          return;
        }
        if (++callCount > MAX_GEMINI_TOOL_CALLS) fail("Too many function calls");
        const call = object(rawCall, "functionCall");
        const name = text(call.name, "function name", true);
        const args = call.args === undefined ? {} : object(call.args, "function arguments");
        const id = call.id === undefined ? `call_gemini_${ci}_${pi}` : text(call.id, "function call id", true);
        if (byId.has(id)) fail("Duplicate function call id");
        const pending: PendingCall = { id, name, matched: false };
        byId.set(id, pending);
        byName.set(name, [...(byName.get(name) ?? []), pending]);
        calls.push({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
      });
      const body = texts.join("");
      if (body || calls.length) messages.push({ role: "assistant", content: body || null, ...(calls.length ? { tool_calls: calls } : {}) });
      return;
    }
    const tools: Obj[] = [];
    const user: Obj[] = [];
    let hasImage = false;
    for (const part of parts) {
      const rawResponse = field(part, "functionResponse");
      if (rawResponse !== undefined) {
        const response = object(rawResponse, "functionResponse");
        const name = text(response.name, "function name", true);
        const id = response.id === undefined ? undefined : text(response.id, "function response id", true);
        let target = id === undefined ? undefined : byId.get(id);
        if (!target || target.matched || target.name !== name) target = byName.get(name)?.find(candidate => !candidate.matched);
        if (!target) fail("Unmatched function response");
        target.matched = true;
        tools.push({ role: "tool", tool_call_id: target.id, content: JSON.stringify(response.response ?? {}) });
      } else if (typeof part.text === "string") {
        if (part.thought !== true) user.push({ type: "text", text: part.text });
      } else if (field(part, "inlineData") !== undefined) {
        user.push(inlineImage(field(part, "inlineData")));
        hasImage = true;
      }
    }
    // Tool results must directly follow the assistant turn that asked for them.
    messages.push(...tools);
    if (user.length) messages.push({ role: "user", content: hasImage ? user : user.map(item => item.text as string).join("\n") });
  });
  return messages;
}

/** Project a generateContent body for `model` onto a Chat Completions body. */
export function geminiToChat(model: string, input: unknown, stream: boolean): Obj {
  const body = object(input, "request");
  const result: Obj = { model: text(model, "model", true), stream, messages: chatMessages(body.contents, field(body, "systemInstruction")) };
  if (body.tools !== undefined) {
    const tools = chatTools(body.tools);
    if (tools.length) {
      result.tools = tools;
      const choice = toolChoice(field(body, "toolConfig"));
      if (choice !== undefined) result.tool_choice = choice;
    }
  }
  generationSettings(field(body, "generationConfig"), result);
  return result;
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function usageMetadata(value: unknown): Obj | undefined {
  if (!isObj(value)) return undefined;
  const prompt = nonNegativeInt(value.prompt_tokens);
  const completion = nonNegativeInt(value.completion_tokens);
  if (prompt === undefined && completion === undefined) return undefined;
  const details = isObj(value.completion_tokens_details) ? value.completion_tokens_details : {};
  const promptDetails = isObj(value.prompt_tokens_details) ? value.prompt_tokens_details : {};
  const thoughts = nonNegativeInt(details.reasoning_tokens) ?? 0;
  const cached = nonNegativeInt(promptDetails.cached_tokens) ?? 0;
  const out: Obj = {
    promptTokenCount: prompt ?? 0,
    // Chat counts reasoning inside completion tokens; Gemini reports it separately.
    candidatesTokenCount: Math.max(0, (completion ?? 0) - thoughts),
    totalTokenCount: (prompt ?? 0) + (completion ?? 0),
  };
  if (thoughts > 0) out.thoughtsTokenCount = thoughts;
  if (cached > 0) out.cachedContentTokenCount = cached;
  return out;
}

const FINISH_REASONS: Readonly<Record<string, string>> = {
  stop: "STOP",
  tool_calls: "STOP",
  function_call: "STOP",
  length: "MAX_TOKENS",
  content_filter: "SAFETY",
};
function finishReason(value: unknown): string | undefined {
  return typeof value === "string" && Object.hasOwn(FINISH_REASONS, value) ? FINISH_REASONS[value] : undefined;
}

function candidate(parts: Obj[], reason?: string): Obj {
  return { content: { role: "model", parts }, ...(reason ? { finishReason: reason } : {}), index: 0 };
}

function functionCallPart(id: unknown, name: string, argumentsJson: unknown, index: number): Obj {
  let args: unknown = {};
  if (typeof argumentsJson === "string") {
    if (argumentsJson.trim()) { try { args = JSON.parse(argumentsJson); } catch { throw new Error("Invalid Chat tool arguments"); } }
  } else if (argumentsJson !== undefined && argumentsJson !== null) args = argumentsJson;
  if (!isObj(args)) throw new Error("Invalid Chat tool arguments");
  return { functionCall: { id: typeof id === "string" && id ? id : `call_gemini_response_${index}`, name, args } };
}

/** A complete Chat completion as a GenerateContentResponse. Throws when the completion did not finish cleanly. */
export function chatToGeminiResponse(model: string, input: unknown): Obj {
  const body = object(input, "Chat response");
  if (!Array.isArray(body.choices) || body.choices.length !== 1) throw new Error("Invalid Chat choices");
  const choice = object(body.choices[0], "Chat choice");
  const reason = finishReason(choice.finish_reason);
  if (!reason) throw new Error("Chat completion did not finish successfully");
  const message = object(choice.message, "Chat message");
  const parts: Obj[] = [];
  const thought = message.reasoning_content ?? message.reasoning;
  if (typeof thought === "string" && thought) parts.push({ text: thought, thought: true });
  if (message.content != null) {
    if (typeof message.content !== "string") throw new Error("Invalid Chat content");
    if (message.content) parts.push({ text: message.content });
  }
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls)) throw new Error("Invalid Chat tool calls");
    message.tool_calls.forEach((raw, i) => {
      const call = object(raw, "Chat tool call");
      const fn = object(call.function, "Chat tool function");
      parts.push(functionCallPart(call.id, text(fn.name, "tool name", true), fn.arguments, i));
    });
  }
  if (!parts.length) parts.push({ text: "" });
  const usage = usageMetadata(body.usage);
  return { candidates: [candidate(parts, reason)], ...(usage ? { usageMetadata: usage } : {}), modelVersion: model };
}

type StreamTool = { id?: string; name: string; arguments: string };
export interface GeminiStreamState {
  model: string;
  finishReason?: unknown;
  usage?: Obj;
  tools: Map<number, StreamTool>;
  toolsEmitted: boolean;
}
export function createGeminiStreamState(model: string): GeminiStreamState {
  return { model, tools: new Map(), toolsEmitted: false };
}

function streamChunk(state: GeminiStreamState, parts: Obj[]): Obj {
  return { candidates: [candidate(parts)], modelVersion: state.model };
}

/** Consume one parsed Chat chunk. The caller owns settlement and may discard these records on failure. */
export function consumeGeminiChatChunk(state: GeminiStreamState, input: unknown): Obj[] {
  const body = object(input, "Chat chunk");
  if (body.error !== undefined) throw new Error("Chat stream error");
  if (body.usage != null) state.usage = usageMetadata(body.usage);
  if (!Array.isArray(body.choices) || body.choices.length > 1) throw new Error("Invalid Chat chunk choices");
  if (!body.choices.length) return [];
  const choice = object(body.choices[0], "Chat choice");
  const delta = object(choice.delta, "Chat delta");
  if (state.finishReason !== undefined) throw new Error("Chat chunk after finish");
  const records: Obj[] = [];
  const thought = delta.reasoning_content ?? delta.reasoning;
  if (thought != null) {
    const value = text(thought, "Chat reasoning");
    if (value) records.push(streamChunk(state, [{ text: value, thought: true }]));
  }
  if (delta.content != null) {
    const value = text(delta.content, "Chat content");
    if (value) records.push(streamChunk(state, [{ text: value }]));
  }
  if (delta.tool_calls !== undefined) {
    if (!Array.isArray(delta.tool_calls) || state.toolsEmitted) throw new Error("Invalid Chat tool delta");
    for (const raw of delta.tool_calls) {
      const call = object(raw, "tool delta");
      if (!Number.isSafeInteger(call.index) || (call.index as number) < 0) throw new Error("Invalid tool index");
      const index = call.index as number;
      if (!state.tools.has(index) && state.tools.size >= MAX_GEMINI_TOOL_CALLS) throw new Error("Too many tool calls");
      const current = state.tools.get(index) ?? { name: "", arguments: "" };
      if (call.id !== undefined) {
        const id = text(call.id, "tool id", true);
        if (current.id && current.id !== id) throw new Error("Conflicting tool id");
        current.id = id;
      }
      if (call.function !== undefined) {
        const fn = object(call.function, "tool function");
        if (fn.name !== undefined) current.name += text(fn.name, "tool name");
        if (fn.arguments !== undefined) current.arguments += text(fn.arguments, "tool arguments");
      }
      state.tools.set(index, current);
    }
  }
  if (choice.finish_reason != null) {
    state.finishReason = choice.finish_reason;
    if (state.tools.size) {
      const parts = [...state.tools.entries()].sort((a, b) => a[0] - b[0])
        .map(([index, tool]) => functionCallPart(tool.id, text(tool.name, "tool name", true), tool.arguments, index));
      records.push(streamChunk(state, parts));
      state.toolsEmitted = true;
    }
  }
  return records;
}

/** The closing chunk with the finish reason and usage. Call only after the outer handler confirms settlement. */
export function geminiStreamTerminal(state: GeminiStreamState): Obj | undefined {
  const reason = finishReason(state.finishReason);
  if (!reason || (state.tools.size > 0 && !state.toolsEmitted)) return undefined;
  return {
    candidates: [candidate([{ text: "" }], reason)],
    ...(state.usage ? { usageMetadata: state.usage } : {}),
    modelVersion: state.model,
  };
}
