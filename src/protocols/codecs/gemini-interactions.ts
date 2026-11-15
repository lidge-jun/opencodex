/**
 * Pure Gemini Interactions API request and Chat Completions response projections.
 *
 * Request side: an Interactions create body becomes one Chat Completions body. Unknown fields are
 * ignored (the API grows them often); a field this proxy cannot honor and that would change the
 * answer (an agent, background execution, a hosted tool, non-text output) is a typed 400 instead of
 * a silent drop. Response side: a buffered Chat completion becomes an Interaction resource, and a
 * Chat SSE chunk sequence becomes the Interactions SSE vocabulary (interaction.created, step.start,
 * step.delta, step.stop, interaction.completed). Field names follow
 * https://ai.google.dev/api/interactions-api; usage uses its total_* names.
 */
import { GeminiCodecError, MAX_GEMINI_TOOL_CALLS, normalizeSchema } from "./gemini";

type Obj = Record<string, unknown>;

export class InteractionsCodecError extends Error {
  readonly status = 400;
  readonly code = "invalid_interactions_request";
  constructor(message: string) { super(message); this.name = "InteractionsCodecError"; }
}

function fail(message: string): never { throw new InteractionsCodecError(message); }
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

/** Lower-case schema types with the generateContent codec's rule, reporting failures as this codec's 400. */
function schema(value: unknown): unknown {
  try { return normalizeSchema(value); } catch (error) {
    if (error instanceof GeminiCodecError) fail(error.message);
    throw error;
  }
}

export interface InteractionsRequestPlan {
  model: string;
  stream: boolean;
  store: boolean;
  previousInteractionId?: string;
  /** function_result call ids with no function_call earlier in this input. */
  unmatchedResultIds: string[];
  /** System messages built from system_instruction and developer/system turns, in order. */
  systemMessages: Obj[];
  /** The conversation messages this request adds (no system role). */
  inputMessages: Obj[];
  /** The input as Interactions steps, kept for a stored interaction's GET resource. */
  inputSteps: Obj[];
  /** The Chat body without messages; the handler sets messages. */
  chat: Obj;
}

const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

/** One Interactions content item as a Chat content part. Text and inline base64 images only. */
function contentPart(raw: unknown): Obj {
  const item = object(raw, "content");
  const type = item.type === undefined && typeof item.text === "string" ? "text" : text(item.type, "content type");
  if (type === "text") return { type: "text", text: text(item.text, "text content") };
  if (type === "image") {
    if (item.data === undefined) fail("unsupported content: image without inline data");
    const mime = text(item.mime_type ?? item.mimeType, "image mime_type", true).toLowerCase();
    if (!/^image\/[a-z0-9.+-]+$/.test(mime)) fail("unsupported content: image mime_type");
    const data = text(item.data, "image data", true);
    if (!BASE64.test(data)) fail("Invalid image data encoding");
    return { type: "image_url", image_url: { url: `data:${mime};base64,${data}` } };
  }
  return fail(`unsupported content type: ${type}`);
}

/** Chat user content: a string when text-only, parts when an image is present. */
function userContent(parts: Obj[]): string | Obj[] {
  return parts.some(part => part.type !== "text") ? parts : parts.map(part => part.text as string).join("\n");
}

function contentList(value: unknown, label: string): Obj[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (isObj(value)) return [contentPart(value)];
  return array(value, label).map(contentPart);
}

function contentText(value: unknown, label: string): string {
  return contentList(value, label).map(part => {
    if (part.type !== "text") fail(`unsupported content in ${label}`);
    return part.text as string;
  }).join("");
}

function systemInstructionText(value: unknown): string {
  if (typeof value === "string") return value;
  const source = object(value, "system_instruction");
  if (typeof source.text === "string") return source.text;
  if (source.parts !== undefined) return array(source.parts, "system_instruction parts").map(part => text(object(part, "system_instruction part").text, "system_instruction text")).join("\n");
  return fail("Invalid system_instruction");
}

const STEP_TYPES = new Set(["user_input", "model_output", "thought", "function_call", "function_result"]);
const CONTENT_TYPES = new Set(["text", "image", "audio", "video", "document"]);

interface InputState {
  system: Obj[];
  messages: Obj[];
  steps: Obj[];
  assistant?: { content: string; calls: Obj[] };
  pendingSignature?: string;
  calls: Set<string>;
  unmatched: string[];
  callCount: number;
}

function flushAssistant(state: InputState): void {
  const pending = state.assistant;
  if (!pending) return;
  state.assistant = undefined;
  if (!pending.content && !pending.calls.length) return;
  state.messages.push({ role: "assistant", content: pending.content || null, ...(pending.calls.length ? { tool_calls: pending.calls } : {}) });
}

function assistantOf(state: InputState): { content: string; calls: Obj[] } {
  state.assistant ??= { content: "", calls: [] };
  return state.assistant;
}

function resultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return contentText(value, "function_result result");
  if (isObj(value)) return JSON.stringify(value);
  return fail("Invalid function_result result");
}

function applyStep(state: InputState, raw: unknown): void {
  const step = object(raw, "step");
  const role = step.role === undefined ? undefined : text(step.role, "role");
  const type = step.type === undefined && role !== undefined ? "turn" : text(step.type, "step type");
  if (type === "turn") {
    const content = step.content ?? step.parts;
    if (role === "user") {
      flushAssistant(state);
      state.messages.push({ role: "user", content: userContent(contentList(content, "turn content")) });
      state.steps.push({ type: "user_input", content: contentList(content, "turn content").map(part => part.type === "text" ? part : { type: "image" }) });
      return;
    }
    if (role === "model" || role === "assistant") {
      const text = contentText(content, "turn content");
      assistantOf(state).content += text;
      state.steps.push({ type: "model_output", content: [{ type: "text", text }] });
      return;
    }
    if (role === "system" || role === "developer") { flushAssistant(state); state.system.push({ role: "system", content: contentText(content, "turn content") }); return; }
    return fail(`unsupported role: ${role}`);
  }
  if (!STEP_TYPES.has(type)) fail(`unsupported step type: ${type}`);
  state.steps.push({ ...step });
  if (type === "user_input") {
    flushAssistant(state);
    state.messages.push({ role: "user", content: userContent(contentList(step.content ?? [], "user_input content")) });
    return;
  }
  if (type === "model_output") { assistantOf(state).content += contentText(step.content ?? [], "model_output content"); return; }
  if (type === "thought") {
    // Thought summaries are not conversation text. A signature belongs to the next function call.
    const signature = step.signature;
    if (signature !== undefined) state.pendingSignature = text(signature, "thought signature", true);
    return;
  }
  if (type === "function_call") {
    if (++state.callCount > MAX_GEMINI_TOOL_CALLS) fail("Too many function calls");
    const id = text(step.id, "function_call id", true);
    if (state.calls.has(id)) fail("Duplicate function_call id");
    const name = text(step.name, "function_call name", true);
    const args = step.arguments === undefined ? {} : object(step.arguments, "function_call arguments");
    const signature = state.pendingSignature;
    state.pendingSignature = undefined;
    state.calls.add(id);
    assistantOf(state).calls.push({
      id, type: "function", function: { name, arguments: JSON.stringify(args) },
      ...(signature ? { extra_content: { google: { thought_signature: signature } } } : {}),
    });
    return;
  }
  // function_result
  flushAssistant(state);
  const callId = text(step.call_id, "function_result call_id", true);
  if (!state.calls.has(callId)) state.unmatched.push(callId);
  const body = resultText(step.result);
  if (step.is_error !== undefined && typeof step.is_error !== "boolean") fail("Invalid function_result is_error");
  state.messages.push({ role: "tool", tool_call_id: callId, content: step.is_error === true ? JSON.stringify({ error: body }) : body });
}

function isContentItem(value: unknown): boolean {
  return isObj(value) && ((typeof value.type === "string" && CONTENT_TYPES.has(value.type)) || (value.type === undefined && value.role === undefined && typeof value.text === "string"));
}

function inputMessages(input: unknown, state: InputState): void {
  if (typeof input === "string") {
    state.messages.push({ role: "user", content: input });
    state.steps.push({ type: "user_input", content: [{ type: "text", text: input }] });
    return;
  }
  if (isContentItem(input)) {
    state.messages.push({ role: "user", content: userContent([contentPart(input)]) });
    state.steps.push({ type: "user_input", content: [{ ...(input as Obj) }] });
    return;
  }
  if (isObj(input)) { applyStep(state, input); flushAssistant(state); return; }
  const items = array(input, "input");
  if (items.length && items.every(isContentItem)) {
    state.messages.push({ role: "user", content: userContent(items.map(contentPart)) });
    state.steps.push({ type: "user_input", content: items.map(item => ({ ...(item as Obj) })) });
    return;
  }
  for (const item of items) {
    if (isContentItem(item)) fail("input mixes content items with steps");
    applyStep(state, item);
  }
  flushAssistant(state);
}

function functionTools(value: unknown): Obj[] {
  return array(value, "tools").map(raw => {
    const tool = object(raw, "tool");
    const type = text(tool.type, "tool type");
    if (type !== "function") fail(`unsupported tool type: ${type}`);
    const name = text(tool.name, "function name", true);
    if (tool.description !== undefined) text(tool.description, "function description");
    const parameters = tool.parameters ?? { type: "object", properties: {} };
    object(parameters, "function parameters");
    return { type: "function", function: { name, ...(typeof tool.description === "string" ? { description: tool.description } : {}), parameters: schema(parameters) } };
  });
}

function toolChoice(value: unknown): unknown {
  if (typeof value === "string") {
    if (value === "auto" || value === "validated") return undefined;
    if (value === "any") return "required";
    if (value === "none") return "none";
    return fail("Unsupported tool_choice");
  }
  const allowed = object(object(value, "tool_choice").allowed_tools, "tool_choice allowed_tools");
  const mode = allowed.mode === undefined ? "auto" : text(allowed.mode, "allowed_tools mode");
  const names = allowed.tools === undefined ? [] : array(allowed.tools, "allowed_tools tools").map(name => text(name, "allowed tool name", true));
  if (mode === "none") return "none";
  const entries = names.map(name => ({ type: "function", function: { name } }));
  if (mode === "auto" || mode === "validated") return entries.length ? { type: "allowed_tools", allowed_tools: { mode: "auto", tools: entries } } : undefined;
  if (mode === "any") {
    // Same semantics as the generateContent codec: one allowed function is a forced call.
    if (entries.length === 1) return entries[0];
    return entries.length ? { type: "allowed_tools", allowed_tools: { mode: "required", tools: entries } } : "required";
  }
  return fail("Unsupported tool_choice mode");
}

const THINKING_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh"]);

function generationConfig(raw: unknown, chat: Obj): unknown {
  if (raw === undefined) return undefined;
  const config = object(raw, "generation_config");
  for (const [key, chatKey] of [["temperature", "temperature"], ["top_p", "top_p"]] as const) {
    if (config[key] !== undefined) chat[chatKey] = finiteNumber(config[key], key);
  }
  if (config.seed !== undefined) {
    if (typeof config.seed !== "number" || !Number.isSafeInteger(config.seed)) fail("Invalid seed");
    chat.seed = config.seed;
  }
  if (config.stop_sequences !== undefined) chat.stop = array(config.stop_sequences, "stop_sequences").map(stop => text(stop, "stop sequence"));
  if (config.max_output_tokens !== undefined) {
    const max = config.max_output_tokens;
    if (typeof max !== "number" || !Number.isSafeInteger(max) || max < 1) fail("Invalid max_output_tokens");
    chat.max_tokens = max;
  }
  if (config.thinking_level !== undefined) {
    const level = text(config.thinking_level, "thinking_level").toLowerCase();
    if (!THINKING_LEVELS.has(level)) fail("Invalid thinking_level");
    chat.reasoning_effort = level;
  }
  if (config.thinking_summaries !== undefined) {
    const summaries = text(config.thinking_summaries, "thinking_summaries");
    if (summaries !== "auto" && summaries !== "none") fail("Invalid thinking_summaries");
    if (summaries === "auto") chat.include_reasoning = true;
  }
  return config.tool_choice;
}

function responseFormat(value: unknown): Obj | undefined {
  const formats = Array.isArray(value) ? value : [value];
  if (formats.length !== 1) fail("response_format must name one text format");
  const format = object(formats[0], "response_format");
  const type = format.type === undefined ? "text" : text(format.type, "response_format type");
  if (type !== "text") fail(`unsupported response_format type: ${type}`);
  const mime = format.mime_type === undefined ? undefined : text(format.mime_type, "response_format mime_type");
  if (mime !== undefined && mime !== "application/json" && mime !== "text/plain") fail("unsupported response_format mime_type");
  if (mime === "text/plain" || (mime === undefined && format.schema === undefined)) return undefined;
  if (format.schema === undefined) return { type: "json_object" };
  return { type: "json_schema", json_schema: { name: "response", schema: schema(object(format.schema, "response_format schema")) } };
}

const UNSUPPORTED_FIELDS = ["webhook_config", "environment", "agent_config"] as const;

/** Project an Interactions create body onto a Chat Completions plan. */
export function interactionsToChat(input: unknown): InteractionsRequestPlan {
  const body = object(input, "request");
  const hasModel = body.model !== undefined;
  const hasAgent = body.agent !== undefined;
  if (hasModel === hasAgent) fail("request requires exactly one of model or agent");
  if (hasAgent) fail("agent interactions require a native Interactions upstream");
  const rawModel = text(body.model, "model", true).trim();
  const model = rawModel.startsWith("models/") ? rawModel.slice("models/".length) : rawModel;
  if (!model) fail("Invalid model");
  if (body.stream !== undefined && typeof body.stream !== "boolean") fail("stream must be a boolean");
  if (body.store !== undefined && typeof body.store !== "boolean") fail("store must be a boolean");
  if (body.background !== undefined && typeof body.background !== "boolean") fail("background must be a boolean");
  if (body.background === true) fail("background interactions are not supported");
  // Fields that would change where or how the interaction runs; ignoring them would change the answer.
  for (const field of UNSUPPORTED_FIELDS) if (body[field] !== undefined) fail(`${field} is not supported`);
  const previous = body.previous_interaction_id === undefined ? undefined : text(body.previous_interaction_id, "previous_interaction_id", true);
  if (body.response_modalities !== undefined) {
    const modalities = array(body.response_modalities, "response_modalities").map(value => text(value, "response modality").toLowerCase());
    if (modalities.some(value => value !== "text")) fail("only text output is supported");
  }
  if (body.input === undefined) fail("Invalid input");
  const state: InputState = { system: [], messages: [], steps: [], calls: new Set(), unmatched: [], callCount: 0 };
  if (body.system_instruction !== undefined) {
    const instruction = systemInstructionText(body.system_instruction);
    if (instruction) state.system.push({ role: "system", content: instruction });
  }
  inputMessages(body.input, state);
  const stream = body.stream === true;
  const chat: Obj = { model, stream };
  if (body.tools !== undefined) {
    const tools = functionTools(body.tools);
    if (tools.length) chat.tools = tools;
  }
  const configChoice = generationConfig(body.generation_config, chat);
  const choiceSource = body.tool_choice ?? configChoice;
  if (choiceSource !== undefined && chat.tools !== undefined) {
    const choice = toolChoice(choiceSource);
    if (choice !== undefined) chat.tool_choice = choice;
  }
  if (body.response_format !== undefined) {
    const format = responseFormat(body.response_format);
    if (format) chat.response_format = format;
  }
  return {
    model, stream, store: body.store !== false,
    ...(previous !== undefined ? { previousInteractionId: previous } : {}),
    unmatchedResultIds: state.unmatched,
    systemMessages: state.system,
    inputMessages: state.messages,
    inputSteps: state.steps,
    chat,
  };
}

export interface InteractionMeta { id: string; model: string; created: string; previousInteractionId?: string }

/** ocx-int- plus 128 random bits as lower-case hex. */
export function newInteractionId(): string {
  return "ocx-int-" + Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
}

export function interactionTimestamp(at = Date.now()): string {
  return new Date(Math.floor(at / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

const STATUS_BY_FINISH: Readonly<Record<string, string>> = {
  stop: "completed",
  tool_calls: "requires_action",
  function_call: "requires_action",
  length: "incomplete",
  content_filter: "incomplete",
};

function interactionStatus(finish: unknown): string | undefined {
  return typeof finish === "string" && Object.hasOwn(STATUS_BY_FINISH, finish) ? STATUS_BY_FINISH[finish] : undefined;
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Chat usage as Interactions usage (Google's total_* names; output excludes thoughts). */
export function interactionUsage(value: unknown): Obj | undefined {
  if (!isObj(value)) return undefined;
  const prompt = nonNegativeInt(value.prompt_tokens);
  const completion = nonNegativeInt(value.completion_tokens);
  if (prompt === undefined && completion === undefined) return undefined;
  const details = isObj(value.completion_tokens_details) ? value.completion_tokens_details : {};
  const promptDetails = isObj(value.prompt_tokens_details) ? value.prompt_tokens_details : {};
  const thoughts = nonNegativeInt(details.reasoning_tokens) ?? 0;
  return {
    total_input_tokens: prompt ?? 0,
    total_cached_tokens: nonNegativeInt(promptDetails.cached_tokens) ?? 0,
    total_output_tokens: Math.max(0, (completion ?? 0) - thoughts),
    total_thought_tokens: thoughts,
    total_tokens: (prompt ?? 0) + (completion ?? 0),
  };
}

function callArguments(raw: unknown): Obj {
  let args: unknown = {};
  if (typeof raw === "string") {
    if (raw.trim()) { try { args = JSON.parse(raw); } catch { throw new Error("Invalid Chat tool arguments"); } }
  } else if (raw !== undefined && raw !== null) args = raw;
  if (!isObj(args)) throw new Error("Invalid Chat tool arguments");
  return args;
}

function callSignature(call: Obj): string | undefined {
  const extra = call.extra_content;
  if (!isObj(extra) || !isObj(extra.google)) return undefined;
  const signature = extra.google.thought_signature;
  return typeof signature === "string" && signature ? signature : undefined;
}

/** The output steps of one assistant answer: thought, model_output, then function calls. */
function outputSteps(reasoning: string, content: string, calls: { id: string; name: string; arguments: Obj; signature?: string }[]): Obj[] {
  const steps: Obj[] = [];
  if (reasoning) steps.push({ type: "thought", summary: [{ type: "text", text: reasoning }] });
  if (content) steps.push({ type: "model_output", content: [{ type: "text", text: content }] });
  for (const call of calls) {
    if (call.signature) steps.push({ type: "thought", signature: call.signature });
    steps.push({ type: "function_call", id: call.id, name: call.name, arguments: call.arguments });
  }
  return steps;
}

/** The assistant message a stored interaction keeps for the next turn. */
export interface InteractionAnswer { reasoning: string; content: string; calls: { id: string; name: string; arguments: Obj; signature?: string }[]; status: string; usage?: Obj }

export function interactionAssistantMessage(answer: InteractionAnswer): Obj | undefined {
  if (!answer.content && !answer.calls.length) return undefined;
  return {
    role: "assistant",
    content: answer.content || null,
    ...(answer.calls.length ? { tool_calls: answer.calls.map(call => ({
      id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      ...(call.signature ? { extra_content: { google: { thought_signature: call.signature } } } : {}),
    })) } : {}),
  };
}

export function interactionResource(meta: InteractionMeta, answer: InteractionAnswer, updated = meta.created): Obj {
  return {
    id: meta.id, object: "interaction", status: answer.status, created: meta.created, updated, model: meta.model,
    ...(meta.previousInteractionId ? { previous_interaction_id: meta.previousInteractionId } : {}),
    steps: outputSteps(answer.reasoning, answer.content, answer.calls),
    ...(answer.usage ? { usage: answer.usage } : {}),
  };
}

/** A complete Chat completion as the answer of one interaction. Throws when it did not finish cleanly. */
export function chatCompletionAnswer(input: unknown): InteractionAnswer {
  const body = object(input, "Chat response");
  if (!Array.isArray(body.choices) || body.choices.length !== 1) throw new Error("Invalid Chat choices");
  const choice = object(body.choices[0], "Chat choice");
  const status = interactionStatus(choice.finish_reason);
  if (!status) throw new Error("Chat completion did not finish successfully");
  const message = object(choice.message, "Chat message");
  const thought = message.reasoning_content ?? message.reasoning;
  if (message.content != null && typeof message.content !== "string") throw new Error("Invalid Chat content");
  const calls: InteractionAnswer["calls"] = [];
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls)) throw new Error("Invalid Chat tool calls");
    message.tool_calls.forEach((raw, index) => {
      const call = object(raw, "Chat tool call");
      const fn = object(call.function, "Chat tool function");
      const signature = callSignature(call);
      calls.push({ id: typeof call.id === "string" && call.id ? call.id : `call_interaction_${index}`, name: text(fn.name, "tool name", true), arguments: callArguments(fn.arguments), ...(signature ? { signature } : {}) });
    });
  }
  const usage = interactionUsage(body.usage);
  return { reasoning: typeof thought === "string" ? thought : "", content: (message.content as string | null | undefined) ?? "", calls, status, ...(usage ? { usage } : {}) };
}

export interface InteractionsSseEvent { event: string; data: Obj }

type StreamTool = { id?: string; name: string; arguments: string; signature?: string };
export interface InteractionsStreamState {
  meta: InteractionMeta;
  created: boolean;
  index: number;
  open?: "thought" | "model_output";
  reasoning: string;
  content: string;
  finishReason?: unknown;
  usage?: Obj;
  tools: Map<number, StreamTool>;
  toolsEmitted: boolean;
  calls: InteractionAnswer["calls"];
}

export function createInteractionsStreamState(meta: InteractionMeta): InteractionsStreamState {
  return { meta, created: false, index: -1, reasoning: "", content: "", tools: new Map(), toolsEmitted: false, calls: [] };
}

function sse(event: string, data: Obj): InteractionsSseEvent {
  return { event, data: { ...data, event_type: event } };
}

function createdEvent(state: InteractionsStreamState): InteractionsSseEvent[] {
  if (state.created) return [];
  state.created = true;
  const { id, model, created } = state.meta;
  return [sse("interaction.created", { interaction: { id, object: "interaction", status: "in_progress", model, created, updated: created } })];
}

function closeStep(state: InteractionsStreamState, events: InteractionsSseEvent[]): void {
  if (state.open === undefined) return;
  events.push(sse("step.stop", { index: state.index }));
  state.open = undefined;
}

function openStep(state: InteractionsStreamState, type: "thought" | "model_output", events: InteractionsSseEvent[]): void {
  if (state.open === type) return;
  closeStep(state, events);
  state.index++;
  state.open = type;
  events.push(sse("step.start", { index: state.index, step: { type } }));
}

/** Consume one parsed Chat chunk. The caller owns settlement and may discard these events on failure. */
export function consumeInteractionsChatChunk(state: InteractionsStreamState, input: unknown): InteractionsSseEvent[] {
  const body = object(input, "Chat chunk");
  if (body.error !== undefined) throw new Error("Chat stream error");
  const events = createdEvent(state);
  if (body.usage != null) state.usage = interactionUsage(body.usage);
  if (!Array.isArray(body.choices) || body.choices.length > 1) throw new Error("Invalid Chat chunk choices");
  if (!body.choices.length) return events;
  const choice = object(body.choices[0], "Chat choice");
  const delta = object(choice.delta, "Chat delta");
  if (state.finishReason !== undefined) throw new Error("Chat chunk after finish");
  const thought = delta.reasoning_content ?? delta.reasoning;
  if (thought != null) {
    const value = text(thought, "Chat reasoning");
    if (value) {
      openStep(state, "thought", events);
      state.reasoning += value;
      events.push(sse("step.delta", { index: state.index, delta: { type: "thought_summary", content: { type: "text", text: value } } }));
    }
  }
  if (delta.content != null) {
    const value = text(delta.content, "Chat content");
    if (value) {
      openStep(state, "model_output", events);
      state.content += value;
      events.push(sse("step.delta", { index: state.index, delta: { type: "text", text: value } }));
    }
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
      const signature = callSignature(call);
      if (signature) current.signature = signature;
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
      closeStep(state, events);
      for (const [index, tool] of [...state.tools.entries()].sort((a, b) => a[0] - b[0])) {
        const args = callArguments(tool.arguments);
        const id = tool.id ?? `call_interaction_${index}`;
        const name = text(tool.name, "tool name", true);
        if (tool.signature) {
          state.index++;
          events.push(sse("step.start", { index: state.index, step: { type: "thought" } }));
          events.push(sse("step.delta", { index: state.index, delta: { type: "thought_signature", signature: tool.signature } }));
          events.push(sse("step.stop", { index: state.index }));
        }
        state.index++;
        events.push(sse("step.start", { index: state.index, step: { type: "function_call", id, name, arguments: {} } }));
        events.push(sse("step.delta", { index: state.index, delta: { type: "arguments_delta", arguments: JSON.stringify(args) } }));
        events.push(sse("step.stop", { index: state.index }));
        state.calls.push({ id, name, arguments: args, ...(tool.signature ? { signature: tool.signature } : {}) });
      }
      state.toolsEmitted = true;
    }
  }
  return events;
}

/** The answer a finished stream produced, or undefined when it did not finish cleanly. */
export function interactionsStreamAnswer(state: InteractionsStreamState): InteractionAnswer | undefined {
  const status = interactionStatus(state.finishReason);
  if (!status || (state.tools.size > 0 && !state.toolsEmitted)) return undefined;
  return { reasoning: state.reasoning, content: state.content, calls: state.calls, status, ...(state.usage ? { usage: state.usage } : {}) };
}

/** The closing events. Call only after the outer handler confirms settlement. */
export function interactionsStreamTerminal(state: InteractionsStreamState, answer: InteractionAnswer, updated = state.meta.created): InteractionsSseEvent[] {
  const events = createdEvent(state);
  closeStep(state, events);
  const { id, model, created } = state.meta;
  events.push(sse("interaction.completed", { interaction: { id, object: "interaction", status: answer.status, model, created, updated, ...(answer.usage ? { usage: answer.usage } : {}) } }));
  return events;
}

const ERROR_CODES: Readonly<Record<number, string>> = {
  400: "invalid_argument", 401: "unauthenticated", 403: "permission_denied", 404: "not_found", 413: "invalid_argument",
  429: "resource_exhausted", 499: "cancelled", 501: "unimplemented", 503: "unavailable", 504: "deadline_exceeded",
};

/** The failure events a stream ends with after it was committed. */
export function interactionsStreamFailure(state: InteractionsStreamState, status: number, message: string): InteractionsSseEvent[] {
  const events = createdEvent(state);
  events.push(sse("error", { error: { code: ERROR_CODES[status] ?? "internal", message } }));
  return events;
}

export function encodeInteractionsEvents(events: InteractionsSseEvent[]): Uint8Array[] {
  const encoder = new TextEncoder();
  return events.map(event => encoder.encode(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`));
}


function toolCallIds(message: Obj | undefined): string[] {
  if (!message || message.role !== "assistant" || !Array.isArray(message.tool_calls)) return [];
  return message.tool_calls.flatMap(call => (isObj(call) && typeof call.id === "string" ? [call.id] : []));
}

/** Call ids of the history's last assistant turn that no later tool message answered. */
export function pendingCallIds(history: Obj[]): Set<string> {
  let last = -1;
  for (let i = history.length - 1; i >= 0; i--) if (history[i]!.role === "assistant") { last = i; break; }
  const pending = new Set(toolCallIds(history[last]));
  for (const message of history.slice(last + 1)) if (message.role === "tool" && typeof message.tool_call_id === "string") pending.delete(message.tool_call_id);
  return pending;
}

/**
 * Continue a stored history with a chained input. A leading assistant message that only resends the
 * pending calls is dropped (they are already in history). Returns undefined when a function_result the
 * input does not define is not one of the pending calls answered at the very start of the input.
 */
export function chainInput(history: Obj[], plan: Pick<InteractionsRequestPlan, "inputMessages" | "unmatchedResultIds">): Obj[] | undefined {
  const pending = pendingCallIds(history);
  let input = plan.inputMessages;
  const first = input[0];
  const resent = toolCallIds(first);
  if (first && resent.length && !first.content && resent.every(id => pending.has(id))) input = input.slice(1);
  if (!plan.unmatchedResultIds.length) return input;
  const leading = new Set<string>();
  for (const message of input) {
    if (message.role !== "tool") break;
    if (typeof message.tool_call_id === "string") leading.add(message.tool_call_id);
  }
  return plan.unmatchedResultIds.every(id => pending.has(id) && leading.has(id)) ? input : undefined;
}
