import type { AdapterRequest, IncomingMeta, ProviderAdapter } from "./base";
import { randomUUID } from "node:crypto";
import type {
  AdapterEvent,
  OcxAssistantMessage,
  OcxContentPart,
  OcxMessage,
  OcxParsedRequest,
  OcxProviderConfig,
  OcxThinkingContent,
  OcxToolCall,
  OcxUsage,
} from "../types";
import {
  isAllowedToolChoice,
  modelInList,
  namespacedToolName,
  toolChoiceToolPredicate,
} from "../types";
import { configuredReasoningEfforts, isReasoningEffortOmitted, mapReasoningEffort, modelRecordValue, reasoningEffortMapFor } from "../reasoning-effort";
import {
  readBoundedResponseBytes,
} from "../lib/bounded-body";
import { debugProviderDiagnostic } from "../lib/debug";
import {
  isTranslatorBudgetExceededError,
  retainTranslatedEventBatch,
  TRANSLATOR_MAX_SSE_EVENT_BYTES,
  TranslatorBudgetExceededError,
  type TranslatorBudget,
} from "../lib/translator-budget";
import { redactSecretString, SENSITIVE_KEY_PATTERN } from "../lib/redact";
import { parseDataUrl } from "./image";
import {
  ollamaNativeChatUrl,
  ollamaNativeEndpointKind,
  type OllamaNativeEndpointKind,
} from "./ollama-native-url";

/** Native `/api/chat` message shape used by this adapter. */
export interface OllamaNativeMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  thinking?: string;
  images?: string[];
  tool_call_id?: string;
  tool_name?: string;
  tool_calls?: Array<{
    type: "function";
    function: {
      index?: number;
      name: string;
      arguments: Record<string, unknown>;
    };
    id?: string;
  }>;
}

interface OllamaNativeTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

interface PendingToolCall {
  id: string;
  name: string;
  namespace?: string;
  wireName: string;
  order: number;
  result?: OcxMessage & { role: "toolResult" };
}

interface PendingToolBatch {
  calls: PendingToolCall[];
  byId: Map<string, PendingToolCall>;
}

interface NativeStreamToolCall {
  key: string;
  budgetKey: string;
  order: number;
  name: string;
  nativeId?: string;
  nativeIndex?: number;
  arguments: Record<string, unknown>;
  argumentBytes: number;
}

interface NativeStreamState {
  toolCalls: Map<string, NativeStreamToolCall>;
  nextToolOrder: number;
  usage?: OcxUsage;
  stopReason?: string;
  sawMessage: boolean;
  terminal: boolean;
  terminalError: boolean;
  allowParallelToolCalls: boolean;
}

type JsonRecord = Record<string, unknown>;
type NativeReadResult = { done: false; value: Uint8Array } | { done: true; value?: undefined };

const NATIVE_THINK_VALUES = new Set(["low", "medium", "high", "max"]);
const NATIVE_TOOL_ID_MAX_LENGTH = 256;
const NATIVE_TOOL_ID_CONTROL = /[\u0000-\u001f\u007f]/u;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Provider-owned call ids are carried into the client-visible Responses call_id field, so never
 * expose malformed or unbounded strings. A duplicate native id is treated like an unusable id:
 * Ollama is allowed to omit ids or repeat them across requests, while the OCX history contract
 * requires one stable, globally unique pairing key.
 */
function validNativeToolCallId(value: unknown): string | undefined {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > NATIVE_TOOL_ID_MAX_LENGTH
    || value !== value.trim()
    || NATIVE_TOOL_ID_CONTROL.test(value)
  ) return undefined;
  return value;
}

function mintNativeToolCallId(nativeIndex: number | undefined, issuedIds: Set<string>): string {
  let id = "";
  do {
    id = "ollama_call_" + randomUUID() + "_" + (nativeIndex ?? "na");
  } while (issuedIds.has(id));
  issuedIds.add(id);
  return id;
}

function allocateNativeToolCallId(
  nativeId: unknown,
  nativeIndex: number | undefined,
  issuedIds: Set<string>,
): string {
  const valid = validNativeToolCallId(nativeId);
  if (valid && !issuedIds.has(valid)) {
    issuedIds.add(valid);
    return valid;
  }
  return mintNativeToolCallId(nativeIndex, issuedIds);
}

function safeNativeString(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const redacted = redactSecretString(value.trim());
  return redacted.length > 400 ? `${redacted.slice(0, 400)}…` : redacted;
}

function errorDetail(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!isRecord(value)) return undefined;
  if (typeof value.error === "string" && value.error.trim()) return value.error.trim();
  if (isRecord(value.error) && typeof value.error.message === "string" && value.error.message.trim()) {
    return value.error.message.trim();
  }
  if (typeof value.detail === "string" && value.detail.trim()) return value.detail.trim();
  if (typeof value.message === "string" && value.message.trim()) return value.message.trim();
  return undefined;
}

function nativeErrorEvent(
  detail: unknown,
  usage?: OcxUsage,
  status = 502,
): Extract<AdapterEvent, { type: "error" }> {
  return {
    type: "error",
    status,
    errorType: "upstream_error",
    code: "ollama_native_error",
    message: safeNativeString(errorDetail(detail), "Ollama native upstream error"),
    ...(usage ? { usage } : {}),
  };
}

function malformedNativeEvent(message: string, usage?: OcxUsage): Extract<AdapterEvent, { type: "error" }> {
  return {
    type: "error",
    status: 502,
    errorType: "upstream_error",
    code: "invalid_ollama_native_payload",
    message,
    ...(usage ? { usage } : {}),
  };
}

function translationBudgetEvent(usage?: OcxUsage): Extract<AdapterEvent, { type: "error" }> {
  return {
    type: "error",
    status: 502,
    errorType: "upstream_error",
    code: "translation_buffer_limit",
    message: "upstream translation buffer exceeded the safe limit",
    ...(usage ? { usage } : {}),
  };
}

function wireModelId(provider: OcxProviderConfig, modelId: string): string {
  if (!provider.modelSuffixBracketStrip) return modelId;
  const end = modelId.trimEnd();
  if (!end.endsWith("]")) return modelId;
  const start = end.lastIndexOf("[");
  return start > 0 ? end.slice(0, start) : modelId;
}

function assertObjectArguments(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`ollama-native ${label} arguments must be a JSON object`);
  return value;
}

function normalizedBase64(value: string, label: string): string {
  const base64 = value.replace(/\s+/g, "");
  if (
    base64.length === 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)
    || base64.length % 4 === 1
  ) {
    throw new Error(`ollama-native ${label} image is not valid base64`);
  }
  return base64;
}

function imageToBase64(imageUrl: string, label: string): string {
  const data = parseDataUrl(imageUrl);
  if (data) {
    if (!data.mediaType.toLowerCase().startsWith("image/")) {
      throw new Error(`ollama-native ${label} image data URL is not an image`);
    }
    return normalizedBase64(data.base64, label);
  }
  if (/^https?:\/\//i.test(imageUrl)) {
    throw new Error(`ollama-native does not fetch remote ${label} image URLs; provide a data URL/base64 image`);
  }
  return normalizedBase64(imageUrl, label);
}

function contentToNative(
  content: string | OcxContentPart[],
  label: string,
  allowImages = true,
): { content: string; images?: string[] } {
  if (typeof content === "string") return { content };
  let text = "";
  const images: string[] = [];
  for (const part of content) {
    if (part.type === "text") {
      text += part.text;
      continue;
    }
    // Ollama's native /api/chat message shape carries `images: string[]` and has no video
    // counterpart, so a video part is refused rather than silently dropped or mis-sent as an image.
    if (part.type === "video") throw new Error(`ollama-native cannot send video content in ${label}`);
    if (!allowImages) throw new Error(`ollama-native cannot preserve images in ${label} developer content`);
    images.push(imageToBase64(part.imageUrl, label));
  }
  return images.length > 0 ? { content: text, images } : { content: text };
}

function assistantTextThinkingAndCalls(message: OcxAssistantMessage): {
  content: string;
  thinking?: string;
  calls: OcxToolCall[];
} {
  let content = "";
  let thinking = "";
  const calls: OcxToolCall[] = [];
  for (const part of message.content) {
    if (part.type === "text") content += part.text;
    else if (part.type === "thinking") thinking += (part as OcxThinkingContent).thinking;
    else if (part.type === "toolCall") calls.push(part);
  }
  return {
    content,
    ...(thinking ? { thinking } : {}),
    calls,
  };
}

function buildNativeMessages(
  parsed: OcxParsedRequest,
  reservedToolCallIds: Set<string>,
): OllamaNativeMessage[] {
  const messages: OllamaNativeMessage[] = [];
  for (const system of parsed.context.systemPrompt ?? []) {
    messages.push({ role: "system", content: system });
  }

  // A request-boundary adapter is a fresh object in production. Reserve every id already
  // present in the parsed history before the next provider response is translated, so a provider
  // id reused on a later request cannot become a duplicate OCX call_id. The set is deliberately
  // owned by this adapter/request lifecycle rather than process-global state.
  reservedToolCallIds.clear();
  let pending: PendingToolBatch | undefined;

  const flushPending = (): void => {
    if (!pending) return;
    for (const call of pending.calls) {
      if (!call.result) {
        throw new Error(`ollama-native tool call ${call.id} is missing its tool result; refusing interrupted replay`);
      }
    }
    for (const call of pending.calls) {
      const result = call.result!;
      const translated = contentToNative(result.content, "tool result");
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        tool_name: call.wireName,
        content: translated.content,
        ...(translated.images ? { images: translated.images } : {}),
      });
    }
    pending = undefined;
  };

  for (const message of parsed.context.messages) {
    if (message.role === "toolResult") {
      if (!pending) {
        throw new Error(`ollama-native orphan tool result ${message.toolCallId || "<missing-id>"}`);
      }
      const call = pending.byId.get(message.toolCallId);
      if (!call) {
        throw new Error(`ollama-native tool result ${message.toolCallId || "<missing-id>"} has no originating call`);
      }
      if (call.result) {
        throw new Error(`ollama-native duplicate tool result for ${message.toolCallId}`);
      }
      if (call.name !== message.toolName || call.namespace !== message.toolNamespace) {
        throw new Error(`ollama-native tool result ${message.toolCallId} names the wrong originating tool`);
      }
      call.result = message;
      continue;
    }

    // Native Ollama requires the whole assistant tool-call turn followed by its tool results.  A
    // new conversational message is a hard boundary; unresolved calls are never fabricated.
    if (pending) flushPending();

    switch (message.role) {
      case "user": {
        const translated = contentToNative(message.content, "user");
        messages.push({ role: "user", content: translated.content, ...(translated.images ? { images: translated.images } : {}) });
        break;
      }
      case "developer": {
        const translated = contentToNative(message.content, "developer", false);
        messages.push({ role: "system", content: translated.content });
        break;
      }
      case "assistant": {
        const extracted = assistantTextThinkingAndCalls(message);
        const wireCalls: PendingToolCall[] = [];
        const nativeCalls = extracted.calls.map((call, index) => {
          if (!call.id || reservedToolCallIds.has(call.id)) {
            throw new Error(`ollama-native assistant tool call id is missing or duplicated: ${call.id || "<missing-id>"}`);
          }
          reservedToolCallIds.add(call.id);
          const args = assertObjectArguments(call.arguments, `assistant tool call ${call.id}`);
          // `customWireName` belongs to the prior caller/provider wire.  It must not override
          // this adapter's deterministic namespace flattening during replay: a native turn is
          // paired by the OCX name/namespace, then lowered to the native wire name here.
          const wireName = namespacedToolName(call.namespace, call.name);
          if (!wireName) throw new Error(`ollama-native assistant tool call ${call.id} has no name`);
          const pendingCall: PendingToolCall = {
            id: call.id,
            name: call.name,
            namespace: call.namespace,
            wireName,
            order: index,
          };
          wireCalls.push(pendingCall);
          return {
            type: "function" as const,
            id: call.id,
            function: { index, name: wireName, arguments: args },
          };
        });
        const native: OllamaNativeMessage = {
          role: "assistant",
          content: extracted.content,
          ...(extracted.thinking ? { thinking: extracted.thinking } : {}),
          ...(nativeCalls.length > 0 ? { tool_calls: nativeCalls } : {}),
        };
        messages.push(native);
        if (wireCalls.length > 0) {
          pending = { calls: wireCalls, byId: new Map(wireCalls.map(call => [call.id, call])) };
        }
        break;
      }
    }
  }
  if (pending) flushPending();
  return messages;
}

function buildNativeTools(parsed: OcxParsedRequest): OllamaNativeTool[] | undefined {
  const declared = parsed.context.tools;
  if (!declared || declared.length === 0 || parsed.options.toolChoice === "none") return undefined;

  const choice = parsed.options.toolChoice;
  if (
    choice === "required"
    || (isAllowedToolChoice(choice) && choice.mode === "required")
    || (choice && typeof choice === "object" && !isAllowedToolChoice(choice) && "name" in choice)
  ) {
    throw new Error("ollama-native does not support required or exact named tool_choice");
  }
  const predicate = toolChoiceToolPredicate(choice, declared);
  const seenNames = new Set<string>();
  const tools: OllamaNativeTool[] = [];
  for (const tool of declared) {
    if (!predicate(tool)) continue;
    const name = namespacedToolName(tool.namespace, tool.name);
    if (!name || seenNames.has(name)) throw new Error(`ollama-native duplicate flattened tool name: ${name || "<missing>"}`);
    if (!isRecord(tool.parameters)) throw new Error(`ollama-native tool ${name} has no JSON schema object`);
    seenNames.add(name);
    tools.push({
      type: "function",
      function: {
        name,
        ...(tool.description ? { description: tool.description } : {}),
        // Native Ollama accepts the schema directly.  In particular, do not copy OpenAI's
        // function.strict flag: `/api/chat` has no documented strict field.
        parameters: tool.parameters,
      },
    });
  }
  return tools.length > 0 ? tools : undefined;
}

function nativeThink(
  provider: OcxProviderConfig,
  parsed: OcxParsedRequest,
): false | true | "low" | "medium" | "high" | "max" | undefined {
  const requested = parsed.options.reasoning;
  // The Responses parser leaves reasoning undefined when the caller made no reasoning decision.
  // Ollama distinguishes an omitted think field from think:false; preserve that distinction.
  if (requested === undefined) return undefined;
  // An explicit `__omit__` wire mapping (issue #2356) is an intentional decision to send NO
  // reasoning field. mapReasoningEffort() collapses the sentinel to `undefined`, and the
  // `?? requested` fallback below would then re-emit the requested label — defeating the
  // sentinel. Upstream consults only the BOUNDARY spelling (`ultra` → `max`) and states raw
  // ultra must never influence the provider wire, so only wireMap[boundary] can authorize an
  // omission. The explicit mapping is checked before the native `none`/noReasoning fallbacks so
  // it stays authoritative over them.
  const wireMap = reasoningEffortMapFor(provider, parsed.modelId);
  if (wireMap) {
    const boundary = requested === "ultra" ? "max" : requested;
    if (isReasoningEffortOmitted(wireMap[boundary])) return undefined;
  }
  if (requested === "none" || modelInList(provider.noReasoningModels, parsed.modelId)) return false;
  // Upstream intentionally advertises synthetic top rungs on routed rows so Codex/subagent effort
  // overrides validate against catalog membership; the wire stays honest because the native
  // adapter clamps the requested effort onto the provider's real supported ladder
  // (clampToSupportedCodexEffort: max/ultra on a [low,medium,high] model serializes "high").
  const mapped = mapReasoningEffort(provider, parsed.modelId, requested);
  if (mapped !== undefined) {
    let value = mapped;
    if (value === "minimal") value = "low";
    if (value === "xhigh" || value === "ultra") value = "max";
    if (value === "enabled" || value === "adaptive" || value === "true") return true;
    if (value === "disabled" || value === "false") return false;
    if (NATIVE_THINK_VALUES.has(value)) return value as "low" | "medium" | "high" | "max";
    throw new Error(`ollama-native does not support reasoning level "${redactSecretString(value)}"`);
  }
  // mapReasoningEffort() returned undefined. For an ordinary Codex label against a declared
  // non-empty ladder this can ONLY be an authoritative post-clamp `__omit__` sentinel (the
  // clamp resolved the requested effort onto a rung whose wire mapping is the sentinel) —
  // honour it; never resurrect the raw requested label. Native boolean aliases have no
  // mapping at all, so their raw passthrough stays isolated here.
  const supported = configuredReasoningEfforts(provider, parsed.modelId);
  const ordinaryLabel = requested === "minimal" || requested === "low" || requested === "medium"
    || requested === "high" || requested === "xhigh" || requested === "ultra"
    || requested === "max";
  if (supported !== undefined && supported.length > 0 && ordinaryLabel) return undefined;
  let value = requested;
  if (value === "minimal") value = "low";
  if (value === "enabled" || value === "adaptive" || value === "true") return true;
  if (value === "disabled" || value === "false") return false;
  if (NATIVE_THINK_VALUES.has(value)) return value as "low" | "medium" | "high" | "max";
  throw new Error(`ollama-native does not support reasoning level "${redactSecretString(value)}"`);
}

function nativeFormat(
  parsed: OcxParsedRequest,
  endpointKind: OllamaNativeEndpointKind,
): "json" | Record<string, unknown> | undefined {
  const format = parsed.options.textFormat;
  if (!format) return undefined;
  // Ollama's own documentation states "Ollama's Cloud currently does not support structured
  // outputs" (docs/capabilities/structured-outputs.mdx). Cloud does not reject `format`: it
  // returns 200 and ignores the constraint, so sending it would turn an output-shape contract
  // into unconstrained prose the caller believes is schema-valid. Refuse the contract instead,
  // the same call Kiro makes for a wire that cannot enforce it. Local and custom self-hosted
  // Ollama keep the native `format` mapping, which their contract does honour.
  if (endpointKind === "cloud") {
    throw new Error("ollama-native does not support structured output on Ollama Cloud");
  }
  if (format.type === "json_object") return "json";
  if (!format.schema || !isRecord(format.schema)) {
    throw new Error("ollama-native json_schema output requires a JSON schema object");
  }
  // Ollama's native contract takes the schema itself, unlike OpenAI's response_format wrapper.
  return format.schema;
}

function usageFromNative(value: JsonRecord | undefined): OcxUsage | undefined {
  if (!value) return undefined;
  const input = isFiniteNonNegativeInteger(value.prompt_eval_count) ? value.prompt_eval_count : undefined;
  const output = isFiniteNonNegativeInteger(value.eval_count) ? value.eval_count : undefined;
  if (input === undefined && output === undefined) return undefined;
  return { inputTokens: input ?? 0, outputTokens: output ?? 0 };
}

function stopReasonFromNative(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  if (value === "length") return "max_tokens";
  return value;
}

function nativeMessageEvents(message: JsonRecord, state: NativeStreamState, budget: TranslatorBudget): AdapterEvent[] {
  const events: AdapterEvent[] = [];
  if (message.role !== undefined && message.role !== "assistant") {
    throw new Error("ollama-native response message role was not assistant");
  }
  // Deltas are forwarded as they arrive; the parser keeps no second complete copy of the
  // response. In-flight memory is bounded by the per-line reservation in the stream reader and
  // the bounded buffered read, matching how the openai-chat adapter accounts deltas.
  if (message.thinking !== undefined) {
    if (typeof message.thinking !== "string") throw new Error("ollama-native response thinking was not text");
    if (message.thinking) events.push({ type: "reasoning_raw_delta", text: message.thinking });
  }
  if (message.content !== undefined) {
    if (typeof message.content !== "string") throw new Error("ollama-native response content was not text");
    if (message.content) events.push({ type: "text_delta", text: message.content });
  }
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls)) throw new Error("ollama-native response tool_calls was not an array");
    for (let position = 0; position < message.tool_calls.length; position++) {
      const rawCall = message.tool_calls[position];
      if (!isRecord(rawCall) || !isRecord(rawCall.function)) {
        throw new Error("ollama-native response tool call was malformed");
      }
      const fn = rawCall.function;
      if (typeof fn.name !== "string" || !fn.name.trim()) throw new Error("ollama-native response tool call had no name");
      const args = assertObjectArguments(fn.arguments, "response tool call");
      const index = isFiniteNonNegativeInteger(fn.index) ? fn.index : undefined;
      const nativeId = validNativeToolCallId(rawCall.id);
      const key = index === undefined ? `position:${position}` : `index:${index}`;
      // Tool-call identity is explicitly keyed by the provider index when supplied: a later
      // frame for the same index updates that call's arguments, while a distinct index creates a
      // second call. This narrow tool-call compatibility rule is independent from text/thinking
      // semantics, where every non-empty native field is an appended partial delta.
      const existing = state.toolCalls.get(key);
      if (!existing && !state.allowParallelToolCalls && state.toolCalls.size > 0) {
        throw new Error("ollama-native provider emitted parallel tool calls while parallelToolCalls:false was requested");
      }
      if (existing) {
        if (existing.name !== fn.name) throw new Error("ollama-native response reused a tool-call index for another function");
        if (nativeId && existing.nativeId && nativeId !== existing.nativeId) {
          throw new Error("ollama-native response changed a tool-call id for an existing index");
        }
        if (!existing.nativeId && nativeId) existing.nativeId = nativeId;
        replaceNativeToolArguments(existing, args, budget);
      } else {
        const call: NativeStreamToolCall = {
          key,
          budgetKey: `ollama-native:${key}`,
          order: state.nextToolOrder++,
          name: fn.name,
          ...(nativeId ? { nativeId } : {}),
          ...(index !== undefined ? { nativeIndex: index } : {}),
          arguments: args,
          argumentBytes: 0,
        };
        budget.openCall(call.budgetKey);
        try {
          replaceNativeToolArguments(call, args, budget);
          state.toolCalls.set(key, call);
        } catch (error) {
          budget.closeCall(call.budgetKey);
          throw error;
        }
      }
      events.push({ type: "heartbeat" });
    }
  }
  state.sawMessage = true;
  return events;
}

function flushNativeStreamToolCalls(
  state: NativeStreamState,
  issuedToolCallIds: Set<string>,
): AdapterEvent[] {
  const events: AdapterEvent[] = [];
  const ordered = [...state.toolCalls.values()].sort((a, b) => a.order - b.order);
  for (const call of ordered) {
    const id = allocateNativeToolCallId(call.nativeId, call.nativeIndex, issuedToolCallIds);
    events.push({ type: "tool_call_start", id, name: call.name });
    events.push({ type: "tool_call_delta", arguments: JSON.stringify(call.arguments) });
    events.push({ type: "tool_call_end" });
  }
  return events;
}

function replaceNativeToolArguments(
  call: NativeStreamToolCall,
  args: Record<string, unknown>,
  budget: TranslatorBudget,
): void {
  const nextBytes = new TextEncoder().encode(JSON.stringify(args)).byteLength;
  if (nextBytes > TRANSLATOR_MAX_SSE_EVENT_BYTES) {
    throw new TranslatorBudgetExceededError("tool_args", TRANSLATOR_MAX_SSE_EVENT_BYTES);
  }
  if (nextBytes === 0) {
    if (call.argumentBytes > 0) budget.releaseRetained(call.argumentBytes, { kind: "tool_args", callId: call.budgetKey });
    call.arguments = args;
    call.argumentBytes = 0;
    return;
  }
  const reservation = budget.reserveTransient(nextBytes, { kind: "tool_args", callId: call.budgetKey });
  try {
    reservation.commitRetained();
    if (call.argumentBytes > 0) budget.releaseRetained(call.argumentBytes, { kind: "tool_args", callId: call.budgetKey });
    call.arguments = args;
    call.argumentBytes = nextBytes;
  } catch (error) {
    reservation.release();
    throw error;
  }
}

function releaseNativeStateBuffers(state: NativeStreamState, budget: TranslatorBudget): void {
  for (const call of state.toolCalls.values()) budget.closeCall(call.budgetKey);
}

function nativeBodyMessage(value: unknown): JsonRecord {
  if (!isRecord(value)) throw new Error("ollama-native response message was missing or malformed");
  return value;
}

function nativeEventsFromResponsePayload(
  payload: unknown,
  budget: TranslatorBudget,
  issuedToolCallIds: Set<string>,
  allowParallelToolCalls = true,
): AdapterEvent[] {
  if (!isRecord(payload)) return [malformedNativeEvent("Ollama native response was not a JSON object")];
  if (payload.error !== undefined && payload.error !== null) return [nativeErrorEvent(payload.error)];

  const state: NativeStreamState = {
    toolCalls: new Map(),
    nextToolOrder: 0,
    usage: usageFromNative(payload),
    stopReason: stopReasonFromNative(payload.done_reason),
    sawMessage: false,
    terminal: false,
    terminalError: false,
    allowParallelToolCalls,
  };
  // Same terminal contract as the NDJSON path — enforced BEFORE any actionable emission. The
  // complete payload is already in memory and known invalid, so partial text and tool calls from
  // it are suppressed along with the terminal: a truncated upstream reply must never be
  // mistaken for a finished turn, and tool calls parsed out of one must never execute.
  if (payload.done !== true) {
    state.terminalError = true;
    const reason = payload.done === undefined
      ? "Ollama native response did not include done:true"
      : payload.done === false
        ? "Ollama native response reported done:false"
        : "Ollama native response done flag was not boolean";
    return [malformedNativeEvent(reason, state.usage)];
  }
  try {
    const events = nativeMessageEvents(nativeBodyMessage(payload.message), state, budget);
    events.push(...flushNativeStreamToolCalls(state, issuedToolCallIds));
    events.push({ type: "done", ...(state.usage ? { usage: state.usage } : {}), ...(state.stopReason ? { stopReason: state.stopReason } : {}) });
    state.terminal = true;
    return events;
  } catch (error) {
    const events = isTranslatorBudgetExceededError(error)
      ? [translationBudgetEvent(state.usage)]
      : [malformedNativeEvent(error instanceof Error ? error.message : "Malformed Ollama native response", state.usage)];
    state.terminalError = true;
    return events;
  } finally {
    releaseNativeStateBuffers(state, budget);
  }
}

function formatNativeErrorBody(status: number, _headers: Headers, payloadText: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadText);
  } catch {
    return status === 401 || status === 403
      ? "Ollama authentication failed"
      : status === 404
        ? "Ollama native endpoint or model was not found"
        : status === 429
          ? "Ollama rate limit was exceeded"
          : status >= 500
            ? "Ollama native upstream failed"
            : "";
  }
  const detail = errorDetail(parsed);
  if (detail) return redactSecretString(detail).slice(0, 400);
  return status === 401 || status === 403
    ? "Ollama authentication failed"
    : status === 404
      ? "Ollama native endpoint or model was not found"
      : status === 429
        ? "Ollama rate limit was exceeded"
        : status >= 500
          ? "Ollama native upstream failed"
          : "";
}

function buildHeaders(
  provider: OcxProviderConfig,
  endpointKind: OllamaNativeEndpointKind,
): { headers: Record<string, string>; hasCredential: boolean } {
  if (provider.authMode === "forward") {
    throw new Error("ollama-native does not support forwarded caller credentials");
  }
  const hasApiKey = typeof provider.apiKey === "string" && provider.apiKey.trim().length > 0;
  const local = endpointKind === "local" || provider.authMode === "local";
  const plaintextRemote = endpointKind === "custom" && new URL(provider.baseUrl).protocol === "http:";
  // A copied provider row can carry credential headers even when apiKey is empty, and a
  // key-optional custom row would otherwise ship them to a plaintext remote. Detect them with
  // the shared credential-bearing name authority instead of a narrower local list.
  const credentialHeaders = Object.keys(provider.headers ?? {}).filter(key =>
    SENSITIVE_KEY_PATTERN.test(key.trim()),
  );
  if (plaintextRemote && (hasApiKey || credentialHeaders.length > 0)) {
    throw new Error(
      "ollama-native refuses to send credentials over plaintext non-loopback HTTP"
        + (hasApiKey ? "" : ` (credential headers: ${credentialHeaders.join(", ")})`),
    );
  }
  const hasCredential = hasApiKey;
  const requiresCredential = !local && (provider.authMode === undefined || provider.authMode === "key" || provider.authMode === "oauth");
  if (requiresCredential && !hasCredential && !provider.keyOptional) {
    throw new Error("ollama-native cloud/custom endpoint requires a non-empty API credential");
  }

  // Same precedence as openAIChatTransport(): the generated Bearer is laid down FIRST and
  // provider.headers are applied LAST, so an explicitly configured Authorization wins. Collision
  // handling is case-insensitive and leaves exactly ONE effective credential spelling on the wire.
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!local && hasCredential) headers.Authorization = `Bearer ${provider.apiKey!.trim()}`;
  for (const [key, value] of Object.entries(provider.headers ?? {})) {
    // Loopback/local targets get no credentials at all — not even ones the row already carried —
    // so a shared provider object cannot leak a shared credential to a local endpoint.
    if (local && SENSITIVE_KEY_PATTERN.test(key.trim())) continue;
    const lower = key.toLowerCase();
    for (const existing of Object.keys(headers)) {
      if (existing.toLowerCase() === lower && existing !== key) delete headers[existing];
    }
    headers[key] = value;
  }
  // Diagnostics carry the FACT that a credential is attached, never any header value.
  return {
    headers,
    hasCredential: !local && (hasCredential
      || Object.keys(provider.headers ?? {}).some(k => SENSITIVE_KEY_PATTERN.test(k.trim()))),
  };
}

function replaceLiveBuffer(
  budget: TranslatorBudget,
  previousBytes: number,
  nextBytes: number,
): void {
  // Release BEFORE reserving: the retained bound tracks what is actually in memory, so growing
  // the residual never transiently charges old + new together.
  if (previousBytes > 0) budget.releaseRetained(previousBytes, { kind: "live_transient" });
  if (nextBytes > TRANSLATOR_MAX_SSE_EVENT_BYTES) {
    throw new TranslatorBudgetExceededError("live_transient", TRANSLATOR_MAX_SSE_EVENT_BYTES);
  }
  if (nextBytes > 0) {
    const reservation = budget.reserveTransient(nextBytes, { kind: "live_transient" });
    reservation.commitRetained();
  }
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<NativeReadResult> {
  if (!signal) return await reader.read() as NativeReadResult;
  if (signal.aborted) throw signal.reason;
  const read = reader.read();
  void read.catch(() => undefined);
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort?.(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const result = await Promise.race([read, aborted]);
    if (signal.aborted) throw signal.reason;
    return result as NativeReadResult;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function streamState(allowParallelToolCalls = true): NativeStreamState {
  return {
    toolCalls: new Map(),
    nextToolOrder: 0,
    sawMessage: false,
    terminal: false,
    terminalError: false,
    allowParallelToolCalls,
  };
}

function processNativeLine(
  line: string,
  state: NativeStreamState,
  budget: TranslatorBudget,
  issuedToolCallIds: Set<string>,
): AdapterEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    state.terminal = true;
    state.terminalError = true;
    return [malformedNativeEvent("Ollama native stream contained malformed NDJSON")];
  }
  if (!isRecord(parsed)) {
    state.terminal = true;
    state.terminalError = true;
    return [malformedNativeEvent("Ollama native stream line was not a JSON object")];
  }
  if (state.terminal) {
    state.terminalError = true;
    return [malformedNativeEvent("Ollama native stream emitted data after its terminal record")];
  }
  if (parsed.error !== undefined && parsed.error !== null) {
    state.terminal = true;
    state.terminalError = true;
    return [nativeErrorEvent(parsed.error, state.usage)];
  }
  if (parsed.prompt_eval_count !== undefined || parsed.eval_count !== undefined) {
    state.usage = usageFromNative(parsed) ?? state.usage;
  }
  if (parsed.done_reason !== undefined) state.stopReason = stopReasonFromNative(parsed.done_reason);

  const events: AdapterEvent[] = [];
  if (parsed.message !== undefined) {
    try {
      events.push(...nativeMessageEvents(nativeBodyMessage(parsed.message), state, budget));
    } catch (error) {
      if (isTranslatorBudgetExceededError(error)) throw error;
      state.terminal = true;
      state.terminalError = true;
      return [malformedNativeEvent(error instanceof Error ? error.message : "Malformed Ollama native stream message", state.usage)];
    }
  }
  if (parsed.done !== undefined && typeof parsed.done !== "boolean") {
    state.terminal = true;
    state.terminalError = true;
    return [malformedNativeEvent("Ollama native stream done flag was not boolean", state.usage)];
  }
  if (parsed.done === true) {
    state.terminal = true;
    events.push(...flushNativeStreamToolCalls(state, issuedToolCallIds));
    events.push({ type: "done", ...(state.usage ? { usage: state.usage } : {}), ...(state.stopReason ? { stopReason: state.stopReason } : {}) });
  }
  return events;
}

async function* parseOllamaNativeStream(
  response: Response,
  budget: TranslatorBudget,
  signal?: AbortSignal,
  issuedToolCallIds?: Set<string>,
  allowParallelToolCalls = true,
): AsyncGenerator<AdapterEvent> {
  if (!response.body) {
    yield malformedNativeEvent("Ollama native response had no body");
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  const state = streamState(allowParallelToolCalls);
  const issuedIds = issuedToolCallIds ?? new Set<string>();
  let buffer = "";
  let bufferBytes = 0;
  let mustCancel = false;

  const ingest = function* (text: string): Generator<AdapterEvent> {
    if (!text) return;
    buffer += text;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    // The safety bound applies to the genuinely retained residual — the incomplete NDJSON record
    // still being assembled — and to each complete record below. It must never depend on the
    // transport read size (one read may carry many valid records) nor transiently charge
    // old + replacement together. On a ceiling violation the old reservation is left in place so
    // the generator's finally releases exactly what is held.
    const residualBytes = encoder.encode(buffer).byteLength;
    if (residualBytes > TRANSLATOR_MAX_SSE_EVENT_BYTES) {
      throw new TranslatorBudgetExceededError("live_transient", TRANSLATOR_MAX_SSE_EVENT_BYTES);
    }
    replaceLiveBuffer(budget, bufferBytes, residualBytes);
    bufferBytes = residualBytes;

    for (const rawLine of lines) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      const lineBytes = encoder.encode(line).byteLength;
      if (lineBytes > TRANSLATOR_MAX_SSE_EVENT_BYTES) {
        throw new TranslatorBudgetExceededError("live_transient", TRANSLATOR_MAX_SSE_EVENT_BYTES);
      }
      if (lineBytes > 0) {
        const reservation = budget.reserveTransient(lineBytes, { kind: "live_transient" });
        reservation.commitRetained();
        try {
          // The Responses terminal guard may stop consuming immediately after it sees `done`.
          const events = processNativeLine(line, state, budget, issuedIds);
          yield* events;
        } finally {
          budget.releaseRetained(lineBytes, { kind: "live_transient" });
        }
      }
      if (state.terminal) {
        return;
      }
    }
  };

  try {
    while (true) {
      const read = await readWithAbort(reader, signal);
      if (read.done) break;
      if (!read.value || read.value.byteLength === 0) continue;
      yield* ingest(decoder.decode(read.value, { stream: true }));
      if (state.terminal) {
        mustCancel = true;
        return;
      }
    }
      yield* ingest(decoder.decode());
    if (!state.terminal && buffer.length > 0) {
      const rawLine = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      const lineBytes = encoder.encode(rawLine).byteLength;
      if (lineBytes > TRANSLATOR_MAX_SSE_EVENT_BYTES) throw new TranslatorBudgetExceededError("live_transient", TRANSLATOR_MAX_SSE_EVENT_BYTES);
      try {
        // The EOF record keeps its residual charge while it is parsed and consumed — releasing it
        // first would drop the accounting before the record is translated (and let a near-limit
        // record's tool arguments slip past the turn cap that the newline-terminated path pays).
        const events = processNativeLine(rawLine, state, budget, issuedIds);
        yield* events;
      } finally {
        replaceLiveBuffer(budget, bufferBytes, 0);
        bufferBytes = 0;
      }
    }
    if (!state.terminal) {
      mustCancel = true;
      const event = malformedNativeEvent(
        state.sawMessage || state.toolCalls.size > 0
          ? "Ollama native stream ended before done:true"
          : "Ollama native stream ended without a terminal record",
        state.usage,
      );
      state.terminalError = true;
      yield event;
    } else {
      mustCancel = true;
    }
  } catch (error) {
    mustCancel = true;
    let event: AdapterEvent;
    if (isTranslatorBudgetExceededError(error)) {
      event = translationBudgetEvent(state.usage);
    } else if (signal?.aborted) {
      event = { type: "error", status: 499, message: "client closed request while reading Ollama native stream" };
    } else {
      event = malformedNativeEvent("Ollama native stream could not be decoded", state.usage);
    }
    state.terminalError = true;
    yield event;
  } finally {
    if (bufferBytes > 0) budget.releaseRetained(bufferBytes, { kind: "live_transient" });
    releaseNativeStateBuffers(state, budget);
    if (mustCancel) {
      try { await reader.cancel(); } catch { /* the upstream body may already be closed */ }
    }
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

async function parseOllamaNativeResponse(
  response: Response,
  budget: TranslatorBudget,
  issuedToolCallIds: Set<string>,
  allowParallelToolCalls = true,
): Promise<AdapterEvent[]> {
  const bounded = await readBoundedResponseBytes(response, { maxBytes: TRANSLATOR_MAX_SSE_EVENT_BYTES });
  if (bounded.oversized) return [malformedNativeEvent("Ollama native response exceeded the safe body limit")];
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bounded.bytes));
  } catch {
    return [malformedNativeEvent("Ollama native response was not valid JSON")];
  }
  const retainedBytes = bounded.bytes.byteLength;
  if (retainedBytes > 0) budget.chargeRetained(retainedBytes, { kind: "retained_collectors" });
  try {
    const events = nativeEventsFromResponsePayload(payload, budget, issuedToolCallIds, allowParallelToolCalls);
    try {
      retainTranslatedEventBatch(events, budget);
    } catch (error) {
      if (isTranslatorBudgetExceededError(error)) return [translationBudgetEvent()];
      throw error;
    }
    return events;
  } finally {
    if (retainedBytes > 0) budget.releaseRetained(retainedBytes, { kind: "retained_collectors" });
  }
}

export function createOllamaNativeAdapter(provider: OcxProviderConfig): ProviderAdapter {
  let requestAbortSignal: AbortSignal | undefined;
  let requestAllowsParallelToolCalls = true;
  const issuedToolCallIds = new Set<string>();
  return {
    name: "ollama-native",
    formatErrorBody: formatNativeErrorBody,

    buildRequest(parsed: OcxParsedRequest, incoming?: IncomingMeta): AdapterRequest {
      requestAbortSignal = incoming?.abortSignal;
      requestAllowsParallelToolCalls = parsed.options.parallelToolCalls !== false;
      const url = ollamaNativeChatUrl(provider.baseUrl);
      const endpointKind = ollamaNativeEndpointKind(provider.baseUrl);
      const { headers, hasCredential } = buildHeaders(provider, endpointKind);
      const messages = buildNativeMessages(parsed, issuedToolCallIds);
      const tools = buildNativeTools(parsed);
      const format = nativeFormat(parsed, endpointKind);
      const options: Record<string, unknown> = {};
      const maxOutputTokens = parsed.options.maxOutputTokens
        ?? modelRecordValue(provider.modelMaxOutputTokens, parsed.modelId)
        ?? provider.defaultMaxOutputTokens;
      // Same gate semantics as the openai-chat adapter (modelInList on the provider lists).
      // Ollama's native Options carries every one of these under its own spelling.
      if (maxOutputTokens !== undefined) options.num_predict = maxOutputTokens;
      if (parsed.options.temperature !== undefined
        && !modelInList(provider.noTemperatureModels, parsed.modelId)) {
        options.temperature = parsed.options.temperature;
      }
      if (parsed.options.topP !== undefined
        && !modelInList(provider.noTopPModels, parsed.modelId)) {
        options.top_p = parsed.options.topP;
      }
      if (parsed.options.stopSequences !== undefined) options.stop = parsed.options.stopSequences;
      if (parsed.options.presencePenalty !== undefined
        && !modelInList(provider.noPenaltyModels, parsed.modelId)) {
        options.presence_penalty = parsed.options.presencePenalty;
      }
      if (parsed.options.frequencyPenalty !== undefined
        && !modelInList(provider.noPenaltyModels, parsed.modelId)) {
        options.frequency_penalty = parsed.options.frequencyPenalty;
      }

      const think = nativeThink(provider, parsed);
      const body: Record<string, unknown> = {
        model: wireModelId(provider, parsed.modelId),
        messages,
        stream: parsed.stream,
        ...(think !== undefined ? { think } : {}),
        ...(tools ? { tools } : {}),
        ...(format !== undefined ? { format } : {}),
        ...(Object.keys(options).length > 0 ? { options } : {}),
      };
      const bodyJson = JSON.stringify(body);
      debugProviderDiagnostic("ollama-native", "request", {
        host: (() => { try { return new URL(url).host; } catch { return "upstream"; } })(),
        model: body.model,
        stream: parsed.stream,
        messageCount: messages.length,
        toolCount: tools?.length ?? 0,
        hasCredential,
        bodyBytes: new TextEncoder().encode(bodyJson).byteLength,
        thinkingRequested: parsed.options.reasoning !== undefined,
      });
      return { url, method: "POST", headers, body: bodyJson };
    },

    parseStream(response: Response, budget: TranslatorBudget): AsyncGenerator<AdapterEvent> {
      return parseOllamaNativeStream(
        response,
        budget,
        requestAbortSignal,
        issuedToolCallIds,
        requestAllowsParallelToolCalls,
      );
    },

    async parseResponse(response: Response, budget: TranslatorBudget): Promise<AdapterEvent[]> {
      return await parseOllamaNativeResponse(
        response,
        budget,
        issuedToolCallIds,
        requestAllowsParallelToolCalls,
      );
    },
  };
}
