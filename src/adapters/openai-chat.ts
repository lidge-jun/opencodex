import type { ProviderAdapter } from "./base";
import type { AdapterEvent, OcxAssistantMessage, OcxContentPart, OcxMessage, OcxParsedRequest, OcxProviderConfig, OcxTextContent, OcxThinkingContent, OcxToolCall, OcxUsage } from "../types";
import { isAllowedToolChoice, modelInList, namespacedToolName, resolveToolChoiceWireName, toolAllowedByChoice } from "../types";
import { mapReasoningEffort } from "../reasoning-effort";
import { redactSecretString } from "../lib/redact";
import { contentPartsToText } from "./image";
import { neutralizeIdentity } from "./identity";
import { buildNonOpenAIToolCatalogNudgeForTools, shouldInjectNonOpenAIToolCatalogNudge } from "./tool-catalog-nudge";
import { openRouterProviderPayload, resolveOpenRouterRouting } from "../providers/openrouter-routing";

// Providers may opt into stripping one trailing "[...]" group from the wire model id.
// Z.AI needs this because its OpenAI path rejects glm-5.2[1m] with 400 code 1211;
// unflagged OpenAI-compatible providers and the Anthropic adapter keep ids verbatim.
export function stripBracketedModelSuffix(modelId: string): string {
  return modelId.replace(/\[[^\]]*\]\s*$/, "");
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
  // OpenAI shape: { error: { message } } or { error: "..." }
  const err = obj.error;
  if (typeof err === "string" && err.trim()) return err.trim();
  if (err !== null && typeof err === "object" && !Array.isArray(err)) {
    const msg = (err as Record<string, unknown>).message;
    if (typeof msg === "string" && msg.trim()) return msg.trim();
  }
  // FastAPI/pydantic shape (NVIDIA NIM): { detail: "..." } or { detail: [{ msg, loc }, ...] }
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
  // Generic fallbacks: { message } / RFC7807 { title }
  if (typeof obj.message === "string" && obj.message.trim()) return obj.message.trim();
  if (typeof obj.title === "string" && obj.title.trim()) return obj.title.trim();
  return undefined;
}

function messagesToChatFormat(parsed: OcxParsedRequest, provider: OcxProviderConfig): unknown[] {
  const out: unknown[] = [];
  const { context, options } = parsed;

  // 260718 dangling tool_calls hardening (devlog/_plan/260718_dangling_toolcall_hardening):
  // strict chat providers (Kimi/Moonshot) 400 when an assistant tool_call is not answered
  // immediately by role:"tool" messages. Repair order: (1) reattach a real result to its
  // original call (barrier messages are DEFERRED until the open tool round closes),
  // (2) synthesize an explicit unavailable-result only when no real result exists,
  // (3) manufacture an orphan assistant call only when no call occurrence matches at all.
  // Occurrences are kept as an ordered list (never a Map) so duplicated ids survive.
  interface PendingToolCall { id: string; name: string }
  let pendingToolCalls: PendingToolCall[] = [];
  let deferredBarrierMessages: unknown[] = [];
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

  // Close an unresolved tool round with explicit unavailable-result messages. The wording
  // must not claim interruption, success, failure, or user intent: execution status is
  // UNKNOWN, and for user-input tools this must not read as an answer.
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
    releaseDeferredBarriers();
  };

  const toolCatalogNudge = shouldInjectNonOpenAIToolCatalogNudge(provider)
    ? buildNonOpenAIToolCatalogNudgeForTools(context.tools, options.toolChoice)
    : undefined;
  const systemParts = [...(context.systemPrompt ?? []), ...(toolCatalogNudge ? [toolCatalogNudge] : [])];
  if (systemParts.length > 0) {
    // Codex sends its GPT-5 identity prompt for EVERY model (the per-model catalog
    // base_instructions is ignored at request time). Neutralize that one identity line
    // so routed, non-OpenAI models don't misreport themselves as GPT-5 / OpenAI — without
    // leaking the proxy identity into the payload.
    const sys = neutralizeIdentity(systemParts.join("\n\n"));
    out.push({ role: "system", content: sys });
  }

  for (const msg of context.messages) {
    switch (msg.role) {
      case "user":
      case "developer": {
        const role = msg.role === "developer" ? "system" : "user";
        let chatMsg: Record<string, unknown>;
        if (typeof msg.content === "string") {
          chatMsg = { role, content: msg.content };
        } else {
          const parts = msg.content as OcxContentPart[];
          if (!parts.some(p => p.type === "image")) {
            chatMsg = { role, content: parts.map(p => (p as OcxTextContent).text).join("") };
          } else {
            // Vision: chat-completions content-parts array. Images are only valid on the user role,
            // and the data URL goes straight into image_url.url (never the token-exploding text path).
            const chatParts = parts.map(p => p.type === "image"
              ? { type: "image_url", image_url: { url: p.imageUrl, ...(p.detail ? { detail: p.detail } : {}) } }
              : { type: "text", text: (p as OcxTextContent).text });
            chatMsg = { role: "user", content: chatParts };
          }
        }
        // A barrier must not split an open tool round: defer it until the round closes
        // (real result arrives) or the round is synthesized shut.
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
        if (textParts.length > 0) {
          chatMsg.content = textParts.map(p => p.text).join("");
        }
        const reasoningContent = thinkingParts.map(p => p.thinking).join("");
        if (reasoningContent.length > 0 && modelInList(provider.preserveReasoningContentModels, parsed.modelId)) {
          chatMsg.reasoning_content = reasoningContent;
        }
        // Skip empty assistant messages: chat APIs like DeepSeek reject an assistant message
        // with neither content, tool calls, nor a provider-supported reasoning_content field.
        if (chatMsg.content === undefined && toolCalls.length === 0 && chatMsg.reasoning_content === undefined) break;
        // A new assistant starts while a previous round is still open: close the previous
        // round synthetically first so its tool_calls are never left dangling.
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
          // "" instead of null: strict validators (xAI: "Each message must have at least one
          // content element", langchain#34140) reject content-less assistant history entries.
          if (!chatMsg.content) chatMsg.content = "";
        }
        if (chatMsg.reasoning_content !== undefined && chatMsg.content === undefined && chatMsg.tool_calls === undefined) {
          chatMsg.content = "";
        }
        out.push(chatMsg);
        pendingToolCalls = wireToolCalls.map(({ tc, id }) => ({ id, name: namespacedToolName(tc.namespace, tc.name) }));
        break;
      }
      case "toolResult": {
        let toolCallId = msg.toolCallId;
        const matchIdx = toolCallId ? pendingToolCalls.findIndex(c => c.id === toolCallId) : -1;
        if (matchIdx >= 0 && toolCallId) {
          // Real result reattached to its original call. Barriers were deferred, so the
          // tool message lands immediately inside the open round.
          out.push({
            role: "tool",
            tool_call_id: toolCallId,
            content: contentPartsToText(msg.content),
          });
          pendingToolCalls.splice(matchIdx, 1);
          if (pendingToolCalls.length === 0) releaseDeferredBarriers();
        } else {
          if (!toolCallId) toolCallId = `call_orphan_${out.length}`;
          // No matching call in the open round. Close any unresolved round first so the
          // synthesized orphan pair never splits it, then keep the historical repair:
          // WS turns can arrive with only tool outputs; chat-completions providers reject a bare
          // role:"tool" message unless an assistant tool_call with the same id immediately precedes it.
          flushPendingToolCalls();
          const name = safeToolName(msg.toolName);
          out.push({
            role: "assistant",
            content: "",
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
            content: contentPartsToText(msg.content),
          });
        }
        break;
      }
    }
  }

  // Trailing dangle: a turn interrupted after the assistant requested tools leaves the
  // round open; close it synthetically (then release any deferred barriers in order).
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
  return provider.baseUrl.replace(/\/+$/, "") === "https://opencode.ai/zen/v1";
}

const XAI_SCHEMA_BASE_URLS = new Set(["api.x.ai", "cli-chat-proxy.grok.com"]);

function isXaiSchemaTarget(provider: OcxProviderConfig): boolean {
  try {
    return XAI_SCHEMA_BASE_URLS.has(new URL(provider.baseUrl).hostname);
  } catch {
    return false;
  }
}

function isKimiSchemaTarget(provider: OcxProviderConfig): boolean {
  try {
    return new URL(provider.baseUrl).hostname === "api.kimi.com";
  } catch {
    return false;
  }
}

/**
 * Kimi requires function.parameters.type to be exactly "object" at the root.
 * Codex tools with oneOf/anyOf schemas omit the root type, causing 400 errors.
 * Add type: "object" at the root while preserving oneOf, $defs, and other schema keys.
 */
function ensureKimiRootObjectType(parameters: unknown): Record<string, unknown> {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    return { type: "object", properties: {} };
  }
  const obj = parameters as Record<string, unknown>;
  if (obj.type === "object") return obj;
  return { ...obj, type: "object" };
}

function expandXaiRootObjectSchemas(schema: unknown): Record<string, unknown>[] | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  const obj = schema as Record<string, unknown>;
  const compositionKey = ["oneOf", "anyOf"].find(key => Array.isArray(obj[key]));
  if (!compositionKey) {
    if (obj.type !== undefined && obj.type !== "object") return undefined;
    return [{ ...obj, type: "object" }];
  }

  const siblings = Object.fromEntries(Object.entries(obj).filter(([key]) => key !== compositionKey));
  const branches = obj[compositionKey];
  if (!Array.isArray(branches)) return undefined;
  const expanded: Record<string, unknown>[] = [];
  for (const branch of branches) {
    const variants = expandXaiRootObjectSchemas(branch);
    if (!variants) return undefined;
    for (const variant of variants) expanded.push({ ...siblings, ...variant });
  }
  return expanded.length > 0 ? expanded : undefined;
}

function normalizeXaiToolParameters(parameters: unknown): Record<string, unknown> | undefined {
  const variants = expandXaiRootObjectSchemas(parameters);
  if (!variants) return undefined;
  if (variants.length === 1) return variants[0];
  const root = parameters && typeof parameters === "object" && !Array.isArray(parameters)
    ? parameters as Record<string, unknown>
    : {};
  const metadata = Object.fromEntries(Object.entries(root).filter(([key]) => key !== "oneOf" && key !== "anyOf" && key !== "type"));
  return { ...metadata, oneOf: variants };
}

function toolsToChatFormat(parsed: OcxParsedRequest, provider: OcxProviderConfig): unknown[] | undefined {
  if (!parsed.context.tools || parsed.context.tools.length === 0) return undefined;
  const allowed = isAllowedToolChoice(parsed.options.toolChoice)
    ? new Set(parsed.options.toolChoice.allowedTools)
    : undefined;
  const tools = allowed
    ? parsed.context.tools.filter(t => toolAllowedByChoice(t, allowed))
    : parsed.context.tools;
  if (tools.length === 0) return undefined;
  const xaiTarget = isXaiSchemaTarget(provider);
  const kimiTarget = isKimiSchemaTarget(provider);
  const formatted = tools.flatMap(t => {
    const parameters = xaiTarget
      ? normalizeXaiToolParameters(t.parameters)
      : kimiTarget
        ? ensureKimiRootObjectType(t.parameters)
        : t.parameters;
    if (parameters === undefined) return [];
    return [{
    type: "function",
    function: {
      name: namespacedToolName(t.namespace, t.name),
      description: t.description,
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

function toolChoiceToChatFormat(tc: OcxParsedRequest["options"]["toolChoice"], tools: OcxParsedRequest["context"]["tools"]): unknown {
  if (!tc) return undefined;
  if (isAllowedToolChoice(tc)) return tc.mode === "required" ? "required" : "auto";
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

function thinkingBudgetForEffort(parsed: OcxParsedRequest, reasoningEffort: string): number | undefined {
  if (parsed.options.reasoning === "minimal") return 0;
  const maxBudget = parsed.options.maxOutputTokens ?? 32768;
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

export function createOpenAIChatAdapter(provider: OcxProviderConfig): ProviderAdapter {
  return {
    name: "openai-chat",

    formatErrorBody: formatOpenAIChatErrorBody,

    buildRequest(parsed: OcxParsedRequest) {
      const hasCredential = typeof provider.apiKey === "string" && provider.apiKey.trim().length > 0;
      if ((provider.authMode === "key" || provider.authMode === "oauth") && !provider.keyOptional && !hasCredential) {
        throw new Error(`${provider.adapter} requires a non-empty credential (authMode: ${provider.authMode})`);
      }

      const messages = messagesToChatFormat(parsed, provider);
      const tools = toolsToChatFormatForProvider(parsed, provider);
      const toolChoice = toolChoiceToChatFormat(parsed.options.toolChoice, parsed.context.tools);

      const body: Record<string, unknown> = {
        model: provider.modelSuffixBracketStrip ? stripBracketedModelSuffix(parsed.modelId) : parsed.modelId,
        messages,
        stream: parsed.stream,
      };
      const openRouterRouting = resolveOpenRouterRouting(provider, parsed.modelId);
      if (openRouterRouting) body.provider = openRouterProviderPayload(openRouterRouting);
      if (tools) body.tools = tools;
      if (tools && toolChoice !== undefined) {
        body.tool_choice = modelInList(provider.autoToolChoiceOnlyModels, parsed.modelId)
          ? (toolChoice === "none" ? "none" : "auto")
          : toolChoice;
      }
      if (parsed.options.maxOutputTokens !== undefined) body.max_tokens = parsed.options.maxOutputTokens;
      if (parsed.options.temperature !== undefined && !modelInList(provider.noTemperatureModels, parsed.modelId)) {
        body.temperature = parsed.options.temperature;
      }
      if (parsed.options.topP !== undefined && !modelInList(provider.noTopPModels, parsed.modelId)) {
        body.top_p = parsed.options.topP;
      }
      if (parsed.options.stopSequences !== undefined) body.stop = parsed.options.stopSequences;
      const reasoningEffort = mapReasoningEffort(provider, parsed.modelId, parsed.options.reasoning);
      if (reasoningEffort !== undefined) {
        if (modelInList(provider.thinkingBudgetModels, parsed.modelId)) {
          const budget = thinkingBudgetForEffort(parsed, reasoningEffort);
          if (budget !== undefined) body.thinking_budget = budget;
        } else if (modelInList(provider.thinkingToggleModels, parsed.modelId)) {
          // Vendor thinking-toggle wire (MiMo v2.x, GLM 5/5.1): the mapped value is the toggle
          // state, sent as `thinking: {type}` — these models ignore/reject reasoning_effort.
          if (reasoningEffort === "enabled" || reasoningEffort === "disabled") {
            body.thinking = { type: reasoningEffort };
          }
        } else {
          body.reasoning_effort = reasoningEffort;
        }
      }
      if (parsed.options.presencePenalty !== undefined && !modelInList(provider.noPenaltyModels, parsed.modelId)) {
        body.presence_penalty = parsed.options.presencePenalty;
      }
      if (parsed.options.frequencyPenalty !== undefined && !modelInList(provider.noPenaltyModels, parsed.modelId)) {
        body.frequency_penalty = parsed.options.frequencyPenalty;
      }
      // prompt_cache_key is an OpenAI-specific chat extension; strict backends (Groq,
      // Cerebras, etc.) reject unknown fields. Only forward when the provider opts in.
      if (provider.promptCacheKey && parsed.options.promptCacheKey !== undefined) {
        body.prompt_cache_key = parsed.options.promptCacheKey;
      }

      if (tools) {
        // Default-ON for chat-completions providers (user decision 260709): the buffered
        // parser assembles multi-call streams safely, so `parallelToolCalls: false` is the
        // only per-provider opt-out; Codex's request bit can still force false per request.
        // Rationale + provider evidence: devlog/_plan/260709_parallel_tool_calls.
        body.parallel_tool_calls = provider.parallelToolCalls === false
          ? false
          : parsed.options.parallelToolCalls !== false;
      }
      if (parsed.stream) {
        body.stream_options = { include_usage: true };
      }

      const url = `${provider.baseUrl}/chat/completions`;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      // Precedence preserved from pre-#128 behavior: apiKey Authorization first, then
      // provider.headers may override (user/registry-configured headers win). Registry
      // staticHeaders (e.g. opencode-free x-opencode-client) flow in via derive.ts and
      // never carry Authorization, so keyless providers are unaffected.
      if (hasCredential) headers["Authorization"] = `Bearer ${provider.apiKey}`;
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
      // Streamed tool calls are BUFFERED until a terminal signal, then flushed as atomic
      // start/delta/end sequences. The bridge treats text/reasoning deltas as barriers that
      // close an open tool-call item (bridge.ts closeCurrentToolCall on text_delta), so
      // emitting calls incrementally would orphan later argument deltas whenever a provider
      // interleaves content — and parallel tool calls (multiple ids, index-keyed continuation
      // chunks, whole-chunk calls) cannot be represented live without overlapping sequences.
      // Keyed by `index` (OpenAI wire standard), falling back to `id`, falling back to the
      // last-seen call for providers that omit both on continuation chunks.
      interface PendingToolCall { key: string; id: string; name: string; args: string }
      const pendingToolCalls: PendingToolCall[] = [];
      let toolCallSeq = 0;
      const flushToolCalls = function* (): Generator<AdapterEvent> {
        for (const call of pendingToolCalls) {
          if (!call.id) call.id = `call_${++toolCallSeq}`;
          yield { type: "tool_call_start", id: call.id, name: call.name };
          if (call.args.length > 0) yield { type: "tool_call_delta", arguments: call.args };
          yield { type: "tool_call_end" };
        }
        pendingToolCalls.length = 0;
      };
      let pendingUsage: OcxUsage | undefined;
      // Track terminal signals so a socket EOF without any terminator can fail closed instead of
      // being reported as a clean completion (silent truncation). A graceful close is either an
      // explicit `[DONE]` sentinel OR a chunk carrying a non-null `finish_reason` (some
      // OpenAI-compatible providers omit `[DONE]` but do send finish_reason).
      let sawFinish = false;

      // Single per-line handler shared by the streaming loop and the EOF residual-frame flush, so
      // a final frame is parsed identically wherever it lands (no duplicated, drift-prone parsing).
      // Yields adapter events and returns "terminate" for a terminal frame ([DONE] / error) that
      // must end the stream, or "continue" otherwise. Mutates the closure's terminal-signal state.
      const handleDataLine = function* (line: string): Generator<AdapterEvent, "continue" | "terminate"> {
        if (!line.startsWith("data: ")) return "continue";
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") {
          yield* flushToolCalls();
          yield { type: "done", usage: pendingUsage };
          return "terminate";
        }

        let chunk: Record<string, unknown>;
        try {
          chunk = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          yield { type: "error", message: "malformed upstream SSE data frame" };
          return "terminate";
        }

        // A 200/OK chat-completions stream may carry an inline provider error envelope
        // instead of a clean [DONE]. Surface it as a terminal error so the bridge emits a
        // classified response.failed (bridge case "error") — never a truncated completion.
        if (chunk.error) {
          const err = chunk.error as { message?: string } | undefined;
          yield* flushToolCalls();
          yield { type: "error", message: err?.message ?? "upstream error" };
          return "terminate";
        }

        if (chunk.usage) {
          // Record usage but keep parsing: some providers send usage and the final content
          // delta in the SAME chunk; a bail here would drop that content. The choices
          // guard below no-ops a usage-only chunk.
          pendingUsage = usageFromOpenAIChat(chunk.usage as Record<string, unknown>);
        }

        const choices = chunk.choices as { delta?: Record<string, unknown>; finish_reason?: string }[] | undefined;
        if (!choices || choices.length === 0) return "continue";
        // Observe the terminator BEFORE the delta guard: a finish-only chunk (finish_reason set,
        // no delta) is a graceful close and must mark sawFinish even though we skip it below.
        if (typeof choices[0].finish_reason === "string" && choices[0].finish_reason) {
          sawFinish = true;
        }
        const delta = choices[0].delta;
        if (delta) {
          if (typeof delta.content === "string" && delta.content.length > 0) {
            yield { type: "text_delta", text: delta.content };
          }

          if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
            yield { type: "reasoning_raw_delta", text: delta.reasoning_content };
          }

          const toolCalls = delta.tool_calls as { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] | undefined;
          if (toolCalls) {
            for (const tc of toolCalls) {
              const key = typeof tc.index === "number"
                ? `i:${tc.index}`
                : tc.id
                ? `id:${tc.id}`
                : pendingToolCalls[pendingToolCalls.length - 1]?.key;
              let call = key !== undefined ? pendingToolCalls.find(c => c.key === key) : undefined;
              // Mixed keying rescue: a call opened under an index key must still absorb an
              // id-only continuation for the same provider id (and vice versa) instead of
              // splitting into two calls that share one call_id downstream.
              if (!call && tc.id) call = pendingToolCalls.find(c => c.id === tc.id);
              if (!call) {
                call = { key: key ?? `seq:${pendingToolCalls.length}`, id: "", name: "", args: "" };
                pendingToolCalls.push(call);
              }
              if (tc.id && !call.id) call.id = tc.id;
              if (tc.function?.name && !call.name) call.name = tc.function.name;
              if (tc.function?.arguments) call.args += tc.function.arguments;
            }
          }
        }

        // Any non-empty finish_reason ends the generation: flush assembled tool calls as
        // atomic sequences (covers "tool_calls" AND providers that close tool turns with "stop").
        if (typeof choices[0].finish_reason === "string" && choices[0].finish_reason) {
          yield* flushToolCalls();
        }
        return "continue";
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if ((yield* handleDataLine(line)) === "terminate") return;
          }
        }

        // Some providers send the terminal `data:` frame (carrying the final delta, finish_reason,
        // and/or usage) WITHOUT a trailing newline before closing the socket, so it never crosses
        // the split("\n") boundary and stays in `buffer`. Run it through the SAME handler so its
        // content/tool-calls are emitted and its terminal signal observed — otherwise a genuinely
        // complete stream loses its last frame and may be falsely failed below.
        if (buffer.length > 0) {
          if ((yield* handleDataLine(buffer)) === "terminate") return;
        }
        yield* flushToolCalls();
        // Reader EOF. A graceful close shows at least one terminal signal: `[DONE]` (returns above),
        // a non-null finish_reason (sawFinish), or a trailing usage chunk (providers emit usage only
        // at end-of-generation). If NONE of those were seen, the stream was cut mid-flight — fail
        // closed so the bridge emits a classified response.failed rather than a silent truncation.
        if (!sawFinish && pendingUsage === undefined) {
          yield { type: "error", message: "upstream stream ended without a terminal signal ([DONE] or finish_reason) — possible truncation" };
          return;
        }
        // Graceful close that omitted [DONE] but delivered finish_reason and/or final usage.
        yield { type: "done", usage: pendingUsage };
      } finally {
        reader.releaseLock();
      }
    },

    async parseResponse(response: Response): Promise<AdapterEvent[]> {
      const json = await response.json() as Record<string, unknown>;
      if (json.error) {
        const upstreamError = json.error as { message?: unknown };
        return [{
          type: "error",
          message: typeof upstreamError.message === "string" ? upstreamError.message : "upstream error",
        }];
      }

      const events: AdapterEvent[] = [];
      const choices = json.choices as { message?: Record<string, unknown> }[] | undefined;
      if (!Array.isArray(choices) || choices.length === 0 || !choices[0].message) {
        return [{ type: "error", message: "upstream response contained no choices" }];
      }

      const msg = choices[0].message;
      if (typeof msg.content === "string") {
        events.push({ type: "text_delta", text: msg.content });
      }
      if (typeof msg.reasoning_content === "string" && msg.reasoning_content.length > 0) {
        events.push({ type: "reasoning_raw_delta", text: msg.reasoning_content });
      }
      const toolCalls = msg.tool_calls as { id: string; function: { name: string; arguments: string } }[] | undefined;
      if (toolCalls) {
        for (const tc of toolCalls) {
          events.push({ type: "tool_call_start", id: tc.id, name: tc.function.name });
          events.push({ type: "tool_call_delta", arguments: tc.function.arguments });
          events.push({ type: "tool_call_end" });
        }
      }
      const usage = json.usage as Record<string, unknown> | undefined;
      events.push({
        type: "done",
        usage: usageFromOpenAIChat(usage),
      });
      return events;
    },
  };
}
