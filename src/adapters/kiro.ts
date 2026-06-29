import { decodeEventStream } from "../lib/eventstream-decoder";
import { estimateTokens } from "../lib/token-estimate";
import { debugProviderDiagnostic } from "../debug";
import { resolveKiroApiRegion, resolveKiroProfileArn } from "../oauth/kiro";
import { KIRO_MODEL_CONTEXT_WINDOWS, normalizeKiroModelId } from "../providers/kiro-models";
import { modelRecordValue } from "../reasoning-effort";
import { parseKiroEvent } from "./kiro-events";
import { safeKiroErrorMessage } from "./kiro-errors";
import { appendFallbackText, toolCallFallbackText, toolResultFallbackText } from "./kiro-tool-fallback";
import { KiroThinkingParser } from "./kiro-thinking";
import { isCompleteKiroToolInput, kiroTruncationErrorMessage } from "./kiro-truncation";
import { fallbackToolUseId, fingerprint, invocationId, mapModelId, normalizeToolId, osTag, stableConversationId } from "./kiro-wire";
import { namespacedToolName } from "../types";
import type {
  AdapterEvent,
  OcxAssistantMessage,
  OcxContentPart,
  OcxMessage,
  OcxParsedRequest,
  OcxProviderConfig,
  OcxTextContent,
  OcxToolCall,
  OcxToolResultMessage,
  OcxUsage,
} from "../types";
import type { ProviderAdapter } from "./base";
import type { AdapterFetchContext, AdapterRequest } from "./base";
import { extractKiroImages, type KiroImage } from "./kiro-images";
import { fetchKiroWithRetry } from "./kiro-retry";
import { convertKiroToolContext } from "./kiro-tools";

const AMZ_TARGET = "AmazonCodeWhispererStreamingService.GenerateAssistantResponse";
const SDK_VERSION = "1.0.27";
const NODE_VERSION = "22.21.1";
const KIRO_IDE_VERSION = "1.2.0";

// Payload construction (conversationState)
interface KiroToolUse {
  name: string;
  input: Record<string, unknown>; // OBJECT, not stringified
  toolUseId: string;
}
interface KiroToolResult {
  content: Array<{ text: string }>;
  status: string;
  toolUseId: string;
}
interface KiroUserInputMessage {
  content: string;
  modelId?: string;
  origin?: string;
  userInputMessageContext?: { tools?: unknown[]; toolResults?: KiroToolResult[] };
  images?: KiroImage[];
}
interface KiroHistoryEntry {
  userInputMessage?: KiroUserInputMessage;
  assistantResponseMessage?: { content: string; toolUses?: KiroToolUse[] };
}
function userContentText(content: string | OcxContentPart[]): string {
  if (typeof content === "string") return content;
  return content.map(p => (p.type === "text" ? p.text : "")).filter(Boolean).join("\n");
}

function usageContentText(content: string | OcxContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .map(p => {
      if (p.type === "text") return p.text;
      if (p.type === "image") return `[image:${p.detail ?? "auto"}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
function serializeForUsage(value: unknown): string {
  try { return JSON.stringify(value); } catch { return String(value); }
}
function currentTurnUsageMessages(messages: OcxMessage[]): OcxMessage[] {
  return messages.slice(messages.map(m => m.role).lastIndexOf("assistant") + 1).filter(m => m.role !== "assistant");
}
function currentTurnPayloadMessages(messages: OcxMessage[]): OcxMessage[] {
  const roles = messages.map(m => m.role);
  const lastAssistant = roles.lastIndexOf("assistant");
  const tail = messages.slice(lastAssistant + 1).filter(m => m.role !== "assistant");
  if (lastAssistant === -1 || !tail.some(m => m.role === "toolResult")) return tail;
  const priorAssistant = roles.slice(0, lastAssistant).lastIndexOf("assistant");
  return messages.slice(priorAssistant + 1);
}

function kiroPayloadMessages(parsed: OcxParsedRequest): OcxMessage[] {
  return parsed.previousResponseId ? currentTurnPayloadMessages(parsed.context.messages) : parsed.context.messages;
}

function messageUsageText(msg: OcxMessage): string {
  switch (msg.role) {
    case "user":
    case "developer":
      return usageContentText(msg.content);
    case "toolResult":
      return [
        msg.toolName,
        msg.toolCallId,
        msg.isError ? "error" : "success",
        usageContentText(msg.content),
      ].filter(Boolean).join("\n");
    case "assistant":
      return "";
  }
}

function messageLogText(msg: OcxMessage): string {
  if (msg.role !== "assistant") return messageUsageText(msg);
  return msg.content.map(part => {
    if (part.type === "text") return part.text;
    if (part.type === "toolCall") return [part.name, part.id, serializeForUsage(part.arguments)].join("\n");
    return part.thinking;
  }).filter(Boolean).join("\n");
}

function shouldCountStablePromptOverhead(parsed: OcxParsedRequest): boolean {
  return !parsed.previousResponseId && !parsed.context.messages.some(m => m.role === "assistant");
}

function estimateKiroInputTokens(parsed: OcxParsedRequest): number {
  const parts = currentTurnUsageMessages(parsed.context.messages)
    .map(messageUsageText)
    .filter(Boolean);

  if (shouldCountStablePromptOverhead(parsed)) {
    if (parsed.context.systemPrompt?.length) parts.push(...parsed.context.systemPrompt);
    if (parsed.context.tools?.length) parts.push(serializeForUsage(parsed.context.tools));
  }

  return estimateTokens(parts.join("\n"), parsed.modelId);
}

function estimateKiroLogInputTokens(parsed: OcxParsedRequest): number {
  const parts = parsed.context.messages.map(messageLogText).filter(Boolean);
  if (parsed.context.systemPrompt?.length) parts.push(...parsed.context.systemPrompt);
  if (parsed.context.tools?.length) parts.push(serializeForUsage(parsed.context.tools));
  return Math.max(estimateKiroInputTokens(parsed), estimateTokens(parts.join("\n"), parsed.modelId));
}

function configuredKiroContextWindow(provider: OcxProviderConfig, modelId: string | undefined): number | undefined {
  if (!modelId) return undefined;
  const normalizedModelId = normalizeKiroModelId(modelId);
  if (normalizedModelId === "auto") return undefined;
  const window =
    modelRecordValue(provider.modelContextWindows, modelId)
    ?? modelRecordValue(provider.modelContextWindows, normalizedModelId)
    ?? provider.contextWindow
    ?? modelRecordValue(KIRO_MODEL_CONTEXT_WINDOWS, modelId)
    ?? modelRecordValue(KIRO_MODEL_CONTEXT_WINDOWS, normalizedModelId);
  return typeof window === "number" && Number.isFinite(window) && window > 0 ? window : undefined;
}

function contextUsageTotalTokens(contextUsagePercentage: number | undefined, contextWindow: number | undefined): number | undefined {
  if (contextUsagePercentage === undefined || contextUsagePercentage <= 0 || !contextWindow) return undefined;
  return Math.max(0, Math.floor((contextUsagePercentage / 100) * contextWindow));
}

function kiroThinkingBudget(parsed: OcxParsedRequest): number | undefined {
  const effort = parsed.options.reasoning;
  if (!effort || effort === "none") return undefined;
  const maxTokens = parsed.options.maxOutputTokens || 4096;
  const percent: Record<string, number> = {
    minimal: 0.10,
    low: 0.20,
    medium: 0.50,
    high: 0.80,
    xhigh: 0.95,
    max: 0.95,
  };
  const ratio = percent[effort];
  return ratio === undefined ? undefined : Math.max(1, Math.floor(maxTokens * ratio));
}

function injectKiroThinkingTags(content: string, parsed: OcxParsedRequest): string {
  const budget = kiroThinkingBudget(parsed);
  if (!budget) return content;
  const instruction = [
    "Think in English for better reasoning quality.",
    "Be thorough and systematic, consider edge cases, challenge assumptions, and verify reasoning before answering.",
    "After thinking, respond in the user's language.",
  ].join("\n");
  return [
    "<thinking_mode>enabled</thinking_mode>",
    `<max_thinking_length>${budget}</max_thinking_length>`,
    `<thinking_instruction>${instruction}</thinking_instruction>`,
    "",
    content,
  ].join("\n");
}

export function buildKiroPayload(parsed: OcxParsedRequest, profileArn: string | undefined): Record<string, unknown> {
  const modelId = mapModelId(parsed.modelId);
  const toolContext = convertKiroToolContext(parsed);
  const kiroTools = toolContext.tools;
  const systemParts: string[] = [];
  if (!parsed.previousResponseId && parsed.context.systemPrompt?.length) systemParts.push(parsed.context.systemPrompt.join("\n\n"));
  if (toolContext.systemAdditions.length > 0) systemParts.push(...toolContext.systemAdditions);
  const systemPrefix = systemParts.length > 0 ? `${systemParts.join("\n\n")}\n\n` : "";
  const structuredToolIds = new Set<string>();

  const mkUser = (content: string, images?: KiroImage[]): KiroHistoryEntry => ({
    userInputMessage: {
      content,
      modelId,
      origin: "AI_EDITOR",
      ...(images && images.length > 0 ? { images } : {}),
    },
  });
  const history: KiroHistoryEntry[] = [];
  const fallbackEntries = new WeakSet<KiroHistoryEntry>();
  let pending: KiroToolResult[] = [];
  let pendingImages: KiroImage[] = [];
  let lastRole = "";
  const attachPending = (entry: KiroHistoryEntry): void => {
    if (pending.length === 0) return;
    const uim = entry.userInputMessage!;
    uim.userInputMessageContext = { ...(uim.userInputMessageContext ?? {}), toolResults: pending };
    if (pendingImages.length > 0) uim.images = [...(uim.images ?? []), ...pendingImages];
    pending = [];
    pendingImages = [];
  };
  const pushUserEntry = (entry: KiroHistoryEntry): void => {
    if (pending.length === 0 && lastRole === "user") {
      history.push({ assistantResponseMessage: { content: "(acknowledged)" } });
    }
    attachPending(entry);
    history.push(entry);
    lastRole = "user";
  };

  for (const msg of kiroPayloadMessages(parsed)) {
    if (msg.role === "user" || msg.role === "developer") {
      const text = userContentText((msg as { content: string | OcxContentPart[] }).content);
      const images = extractKiroImages((msg as { content: string | OcxContentPart[] }).content);
      pushUserEntry(mkUser(text, images));
    } else if (msg.role === "assistant") {
      if (pending.length > 0) {
        const carrier = mkUser("(tool results)");
        pushUserEntry(carrier);
      }
      const aMsg = msg as OcxAssistantMessage;
      let text = (aMsg.content || [])
        .filter((b): b is OcxTextContent => b.type === "text")
        .map(b => b.text)
        .join("");
      const toolCalls = (aMsg.content || [])
        .filter((b): b is OcxToolCall => b.type === "toolCall");
      const toolUses: KiroToolUse[] = kiroTools.length > 0
        ? toolCalls.map(tc => {
          const toolUseId = normalizeToolId(tc.id);
          structuredToolIds.add(toolUseId);
          return { name: namespacedToolName(tc.namespace, tc.name), input: (tc.arguments ?? {}) as Record<string, unknown>, toolUseId };
        })
        : [];
      if (kiroTools.length === 0) {
        for (const toolCall of toolCalls) text = appendFallbackText(text, toolCallFallbackText(toolCall));
      }
      if (lastRole === "assistant") history.push(mkUser("(continue)"));
      const entry: KiroHistoryEntry = { assistantResponseMessage: { content: text } };
      if (toolUses.length > 0) entry.assistantResponseMessage!.toolUses = toolUses;
      history.push(entry);
      lastRole = "assistant";
    } else if (msg.role === "toolResult") {
      const tr = msg as OcxToolResultMessage;
      const text = userContentText(tr.content);
      const images = extractKiroImages(tr.content);
      const toolUseId = normalizeToolId(tr.toolCallId);
      if (kiroTools.length > 0 && structuredToolIds.has(toolUseId)) {
        pending.push({
          content: [{ text: text || "(empty)" }],
          status: tr.isError ? "error" : "success",
          toolUseId,
        });
        pendingImages.push(...images);
      } else {
        if (pending.length > 0) pushUserEntry(mkUser("(tool results)"));
        const fallback = mkUser(toolResultFallbackText(tr), images);
        fallbackEntries.add(fallback);
        pushUserEntry(fallback);
      }
    }
  }

  let currentEntry: KiroHistoryEntry;
  if (pending.length > 0) {
    currentEntry = mkUser("(tool results)");
    attachPending(currentEntry);
  } else if (history.length > 0 && history[history.length - 1].userInputMessage) {
    currentEntry = history.pop()!;
  } else {
    currentEntry = mkUser("(continue)");
  }
  const currentUim = currentEntry.userInputMessage!;

  if (systemPrefix) {
    const firstUser = history.find(e => e.userInputMessage)?.userInputMessage;
    if (firstUser) firstUser.content = systemPrefix + firstUser.content;
    else currentUim.content = systemPrefix + currentUim.content;
  }
  if (kiroTools.length > 0) {
    currentUim.userInputMessageContext = { ...(currentUim.userInputMessageContext ?? {}), tools: kiroTools };
  }
  if (!fallbackEntries.has(currentEntry) && !currentUim.userInputMessageContext?.toolResults && currentUim.content !== "(continue)") {
    currentUim.content = injectKiroThinkingTags(currentUim.content, parsed);
  }

  const payload: Record<string, unknown> = {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId: stableConversationId(parsed),
      currentMessage: { userInputMessage: currentUim },
      ...(history.length > 0 ? { history } : {}),
    },
  };
  if (profileArn) payload.profileArn = profileArn;
  return payload;
}

// Stream parsing (shared by parseStream + parseResponse)
// CodeWhisperer GenerateAssistantResponse ALWAYS returns an AWS eventstream body (there is no
// non-streaming mode), so both the streaming bridge and the non-streaming web-search sidecar loop
// decode the same way — parseResponse just collects what parseStream yields.
export async function* parseKiroStream(
  response: Response,
  modelId?: string,
  inputTokens = 0,
  contextWindow?: number,
): AsyncGenerator<AdapterEvent> {
  if (!response.body) {
    yield { type: "error", message: "Kiro response has no body" };
    return;
  }
  let open: { id: string; name: string; chunks: string[] } | null = null;
  // CW provides no usage; accumulate output chars and emit a heuristic estimate on done so Codex's
  // usage display + auto-compact engage (see src/lib/token-estimate.ts).
  let outputChars = "";
  let contextUsagePercentage: number | undefined;
  const thinking = new KiroThinkingParser();
  const trackContent = (event: AdapterEvent): void => {
    if ("text" in event) outputChars += event.text;
  };
  function* flushTool(): Generator<AdapterEvent> {
    if (!open) return;
    const tool = open;
    open = null;
    yield { type: "tool_call_start", id: tool.id, name: tool.name };
    for (const chunk of tool.chunks) if (chunk) yield { type: "tool_call_delta", arguments: chunk };
    yield { type: "tool_call_end" };
  }
  try {
    for await (const msg of decodeEventStream(response.body)) {
      const mt = msg.headers[":message-type"];
      if (mt === "exception" || mt === "error") {
        // Terminal: surface the upstream error and never emit a trailing success-shaped `done`.
        open = null;
        yield { type: "error", message: safeKiroErrorMessage(msg.headers, new TextDecoder().decode(msg.payload)) };
        return;
      }
      if (mt && mt !== "event") continue;
      const ev = parseKiroEvent(msg.payload);
      if (!ev) continue;
      switch (ev.type) {
        case "usage":
          break;
        case "context_usage":
          if (ev.contextUsagePercentage !== undefined && ev.contextUsagePercentage > 0) {
            contextUsagePercentage = ev.contextUsagePercentage;
          }
          break;
        case "content":
          if (open) {
            open = null;
            yield { type: "error", message: kiroTruncationErrorMessage("content arrived before tool stop") };
            return;
          }
          if (ev.data) {
            for (const contentEvent of thinking.feed(ev.data)) {
              trackContent(contentEvent);
              yield contentEvent;
            }
          }
          break;
        case "tool_start": {
          for (const contentEvent of thinking.flush()) {
            trackContent(contentEvent);
            yield contentEvent;
          }
          const id = ev.toolUseId || fallbackToolUseId();
          const name = ev.name || "unknown";
          if (open) {
            if (open.id !== id || open.name !== name) {
              open = null;
              yield { type: "error", message: kiroTruncationErrorMessage("new tool started before previous tool stop") };
              return;
            }
          } else {
            open = { id, name, chunks: [] };
          }
          yield { type: "heartbeat" };
          break;
        }
        case "tool_input": {
          for (const contentEvent of thinking.flush()) {
            trackContent(contentEvent);
            yield contentEvent;
          }
          if (!open) {
            open = { id: ev.toolUseId || fallbackToolUseId(), name: ev.name || "unknown", chunks: [] };
          }
          if (open && ev.input) {
            if (open.name === "unknown" && ev.name) open.name = ev.name;
            open.chunks.push(ev.input);
            outputChars += ev.input;
          }
          yield { type: "heartbeat" };
          break;
        }
        case "tool_stop": {
          if (open) {
            const input = open.chunks.join("");
            if (!isCompleteKiroToolInput(input)) {
              open = null;
              yield { type: "error", message: kiroTruncationErrorMessage("incomplete tool input JSON") };
              return;
            }
            yield* flushTool();
          }
          break;
        }
        case "truncation":
          open = null;
          yield { type: "error", message: kiroTruncationErrorMessage(ev.data) };
          return;
      }
    }
    for (const contentEvent of thinking.flush()) {
      trackContent(contentEvent);
      yield contentEvent;
    }
    if (open) {
      const input = open.chunks.join("");
      if (!isCompleteKiroToolInput(input)) {
        open = null;
        yield { type: "error", message: kiroTruncationErrorMessage("stream ended before tool stop") };
        return;
      }
      yield* flushTool();
    }
    const outputTokens = estimateTokens(outputChars, modelId);
    const usage: OcxUsage = { inputTokens, outputTokens, estimated: true };
    const totalTokens = contextUsageTotalTokens(contextUsagePercentage, contextWindow);
    if (totalTokens !== undefined) usage.totalTokens = totalTokens;
    yield { type: "done", usage };
  } catch (err) {
    yield { type: "error", message: safeKiroErrorMessage({}, err instanceof Error ? err.message : String(err)) };
  }
}

// Adapter
export function createKiroAdapter(provider: OcxProviderConfig): ProviderAdapter {
  // Per-request closure (resolveAdapter builds a fresh adapter per request — server.ts:440 — so this
  // is race-free) carrying the heuristic input-token estimate from buildRequest into the stream.
  let inputTokens = 0;
  let modelId: string | undefined;
  let contextWindow: number | undefined;
  return {
    name: "kiro",
    buildRequest(parsed: OcxParsedRequest) {
      const region = resolveKiroApiRegion();
      const profileArn = resolveKiroProfileArn();
      const fp = fingerprint().slice(0, 64);
      const headers: Record<string, string> = {
        authorization: `Bearer ${provider.apiKey ?? ""}`,
        "content-type": "application/x-amz-json-1.0",
        accept: "application/vnd.amazon.eventstream",
        "x-amz-target": AMZ_TARGET,
        "user-agent": `aws-sdk-js/${SDK_VERSION} ua/2.1 os/${osTag()} lang/js md/nodejs#${NODE_VERSION} api/codewhispererstreaming#${SDK_VERSION} m/E KiroIDE-${KIRO_IDE_VERSION}-${fp}`,
        "x-amz-user-agent": `aws-sdk-js/${SDK_VERSION} KiroIDE-${KIRO_IDE_VERSION}-${fp}`,
        "x-amzn-codewhisperer-optout": "true",
        "x-amzn-kiro-agent-mode": "vibe",
        "amz-sdk-invocation-id": invocationId(),
      };
      if (profileArn) headers["x-amzn-kiro-profile-arn"] = profileArn;
      // CodeWhisperer GenerateAssistantResponse has no reasoning_effort field. Match kiro-gateway's
      // fake-reasoning contract by injecting effort-derived thinking tags into only the current user turn.
      const payload = buildKiroPayload(parsed, profileArn);
      const body = JSON.stringify(payload);
      debugProviderDiagnostic("kiro", "request", {
        region,
        requestedModel: parsed.modelId,
        bodyBytes: new TextEncoder().encode(body).length,
        messageCount: kiroPayloadMessages(parsed).length,
        toolCount: parsed.context.tools?.length ?? 0,
        hasProfileArn: Boolean(profileArn),
        hasPreviousResponseId: Boolean(parsed.previousResponseId),
      });
      // CW returns no usage. Codex adds each response's usage into its session total; report only the
      // current-turn input delta so old history is not repeatedly added to Codex's visible token usage.
      modelId = parsed.modelId;
      contextWindow = configuredKiroContextWindow(provider, parsed.modelId);
      inputTokens = estimateKiroInputTokens(parsed);
      return {
        url: `https://runtime.${region}.kiro.dev/`,
        method: "POST",
        headers,
        body,
        usageLog: { inputTokens: estimateKiroLogInputTokens(parsed), estimated: true },
      };
    },

    parseStream(response: Response): AsyncGenerator<AdapterEvent> {
      return parseKiroStream(response, modelId, inputTokens, contextWindow);
    },

    fetchResponse(request: AdapterRequest, ctx?: AdapterFetchContext): Promise<Response> {
      return fetchKiroWithRetry(request, ctx);
    },

    // Non-streaming path used by the web-search sidecar loop (loop.ts runs each iteration
    // non-streamed so it can inspect tool calls). CW only ever event-streams, so we drain the
    // same decoder into an array. Without this, any Codex request that includes the web_search
    // tool failed with "web-search sidecar requires a non-streaming adapter" (kiro-only).
    async parseResponse(response: Response): Promise<AdapterEvent[]> {
      const events: AdapterEvent[] = [];
      for await (const e of parseKiroStream(response, modelId, inputTokens, contextWindow)) events.push(e);
      return events;
    },
  };
}
