import type { AdapterRequest, ProviderAdapter } from "./base";
import type { AdapterEvent, OcxAssistantMessage, OcxContentPart, OcxMessage, OcxParsedRequest, OcxProviderConfig, OcxTextContent, OcxThinkingContent, OcxToolCall, OcxUsage } from "../types";
import { isAllowedToolChoice, modelInList, namespacedToolName, resolveToolChoiceWireName, toolChoiceToolPredicate } from "../types";
import { mapReasoningEffort, modelRecordValue } from "../reasoning-effort";
import { debugProviderDiagnostic } from "../lib/debug";
import { sseFieldValue } from "../lib/sse-decoder";
import { isDebugEnabled } from "../lib/debug-settings";
import { isCyberPolicyCode } from "../lib/errors";
import { redactSecretString } from "../lib/redact";
import { contentPartsToText } from "./image";
import { identifyRoutedModel } from "./identity";
import { peekReasoningForCall } from "../responses/reasoning-replay-cache";
import { buildNonOpenAIToolCatalogNudgeForTools, shouldInjectNonOpenAIToolCatalogNudge } from "./tool-catalog-nudge";
import { openRouterProviderPayload, resolveOpenRouterRouting } from "../providers/openrouter-routing";
import {
  canForwardForeignServiceTierForChatModel,
  fastPolicyForModel,
  supportsServiceTierForModel,
} from "../providers/service-tier";
import {
  canonicalFastTierMarker,
  createAdapterTierMetadata,
  decideTier,
  type AdapterTierMetadata,
  type ResolvedFastPolicy,
} from "../providers/fastwire";
import { openaiChatCompletionsUrl } from "./openai-chat-url";
import { stripResponsesOnlyEncryptedMarker } from "./responses-tool-schema";
import {
  isTranslatorBudgetExceededError,
  retainTranslatedEventBatch,
  TRANSLATOR_MAX_SSE_EVENT_BYTES,
  type TranslatorBudget,
} from "../lib/translator-budget";

// Providers may opt into stripping one trailing "[...]" group from the wire model id.
// Z.AI needs this because its OpenAI path rejects glm-5.2[1m] with 400 code 1211;
// unflagged OpenAI-compatible providers and the Anthropic adapter keep ids verbatim.
export function stripBracketedModelSuffix(modelId: string): string {
  const suffixEnd = modelId.trimEnd().length;
  if (suffixEnd === 0 || modelId[suffixEnd - 1] !== "]") return modelId;

  let suffixStart = -1;
  for (let i = suffixEnd - 2; i >= 0 && modelId[i] !== "]"; i--) {
    if (modelId[i] === "[") suffixStart = i;
  }
  return suffixStart === -1 ? modelId : modelId.slice(0, suffixStart);
}

const CHAT_PASSTHROUGH_FIELDS = [
  "audio",
  "frequency_penalty",
  "logit_bias",
  "logprobs",
  "max_completion_tokens",
  "max_tokens",
  "metadata",
  "modalities",
  "n",
  "prediction",
  "presence_penalty",
  "reasoning_effort",
  "response_format",
  "seed",
  "stop",
  "store",
  "temperature",
  "tool_choice",
  "tools",
  "top_logprobs",
  "top_p",
  "user",
  "web_search_options",
] as const;

function openAIChatTransport(provider: OcxProviderConfig): {
  url: string;
  headers: Record<string, string>;
  hasCredential: boolean;
} {
  const hasCredential = typeof provider.apiKey === "string" && provider.apiKey.trim().length > 0;
  if ((provider.authMode === "key" || provider.authMode === "oauth") && !provider.keyOptional && !hasCredential) {
    throw new Error(`${provider.adapter} requires a non-empty credential (authMode: ${provider.authMode})`);
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (hasCredential) headers.Authorization = `Bearer ${provider.apiKey}`;
  if (provider.headers) Object.assign(headers, provider.headers);
  return { url: openaiChatCompletionsUrl(provider.baseUrl), headers, hasCredential };
}

/**
 * Build a provider request from an inbound Chat Completions body without translating it
 * through the Responses contract. This is deliberately a whitelist: Chat-only caller
 * fields retain their exact wire representation, while provider capability gates remain
 * centralized beside the ordinary openai-chat adapter.
 */
export function buildOpenAIChatPassthroughRequest(
  provider: OcxProviderConfig,
  rawBody: Record<string, unknown>,
  modelId: string,
  stream: boolean,
  fastPolicy: ResolvedFastPolicy = fastPolicyForModel(provider, modelId, undefined, "chat"),
  fastMode?: boolean,
): AdapterRequest {
  const { url, headers, hasCredential } = openAIChatTransport(provider);

  const body: Record<string, unknown> = {
    model: provider.modelSuffixBracketStrip ? stripBracketedModelSuffix(modelId) : modelId,
    messages: rawBody.messages,
    stream,
  };
  for (const field of CHAT_PASSTHROUGH_FIELDS) {
    if (rawBody[field] !== undefined) body[field] = rawBody[field];
  }

  const openRouterRouting = resolveOpenRouterRouting(provider, modelId);
  if (openRouterRouting) body.provider = openRouterProviderPayload(openRouterRouting);

  if (modelInList(provider.noTemperatureModels, modelId)) delete body.temperature;
  if (modelInList(provider.noTopPModels, modelId)) delete body.top_p;
  if (modelInList(provider.noPenaltyModels, modelId)) {
    delete body.presence_penalty;
    delete body.frequency_penalty;
  }
  // Exact match, unlike the gates above: `noStructuredOutputModels` is documented as
  // "only an exact requested-model match omits the field" (#1424), and the Responses
  // ingress enforces exactly that. A prefix match here would strip response_format from
  // `<listed>:<tag>` siblings the operator never opted out, silently returning prose.
  if (provider.noStructuredOutputModels?.includes(modelId)) delete body.response_format;

  // Run the same complete Fast policy as the translated Chat path, including explicit
  // fastMode and foreign-tier handling. On inherited canonical Fast, the passthrough still
  // retains the caller's exact spelling; forced Fast uses the policy-owned wire value.
  const callerTier = typeof rawBody.service_tier === "string" ? rawBody.service_tier : undefined;
  const tierDecision = decideTier(fastPolicy, fastMode, callerTier);
  if (tierDecision.kind === "set") {
    body.service_tier = fastMode === undefined && canonicalFastTierMarker(callerTier) !== undefined
      ? callerTier
      : tierDecision.value;
  } else if (tierDecision.kind === "forward-caller" && rawBody.service_tier !== undefined) {
    body.service_tier = rawBody.service_tier;
  }
  if (provider.promptCacheKey && rawBody.prompt_cache_key !== undefined) {
    body.prompt_cache_key = rawBody.prompt_cache_key;
  }
  if (Array.isArray(rawBody.tools) && rawBody.tools.length > 0) {
    if (provider.parallelToolCalls === true) {
      body.parallel_tool_calls = rawBody.parallel_tool_calls !== false;
    } else if (provider.parallelToolCalls === false
        && (provider.baseUrl === "https://integrate.api.nvidia.com/v1" || provider.pinParallelToolCallsFalse === true)) {
      body.parallel_tool_calls = false;
    }
  }
  if (stream) {
    const callerOptions = rawBody.stream_options !== null
        && typeof rawBody.stream_options === "object"
        && !Array.isArray(rawBody.stream_options)
      ? rawBody.stream_options as Record<string, unknown>
      : {};
    body.stream_options = { ...callerOptions, include_usage: true };
  } else if (rawBody.stream_options !== undefined) {
    body.stream_options = rawBody.stream_options;
  }

  const bodyJson = JSON.stringify(body);

  if (isDebugEnabled()) {
    let host = "upstream";
    try { host = new URL(url).host; } catch { /* keep fallback */ }
    debugProviderDiagnostic("openai-chat", "passthrough-request", {
      host,
      model: body.model,
      stream,
      messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
      toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
      hasCredential,
      bodyBytes: new TextEncoder().encode(bodyJson).length,
    });
  }

  return { url, method: "POST", headers, body: bodyJson };
}

// 260715 (issue #126): surface upstream error detail through the web-search sidecar loop.
// loop.ts only appends a suffix to "Provider error N" when the adapter exposes
// formatErrorBody; without it, strict OpenAI-compatible backends (NVIDIA NIM pydantic
// validation, "This model only supports single tool-calls at once!", etc.) were reduced
// to a bare status code. JSON-only extraction: recognized string fields are returned,
// HTML/non-JSON bodies yield "" so raw markup is never echoed to the client.
export function formatOpenAIChatErrorBody(status: number, _headers: Headers, payloadText: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadText);
  } catch {
    return "";
  }
  const detail = extractErrorDetail(parsed);
  if (!detail) return "";
  return redactSecretString(detail).slice(0, 400);
}

function extractErrorDetail(parsed: unknown): string | undefined {
  if (typeof parsed === "string") return parsed.trim() || undefined;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  const err = obj.error;
  if (typeof err === "string" && err.trim()) return err.trim();
  if (err !== null && typeof err === "object" && !Array.isArray(err)) {
    const msg = (err as Record<string, unknown>).message;
    if (typeof msg === "string" && msg.trim()) return msg.trim();
  }
  const det = obj.detail;
  if (typeof det === "string" && det.trim()) return det.trim();
  if (Array.isArray(det)) {
    const msgs = det
      .map(item => (item !== null && typeof item === "object" && typeof (item as Record<string, unknown>).msg === "string"
        ? ((item as Record<string, unknown>).msg as string).trim()
        : ""))
      .filter(m => m.length > 0);
    if (msgs.length > 0) return msgs.join("; ");
  }
  if (typeof obj.message === "string" && obj.message.trim()) return obj.message.trim();
  if (typeof obj.title === "string" && obj.title.trim()) return obj.title.trim();
  return undefined;
}

function unwrapChatCompletionPayload(json: Record<string, unknown>): Record<string, unknown> {
  if ((json.error !== undefined && json.error !== null) || Array.isArray(json.choices)) return json;
  const data = json.data;
  return data !== null && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : json;
}

interface OpenAIChatError {
  message?: unknown;
  code?: unknown;
  type?: unknown;
  status?: unknown;
  metadata?: unknown;
}

function safeUpstreamRequestId(metadata: unknown): string | undefined {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const record = metadata as Record<string, unknown>;
  const value = record.request_id ?? record.requestId;
  if (typeof value !== "string") return undefined;
  const requestId = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId)
    && redactSecretString(requestId) === requestId
    ? requestId
    : undefined;
}

function upstreamErrorEvent(
  error: unknown,
  usage?: OcxUsage,
): Extract<AdapterEvent, { type: "error" }> {
  const details = error !== null && typeof error === "object" && !Array.isArray(error)
    ? error as OpenAIChatError
    : undefined;
  const rawMessage = typeof error === "string"
    ? error.trim() || "upstream error"
    : typeof details?.message === "string" ? details.message : "upstream error";
  const safeMessage = redactSecretString(rawMessage);
  const requestId = safeUpstreamRequestId(details?.metadata);
  const message = requestId !== undefined && !safeMessage.includes(requestId)
    ? `${safeMessage} (request ID: ${requestId})`
    : safeMessage;
  const code = typeof details?.code === "string"
    ? details.code
    : typeof details?.code === "number" && Number.isFinite(details.code) && Number.isInteger(details.code)
      ? String(details.code)
      : undefined;
  const errorType = typeof details?.type === "string" ? details.type : undefined;
  const codeStatus = typeof details?.code === "number"
    && Number.isInteger(details.code)
    && details.code >= 100
    && details.code <= 599
    ? details.code
    : undefined;
  const status = isCyberPolicyCode(code)
    ? 400
    : typeof details?.status === "number" && Number.isInteger(details.status)
      ? details.status
      : codeStatus;
  return {
    type: "error",
    message,
    ...(usage !== undefined ? { usage } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(errorType !== undefined ? { errorType } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

function stopReasonFor(finishReason: unknown): "max_tokens" | "content_filter" | undefined {
  return finishReason === "length"
    ? "max_tokens"
    : finishReason === "content_filter"
      ? "content_filter"
      : undefined;
}

function reasoningTextFrom(record: Record<string, unknown>): string | undefined {
  return typeof record.reasoning_content === "string" && record.reasoning_content.length > 0
    ? record.reasoning_content
    : typeof record.reasoning === "string" && record.reasoning.length > 0
      ? record.reasoning
      : undefined;
}

function invalidChoicesEvent(usage?: OcxUsage): Extract<AdapterEvent, { type: "error" }> {
  return {
    type: "error",
    message: "upstream response contained invalid choices",
    ...(usage !== undefined ? { usage } : {}),
  };
}

function invalidToolCallsEvent(
  rawToolCalls: unknown,
  mode: "stream" | "response",
  usage?: OcxUsage,
  diagnosticOverride?: InvalidToolCallDiagnostic,
): Extract<AdapterEvent, { type: "error" }> {
  // The streamed accumulator knows things a rescan cannot: which field on which pending call
  // was actually rejected. Without the override, a stream carrying accepted padding on call 0
  // and a real defect on call 1 blames call 0, because the stateless scan stops at the first
  // structurally odd value it sees.
  const diagnostic = diagnosticOverride ?? diagnoseInvalidToolCalls(rawToolCalls, mode);
  const detail = diagnostic
    ? ` (${diagnostic.reason}${diagnostic.callIndex !== undefined ? `; callIndex=${diagnostic.callIndex}` : ""}; valueType=${diagnostic.valueType})`
    : "";
  return {
    type: "error",
    status: 502,
    errorType: "upstream_error",
    message: `upstream response contained invalid tool calls${detail}`,
    ...(usage !== undefined ? { usage } : {}),
  };
}

/**
 * A streamed tool call is only dispatchable once the upstream has named the function.
 *
 * The OpenAI streaming convention puts `function.name` in the first chunk for a tool-call
 * index and leaves later chunks carrying only `arguments` deltas, so a stream that never
 * sends a name is non-conforming for every provider rather than quirky for one. The
 * reference implementations accumulate such a call with an empty name and let the caller
 * fail; we sit at the boundary where it would become a Codex tool-call contract event, so
 * the equivalent is to refuse to emit it.
 *
 * Failing closed rather than dropping is deliberate, and matches #1325: a claimed tool call
 * that silently disappears can leave the matching result orphaned on the next turn. Naming
 * it ourselves is worse still — the id is synthesizable because it is an opaque correlation
 * handle, but a function name is a guess at intent.
 */
function unnamedToolCallEvent(usage?: OcxUsage): Extract<AdapterEvent, { type: "error" }> {
  return {
    type: "error",
    message: "upstream streamed a tool call without a function name — cannot dispatch",
    ...(usage !== undefined ? { usage } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type InvalidToolCallReason =
  | "tool_calls_not_array"
  | "tool_call_not_object"
  | "tool_call_id_invalid"
  | "tool_call_function_not_object"
  | "tool_call_function_name_invalid"
  | "tool_call_function_name_blank"
  | "tool_call_function_arguments_invalid";

type InvalidToolCallDiagnostic = {
  reason: InvalidToolCallReason;
  callIndex?: number;
  valueType: string;
};

type InvalidFieldShape =
  | {
      kind: "object";
      knownKeys: string[];
      knownFieldTypes: Record<string, string>;
      hasUnknownKeys: boolean;
    }
  | {
      kind: "array";
      length: number;
    };

const SAFE_TOOL_CALL_SHAPE_KEYS = [
  "name",
  "type",
  "value",
  "function",
  "arguments",
  "id",
  "index",
] as const;
const SAFE_TOOL_CALL_SHAPE_KEY_SET = new Set<string>(SAFE_TOOL_CALL_SHAPE_KEYS);

function structuralValueType(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

function invalidToolCallField(rawToolCalls: unknown, diagnostic: InvalidToolCallDiagnostic): unknown {
  if (diagnostic.reason === "tool_calls_not_array") return rawToolCalls;
  if (!Array.isArray(rawToolCalls) || diagnostic.callIndex === undefined) return undefined;

  const rawToolCall = rawToolCalls[diagnostic.callIndex];
  if (diagnostic.reason === "tool_call_not_object") return rawToolCall;
  if (!isRecord(rawToolCall)) return undefined;
  if (diagnostic.reason === "tool_call_function_not_object") return rawToolCall.function;

  const rawFunction = rawToolCall.function;
  switch (diagnostic.reason) {
    case "tool_call_id_invalid":
      return rawToolCall.id;
    case "tool_call_function_name_invalid":
      return isRecord(rawFunction) ? rawFunction.name : undefined;
    case "tool_call_function_arguments_invalid":
      return isRecord(rawFunction) ? rawFunction.arguments : undefined;
    default:
      return undefined;
  }
}

function fingerprintInvalidField(value: unknown): InvalidFieldShape | undefined {
  if (Array.isArray(value)) return { kind: "array", length: value.length };
  if (!isRecord(value)) return undefined;

  const knownKeys: string[] = [];
  const knownFieldTypes: Record<string, string> = {};
  for (const key of SAFE_TOOL_CALL_SHAPE_KEYS) {
    if (!Object.hasOwn(value, key)) continue;
    knownKeys.push(key);
    knownFieldTypes[key] = structuralValueType(value[key]);
  }

  let hasUnknownKeys = false;
  for (const key of Object.keys(value)) {
    if (!SAFE_TOOL_CALL_SHAPE_KEY_SET.has(key)) {
      hasUnknownKeys = true;
      break;
    }
  }
  return { kind: "object", knownKeys, knownFieldTypes, hasUnknownKeys };
}

/**
 * Streamed string fields are absent when null or undefined (#1731): OpenAI-compatible
 * streamers repeat already-sent `id`/`name`/`arguments` as null on continuation deltas.
 * The accumulator and this diagnostic share this predicate so they cannot disagree about
 * which delta was the invalid one.
 */
function isInvalidStreamStringField(value: unknown): boolean {
  return value != null && typeof value !== "string";
}

/**
 * Explain only the rejected wire shape, never its values. This diagnostic exists so provider
 * compatibility can be tightened from evidence without retaining tool arguments or credentials.
 */
function diagnoseInvalidToolCalls(
  rawToolCalls: unknown,
  mode: "stream" | "response",
): InvalidToolCallDiagnostic | undefined {
  if (!Array.isArray(rawToolCalls)) {
    return { reason: "tool_calls_not_array", valueType: rawToolCalls === null ? "null" : typeof rawToolCalls };
  }
  for (let callIndex = 0; callIndex < rawToolCalls.length; callIndex++) {
    const rawToolCall = rawToolCalls[callIndex];
    if (!isRecord(rawToolCall)) {
      return {
        reason: "tool_call_not_object",
        callIndex,
        valueType: rawToolCall === null ? "null" : Array.isArray(rawToolCall) ? "array" : typeof rawToolCall,
      };
    }
    if (mode === "stream") {
      // The streamed path validates the pieces it is about to store (#1531): a present
      // `function` must be a record, and a present `name`/`arguments`/`id` must be a string.
      // Blank names are caught later at flush, not here, so they are not diagnosed on this
      // branch. Describe exactly that boundary rather than tightening compatibility in a
      // diagnostic change.
      // #1731: "present" means the same thing here as in the accumulator — null and undefined
      // are both absent, because some OpenAI-compatible streamers repeat already-sent fields
      // as null on continuation deltas. A separate predicate here would diagnose accepted
      // padding as the failure and point compatibility work at the wrong delta.
      const streamFunction = (rawToolCall as { function?: unknown }).function;
      if (streamFunction !== undefined && streamFunction !== null) {
        if (!isRecord(streamFunction)) {
          return {
            reason: "tool_call_function_not_object",
            callIndex,
            valueType: Array.isArray(streamFunction) ? "array" : typeof streamFunction,
          };
        }
        if (isInvalidStreamStringField(streamFunction.name)) {
          return { reason: "tool_call_function_name_invalid", callIndex, valueType: typeof streamFunction.name };
        }
        if (isInvalidStreamStringField(streamFunction.arguments)) {
          return { reason: "tool_call_function_arguments_invalid", callIndex, valueType: typeof streamFunction.arguments };
        }
      }
      if (isInvalidStreamStringField(rawToolCall.id)) {
        return { reason: "tool_call_id_invalid", callIndex, valueType: typeof rawToolCall.id };
      }
      continue;
    }
    // Precedence must mirror the buffered validator below, or a payload with more than one
    // problem is reported under the wrong reason and sends compatibility work after the wrong
    // shape. That validator checks the `function` container first (`!isRecord(rawToolCall) ||
    // !isRecord(rawToolCall.function)`), then id/name/arguments types together, and only then
    // the blank name.
    if (!isRecord(rawToolCall.function)) {
      return {
        reason: "tool_call_function_not_object",
        callIndex,
        valueType: rawToolCall.function === null ? "null" : Array.isArray(rawToolCall.function) ? "array" : typeof rawToolCall.function,
      };
    }
    if (typeof rawToolCall.id !== "string") {
      return { reason: "tool_call_id_invalid", callIndex, valueType: typeof rawToolCall.id };
    }
    if (typeof rawToolCall.function.name !== "string") {
      return { reason: "tool_call_function_name_invalid", callIndex, valueType: typeof rawToolCall.function.name };
    }
    if (typeof rawToolCall.function.arguments !== "string") {
      return { reason: "tool_call_function_arguments_invalid", callIndex, valueType: typeof rawToolCall.function.arguments };
    }
    // Last, matching the validator: #1531 also rejects a blank or whitespace-only name here,
    // because such a call cannot select a dispatch target. Reporting it as `name_invalid`
    // would claim a type problem for a correctly-typed value, so it gets its own code.
    if (rawToolCall.function.name.trim().length === 0) {
      return { reason: "tool_call_function_name_blank", callIndex, valueType: "string" };
    }
  }
  return undefined;
}

function logInvalidToolCalls(
  mode: "stream" | "response",
  rawToolCalls: unknown,
  diagnosticOverride?: InvalidToolCallDiagnostic,
): void {
  if (!isDebugEnabled()) return;
  const diagnostic = diagnosticOverride ?? diagnoseInvalidToolCalls(rawToolCalls, mode);
  if (!diagnostic) return;
  const fieldShape = fingerprintInvalidField(invalidToolCallField(rawToolCalls, diagnostic));
  debugProviderDiagnostic("openai-chat", "invalid-tool-calls", {
    mode,
    ...diagnostic,
    ...(fieldShape ? { fieldShape } : {}),
  });
}

function developerSystemText(message: OcxMessage): string | undefined {
  if (message.role !== "developer") return undefined;
  if (typeof message.content === "string") return message.content;
  if (message.content.some(part => part.type === "image")) return undefined;
  return message.content.map(part => (part as OcxTextContent).text).join("");
}

function isNativeOpenAIChatTarget(provider: OcxProviderConfig): boolean {
  try {
    return new URL(provider.baseUrl).hostname === "api.openai.com";
  } catch {
    return false;
  }
}

/**
 * Chat-completions image_url parts for images carried inside a tool result (issue #888). role:"tool"
 * content is text-only on every chat provider, so these ride in a follow-up user message instead of
 * being flattened to the "[image]" marker the model can't actually see. Data URLs and remote https
 * URLs are both valid in image_url.url, unlike Gemini inline_data which needs base64.
 */
function toolResultTextForWire(content: string | OcxContentPart[]): string {
  if (typeof content === "string") return content;
  const text = content.filter((p) => p.type === "text").map((p) => (p as OcxTextContent).text).join("");
  if (text) {
    const untransportableImages = content.filter((p) => p.type === "image" && !p.imageUrl).length;
    return `${text}${"[image]".repeat(untransportableImages)}`;
  }
  return contentPartsToText(content);
}

function toolResultImageChatParts(content: string | OcxContentPart[]): unknown[] {
  if (typeof content === "string") return [];
  const parts: unknown[] = [];
  for (const p of content) {
    if (p.type !== "image" || !p.imageUrl) continue;
    parts.push({ type: "image_url", image_url: { url: p.imageUrl, ...(p.detail ? { detail: p.detail } : {}) } });
  }
  return parts;
}

function messagesToChatFormat(parsed: OcxParsedRequest, provider: OcxProviderConfig): unknown[] {
  const out: unknown[] = [];
  const { context, options } = parsed;
  const replayCacheScope = parsed._reasoningReplayScope;

  interface PendingToolCall { id: string; name: string }
  let pendingToolCalls: PendingToolCall[] = [];
  let deferredBarrierMessages: unknown[] = [];
  let pendingToolResultImageParts: unknown[] = [];
  let mintedIdSeq = 0;
  const seenWireCallIds = new Set<string>();

  const mintCallId = (): string => {
    let id = "";
    do {
      id = `call_ocx_minted_${++mintedIdSeq}`;
    } while (seenWireCallIds.has(id));
    seenWireCallIds.add(id);
    return id;
  };

  const releaseDeferredBarriers = (): void => {
    if (deferredBarrierMessages.length === 0) return;
    out.push(...deferredBarrierMessages);
    deferredBarrierMessages = [];
  };

  const flushToolResultImages = (): void => {
    if (pendingToolResultImageParts.length === 0) return;
    out.push({
      role: "user",
      content: [
        { type: "text", text: "[ocx] image output from the preceding tool result(s):" },
        ...pendingToolResultImageParts,
      ],
    });
    pendingToolResultImageParts = [];
  };

  const flushPendingToolCalls = (): void => {
    if (pendingToolCalls.length === 0) return;
    for (const call of pendingToolCalls) {
      out.push({
        role: "tool",
        tool_call_id: call.id,
        content: `[ocx] no tool result was recorded for "${call.name}"; execution status unknown — do not treat this as success, failure, or user-provided input.`,
      });
    }
    pendingToolCalls = [];
    flushToolResultImages();
    releaseDeferredBarriers();
  };

  const nativeOpenAI = isNativeOpenAIChatTarget(provider);
  const toolCatalogNudge = shouldInjectNonOpenAIToolCatalogNudge(provider)
    ? buildNonOpenAIToolCatalogNudgeForTools(context.tools, options.toolChoice)
    : undefined;
  const developerSystemParts = nativeOpenAI
    ? []
    : context.messages
      .map(developerSystemText)
      .filter((part): part is string => part !== undefined && part.length > 0);
  const systemParts = [
    ...(context.systemPrompt ?? []),
    ...developerSystemParts,
    ...(toolCatalogNudge ? [toolCatalogNudge] : []),
  ];
  if (systemParts.length > 0) {
    const wireModelId = provider.modelSuffixBracketStrip
      ? stripBracketedModelSuffix(parsed.modelId)
      : parsed.modelId;
    const sys = identifyRoutedModel(systemParts.join("\n\n"), wireModelId);
    out.push({ role: "system", content: sys });
  }

  for (const msg of context.messages) {
    switch (msg.role) {
      case "user":
      case "developer": {
        const parts = typeof msg.content === "string" ? undefined : msg.content as OcxContentPart[];
        const hasImages = parts?.some(p => p.type === "image") ?? false;
        let chatMsg: Record<string, unknown>;
        if (msg.role === "developer" && !hasImages) {
          if (!nativeOpenAI) break;
          const text = typeof msg.content === "string"
            ? msg.content
            : parts!.map(p => (p as OcxTextContent).text).join("");
          chatMsg = { role: "developer", content: text };
        } else if (typeof msg.content === "string") {
          chatMsg = { role: "user", content: msg.content };
        } else if (!hasImages) {
          chatMsg = { role: "user", content: parts!.map(p => (p as OcxTextContent).text).join("") };
        } else {
          const chatParts = parts!.map(p => p.type === "image"
            ? { type: "image_url", image_url: { url: p.imageUrl, ...(p.detail ? { detail: p.detail } : {}) } }
            : { type: "text", text: (p as OcxTextContent).text });
          chatMsg = { role: "user", content: chatParts };
        }
        if (pendingToolCalls.length > 0) deferredBarrierMessages.push(chatMsg);
        else out.push(chatMsg);
        break;
      }
      case "assistant": {
        const aMsg = msg as OcxAssistantMessage;
        const textParts = aMsg.content.filter(p => p.type === "text") as OcxTextContent[];
        const thinkingParts = aMsg.content.filter(p => p.type === "thinking") as OcxThinkingContent[];
        const toolCalls = aMsg.content.filter(p => p.type === "toolCall") as OcxToolCall[];
        const chatMsg: Record<string, unknown> = { role: "assistant" };
        if (textParts.length > 0) chatMsg.content = textParts.map(p => p.text).join("");
        let reasoningContent = thinkingParts.map(p => p.thinking).join("");
        if (
          reasoningContent.length === 0
          && toolCalls.length > 0
          && modelInList(provider.preserveReasoningContentModels, parsed.modelId)
        ) {
          const cached = toolCalls
            .map(tc => (tc.id ? peekReasoningForCall(tc.id, replayCacheScope) : undefined))
            .filter((text): text is string => typeof text === "string" && text.length > 0);
          // Parallel calls share one preceding reasoning block, which is
          // recorded under every call id — join unique texts only.
          if (cached.length > 0) {
            reasoningContent = [...new Set(cached)].join("\n");
          } else if (modelInList(provider.requiresReasoningPlaceholderModels ?? provider.preserveReasoningContentModels, parsed.modelId)) {
            // Fallback (extends #950, closes #1193): the replay cache is
            // bounded (64 entries / 256 KiB / 1 h TTL) and always misses on
            // long sessions, and some tool rounds carry no recorded reasoning
            // at all. DeepSeek thinking mode rejects ANY tool_call assistant
            // message missing reasoning_content with HTTP 400, so inject a
            // minimal placeholder rather than emit a bare continuation the
            // upstream will reject. Scoped to requiresReasoningPlaceholderModels
            // (defaulting to the preserve list): preserve-listed providers with
            // toggleable thinking (MiniMax low effort) opt out with `[]` so
            // non-thinking histories are never given a fabricated placeholder.
            reasoningContent = " ";
          }
        }
        if (reasoningContent.length > 0 && modelInList(provider.preserveReasoningContentModels, parsed.modelId)) {
          chatMsg.reasoning_content = reasoningContent;
        }
        if (chatMsg.content === undefined && toolCalls.length === 0 && chatMsg.reasoning_content === undefined) break;
        flushPendingToolCalls();
        const wireToolCalls = toolCalls.map(tc => {
          let id = tc.id;
          if (!id) id = mintCallId();
          else seenWireCallIds.add(id);
          return { tc, id };
        });
        if (wireToolCalls.length > 0) {
          chatMsg.tool_calls = wireToolCalls.map(({ tc, id }) => ({
            id,
            type: "function",
            function: { name: namespacedToolName(tc.namespace, tc.name), arguments: JSON.stringify(tc.arguments) },
          }));
          if (!chatMsg.content) chatMsg.content = emptyAssistantContent(provider);
        }
        if (chatMsg.reasoning_content !== undefined && chatMsg.content === undefined && chatMsg.tool_calls === undefined) {
          chatMsg.content = emptyAssistantContent(provider);
        }
        out.push(chatMsg);
        pendingToolCalls = wireToolCalls.map(({ tc, id }) => ({ id, name: namespacedToolName(tc.namespace, tc.name) }));
        break;
      }
      case "toolResult": {
        let toolCallId = msg.toolCallId;
        const matchIdx = toolCallId ? pendingToolCalls.findIndex(c => c.id === toolCallId) : -1;
        if (matchIdx >= 0 && toolCallId) {
          out.push({
            role: "tool",
            tool_call_id: toolCallId,
            content: toolResultTextForWire(msg.content),
          });
          pendingToolResultImageParts.push(...toolResultImageChatParts(msg.content));
          pendingToolCalls.splice(matchIdx, 1);
          if (pendingToolCalls.length === 0) {
            flushToolResultImages();
            releaseDeferredBarriers();
          }
        } else {
          if (!toolCallId) toolCallId = `call_orphan_${out.length}`;
          flushPendingToolCalls();
          const name = safeToolName(msg.toolName);
          const cachedReasoning =
            toolCallId && modelInList(provider.preserveReasoningContentModels, parsed.modelId)
              ? peekReasoningForCall(toolCallId, replayCacheScope)
              : undefined;
          // Same fallback as the main-assistant path: never emit a bare orphan
          // tool_call continuation on a thinking-mode provider — inject a
          // placeholder when the replay cache missed (the bounded cache can
          // always miss on long sessions), or DeepSeek thinking mode 400s.
          // Gate on the preserve list too: reasoning_content is only ever
          // serialized for preserve-listed models, so a requires-only custom
          // entry must not fabricate it on this path (P2 on #1205).
          // `||` (not `??`): the cache never stores empty strings, but treat a
          // falsy hit as a miss so the placeholder still fires.
          const orphanReasoning =
            cachedReasoning
            || (modelInList(provider.preserveReasoningContentModels, parsed.modelId)
              && modelInList(provider.requiresReasoningPlaceholderModels ?? provider.preserveReasoningContentModels, parsed.modelId)
              ? " "
              : undefined);
          out.push({
            role: "assistant",
            content: emptyAssistantContent(provider),
            ...(orphanReasoning ? { reasoning_content: orphanReasoning } : {}),
            tool_calls: [{
              id: toolCallId,
              type: "function",
              function: { name, arguments: "{}" },
            }],
          });
          seenWireCallIds.add(toolCallId);
          out.push({
            role: "tool",
            tool_call_id: toolCallId,
            content: toolResultTextForWire(msg.content),
          });
          pendingToolResultImageParts.push(...toolResultImageChatParts(msg.content));
          flushToolResultImages();
        }
        break;
      }
    }
  }

  flushPendingToolCalls();
  releaseDeferredBarriers();
  return out;
}

function safeToolName(name: string | undefined): string {
  const raw = name && name.trim().length > 0 ? name : "tool_result";
  const sanitized = raw.replace(/[^A-Za-z0-9_-]/g, "_");
  return sanitized;
}

const ZEN_SCHEMA_MAP_KEYS = new Set(["properties", "$defs", "definitions"]);
const ZEN_DROPPED_SCHEMA_KEYS = new Set(["encrypted"]);

function sanitizeZenSchemaMap(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return sanitizeZenToolParameters(value);
  const out: Record<string, unknown> = {};
  for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
    out[name] = sanitizeZenToolParameters(child);
  }
  return out;
}

function sanitizeZenToolParameters(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeZenToolParameters);
  if (!value || typeof value !== "object") return value;
  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(input)) {
    if (ZEN_DROPPED_SCHEMA_KEYS.has(key)) continue;
    if (key === "required" && Array.isArray(child) && child.length === 0) continue;
    if (key === "type" && Array.isArray(child)) {
      const nonNull = child.filter(entry => entry !== "null");
      if (child.includes("null")) out.nullable = true;
      if (nonNull.length > 0) out.type = nonNull[0];
      continue;
    }
    out[key] = ZEN_SCHEMA_MAP_KEYS.has(key) ? sanitizeZenSchemaMap(child) : sanitizeZenToolParameters(child);
  }
  return out;
}

function ensureZenRootObjectSchema(schema: unknown): Record<string, unknown> {
  const obj = schema && typeof schema === "object" && !Array.isArray(schema)
    ? schema as Record<string, unknown>
    : {};
  const compositionKeys = ["oneOf", "anyOf", "allOf"] as const;
  const hasComposition = compositionKeys.some(key => Array.isArray(obj[key]));
  const rootType = obj.type;
  const rootObjectType = rootType === "object" || (Array.isArray(rootType) && rootType.includes("object"));
  if (!hasComposition) {
    const base = sanitizeZenToolParameters(obj) as Record<string, unknown>;
    return rootObjectType && base.type === "object" ? base : { ...base, type: "object" };
  }

  const props: Record<string, unknown> = {};
  const required = new Set<string>();
  if (obj.properties && typeof obj.properties === "object") {
    Object.assign(props, sanitizeZenSchemaMap(obj.properties) as Record<string, unknown>);
  }
  if (Array.isArray(obj.required)) {
    for (const entry of obj.required) if (typeof entry === "string") required.add(entry);
  }
  for (const key of compositionKeys) {
    const variants = obj[key];
    if (!Array.isArray(variants)) continue;
    const mergeRequired = key === "allOf";
    for (const variant of variants) {
      if (!variant || typeof variant !== "object" || Array.isArray(variant)) continue;
      const rec = variant as Record<string, unknown>;
      if (rec.properties && typeof rec.properties === "object") {
        Object.assign(props, sanitizeZenSchemaMap(rec.properties) as Record<string, unknown>);
      }
      if (mergeRequired && Array.isArray(rec.required)) {
        for (const entry of rec.required) if (typeof entry === "string") required.add(entry);
      }
    }
  }

  const merged = sanitizeZenToolParameters(obj) as Record<string, unknown>;
  delete merged.oneOf;
  delete merged.anyOf;
  delete merged.allOf;
  merged.type = "object";
  if (Object.keys(props).length > 0) merged.properties = props;
  if (required.size > 0) merged.required = [...required];
  return merged;
}

function shouldSanitizeZenToolParameters(provider: OcxProviderConfig): boolean {
  const baseUrl = provider.baseUrl.replace(/\/+$/, "");
  return baseUrl === "https://opencode.ai/zen/v1"
    || baseUrl === "https://opencode.ai/zen/go/v1";
}

function isXaiSchemaTarget(provider: OcxProviderConfig): boolean {
  try {
    // Public api.x.ai accepts native root object unions. Only the Grok CLI proxy
    // 400s on a root oneOf/anyOf, so flattening/omitting is scoped to that host.
    return new URL(provider.baseUrl).hostname === "cli-chat-proxy.grok.com";
  } catch {
    return false;
  }
}

const VOLCENGINE_ARK_HOSTNAMES = new Set([
  "ark.cn-beijing.volces.com",
  "ark.ap-southeast.volces.com",
]);

function isVolcengineArkPaygChatTarget(provider: OcxProviderConfig): boolean {
  try {
    const url = new URL(provider.baseUrl);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    return VOLCENGINE_ARK_HOSTNAMES.has(url.hostname) && pathname === "/api/v3";
  } catch {
    return false;
  }
}

function emptyAssistantContent(provider: OcxProviderConfig): string | { type: "text"; text: string }[] {
  return isVolcengineArkPaygChatTarget(provider) ? [{ type: "text", text: "" }] : "";
}

function ensureRootObjectType(parameters: unknown): Record<string, unknown> {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    return { type: "object", properties: {} };
  }
  const obj = parameters as Record<string, unknown>;
  if (obj.type === "object") return obj;
  return { ...obj, type: "object" };
}

function isXaiObjectSchema(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringRequiredFields(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** Variant keys the merger can keep. Anything else is refused, not silently dropped. */
const XAI_VARIANT_MERGE_KEYS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "description",
  "title",
  "$comment",
  "$defs",
  "definitions",
]);

function decodeJsonPointerToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function lookupLocalJsonPointer(root: unknown, ref: string): unknown {
  if (ref === "#" || ref === "#/") return root;
  if (!ref.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const token of ref.slice(2).split("/").map(decodeJsonPointerToken)) {
    if (!isXaiObjectSchema(current) || !Object.hasOwn(current, token)) return undefined;
    current = current[token];
  }
  return current;
}

/** Resolve local `#/` `$ref`s. Unresolvable or cyclic refs return undefined. */
function resolveXaiSchemaRefs(
  schema: unknown,
  root: Record<string, unknown>,
  stack: Set<string> = new Set(),
): unknown | undefined {
  if (!isXaiObjectSchema(schema)) return schema;
  if (typeof schema.$ref === "string") {
    const ref = schema.$ref;
    if (stack.has(ref)) return undefined;
    const target = lookupLocalJsonPointer(root, ref);
    if (target === undefined) return undefined;
    stack.add(ref);
    const resolvedTarget = resolveXaiSchemaRefs(target, root, stack);
    stack.delete(ref);
    if (resolvedTarget === undefined) return undefined;
    const rest: Record<string, unknown> = { ...schema };
    delete rest.$ref;
    if (Object.keys(rest).length === 0) return resolvedTarget;
    const resolvedRest = resolveXaiSchemaRefs(rest, root, stack);
    if (resolvedRest === undefined || !isXaiObjectSchema(resolvedTarget) || !isXaiObjectSchema(resolvedRest)) {
      return undefined;
    }
    return composeXaiObjectSchemas(resolvedTarget, resolvedRest);
  }

  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if ((key === "oneOf" || key === "anyOf") && Array.isArray(value)) {
      const items: unknown[] = [];
      for (const item of value) {
        const next = resolveXaiSchemaRefs(item, root, stack);
        if (next === undefined) return undefined;
        items.push(next);
      }
      resolved[key] = items;
      continue;
    }
    if (key === "properties" && isXaiObjectSchema(value)) {
      const properties: Record<string, unknown> = {};
      for (const [name, property] of Object.entries(value)) {
        const next = resolveXaiSchemaRefs(property, root, stack);
        if (next === undefined) return undefined;
        properties[name] = next;
      }
      resolved[key] = properties;
      continue;
    }
    resolved[key] = value;
  }
  return resolved;
}

function xaiVariantIsConcreteObject(variant: Record<string, unknown>): boolean {
  if (variant.type !== undefined && variant.type !== "object") return false;
  return Object.keys(variant).every(key => XAI_VARIANT_MERGE_KEYS.has(key));
}

function variantProperties(variant: Record<string, unknown>): Record<string, unknown> {
  return isXaiObjectSchema(variant.properties) ? variant.properties : {};
}

/**
 * Independent per-property anyOf is lossless only when every property name exists
 * on every variant (absence is meaningful under xAI's default additionalProperties:
 * false, and promoting a branch-local key also tightens explicit-true variants)
 * and at most one of those shared properties has a conflicting schema.
 */
function xaiPropertyMergeIsLossless(variants: Record<string, unknown>[]): boolean {
  const names = new Set<string>();
  const props = variants.map(variant => {
    const properties = variantProperties(variant);
    for (const name of Object.keys(properties)) names.add(name);
    return properties;
  });
  let schemaConflicts = 0;
  for (const name of names) {
    const values = props.map(property => property[name]);
    if (values.some(value => value === undefined)) return false;
    if (values.some(value => JSON.stringify(value) !== JSON.stringify(values[0]))) schemaConflicts += 1;
  }
  return schemaConflicts <= 1;
}

function xaiRequiredSetsMatch(variants: Record<string, unknown>[]): boolean {
  const serialized = variants.map(variant => [...stringRequiredFields(variant.required)].sort().join("\0"));
  return serialized.every(value => value === serialized[0]);
}

function mergeXaiAdditionalProperties(
  variants: Record<string, unknown>[],
): { ok: true; value?: unknown } | { ok: false } {
  const values = variants.map(variant => variant.additionalProperties);
  const explicit = values.filter(value => value !== undefined);
  if (explicit.length === 0) return { ok: true };
  if (explicit.length !== values.length) return { ok: false };
  const hasFalse = explicit.some(value => value === false);
  const permissive = explicit.filter(value => value !== false);
  if (hasFalse && permissive.length > 0) return { ok: false };
  if (hasFalse) return { ok: true, value: false };
  const unique: unknown[] = [];
  const seen = new Set<string>();
  for (const value of permissive) {
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(value);
  }
  if (unique.length !== 1) return { ok: false };
  return { ok: true, value: unique[0] };
}

/** Compose root siblings into a branch so properties/required are not overwritten. */
function composeXaiObjectSchemas(
  inherited: Record<string, unknown>,
  branch: Record<string, unknown>,
): Record<string, unknown> {
  const composed: Record<string, unknown> = { ...inherited, ...branch };
  const inheritedProps = isXaiObjectSchema(inherited.properties) ? inherited.properties : undefined;
  const branchProps = isXaiObjectSchema(branch.properties) ? branch.properties : undefined;
  if (inheritedProps || branchProps) {
    const properties: Record<string, unknown> = { ...(inheritedProps ?? {}) };
    for (const [name, value] of Object.entries(branchProps ?? {})) {
      const inheritedValue = inheritedProps?.[name];
      properties[name] = inheritedValue !== undefined && JSON.stringify(inheritedValue) !== JSON.stringify(value)
        ? { allOf: [inheritedValue, value] }
        : value;
    }
    composed.properties = properties;
  }
  const required = [...new Set([
    ...stringRequiredFields(inherited.required),
    ...stringRequiredFields(branch.required),
  ])];
  if (required.length > 0) composed.required = required;
  else delete composed.required;
  return composed;
}

function expandXaiRootObjectSchemas(schema: unknown): Record<string, unknown>[] | undefined {
  if (!isXaiObjectSchema(schema)) return undefined;
  const compositionKey = ["oneOf", "anyOf"].find(key => Array.isArray(schema[key]));
  if (!compositionKey) {
    if (schema.type !== undefined && schema.type !== "object") return undefined;
    return [{ ...schema, type: "object" }];
  }

  const siblings = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== compositionKey));
  const branches = schema[compositionKey];
  if (!Array.isArray(branches)) return undefined;
  const expanded: Record<string, unknown>[] = [];
  for (const branch of branches) {
    const variants = expandXaiRootObjectSchemas(branch);
    if (!variants) return undefined;
    for (const variant of variants) expanded.push(composeXaiObjectSchemas(siblings, variant));
  }
  return expanded.length > 0 ? expanded : undefined;
}

function mergeXaiPropertySchemas(values: unknown[]): unknown {
  const unique: unknown[] = [];
  const serialized = new Set<string>();
  for (const value of values) {
    const key = JSON.stringify(value);
    if (serialized.has(key)) continue;
    serialized.add(key);
    unique.push(value);
  }
  return unique.length === 1 ? unique[0] : { anyOf: unique };
}

/**
 * The Grok CLI proxy rejects a function parameter schema whose root remains oneOf/anyOf.
 * Flatten only when the merge is lossless: local $refs resolve, every variant is a concrete
 * object whose keys we can preserve, required sets match, additionalProperties does not change
 * meaning, every property name exists on every variant, and at most one property schema
 * differs. Otherwise omit the tool rather than emit a weaker schema.
 */
function normalizeXaiToolParameters(parameters: unknown): Record<string, unknown> | undefined {
  if (!isXaiObjectSchema(parameters)) return undefined;
  const resolved = resolveXaiSchemaRefs(parameters, parameters);
  if (!isXaiObjectSchema(resolved)) return undefined;

  const normalizedRoot = { ...resolved };
  delete normalizedRoot.$schema;

  const variants = expandXaiRootObjectSchemas(normalizedRoot);
  if (!variants) return undefined;
  if (variants.length === 1) {
    return xaiVariantIsConcreteObject(variants[0]) ? variants[0] : undefined;
  }
  if (!variants.every(xaiVariantIsConcreteObject) || !xaiRequiredSetsMatch(variants)) return undefined;
  const additionalProperties = mergeXaiAdditionalProperties(variants);
  if (!additionalProperties.ok) return undefined;
  if (!xaiPropertyMergeIsLossless(variants)) return undefined;

  const metadata = Object.fromEntries(Object.entries(normalizedRoot).filter(([key]) => key !== "oneOf" && key !== "anyOf" && key !== "type"));
  delete metadata.properties;
  delete metadata.required;
  delete metadata.additionalProperties;

  const propertyValues = new Map<string, unknown[]>();
  for (const variant of variants) {
    if (!variant.properties || typeof variant.properties !== "object" || Array.isArray(variant.properties)) continue;
    for (const [name, value] of Object.entries(variant.properties as Record<string, unknown>)) {
      const values = propertyValues.get(name) ?? [];
      values.push(value);
      propertyValues.set(name, values);
    }
  }

  const properties = Object.fromEntries(
    [...propertyValues].map(([name, values]) => [name, mergeXaiPropertySchemas(values)]),
  );
  const required = stringRequiredFields(variants[0]?.required);

  return {
    ...metadata,
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    ...("value" in additionalProperties ? { additionalProperties: additionalProperties.value } : {}),
  };
}

function toolsToChatFormat(parsed: OcxParsedRequest, provider: OcxProviderConfig): unknown[] | undefined {
  if (!parsed.context.tools || parsed.context.tools.length === 0) return undefined;
  const tools = parsed.context.tools.filter(toolChoiceToolPredicate(parsed.options.toolChoice, parsed.context.tools));
  if (tools.length === 0) return undefined;
  const xaiTarget = isXaiSchemaTarget(provider);
  const formatted = tools.flatMap(t => {
    const parameters = stripResponsesOnlyEncryptedMarker(xaiTarget
      ? normalizeXaiToolParameters(t.parameters)
      : ensureRootObjectType(t.parameters));

    if (parameters === undefined) return [];
    return [{
      type: "function",
      function: {
        name: namespacedToolName(t.namespace, t.name),
        ...(t.description ? { description: t.description } : {}),
        parameters,
        ...(t.strict !== undefined ? { strict: t.strict } : {}),
      },
    }];
  });
  return formatted.length > 0 ? formatted : undefined;
}

function toolsToChatFormatForProvider(parsed: OcxParsedRequest, provider: OcxProviderConfig): unknown[] | undefined {
  const base = toolsToChatFormat(parsed, provider);
  if (!base || !shouldSanitizeZenToolParameters(provider)) return base;
  return base.map(tool => {
    if (!tool || typeof tool !== "object") return tool;
    const functionDef = (tool as { function?: Record<string, unknown> }).function;
    if (!functionDef || typeof functionDef !== "object") return tool;
    return {
      ...tool,
      function: {
        ...functionDef,
        parameters: ensureZenRootObjectSchema(functionDef.parameters ?? {}),
      },
    };
  });
}

function toolChoiceToChatFormat(
  tc: OcxParsedRequest["options"]["toolChoice"],
  tools: OcxParsedRequest["context"]["tools"],
  provider: OcxProviderConfig,
): unknown {
  if (!tc) return undefined;
  if (isAllowedToolChoice(tc)) {
    if (tc.mode === "required" && tc.allowedTools.length === 1 && isNativeOpenAIChatTarget(provider)) {
      return { type: "function", function: { name: resolveToolChoiceWireName(tools, tc.allowedTools[0]) } };
    }
    return tc.mode === "required" ? "required" : "auto";
  }
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

function resolveMaxTokens(provider: OcxProviderConfig, parsed: OcxParsedRequest): number | undefined {
  return parsed.options.maxOutputTokens
    ?? modelRecordValue(provider.modelMaxOutputTokens, parsed.modelId)
    ?? provider.defaultMaxOutputTokens;
}

function thinkingBudgetForEffort(parsed: OcxParsedRequest, reasoningEffort: string, maxOutputTokens?: number): number | undefined {
  if (parsed.options.reasoning === "minimal") return 0;
  const maxBudget = maxOutputTokens ?? 32768;
  const fractions: Record<string, number> = {
    low: 0.20,
    medium: 0.50,
    high: 0.75,
    xhigh: 0.90,
    max: 1.0,
  };
  const fraction = fractions[reasoningEffort];
  return fraction === undefined ? undefined : Math.max(1, Math.floor(maxBudget * fraction));
}

function canSerializeOpenAIChatServiceTier(
  provider: OcxProviderConfig,
  modelId: string,
  serviceTier: unknown,
  tierDecision?: OcxParsedRequest["options"]["tierDecision"],
): boolean {
  if (serviceTier === undefined) return false;
  if (tierDecision !== undefined) {
    return tierDecision.kind === "set" || tierDecision.kind === "forward-caller";
  }
  // No decision from the router means this call did not go through the tier state machine, so
  // ask that machine rather than re-deriving a looser answer beside it. The previous fallback
  // returned true whenever foreign forwarding was allowed at all, which let a caller tier
  // reach the wire in cases `decideTier` would have dropped — the two paths disagreeing is
  // precisely the bug, so there is now only one authority.
  const callerTier = typeof serviceTier === "string" ? serviceTier : undefined;
  const decision = decideTier(fastPolicyForModel(provider, modelId, undefined, "chat"), undefined, callerTier);
  return decision.kind === "set" || decision.kind === "forward-caller";
}

export function createOpenAIChatAdapter(provider: OcxProviderConfig): ProviderAdapter {
  return {
    name: "openai-chat",

    formatErrorBody: formatOpenAIChatErrorBody,

    buildRequest(parsed: OcxParsedRequest) {
      const { url, headers, hasCredential } = openAIChatTransport(provider);
      const messages = messagesToChatFormat(parsed, provider);
      const tools = toolsToChatFormatForProvider(parsed, provider);
      const toolChoice = toolChoiceToChatFormat(parsed.options.toolChoice, parsed.context.tools, provider);

      const body: Record<string, unknown> = {
        model: provider.modelSuffixBracketStrip ? stripBracketedModelSuffix(parsed.modelId) : parsed.modelId,
        messages,
        stream: parsed.stream,
      };
      // A policy-produced canonical decision has already passed capability validation. Without
      // that decision, a canonical caller value still requires an explicit true capability;
      // unclassified Chat routes remain behind the caller-forwarding opt-in.
      const serviceTier = parsed.options.serviceTier;
      const tierDecision = parsed.options.tierDecision;
      const canSerializeServiceTier = canSerializeOpenAIChatServiceTier(
        provider,
        parsed.modelId,
        serviceTier,
        tierDecision,
      );
      if (canSerializeServiceTier && serviceTier !== undefined) {
        body.service_tier = serviceTier;
      }
      if (modelInList(provider.reasoningSplitModels, parsed.modelId)) body.reasoning_split = true;
      const maxTokens = resolveMaxTokens(provider, parsed);
      const openRouterRouting = resolveOpenRouterRouting(provider, parsed.modelId);
      if (openRouterRouting) body.provider = openRouterProviderPayload(openRouterRouting);
      if (tools) body.tools = tools;
      if (tools && toolChoice !== undefined) {
        body.tool_choice = modelInList(provider.autoToolChoiceOnlyModels, parsed.modelId)
          ? (toolChoice === "none" ? "none" : "auto")
          : toolChoice;
      }
      if (maxTokens !== undefined) body.max_tokens = maxTokens;
      if (parsed.options.temperature !== undefined && !modelInList(provider.noTemperatureModels, parsed.modelId)) {
        body.temperature = parsed.options.temperature;
      }
      if (parsed.options.topP !== undefined && !modelInList(provider.noTopPModels, parsed.modelId)) {
        body.top_p = parsed.options.topP;
      }
      if (parsed.options.stopSequences !== undefined) body.stop = parsed.options.stopSequences;
      const reasoningDisabled = modelInList(provider.noReasoningModels, parsed.modelId);
      const reasoningEffort = mapReasoningEffort(provider, parsed.modelId, parsed.options.reasoning);
      const nativeOpenAI = isNativeOpenAIChatTarget(provider);
      let reasoningLog: AdapterRequest["reasoningLog"];
      if (!reasoningDisabled && provider.reasoningWireFormat === "gateway-object" && parsed.options.reasoning === "none") {
        if (nativeOpenAI) {
          body.reasoning_effort = "none";
          reasoningLog = {
            effectiveEffort: "none",
            wireField: "reasoning_effort",
            wireValue: "none",
          };
        } else {
          body.reasoning = { enabled: false };
          reasoningLog = {
            effectiveEffort: "none",
            wireField: "reasoning.enabled",
            wireValue: false,
          };
        }
      } else if (reasoningEffort !== undefined) {
        if (provider.reasoningWireFormat === "gateway-object") {
          if (nativeOpenAI) {
            body.reasoning_effort = reasoningEffort;
            reasoningLog = {
              effectiveEffort: reasoningEffort,
              wireField: "reasoning_effort",
              wireValue: reasoningEffort,
            };
          } else {
            body.reasoning = { enabled: true, effort: reasoningEffort };
            reasoningLog = {
              effectiveEffort: reasoningEffort,
              wireField: "reasoning.effort",
              wireValue: reasoningEffort,
            };
          }
        } else if (modelInList(provider.thinkingBudgetModels, parsed.modelId)) {
          const budget = thinkingBudgetForEffort(parsed, reasoningEffort, maxTokens);
          if (budget !== undefined) {
            body.thinking_budget = budget;
            reasoningLog = {
              effectiveEffort: parsed.options.reasoning === "minimal" ? "minimal" : reasoningEffort,
              wireField: "thinking_budget",
              wireValue: budget,
            };
          }
        } else if (modelInList(provider.thinkingToggleModels, parsed.modelId)) {
          if (reasoningEffort === "enabled" || reasoningEffort === "disabled" || reasoningEffort === "adaptive") {
            body.thinking = { type: reasoningEffort };
            reasoningLog = {
              effectiveEffort: reasoningEffort,
              wireField: "thinking.type",
              wireValue: reasoningEffort,
            };
          }
        } else {
          body.reasoning_effort = reasoningEffort;
          reasoningLog = {
            effectiveEffort: reasoningEffort,
            wireField: "reasoning_effort",
            wireValue: reasoningEffort,
          };
        }
      }
      if (parsed.options.presencePenalty !== undefined && !modelInList(provider.noPenaltyModels, parsed.modelId)) {
        body.presence_penalty = parsed.options.presencePenalty;
      }
      if (parsed.options.frequencyPenalty !== undefined && !modelInList(provider.noPenaltyModels, parsed.modelId)) {
        body.frequency_penalty = parsed.options.frequencyPenalty;
      }
      if (provider.promptCacheKey && parsed.options.promptCacheKey !== undefined) {
        body.prompt_cache_key = parsed.options.promptCacheKey;
      }
      // Structured-output support varies by the physical upstream model even when one
      // gateway exposes a uniform OpenAI-compatible endpoint. Keep the #1137 translation
      // as the default, but let an exact model opt out instead of forcing a provider-wide
      // rollback that would silently return prose for siblings that support JSON Schema.
      if (!provider.noStructuredOutputModels?.includes(parsed.modelId)) {
        const textFormat = parsed.options.textFormat;
        if (textFormat?.type === "json_object") {
          body.response_format = { type: "json_object" };
        } else if (textFormat?.type === "json_schema") {
          body.response_format = {
            type: "json_schema",
            json_schema: {
              name: textFormat.name ?? "response",
              ...(textFormat.description !== undefined ? { description: textFormat.description } : {}),
              ...(textFormat.schema !== undefined ? { schema: textFormat.schema } : {}),
              ...(textFormat.strict !== undefined ? { strict: textFormat.strict } : {}),
            },
          };
        }
      }

      if (tools) {
        if (provider.parallelToolCalls === false) {
          // NIM documents the Boolean defaulting to false and kimi rejects true; pin the
          // wire bit so Codex cannot opt in via request.options. Other opted-out providers
          // omit the field by default so strict OpenAI-compatible hosts never see an
          // unsupported knob, but a self-hosted gateway that DOES honor the field and keeps
          // emitting parallel calls without it can opt in via pinParallelToolCallsFalse.
          if (provider.baseUrl === "https://integrate.api.nvidia.com/v1"
              || provider.pinParallelToolCallsFalse === true) {
            body.parallel_tool_calls = false;
          }
        } else if (provider.parallelToolCalls === true) {
          body.parallel_tool_calls = parsed.options.parallelToolCalls !== false;
        }
      }
      if (parsed.stream) body.stream_options = { include_usage: true };

      const bodyJson = JSON.stringify(body);
      const actualServiceTier = typeof body.service_tier === "string" ? body.service_tier : null;
      const tierLog = createAdapterTierMetadata(
        parsed.options.tierObservation,
        parsed.options.tierDecision,
        actualServiceTier === null ? null : "service-tier",
        actualServiceTier,
      );
      if (isDebugEnabled()) {
        let host = "upstream";
        try { host = new URL(url).host; } catch { /* keep fallback */ }
        debugProviderDiagnostic("openai-chat", "request", {
          host,
          model: body.model,
          stream: parsed.stream,
          messageCount: Array.isArray(messages) ? messages.length : 0,
          toolCount: Array.isArray(tools) ? tools.length : 0,
          hasCredential,
          bodyBytes: new TextEncoder().encode(bodyJson).length,
        });
      }

      return {
        url,
        method: "POST",
        headers,
        body: bodyJson,
        ...(reasoningLog ? { reasoningLog } : {}),
        ...(tierLog ? { tierLog } : {}),
      };
    },

    async *parseStream(
      response: Response,
      budget: TranslatorBudget,
      tierMetadata?: AdapterTierMetadata,
    ): AsyncGenerator<AdapterEvent> {
      if (!response.body) {
        yield { type: "error", message: "No response body" };
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const budgetEncoder = new TextEncoder();
      let buffer = "";
      let bufferBytes = 0;
      interface PendingToolCall {
        key: string;
        id: string;
        name: string;
        args: string;
        argsBytes: number;
        /**
         * Whether this call has ever received `arguments` as an actual string, empty included.
         * An empty string still counts: it proves the upstream sent the field with the right
         * wire type, which is what a later malformed repeat of that field would be padding for.
         * A canonical NAME is not evidence about the ARGUMENTS field and must not stand in.
         */
        sawArgumentsString: boolean;
      }
      const pendingToolCalls: PendingToolCall[] = [];
      let toolCallSeq = 0;
      const closeToolCalls = (): PendingToolCall[] => {
        const calls = [...pendingToolCalls];
        for (const call of calls) budget.closeCall(call.key);
        pendingToolCalls.length = 0;
        return calls;
      };
      const pendingToolCallsAreCompleteJsonObjects = (): boolean =>
        pendingToolCalls.length > 0 && pendingToolCalls.every(call => {
          if (call.name.trim().length === 0 || !call.sawArgumentsString || call.args.length === 0) return false;
          try {
            const parsed = JSON.parse(call.args) as unknown;
            return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
          } catch {
            return false;
          }
        });
      // Returns "terminate" when a pending call cannot be dispatched, so every flush site
      // stops the turn instead of emitting an unusable call. `closeToolCalls()` runs first,
      // so budget reservations are released for every pending call even on the early return.
      const flushToolCalls = function* (): Generator<AdapterEvent, "continue" | "terminate"> {
        for (const call of closeToolCalls()) {
          // Ingest already proved `name` is a string; the typeof guard keeps this branch
          // total so a future ingest change cannot turn a malformed name into a throw.
          if (typeof call.name !== "string" || call.name.trim().length === 0) {
            debugProviderDiagnostic("openai-chat", "tool-call-unnamed", {
              hadId: call.id.length > 0,
              argsBytes: call.argsBytes,
            });
            yield unnamedToolCallEvent(pendingUsage);
            return "terminate";
          }
          if (!call.id) call.id = `call_${++toolCallSeq}`;
          yield { type: "tool_call_start", id: call.id, name: call.name };
          if (call.args.length > 0) yield { type: "tool_call_delta", arguments: call.args };
          yield { type: "tool_call_end" };
        }
        return "continue";
      };
      const terminateWithError = function* (
        event: Extract<AdapterEvent, { type: "error" }>,
      ): Generator<AdapterEvent, "terminate"> {
        closeToolCalls();
        yield event;
        return "terminate";
      };
      let pendingUsage: OcxUsage | undefined;
      let finishReason: string | undefined;
      let sawUserFacingOutput = false;

      const handleDataLine = function* (line: string): Generator<AdapterEvent, "continue" | "terminate"> {
        const rawPayload = sseFieldValue(line, "data");
        if (rawPayload === null) return "continue";
        const payload = rawPayload.trim();
        if (payload.length === 0) return "continue";
        if (payload === "[DONE]") {
          if ((yield* flushToolCalls()) === "terminate") return "terminate";
          const stopReason = stopReasonFor(finishReason);
          yield { type: "done", usage: pendingUsage, ...(stopReason ? { stopReason } : {}) };
          return "terminate";
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          tierMetadata?.markResponseUnparseable();
          yield { type: "error", message: "malformed upstream SSE data frame" };
          return "terminate";
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "continue";
        const chunk = parsed as Record<string, unknown>;
        if (Object.hasOwn(chunk, "service_tier")) {
          tierMetadata?.observeResponseServiceTier(chunk.service_tier);
        }

        if (chunk.error !== undefined && chunk.error !== null) {
          const event = upstreamErrorEvent(chunk.error, pendingUsage);
          debugProviderDiagnostic("openai-chat", "stream-error", { message: event.message });
          return yield* terminateWithError(event);
        }

        if (chunk.usage) pendingUsage = usageFromOpenAIChat(chunk.usage as Record<string, unknown>);

        const choices = chunk.choices;
        if (choices === undefined) return "continue";
        if (!Array.isArray(choices)) return yield* terminateWithError(invalidChoicesEvent(pendingUsage));
        if (choices.length === 0) return "continue";
        const rawChoice = choices[0];
        if (rawChoice === null || typeof rawChoice !== "object" || Array.isArray(rawChoice)) {
          return yield* terminateWithError(invalidChoicesEvent(pendingUsage));
        }
        const choice = rawChoice as {
          delta?: Record<string, unknown>;
          finish_reason?: string;
          error?: unknown;
        };
        if (choice.finish_reason === "error") {
          const event = upstreamErrorEvent(choice.error, pendingUsage);
          debugProviderDiagnostic("openai-chat", "stream-error", { message: event.message });
          return yield* terminateWithError(event);
        }
        if (typeof choice.finish_reason === "string" && choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta;
        if (delta) {
          const reasoningText = reasoningTextFrom(delta);
          if (reasoningText !== undefined) yield { type: "reasoning_raw_delta", text: reasoningText };
          if (typeof delta.content === "string" && delta.content.length > 0) {
            sawUserFacingOutput = true;
            yield { type: "text_delta", text: delta.content };
          }

          const rawToolCalls = delta.tool_calls;
          if (rawToolCalls !== undefined && rawToolCalls !== null) {
            // A non-null claimed tool-call payload is not benign padding. Dropping it can leave the
            // matching result permanently orphaned, so malformed nested shapes fail closed
            // through the adapter error channel instead of escaping as TypeError (#1325). Null is
            // tolerated as absent because OpenAI-compatible providers may emit it as stream padding.
            if (!Array.isArray(rawToolCalls)) {
              logInvalidToolCalls("stream", rawToolCalls);
              return yield* terminateWithError(invalidToolCallsEvent(rawToolCalls, "stream", pendingUsage));
            }
            for (let callIndex = 0; callIndex < rawToolCalls.length; callIndex++) {
              const rawToolCall: unknown = rawToolCalls[callIndex];
              if (!isRecord(rawToolCall)) {
                const diagnostic: InvalidToolCallDiagnostic = {
                  reason: "tool_call_not_object",
                  callIndex,
                  valueType: rawToolCall === null ? "null" : Array.isArray(rawToolCall) ? "array" : typeof rawToolCall,
                };
                logInvalidToolCalls("stream", rawToolCalls, diagnostic);
                return yield* terminateWithError(invalidToolCallsEvent(rawToolCalls, "stream", pendingUsage, diagnostic));
              }
              // This is upstream JSON, so every field is validated before it is stored: a
              // malformed value must fail closed through the #1325 channel here rather than
              // escaping later as a TypeError from string handling at flush time.
              const rawFunction = rawToolCall.function;
              if (rawFunction !== undefined && rawFunction !== null && !isRecord(rawFunction)) {
                const diagnostic: InvalidToolCallDiagnostic = {
                  reason: "tool_call_function_not_object",
                  callIndex,
                  valueType: Array.isArray(rawFunction) ? "array" : typeof rawFunction,
                };
                logInvalidToolCalls("stream", rawToolCalls, diagnostic);
                return yield* terminateWithError(invalidToolCallsEvent(rawToolCalls, "stream", pendingUsage, diagnostic));
              }
              const fnRecord = isRecord(rawFunction) ? rawFunction : undefined;
              const rawName = fnRecord?.name;
              const rawArguments = fnRecord?.arguments;
              const rawId = rawToolCall.id;
              const idDelta = typeof rawId === "string" ? rawId : "";
              const rawIndex = rawToolCall.index;

              // Resolve the pending call BEFORE judging the fields. Some OpenAI-compatible
              // streamers repeat an already-sent field as a non-string placeholder on a
              // continuation delta; judging first meant the whole stream died with a 502 even
              // though the value being repeated was already held in canonical form.
              const key = typeof rawIndex === "number"
                ? `i:${rawIndex}`
                : idDelta
                  ? `id:${idDelta}`
                  : pendingToolCalls[pendingToolCalls.length - 1]?.key;
              let call = key !== undefined ? pendingToolCalls.find(c => c.key === key) : undefined;
              if (!call && idDelta) call = pendingToolCalls.find(c => c.id === idDelta);
              if (!call) {
                call = {
                  key: key ?? `seq:${pendingToolCalls.length}`,
                  id: "",
                  name: "",
                  args: "",
                  argsBytes: 0,
                  sawArgumentsString: false,
                };
                pendingToolCalls.push(call);
                budget.openCall(call.key);
              }

              // Tolerance is per FIELD, keyed on that field's own provenance. A canonical name
              // says nothing about whether `arguments` was ever sent as a string, so it cannot
              // authorize a malformed arguments value — that would silently drop a real
              // argument payload the model intended to send.
              const rejection: InvalidToolCallDiagnostic | undefined =
                isInvalidStreamStringField(rawName) && call.name.trim() === ""
                  ? { reason: "tool_call_function_name_invalid", callIndex, valueType: typeof rawName }
                  : isInvalidStreamStringField(rawArguments) && !call.sawArgumentsString
                    ? { reason: "tool_call_function_arguments_invalid", callIndex, valueType: typeof rawArguments }
                    : isInvalidStreamStringField(rawId) && call.id === ""
                      ? { reason: "tool_call_id_invalid", callIndex, valueType: typeof rawId }
                      : undefined;
              if (rejection) {
                logInvalidToolCalls("stream", rawToolCalls, rejection);
                return yield* terminateWithError(invalidToolCallsEvent(rawToolCalls, "stream", pendingUsage, rejection));
              }

              if (idDelta && !call.id) call.id = idDelta;
              if (typeof rawName === "string" && rawName && !call.name) call.name = rawName;
              if (typeof rawArguments === "string") call.sawArgumentsString = true;
              // Tool-call deltas are BUFFERED until a terminal signal, so this adapter can
              // consume upstream frames for a long time while yielding nothing. The Responses
              // bridge reads adapter activity, not socket activity, so a model that streams a
              // large argument payload looks identical to a hung upstream and the stall
              // watchdog can abort a turn that was progressing normally.
              //
              // Found while investigating #2156, but it is NOT that bug: a stall abort emits
              // `response.incomplete` with `upstream_stall_timeout` from the bridge, whereas
              // that report shows the adapter's own end-of-stream error after `reader.read()`
              // returned EOF with tool calls still pending. Different path, different frame.
              //
              // A heartbeat is invisible downstream — the bridge consumes it to re-arm the
              // watchdog and emits nothing — which is the same remedy the Cursor, Anthropic,
              // Google, and Kiro adapters already use for their own silent phases.
              yield { type: "heartbeat" };
              if (typeof rawArguments === "string" && rawArguments) {
                const previousBytes = call.argsBytes;
                const nextBytes = previousBytes + budgetEncoder.encode(rawArguments).byteLength;
                const scope = { kind: "tool_args" as const, callId: call.key };
                const reservation = budget.reserveTransient(nextBytes, scope);
                try {
                  call.args += rawArguments;
                  reservation.commitRetained();
                  budget.releaseRetained(previousBytes, scope);
                  call.argsBytes = nextBytes;
                } catch (error) {
                  reservation.release();
                  throw error;
                }
              }
            }
          }
        }

        if (typeof choice.finish_reason === "string" && choice.finish_reason) {
          if ((yield* flushToolCalls()) === "terminate") return "terminate";
        }
        return "continue";
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const decoded = decoder.decode(value, { stream: true });
          const nextBufferBytes = bufferBytes + budgetEncoder.encode(decoded).byteLength;
          if (nextBufferBytes > TRANSLATOR_MAX_SSE_EVENT_BYTES) {
            throw new Error(`translation SSE event exceeded ${TRANSLATOR_MAX_SSE_EVENT_BYTES} bytes`, {
              cause: { code: "translation_buffer_limit" },
            });
          }
          const appendReservation = budget.reserveTransient(nextBufferBytes, { kind: "live_transient" });
          try {
            buffer += decoded;
            appendReservation.commitRetained();
            budget.releaseRetained(bufferBytes, { kind: "live_transient" });
          } catch (error) {
            appendReservation.release();
            throw error;
          }
          bufferBytes = nextBufferBytes;

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          const residualBytes = budgetEncoder.encode(buffer).byteLength;
          const residualReservation = budget.reserveTransient(residualBytes, { kind: "live_transient" });
          residualReservation.commitRetained();
          budget.releaseRetained(bufferBytes, { kind: "live_transient" });
          bufferBytes = residualBytes;

          for (const line of lines) {
            if ((yield* handleDataLine(line)) === "terminate") return;
          }
        }

        if (buffer.length > 0) {
          if ((yield* handleDataLine(buffer)) === "terminate") return;
        }
        const sawFinish = finishReason !== undefined;
        if (!sawFinish && pendingToolCalls.length > 0) {
          // Some OpenAI-compatible gateways close immediately after a complete function-call
          // delta and omit both terminal conventions. Keep the default fail-closed policy, and
          // let an opted-in provider recover only calls whose assembled argument payload is a
          // complete JSON object. A partial JSON prefix still takes the truncation path below.
          if (provider.openaiChatEofTolerance === true && pendingToolCallsAreCompleteJsonObjects()) {
            if ((yield* flushToolCalls()) === "terminate") return;
            yield { type: "done", usage: pendingUsage };
            return;
          }
          debugProviderDiagnostic("openai-chat", "stream-truncated", {
            finishReason: null,
            hadUsage: pendingUsage !== undefined,
            pendingToolCalls: pendingToolCalls.length,
          });
          yield { type: "error", message: "upstream stream ended mid tool call without a terminal signal — possible truncation" };
          return;
        }
        if (!sawFinish && !sawUserFacingOutput) {
          debugProviderDiagnostic("openai-chat", "stream-truncated", {
            finishReason: finishReason ?? null,
            hadUsage: pendingUsage !== undefined,
          });
          yield { type: "error", message: "upstream stream ended without a terminal signal ([DONE] or finish_reason) — possible truncation" };
          return;
        }
        if ((yield* flushToolCalls()) === "terminate") return;
        const stopReason = stopReasonFor(finishReason);
        yield { type: "done", usage: pendingUsage, ...(stopReason ? { stopReason } : {}) };
      } catch (error) {
        if (isTranslatorBudgetExceededError(error)
          || (error instanceof Error && (error.cause as { code?: unknown } | undefined)?.code === "translation_buffer_limit")) {
          yield {
            type: "error",
            status: 502,
            errorType: "upstream_error",
            code: "translation_buffer_limit",
            message: "upstream translation buffer exceeded the safe limit",
          };
          try { await reader.cancel(error); } catch { /* already closed */ }
          return;
        }
        throw error;
      } finally {
        budget.releaseRetained(bufferBytes, { kind: "live_transient" });
        closeToolCalls();
        reader.releaseLock();
      }
    },

    async parseResponse(
      response: Response,
      budget: TranslatorBudget,
      tierMetadata?: AdapterTierMetadata,
    ): Promise<AdapterEvent[]> {
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch (error) {
        tierMetadata?.markResponseUnparseable();
        throw error;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        tierMetadata?.markResponseUnparseable();
        throw new Error("upstream response was not a JSON object");
      }
      const json = parsed as Record<string, unknown>;
      if (Object.hasOwn(json, "service_tier")) {
        tierMetadata?.observeResponseServiceTier(json.service_tier);
      }
      const responseBytes = new TextEncoder().encode(JSON.stringify(json)).byteLength;
      budget.chargeRetained(responseBytes, { kind: "retained_collectors" });
      try {
        const payload = unwrapChatCompletionPayload(json);
        const usage = usageFromOpenAIChat(payload.usage as Record<string, unknown> | undefined);
        if (json.success === false && payload.error === undefined) {
          return [{
            type: "error",
            message: "upstream reported failure without an error payload",
            ...(usage ? { usage } : {}),
          }];
        }
        if (payload.error !== undefined && payload.error !== null) return [upstreamErrorEvent(payload.error, usage)];

        const events: AdapterEvent[] = [];
        const choices = payload.choices as {
          message?: Record<string, unknown>;
          finish_reason?: unknown;
          error?: OpenAIChatError;
        }[] | undefined;
        if (!Array.isArray(choices) || choices.length === 0) {
          return [{ type: "error", message: "upstream response contained no choices", ...(usage ? { usage } : {}) }];
        }
        const rawChoice = choices[0];
        if (rawChoice === null || typeof rawChoice !== "object" || Array.isArray(rawChoice)) {
          return [invalidChoicesEvent(usage)];
        }
        const choice = rawChoice;
        if (choice.finish_reason === "error") return [upstreamErrorEvent(choice.error, usage)];
        if (!choice.message) return [{ type: "error", message: "upstream response contained no choices", ...(usage ? { usage } : {}) }];

        const msg = choice.message;
        const reasoningText = reasoningTextFrom(msg);
        if (reasoningText !== undefined) events.push({ type: "reasoning_raw_delta", text: reasoningText });
        if (typeof msg.content === "string") events.push({ type: "text_delta", text: msg.content });
        const rawToolCalls = msg.tool_calls;
        if (rawToolCalls !== undefined && rawToolCalls !== null) {
          if (!Array.isArray(rawToolCalls)) {
            logInvalidToolCalls("response", rawToolCalls);
            return [invalidToolCallsEvent(rawToolCalls, "response", usage)];
          }
          for (const rawToolCall of rawToolCalls) {
            if (!isRecord(rawToolCall) || !isRecord(rawToolCall.function)) {
              logInvalidToolCalls("response", rawToolCalls);
              return [invalidToolCallsEvent(rawToolCalls, "response", usage)];
            }
            const id = rawToolCall.id;
            const name = rawToolCall.function.name;
            const args = rawToolCall.function.arguments;
            // A blank name is as undispatchable as a missing one, so it fails closed here
            // for the same reason the streamed path refuses it. Trimmed length, not `!name`:
            // a whitespace-only function name is not a legitimate tool-call shape either.
            if (typeof id !== "string" || typeof name !== "string" || typeof args !== "string"
              || name.trim().length === 0) {
              logInvalidToolCalls("response", rawToolCalls);
              return [invalidToolCallsEvent(rawToolCalls, "response", usage)];
            }
            events.push({ type: "tool_call_start", id, name });
            events.push({ type: "tool_call_delta", arguments: args });
            events.push({ type: "tool_call_end" });
          }
        }
        const stopReason = stopReasonFor(choice.finish_reason);
        events.push({
          type: "done",
          usage,
          ...(stopReason ? { stopReason } : {}),
        });
        retainTranslatedEventBatch(events, budget);
        return events;
      } finally {
        budget.releaseRetained(responseBytes, { kind: "retained_collectors" });
      }
    },
  };
}
