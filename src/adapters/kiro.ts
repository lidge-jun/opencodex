import { decodeEventStream } from "../lib/eventstream-decoder";
import { estimateTokens } from "../lib/token-estimate";
import { debugProviderDiagnostic } from "../lib/debug";
import { resolveKiroApiRegion, resolveKiroProfileArn } from "../oauth/kiro";
import { KIRO_MODEL_CONTEXT_WINDOWS, normalizeKiroModelId } from "../providers/kiro-models";
import { modelRecordValue } from "../reasoning-effort";
import { parseKiroEvent } from "./kiro-events";
import {
  classifyKiroEventError,
  classifyKiroHttpError,
  classifyKiroStreamError,
  safeKiroErrorMessage,
  safeKiroHttpErrorMessage,
  type KiroErrorClassification,
} from "./kiro-errors";
import { KiroThinkingParser } from "./kiro-thinking";
import { isCompleteKiroToolInput, kiroTruncationErrorMessage } from "./kiro-truncation";
import { createKiroToolNameRegistry, fallbackToolUseId, fingerprint, invocationId, isValidKiroConversationId, mapModelId, normalizeToolId, osTag, stableConversationId } from "./kiro-wire";
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
import { extractKiroImages, normalizeKiroImages, type KiroImage } from "./kiro-images";
import { fetchKiroWithRetry } from "./kiro-retry";
import { convertKiroToolContext } from "./kiro-tools";
import { neutralizeIdentity } from "./identity";
import { buildNonOpenAIToolCatalogNudgeFromNames } from "./tool-catalog-nudge";
import {
  KIRO_COMPLETION_INSTRUCTIONS,
  KIRO_COMPLETION_RETRY_MESSAGE,
  KIRO_COMPLETION_TOOL_NAME,
  KIRO_CONTINUATION_MESSAGE,
  MAX_KIRO_INJECTED_INSTRUCTION_CHARS,
  type KiroCompletionMode,
} from "./kiro-constants";

const AMZ_TARGET = "AmazonCodeWhispererStreamingService.GenerateAssistantResponse";
const SDK_VERSION = "1.0.27";
const NODE_VERSION = "22.21.1";
const KIRO_IDE_VERSION = "1.0.0";

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

function kiroToolWireNames(tools: readonly unknown[]): string[] {
  return tools
    .map(tool => {
      const spec = (tool as { toolSpecification?: { name?: unknown } }).toolSpecification;
      return typeof spec?.name === "string" ? spec.name : undefined;
    })
    .filter((name): name is string => typeof name === "string");
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
function kiroPayloadMessages(parsed: OcxParsedRequest): OcxMessage[] {
  return parsed.context.messages;
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

function kiroRuntimeEndpoint(provider: OcxProviderConfig, region: string): string {
  const configured = new URL(provider.baseUrl);
  if (
    /^runtime\.[a-z]{2}(?:-[a-z]+)+-\d\.kiro\.dev$/i.test(configured.hostname)
    && configured.pathname === "/"
  ) {
    return `https://runtime.${region}.kiro.dev/`;
  }
  return configured.toString();
}

export type KiroReasoningMode = "native" | "emulated";

export function kiroReasoningMode(modelId: string): KiroReasoningMode {
  return normalizeKiroModelId(modelId) === "gpt-5.6-sol" ? "native" : "emulated";
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
    xhigh: 0.90,
    max: 0.95,
  };
  const ratio = percent[effort];
  return ratio === undefined ? undefined : Math.max(1, Math.floor(maxTokens * ratio));
}

function injectKiroThinkingTags(content: string, parsed: OcxParsedRequest): string {
  if (kiroReasoningMode(parsed.modelId) !== "emulated") return content;
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

function validateKiroCapabilities(parsed: OcxParsedRequest): void {
  const choice = parsed.options.toolChoice;
  if (choice !== undefined && choice !== "auto" && choice !== "none") {
    throw new Error("Kiro supports only automatic tool choice or tool_choice:none");
  }
  if (parsed.options.parallelToolCalls === true) {
    throw new Error("Kiro does not support parallel tool calls");
  }
  if (parsed.options.serviceTier !== undefined) {
    throw new Error("Kiro does not support service tiers");
  }
  const raw = parsed._rawBody as Record<string, unknown> | undefined;
  if (parsed._structuredOutput || raw?.text !== undefined) {
    throw new Error("Kiro does not support Responses text controls or structured output");
  }
}

type KiroTurn =
  | { kind: "user"; content: string; images: KiroImage[]; toolResults: KiroToolResult[] }
  | { kind: "assistant"; content: string; toolUses: KiroToolUse[] };

function appendTurnText(target: string, next: string): string {
  if (!next) return target;
  return target ? `${target}\n\n${next}` : next;
}

function boundedInjectedInstruction(text: string, used: { value: number }): string | undefined {
  const remaining = MAX_KIRO_INJECTED_INSTRUCTION_CHARS - used.value;
  if (remaining <= 0 || !text) return undefined;
  const result = text.length <= remaining ? text : text.slice(0, remaining);
  used.value += result.length;
  return result;
}

function kiroCompletionTool(): Record<string, unknown> {
  return {
    toolSpecification: {
      name: KIRO_COMPLETION_TOOL_NAME,
      description: "Finish the task and return the complete user-facing final answer. Call only when no more work or tool calls are needed.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            answer: {
              type: "string",
              description: "The complete final answer to show the user.",
            },
          },
          required: ["answer"],
        },
      },
    },
  };
}

export function buildKiroPayload(
  parsed: OcxParsedRequest,
  profileArn: string | undefined,
  forcedCompletionMode?: KiroCompletionMode,
): {
  payload: Record<string, unknown>;
  nameMap: Map<string, string>;
  conversationId: string;
  completionMode: KiroCompletionMode;
} {
  validateKiroCapabilities(parsed);
  const modelId = mapModelId(parsed.modelId);
  const registry = createKiroToolNameRegistry();
  const toolContext = convertKiroToolContext(parsed, registry);
  const ordinaryTools = toolContext.tools;
  const completionMode: KiroCompletionMode = forcedCompletionMode
    ?? (ordinaryTools.length > 0 ? "required" : "disabled");
  const kiroTools = completionMode === "disabled"
    ? ordinaryTools
    : [...ordinaryTools, kiroCompletionTool()];
  const nameMap = toolContext.nameMap;
  const systemParts: string[] = [];
  const injectedChars = { value: 0 };
  // Neutralize Codex's GPT-5 identity line so a routed Kiro model never misreports as GPT-5/OpenAI
  // and the proxy identity never leaks upstream.
  if (parsed.context.systemPrompt?.length) systemParts.push(neutralizeIdentity(parsed.context.systemPrompt.join("\n\n")));
  const toolCatalogNudge = buildNonOpenAIToolCatalogNudgeFromNames(kiroToolWireNames(ordinaryTools));
  const boundedNudge = toolCatalogNudge ? boundedInjectedInstruction(toolCatalogNudge, injectedChars) : undefined;
  if (boundedNudge) systemParts.push(boundedNudge);
  if (completionMode !== "disabled") {
    const boundedCompletion = boundedInjectedInstruction(KIRO_COMPLETION_INSTRUCTIONS, injectedChars);
    if (boundedCompletion) systemParts.push(boundedCompletion);
  }
  const systemPrefix = systemParts.length > 0 ? `${systemParts.join("\n\n")}\n\n` : "";
  const turns: KiroTurn[] = [];
  const priorCalls = new Map<string, { wireName: string }>();
  const pushUser = (content: string, images: KiroImage[] = [], toolResults: KiroToolResult[] = []): void => {
    const last = turns.at(-1);
    if (last?.kind === "user") {
      last.content = appendTurnText(last.content, content);
      last.images.push(...images);
      last.toolResults.push(...toolResults);
    } else {
      turns.push({ kind: "user", content, images: [...images], toolResults: [...toolResults] });
    }
  };
  const pushAssistant = (content: string, toolUses: KiroToolUse[]): void => {
    const last = turns.at(-1);
    if (last?.kind === "assistant") {
      last.content = appendTurnText(last.content, content);
      last.toolUses.push(...toolUses);
    } else {
      turns.push({ kind: "assistant", content, toolUses: [...toolUses] });
    }
  };

  for (const msg of kiroPayloadMessages(parsed)) {
    if (msg.role === "user" || msg.role === "developer") {
      const text = userContentText((msg as { content: string | OcxContentPart[] }).content);
      const images = extractKiroImages((msg as { content: string | OcxContentPart[] }).content);
      pushUser(text, images);
    } else if (msg.role === "assistant") {
      const aMsg = msg as OcxAssistantMessage;
      const text = (aMsg.content || [])
        .filter((b): b is OcxTextContent => b.type === "text")
        .map(b => b.text)
        .join("");
      const toolCalls = (aMsg.content || [])
        .filter((b): b is OcxToolCall => b.type === "toolCall");
      const toolUses: KiroToolUse[] = toolCalls.map(tc => {
        const toolUseId = normalizeToolId(tc.id);
        if (!toolUseId) throw new Error("Kiro history contains a tool call with an empty id");
        if (priorCalls.has(toolUseId)) throw new Error(`Kiro history contains duplicate tool call id ${JSON.stringify(tc.id)}`);
        const wireName = namespacedToolName(tc.namespace, tc.name);
        const name = registry.alias(wireName);
        priorCalls.set(toolUseId, { wireName });
        return { name, input: (tc.arguments ?? {}) as Record<string, unknown>, toolUseId };
      });
      if (!text && toolUses.length === 0) {
        const hasReasoning = aMsg.content.some(part => part.type === "thinking" && part.thinking.trim());
        if (hasReasoning) continue;
      }
      pushAssistant(text, toolUses);
    } else if (msg.role === "toolResult") {
      const tr = msg as OcxToolResultMessage;
      if (tr.containsEncryptedContent) {
        throw new Error(`Kiro cannot translate encrypted output for tool call ${JSON.stringify(tr.toolCallId)}`);
      }
      const text = userContentText(tr.content);
      const images = extractKiroImages(tr.content);
      const toolUseId = normalizeToolId(tr.toolCallId);
      if (!priorCalls.has(toolUseId)) {
        throw new Error(`Kiro history contains an orphaned tool result for call ${JSON.stringify(tr.toolCallId)}`);
      }
      pushUser("", images, [{
        content: [{ text }],
        status: tr.isError ? "error" : "success",
        toolUseId,
      }]);
    }
  }

  // A reasoning-only first attempt has no Kiro-replayable assistant text. Preserve the turn
  // boundary structurally so the adapter-generated retry is still a user turn after assistant
  // history, without inventing prose that the model never said.
  if (completionMode === "text_fallback" && turns.at(-1)?.kind !== "assistant") {
    pushAssistant("", []);
  }

  if (turns.length === 0 || turns[0].kind === "assistant") {
    turns.unshift({ kind: "user", content: KIRO_CONTINUATION_MESSAGE, images: [], toolResults: [] });
  }
  if (turns.at(-1)?.kind === "assistant") {
    turns.push({ kind: "user", content: KIRO_CONTINUATION_MESSAGE, images: [], toolResults: [] });
  }

  const currentTurn = turns.pop();
  if (!currentTurn || currentTurn.kind !== "user") throw new Error("Kiro request must end with a user turn");
  const toEntry = (turn: KiroTurn): KiroHistoryEntry => turn.kind === "assistant"
    ? {
        assistantResponseMessage: {
          content: turn.content,
          ...(turn.toolUses.length > 0 ? { toolUses: turn.toolUses } : {}),
        },
      }
    : {
        userInputMessage: {
          content: turn.content,
          modelId,
          origin: "AI_EDITOR",
          ...(turn.images.length > 0 ? { images: turn.images } : {}),
          ...(turn.toolResults.length > 0 ? { userInputMessageContext: { toolResults: turn.toolResults } } : {}),
        },
      };
  const history = turns.map(toEntry);
  const currentEntry = toEntry(currentTurn);
  const currentUim = currentEntry.userInputMessage!;

  if (systemPrefix) {
    const firstUser = history.find(e => e.userInputMessage)?.userInputMessage;
    if (firstUser) firstUser.content = systemPrefix + firstUser.content;
    else currentUim.content = systemPrefix + currentUim.content;
  }
  if (kiroTools.length > 0) {
    currentUim.userInputMessageContext = { ...(currentUim.userInputMessageContext ?? {}), tools: kiroTools };
  }
  if (completionMode === "text_fallback") {
    currentUim.content = KIRO_COMPLETION_RETRY_MESSAGE;
  } else if (!currentUim.userInputMessageContext?.toolResults && currentUim.content !== KIRO_CONTINUATION_MESSAGE) {
    currentUim.content = injectKiroThinkingTags(currentUim.content, parsed);
  }

  const conversationId = stableConversationId(parsed);
  const payload: Record<string, unknown> = {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId,
      currentMessage: { userInputMessage: currentUim },
      ...(history.length > 0 ? { history } : {}),
    },
  };
  const effort = parsed.options.reasoning;
  if (kiroReasoningMode(parsed.modelId) === "native" && effort && effort !== "none") {
    if (!["low", "medium", "high", "xhigh", "max"].includes(effort)) {
      throw new Error(`Kiro gpt-5.6-sol does not support reasoning effort ${JSON.stringify(effort)}`);
    }
    payload.additionalModelRequestFields = { reasoning: { effort } };
  }
  if (profileArn) payload.profileArn = profileArn;
  return { payload, nameMap, conversationId, completionMode };
}

// Stream parsing (shared by parseStream + parseResponse)
// CodeWhisperer GenerateAssistantResponse ALWAYS returns an AWS eventstream body (there is no
// non-streaming mode), so both the streaming bridge and the non-streaming web-search sidecar loop
// decode the same way — parseResponse just collects what parseStream yields.
interface KiroAttemptResult {
  terminal?: AdapterEvent;
  needsFallback?: boolean;
  usage?: OcxUsage;
  providerState?: { kiro: { conversationId: string } };
  assistantText: string;
  sawReasoning: boolean;
}

interface KiroFallbackAttempt {
  response: Response;
  inputTokens: number;
  nameMap: Map<string, string>;
  conversationId: string;
}

type KiroFallbackFactory = (
  conversationId: string | undefined,
  assistantText: string,
  sawReasoning: boolean,
) => Promise<KiroFallbackAttempt>;

function mergeKiroUsage(first: OcxUsage | undefined, second: OcxUsage | undefined): OcxUsage | undefined {
  if (!first) return second;
  if (!second) return first;
  const sumOptional = (key: keyof OcxUsage): number | undefined => {
    const a = first[key];
    const b = second[key];
    return typeof a === "number" || typeof b === "number"
      ? (typeof a === "number" ? a : 0) + (typeof b === "number" ? b : 0)
      : undefined;
  };
  const totalTokens = typeof first.totalTokens === "number" && typeof second.totalTokens === "number"
    ? first.totalTokens + second.totalTokens
    : undefined;
  return {
    inputTokens: first.inputTokens + second.inputTokens,
    outputTokens: first.outputTokens + second.outputTokens,
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(sumOptional("cachedInputTokens") !== undefined ? { cachedInputTokens: sumOptional("cachedInputTokens") } : {}),
    ...(sumOptional("cacheReadInputTokens") !== undefined ? { cacheReadInputTokens: sumOptional("cacheReadInputTokens") } : {}),
    ...(sumOptional("cacheCreationInputTokens") !== undefined ? { cacheCreationInputTokens: sumOptional("cacheCreationInputTokens") } : {}),
    ...(sumOptional("reasoningOutputTokens") !== undefined ? { reasoningOutputTokens: sumOptional("reasoningOutputTokens") } : {}),
    ...(first.estimated || second.estimated ? { estimated: true } : {}),
  };
}

function retryableKiroIncomplete(
  reason: string,
  message: string,
  usage: OcxUsage,
  providerState: { kiro: { conversationId: string } } | undefined,
): AdapterEvent {
  return {
    type: "incomplete",
    reason,
    message,
    usage,
    retryable: true,
    endTurn: false,
    ...(providerState ? { providerState } : {}),
  };
}

function normalizedKiroAnswer(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

async function* parseKiroAttempt(
  response: Response,
  mode: KiroCompletionMode,
  modelId: string | undefined,
  inputTokens: number,
  contextWindow: number | undefined,
  nameMap: Map<string, string> | undefined,
  conversationId: string | undefined,
  previousAssistantText?: string,
): AsyncGenerator<AdapterEvent, KiroAttemptResult> {
  const emptyResult = (): KiroAttemptResult => ({ assistantText: "", sawReasoning: false });
  if (!response.body) {
    return {
      ...emptyResult(),
      terminal: { type: "error", message: "Kiro response has no body", status: 502, errorType: "upstream_error" },
    };
  }

  let open: { id: string; name: string; chunks: string[]; completion: boolean } | null = null;
  let outputChars = "";
  let contextUsagePercentage: number | undefined;
  let returnedConversationId = conversationId;
  let assistantText = "";
  let sawText = false;
  let sawReasoning = false;
  let sawRealTool = false;
  let completionAnswer: string | undefined;
  let completionCalls = 0;
  let authoritativeUsage: OcxUsage | undefined;
  const fallbackEvents: AdapterEvent[] = [];
  const thinking = new KiroThinkingParser();

  const providerState = (): { kiro: { conversationId: string } } | undefined =>
    returnedConversationId ? { kiro: { conversationId: returnedConversationId } } : undefined;

  const usage = (): OcxUsage => authoritativeUsage ?? ({
      inputTokens,
      outputTokens: estimateTokens(outputChars, modelId),
      estimated: true,
    });

  const classifiedTerminal = (failure: KiroErrorClassification): AdapterEvent => ({
    type: "error",
    message: failure.message,
    status: failure.status,
    errorType: failure.errorType,
    code: failure.code,
    retryable: failure.retryable,
    usage: usage(),
  });

  const protocolTerminal = (message: string, malformedCompletion = false): AdapterEvent => {
    if (mode === "text_fallback" && malformedCompletion) {
      return retryableKiroIncomplete(
        "malformed_kiro_completion",
        message,
        usage(),
        providerState(),
      );
    }
    return {
      type: "error",
      message,
      status: 502,
      errorType: "upstream_error",
      code: malformedCompletion ? "invalid_kiro_completion" : "kiro_stream_protocol_error",
      retryable: false,
      usage: usage(),
    };
  };

  const classifyTool = (
    tool: { id: string; name: string; chunks: string[]; completion: boolean },
  ): AdapterEvent | undefined => {
    if (tool.name !== KIRO_COMPLETION_TOOL_NAME) {
      tool.completion = false;
      return completionAnswer !== undefined || completionCalls > 0
        ? protocolTerminal("Kiro returned a real tool call alongside a private final answer")
        : undefined;
    }
    if (mode === "disabled") {
      return protocolTerminal("Kiro returned the reserved private final-answer tool while explicit completion was disabled");
    }
    tool.completion = true;
    if (completionAnswer !== undefined || completionCalls > 0) {
      return protocolTerminal("Kiro returned more than one private final-answer tool call", true);
    }
    if (sawRealTool) {
      return protocolTerminal("Kiro returned a private final answer alongside a real tool call");
    }
    return undefined;
  };

  const beginTool = (
    id: string,
    name: string,
  ): { tool?: { id: string; name: string; chunks: string[]; completion: boolean }; terminal?: AdapterEvent } => {
    const next = { id, name, chunks: [], completion: false };
    const terminal = classifyTool(next);
    return terminal ? { terminal } : { tool: next };
  };

  const stage = (event: AdapterEvent): AdapterEvent[] => {
    if (event.type === "text_delta") {
      assistantText += event.text;
      if (event.text.trim()) sawText = true;
      outputChars += event.text;
      const phased = mode === "disabled"
        ? event
        : { ...event, phase: "commentary" as const };
      if (mode === "text_fallback") {
        fallbackEvents.push(phased);
        return [];
      }
      return [phased];
    }
    if (event.type === "reasoning_raw_delta" || event.type === "thinking_delta") {
      const text = event.type === "reasoning_raw_delta" ? event.text : event.thinking;
      if (text.trim()) sawReasoning = true;
      outputChars += text;
    }
    if (mode === "text_fallback" && event.type !== "heartbeat") {
      fallbackEvents.push(event);
      return [];
    }
    return [event];
  };

  const parseCompletion = (chunks: string[]): string | Error => {
    const raw = chunks.join("").trim();
    let value: unknown;
    try {
      value = JSON.parse(raw || "{}");
    } catch {
      return new Error("Kiro returned invalid JSON for the private final-answer tool");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return new Error("Kiro returned a non-object value for the private final-answer tool");
    }
    const answer = (value as { answer?: unknown }).answer;
    if (typeof answer !== "string" || !answer.trim()) {
      return new Error("Kiro returned an empty final answer");
    }
    return answer;
  };

  const flushOpen = (): { events: AdapterEvent[]; terminal?: AdapterEvent } => {
    if (!open) return { events: [] };
    const tool = open;
    open = null;
    const input = tool.chunks.join("");
    if (!isCompleteKiroToolInput(input)) {
      return { events: [], terminal: protocolTerminal(kiroTruncationErrorMessage("incomplete tool input JSON"), tool.completion) };
    }
    if (tool.completion) {
      completionCalls++;
      if (completionCalls > 1) {
        return { events: [], terminal: protocolTerminal("Kiro returned more than one private final-answer tool call", true) };
      }
      if (sawRealTool) {
        return { events: [], terminal: protocolTerminal("Kiro returned a private final answer alongside a real tool call") };
      }
      const answer = parseCompletion(tool.chunks);
      if (answer instanceof Error) return { events: [], terminal: protocolTerminal(answer.message, true) };
      completionAnswer = answer;
      return { events: [] };
    }
    if (completionAnswer !== undefined || completionCalls > 0) {
      return { events: [], terminal: protocolTerminal("Kiro returned a real tool call alongside a private final answer") };
    }
    sawRealTool = true;
    const restored = nameMap?.get(tool.name) ?? tool.name;
    return {
      events: [
        { type: "tool_call_start", id: tool.id, name: restored },
        ...tool.chunks.filter(Boolean).map(argumentsChunk => ({ type: "tool_call_delta", arguments: argumentsChunk }) as AdapterEvent),
        { type: "tool_call_end" },
      ],
    };
  };

  try {
    for await (const msg of decodeEventStream(response.body)) {
      const mt = msg.headers[":message-type"];
      if (mt === "exception" || mt === "error") {
        open = null;
        return {
          assistantText,
          sawReasoning,
          terminal: classifiedTerminal(classifyKiroStreamError(msg.headers, new TextDecoder().decode(msg.payload))),
        };
      }
      if (mt !== "event") {
        open = null;
        return {
          assistantText,
          sawReasoning,
          terminal: protocolTerminal(`Kiro response protocol error: unsupported Smithy message type ${JSON.stringify(mt ?? "missing")}`),
        };
      }
      const eventType = msg.headers[":event-type"];
      if (!eventType) {
        open = null;
        return { assistantText, sawReasoning, terminal: protocolTerminal("Kiro response protocol error: event is missing :event-type") };
      }
      const ev = parseKiroEvent(eventType, msg.payload);
      if (!ev) continue;
      switch (ev.type) {
        case "metadata":
          if (ev.usage) authoritativeUsage = ev.usage;
          if (ev.contextUsagePercentage !== undefined && ev.contextUsagePercentage > 0) {
            contextUsagePercentage = ev.contextUsagePercentage;
          }
          break;
        case "message_metadata":
          if (isValidKiroConversationId(ev.conversationId)) returnedConversationId = ev.conversationId;
          break;
        case "content":
          if (open) {
            open = null;
            return { assistantText, sawReasoning, terminal: protocolTerminal(kiroTruncationErrorMessage("content arrived before tool stop")) };
          }
          if (ev.data) {
            for (const contentEvent of thinking.feed(ev.data)) {
              for (const staged of stage(contentEvent)) yield staged;
            }
          }
          break;
        case "reasoning":
          for (const contentEvent of thinking.flush()) {
            for (const staged of stage(contentEvent)) yield staged;
          }
          if (ev.data) {
            for (const staged of stage({ type: "reasoning_raw_delta", text: ev.data })) yield staged;
          }
          break;
        case "tool": {
          for (const contentEvent of thinking.flush()) {
            for (const staged of stage(contentEvent)) yield staged;
          }
          if (!open) {
            if (ev.stop === true) {
              return { assistantText, sawReasoning, terminal: protocolTerminal("Kiro response protocol error: tool stop received without an open tool call") };
            }
            if (!ev.toolUseId || !ev.name) {
              return { assistantText, sawReasoning, terminal: protocolTerminal("Kiro response protocol error: new tool event is missing toolUseId or name") };
            }
            const started = beginTool(ev.toolUseId, ev.name);
            if (started.terminal) return { assistantText, sawReasoning, terminal: started.terminal };
            open = started.tool!;
          } else if (
            (ev.toolUseId && ev.toolUseId !== open.id)
            || (ev.name && open.name !== "unknown" && ev.name !== open.name)
          ) {
            open = null;
            return { assistantText, sawReasoning, terminal: protocolTerminal(kiroTruncationErrorMessage("tool input changed identity before stop")) };
          }
          if (open && open.name === "unknown" && ev.name) {
            open.name = ev.name;
            const terminal = classifyTool(open);
            if (terminal) {
              open = null;
              return { assistantText, sawReasoning, terminal };
            }
          }
          if (open && ev.input !== undefined) {
            open.chunks.push(ev.input);
            outputChars += ev.input;
          }
          if (ev.stop === true) {
            const flushed = flushOpen();
            if (flushed.terminal) return { assistantText, sawReasoning, terminal: flushed.terminal };
            for (const event of flushed.events) {
              for (const staged of stage(event)) yield staged;
            }
          } else {
            yield { type: "heartbeat" };
          }
          break;
        }
        case "invalid_state":
          open = null;
          return { assistantText, sawReasoning, terminal: classifiedTerminal(classifyKiroEventError(undefined, ev.message ?? "Kiro entered an invalid state")) };
        case "error":
          open = null;
          return { assistantText, sawReasoning, terminal: classifiedTerminal(classifyKiroEventError(ev.reason, ev.message)) };
        case "truncation":
          open = null;
          return { assistantText, sawReasoning, terminal: protocolTerminal(kiroTruncationErrorMessage(ev.data)) };
      }
    }

    for (const contentEvent of thinking.flush()) {
      for (const staged of stage(contentEvent)) yield staged;
    }
    if (open) {
      const input = open.chunks.join("");
      if (!isCompleteKiroToolInput(input)) {
        const privateTool = open.completion;
        open = null;
        return {
          assistantText,
          sawReasoning,
          terminal: protocolTerminal(kiroTruncationErrorMessage("stream ended before tool stop"), privateTool),
        };
      }
      const flushed = flushOpen();
      if (flushed.terminal) return { assistantText, sawReasoning, terminal: flushed.terminal };
      for (const event of flushed.events) {
        for (const staged of stage(event)) yield staged;
      }
    }

    const finalUsage = usage();
    const finalProviderState = providerState();
    if (contextUsagePercentage !== undefined) {
      debugProviderDiagnostic("kiro", "context_usage", {
        contextUsagePercentage,
        ...(contextWindow ? { configuredContextWindow: contextWindow } : {}),
      });
    }

    if (mode === "text_fallback") {
      if (completionAnswer !== undefined) {
        for (const event of fallbackEvents) yield event;
        if (normalizedKiroAnswer(completionAnswer) !== normalizedKiroAnswer(previousAssistantText ?? "")) {
          yield { type: "text_delta", text: completionAnswer, phase: "final_answer" };
        }
        return {
          assistantText,
          sawReasoning,
          terminal: { type: "done", usage: finalUsage, endTurn: true, ...(finalProviderState ? { providerState: finalProviderState } : {}) },
        };
      }
      if (sawRealTool) {
        for (const event of fallbackEvents) yield event;
        return {
          assistantText,
          sawReasoning,
          terminal: { type: "done", usage: finalUsage, endTurn: false, ...(finalProviderState ? { providerState: finalProviderState } : {}) },
        };
      }
      if (sawText) {
        const repeated = normalizedKiroAnswer(assistantText) === normalizedKiroAnswer(previousAssistantText ?? "");
        for (const event of fallbackEvents) {
          if (event.type !== "text_delta") yield event;
          else if (!repeated) yield { ...event, phase: "final_answer" };
        }
        return {
          assistantText,
          sawReasoning,
          terminal: { type: "done", usage: finalUsage, endTurn: true, ...(finalProviderState ? { providerState: finalProviderState } : {}) },
        };
      }
      for (const event of fallbackEvents) yield event;
      return {
        assistantText,
        sawReasoning,
        terminal: retryableKiroIncomplete(
          sawReasoning ? "reasoning_only_kiro_fallback" : "empty_kiro_fallback",
          sawReasoning
            ? "Kiro produced reasoning but no final answer on its bounded completion retry"
            : "Kiro produced no final answer on its bounded completion retry",
          finalUsage,
          finalProviderState,
        ),
      };
    }

    if (completionAnswer !== undefined) {
      yield { type: "text_delta", text: completionAnswer, phase: "final_answer" };
      return {
        assistantText,
        sawReasoning,
        terminal: { type: "done", usage: finalUsage, endTurn: true, ...(finalProviderState ? { providerState: finalProviderState } : {}) },
      };
    }
    if (sawRealTool) {
      return {
        assistantText,
        sawReasoning,
        terminal: { type: "done", usage: finalUsage, endTurn: false, ...(finalProviderState ? { providerState: finalProviderState } : {}) },
      };
    }
    if (mode === "required" && (sawText || sawReasoning)) {
      return { assistantText, sawReasoning, needsFallback: true, usage: finalUsage, providerState: finalProviderState };
    }
    if (!sawText && !sawReasoning) {
      return {
        assistantText,
        sawReasoning,
        terminal: retryableKiroIncomplete(
          "empty_kiro_stream",
          "Kiro returned a successful but empty response stream",
          finalUsage,
          finalProviderState,
        ),
      };
    }
    return {
      assistantText,
      sawReasoning,
      terminal: {
        type: "done",
        usage: finalUsage,
        endTurn: mode === "disabled" ? sawText : false,
        ...(finalProviderState ? { providerState: finalProviderState } : {}),
      },
    };
  } catch (err) {
    return {
      assistantText,
      sawReasoning,
      terminal: {
        type: "error",
        message: safeKiroErrorMessage({}, err instanceof Error ? err.message : String(err)),
        status: 502,
        errorType: "server_error",
        code: "kiro_stream_protocol_error",
        retryable: false,
        usage: usage(),
      },
    };
  }
}

export async function* parseKiroStream(
  response: Response,
  modelId?: string,
  inputTokens = 0,
  contextWindow?: number,
  nameMap?: Map<string, string>,
  conversationId?: string,
  completionMode: KiroCompletionMode = "disabled",
  fallbackFactory?: KiroFallbackFactory,
): AsyncGenerator<AdapterEvent> {
  const first = parseKiroAttempt(
    response,
    completionMode,
    modelId,
    inputTokens,
    contextWindow,
    nameMap,
    conversationId,
  );
  let firstNext = await first.next();
  while (!firstNext.done) {
    yield firstNext.value;
    firstNext = await first.next();
  }
  const firstResult = firstNext.value;
  if (!firstResult.needsFallback) {
    if (firstResult.terminal) yield firstResult.terminal;
    return;
  }
  if (!fallbackFactory) {
    yield retryableKiroIncomplete(
      "uncompleted_kiro_response",
      "Kiro produced progress without an explicit final answer and no bounded retry transport was available",
      firstResult.usage ?? { inputTokens, outputTokens: 0, estimated: true },
      firstResult.providerState,
    );
    return;
  }

  yield { type: "heartbeat" };
  let fallback: KiroFallbackAttempt;
  try {
    fallback = await fallbackFactory(
      firstResult.providerState?.kiro.conversationId ?? conversationId,
      firstResult.assistantText,
      firstResult.sawReasoning,
    );
  } catch (err) {
    yield {
      type: "error",
      message: safeKiroErrorMessage({}, err instanceof Error ? err.message : String(err)),
      status: err instanceof Error && err.name === "TimeoutError" ? 504 : 502,
      errorType: "upstream_error",
      retryable: true,
      usage: firstResult.usage,
    };
    return;
  }
  if (!fallback.response.ok) {
    const payload = await fallback.response.text().catch(() => "");
    const failure = classifyKiroHttpError(fallback.response.status, fallback.response.headers, payload);
    yield {
      type: "error",
      message: failure.message,
      status: failure.status,
      errorType: failure.errorType,
      code: failure.code,
      retryable: failure.retryable,
      usage: firstResult.usage,
    };
    return;
  }

  const second = parseKiroAttempt(
    fallback.response,
    "text_fallback",
    modelId,
    fallback.inputTokens,
    contextWindow,
    fallback.nameMap,
    fallback.conversationId,
    firstResult.assistantText,
  );
  let secondNext = await second.next();
  while (!secondNext.done) {
    yield secondNext.value;
    secondNext = await second.next();
  }
  const secondResult = secondNext.value;
  if (!secondResult.terminal) {
    yield retryableKiroIncomplete(
      "empty_kiro_fallback",
      "Kiro's bounded completion retry ended without a terminal result",
      mergeKiroUsage(firstResult.usage, secondResult.usage) ?? { inputTokens, outputTokens: 0, estimated: true },
      secondResult.providerState ?? firstResult.providerState,
    );
    return;
  }
  if (secondResult.terminal.type === "done" || secondResult.terminal.type === "incomplete") {
    yield {
      ...secondResult.terminal,
      usage: mergeKiroUsage(firstResult.usage, secondResult.terminal.usage),
      providerState: secondResult.terminal.providerState ?? firstResult.providerState,
    };
    return;
  }
  yield {
    ...secondResult.terminal,
    ...(secondResult.terminal.type === "error"
      ? { usage: mergeKiroUsage(firstResult.usage, secondResult.terminal.usage) }
      : {}),
  };
}

// Adapter
export function createKiroAdapter(provider: OcxProviderConfig): ProviderAdapter {
  // Per-request closure (resolveAdapter builds a fresh adapter per request — server.ts:440 — so this
  // is race-free) carrying the heuristic input-token estimate from buildRequest into the stream.
  let inputTokens = 0;
  let modelId: string | undefined;
  let contextWindow: number | undefined;
  let toolNameMap: Map<string, string> | undefined;
  let conversationId: string | undefined;
  let completionMode: KiroCompletionMode = "disabled";
  let requestSnapshot: OcxParsedRequest | undefined;
  let requestAbortSignal: AbortSignal | undefined;

  const build = async (
    parsed: OcxParsedRequest,
    forcedCompletionMode?: KiroCompletionMode,
  ): Promise<{
    request: AdapterRequest;
    nameMap: Map<string, string>;
    conversationId: string;
    completionMode: KiroCompletionMode;
    inputTokens: number;
  }> => {
    if (typeof provider.apiKey !== "string" || provider.apiKey.trim() === "") {
      throw new Error("kiro token missing — run ocx login kiro");
    }
    const region = resolveKiroApiRegion();
    const profileArn = resolveKiroProfileArn();
    const fp = fingerprint().slice(0, 64);
    const headers: Record<string, string> = {
      authorization: `Bearer ${provider.apiKey}`,
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
    const built = buildKiroPayload(parsed, profileArn, forcedCompletionMode);
    await normalizeKiroImages(built.payload);
    const body = JSON.stringify(built.payload);
    debugProviderDiagnostic("kiro", "request", {
      region,
      requestedModel: parsed.modelId,
      completionMode: built.completionMode,
      bodyBytes: new TextEncoder().encode(body).length,
      messageCount: kiroPayloadMessages(parsed).length,
      toolCount: parsed.context.tools?.length ?? 0,
      hasProfileArn: Boolean(profileArn),
      hasPreviousResponseId: Boolean(parsed.previousResponseId),
    });
    return {
      request: {
        url: kiroRuntimeEndpoint(provider, region),
        method: "POST",
        headers,
        body,
        usageLog: { inputTokens: estimateKiroLogInputTokens(parsed), estimated: true },
      },
      nameMap: built.nameMap,
      conversationId: built.conversationId,
      completionMode: built.completionMode,
      inputTokens: estimateKiroInputTokens(parsed),
    };
  };

  const fallbackFactory: KiroFallbackFactory = async (
    returnedConversationId,
    assistantText,
    sawReasoning,
  ) => {
    if (!requestSnapshot) throw new Error("Kiro completion retry lost its request state");
    if (requestAbortSignal?.aborted) {
      throw requestAbortSignal.reason instanceof Error
        ? requestAbortSignal.reason
        : new DOMException("Kiro request was cancelled", "AbortError");
    }
    const retryParsed = structuredClone(requestSnapshot);
    retryParsed._providerContinuation = {
      ...(retryParsed._providerContinuation ?? {}),
      ...(returnedConversationId ? { kiro: { conversationId: returnedConversationId } } : {}),
    };
    retryParsed.context.messages.push({
      role: "assistant",
      content: [
        ...(sawReasoning ? [{ type: "thinking" as const, thinking: "" }] : []),
        ...(assistantText ? [{ type: "text" as const, text: assistantText }] : []),
      ],
      phase: "commentary",
      model: retryParsed.modelId,
      timestamp: Date.now(),
    });
    const retry = await build(retryParsed, "text_fallback");
    const response = await fetchKiroWithRetry(retry.request, {
      abortSignal: requestAbortSignal,
      returnRawErrors: true,
      stream: true,
    });
    return {
      response,
      inputTokens: retry.inputTokens,
      nameMap: retry.nameMap,
      conversationId: retry.conversationId,
    };
  };

  return {
    name: "kiro",
    async buildRequest(parsed: OcxParsedRequest, incoming) {
      const built = await build(parsed);
      modelId = parsed.modelId;
      contextWindow = configuredKiroContextWindow(provider, parsed.modelId);
      inputTokens = built.inputTokens;
      toolNameMap = built.nameMap;
      conversationId = built.conversationId;
      completionMode = built.completionMode;
      requestSnapshot = structuredClone(parsed);
      requestAbortSignal = incoming?.abortSignal;
      return built.request;
    },

    parseStream(response: Response): AsyncGenerator<AdapterEvent> {
      return parseKiroStream(
        response,
        modelId,
        inputTokens,
        contextWindow,
        toolNameMap,
        conversationId,
        completionMode,
        completionMode === "required" ? fallbackFactory : undefined,
      );
    },

    fetchResponse(request: AdapterRequest, ctx?: AdapterFetchContext): Promise<Response> {
      // The normal Responses path supplies cancellation at fetch time rather than build time.
      // Keep it for the adapter-owned bounded continuation so cancelling the client turn aborts
      // both the first Kiro request and its one allowed completion retry.
      if (ctx?.abortSignal) requestAbortSignal = ctx.abortSignal;
      return fetchKiroWithRetry(request, ctx);
    },

    formatErrorBody(status: number, headers: Headers, payloadText: string): string {
      return safeKiroHttpErrorMessage(status, headers, payloadText);
    },

    // Non-streaming path used by the web-search sidecar loop (loop.ts runs each iteration
    // non-streamed so it can inspect tool calls). CW only ever event-streams, so we drain the
    // same decoder into an array. Without this, any Codex request that includes the web_search
    // tool failed with "web-search sidecar requires a non-streaming adapter" (kiro-only).
    async parseResponse(response: Response): Promise<AdapterEvent[]> {
      const events: AdapterEvent[] = [];
      for await (const e of parseKiroStream(
        response,
        modelId,
        inputTokens,
        contextWindow,
        toolNameMap,
        conversationId,
        completionMode,
        completionMode === "required" ? fallbackFactory : undefined,
      )) events.push(e);
      return events;
    },
  };
}
