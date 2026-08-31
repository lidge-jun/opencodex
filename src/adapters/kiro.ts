import { decodeEventStream } from "../lib/eventstream-decoder";
import { estimateTokens } from "../lib/token-estimate";
import { debugProviderDiagnostic } from "../lib/debug";
import { resolveKiroApiRegion, resolveKiroRequestProfile } from "../oauth/kiro";
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
import {
  isTranslatorBudgetExceededError,
  releaseTranslatedEvent,
  retainTranslatedEvent,
  type TranslatorBudget,
} from "../lib/translator-budget";
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
  OcxTool,
  OcxUsage,
} from "../types";
import { hasRecordedTrailingDeliveredFinalAnswer } from "../responses/turn-termination";
import type { ProviderAdapter } from "./base";
import type { AdapterFetchContext, AdapterRequest } from "./base";
import { extractKiroImages, normalizeKiroImages, type KiroImage } from "./kiro-images";
import { sniffImageDimensions } from "./anthropic-image-guard";
import { fetchKiroWithRetry, noteKiroTransientThrottle } from "./kiro-retry";
import { convertKiroToolContext } from "./kiro-tools";
import { normalizeEmptyExecToolResultText } from "./exec-tool-result-normalize";
import { identifyRoutedModel } from "./identity";
import { buildNonOpenAIToolCatalogNudgeFromNames, isBareShellBridgeTool, isCodexCodeModeExecTool } from "./tool-catalog-nudge";
import {
  KIRO_ANSWER_DELIVERED_MESSAGE,
  KIRO_COMPLETION_INSTRUCTIONS,
  KIRO_COMPLETION_RETRY_MESSAGE,
  KIRO_COMPLETION_TOOL_NAME,
  KIRO_CONTINUATION_MESSAGE,
  KIRO_EMPTY_TOOL_RESULT_MESSAGE,
  KIRO_TOOL_RESULT_CARRIER_MESSAGE,
  MAX_KIRO_INJECTED_INSTRUCTION_CHARS,
  type KiroCompletionMode,
} from "./kiro-constants";

const AMZ_TARGET = "AmazonCodeWhispererStreamingService.GenerateAssistantResponse";
const SDK_VERSION = "1.0.27";
const NODE_VERSION = "22.21.1";
const KIRO_IDE_VERSION = "1.0.0";
const KIRO_FALLBACK_SERIALIZATION_ENVELOPE_BYTES = 64 * 1024;
type KiroWireClient = "ide" | "cli";

function kiroCliPlatform(): "linux" | "macos" | "windows" {
  return process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
}

function kiroCliUserAgent(includeAppVersion: boolean): string {
  return [
    "aws-sdk-rust/1.3.15",
    "ua/2.1",
    "api/codewhispererstreaming/0.1.17975",
    `os/${kiroCliPlatform()}`,
    "lang/rust/1.92.0",
    ...(includeAppVersion ? ["md/appVersion-2.14.2"] : []),
    "m/F",
    "app/AmazonQ-For-CLI",
  ].join(" ");
}

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
  userInputMessageContext?: {
    tools?: unknown[];
    toolResults?: KiroToolResult[];
  };
  images?: KiroImage[];
}
interface KiroHistoryEntry {
  userInputMessage?: KiroUserInputMessage;
  assistantResponseMessage?: {
    content: string;
    toolUses?: KiroToolUse[];
    reasoningContent?: { redactedContent: string };
  };
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

function estimateKiroImageTokens(image: KiroImage): number {
  const dimensions = sniffImageDimensions(image.source.bytes);
  if (dimensions) {
    return Math.max(256, Math.ceil(dimensions.width * dimensions.height / 750));
  }
  const decodedBytes = Math.floor(image.source.bytes.length * 3 / 4);
  return Math.max(256, Math.ceil(decodedBytes / 512));
}

function estimateKiroTokens(text: string, modelId?: string): number {
  return estimateTokens(text, modelId ? `kiro/${modelId}` : "kiro");
}

function estimateKiroPayloadInputTokens(payload: Record<string, unknown>, modelId: string): number {
  const conversationState = (payload as {
    conversationState?: {
      history?: KiroHistoryEntry[];
      currentMessage?: KiroHistoryEntry;
    };
  }).conversationState;
  if (!conversationState) return 0;

  const parts: string[] = [];
  let imageTokens = 0;
  const entries = [
    ...(conversationState.history ?? []),
    ...(conversationState.currentMessage ? [conversationState.currentMessage] : []),
  ];
  for (const entry of entries) {
    const user = entry.userInputMessage;
    if (user) {
      if (user.content) parts.push(user.content);
      for (const image of user.images ?? []) imageTokens += estimateKiroImageTokens(image);
      const context = user.userInputMessageContext;
      if (context?.tools?.length) parts.push(serializeForUsage(context.tools));
      if (context?.toolResults?.length) parts.push(serializeForUsage(context.toolResults));
    }
    const assistant = entry.assistantResponseMessage;
    if (assistant) {
      if (assistant.content) parts.push(assistant.content);
      if (assistant.toolUses?.length) parts.push(serializeForUsage(assistant.toolUses));
    }
  }
  return estimateKiroTokens(parts.join("\n"), modelId) + imageTokens;
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

  return estimateKiroTokens(parts.join("\n"), parsed.modelId);
}

function estimateKiroLogInputTokens(parsed: OcxParsedRequest): number {
  const parts = parsed.context.messages.map(messageLogText).filter(Boolean);
  if (parsed.context.systemPrompt?.length) parts.push(...parsed.context.systemPrompt);
  if (parsed.context.tools?.length) parts.push(serializeForUsage(parsed.context.tools));
  return Math.max(estimateKiroInputTokens(parsed), estimateKiroTokens(parts.join("\n"), parsed.modelId));
}

function kiroUpstreamContextWindow(modelId: string | undefined): number | undefined {
  if (!modelId) return undefined;
  const normalizedModelId = normalizeKiroModelId(modelId);
  if (normalizedModelId === "auto") return undefined;
  const window = modelRecordValue(KIRO_MODEL_CONTEXT_WINDOWS, modelId)
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

// Kiro takes a verified native effort field for these models, and each model family names it
// differently: the Sol-only `reasoning.effort` versus the Claude-specific `output_config.effort`.
// Models absent from this table fall back to emulated thinking instructions.
const KIRO_NATIVE_EFFORT_FIELDS: Record<string, "reasoning" | "output_config"> = {
  "gpt-5.6-sol": "reasoning",
  "claude-opus-5": "output_config",
};

const KIRO_NATIVE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

function kiroNativeEffortField(modelId: string): "reasoning" | "output_config" | undefined {
  return KIRO_NATIVE_EFFORT_FIELDS[normalizeKiroModelId(modelId)];
}

export function kiroReasoningMode(modelId: string): KiroReasoningMode {
  return kiroNativeEffortField(modelId) ? "native" : "emulated";
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
  if (parsed.options.serviceTier !== undefined) {
    throw new Error("Kiro does not support service tiers");
  }
  // Structured output is a real contract Kiro cannot honour: the wire has no
  // schema-constrained response mode, so a caller expecting parseable JSON would receive
  // prose and fail downstream. Refuse it.
  //
  // The rest of the Responses `text` object is not that. `text.verbosity` is a length
  // preference and `text.format: {type:"text"}` is ordinary prose — the default output
  // mode, which no capability flag governs and every correct client may send. Testing
  // `_rawBody.text !== undefined` refused those turns for the mere PRESENCE of the key,
  // the same mistake db040e70f removed one condition earlier where a permissive
  // `parallel_tool_calls` hint was read as a requirement.
  //
  // Nothing needs stripping the way openai-responses strips a no-op verbosity:
  // buildKiroPayload composes conversationState field by field from `parsed` and never
  // spreads `_rawBody`, so a tolerated control is dropped by construction. The test
  // asserts that absence so it stays true.
  if (parsed._structuredOutput) {
    throw new Error("Kiro does not support Responses structured output");
  }
}

type KiroTurn =
  | {
      kind: "user";
      content: string;
      images: KiroImage[];
      toolResults: KiroToolResult[];
      /**
       * True only for the proxy-generated acknowledgement that follows a delivered final answer.
       * A flag rather than a content comparison: a real user message may legitimately quote the
       * same sentence, and treating that as internal state would strip its thinking tags and
       * completion retry.
       */
       answerDeliveredAck?: boolean;
    }
  | {
      kind: "assistant";
      content: string;
      toolUses: KiroToolUse[];
      redactedReasoning?: string;
      /**
       * True when this assistant turn was the DELIVERED final answer (Responses
       * `phase: "final_answer"`). A trailing assistant turn normally means the model stopped
       * mid-task and needs a continuation prompt, but a delivered final answer already ended its
       * turn — prompting it again restarts finished work as if a goal were still open.
       */
      finalAnswer?: boolean;
    };

/**
 * True when the LAST content-bearing message is an assistant final answer that closed its turn.
 *
 * Mirrors the turn-merge rule: a tool call in that message, or any later user/tool-result message,
 * means work continued, so the turn is no longer terminal. Empty assistant messages are skipped
 * rather than treated as continuation, since they carry no visible turn.
 */
function hasTrailingDeliveredFinalAnswer(messages: readonly OcxMessage[], parsed?: OcxParsedRequest): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") return false;
    const aMsg = msg as OcxAssistantMessage;
    const hasToolCall = (aMsg.content ?? []).some(part => part.type === "toolCall");
    if (hasToolCall) return false;
    const hasText = (aMsg.content ?? []).some(part => part.type === "text" && part.text.trim());
    if (!hasText) continue;
    return aMsg.phase === "final_answer"
      || (parsed !== undefined && hasRecordedTrailingDeliveredFinalAnswer(parsed, messages));
  }
  return false;
}

function appendTurnText(target: string, next: string): string {
  if (!next) return target;
  return target ? `${target}\n\n${next}` : next;
}

function validateKiroConversationState(history: KiroHistoryEntry[], currentMessage: KiroHistoryEntry): void {
  const entries = [...history, currentMessage];
  const pendingToolUses = new Set<string>();
  let previousRole: "user" | "assistant" | undefined;

  for (const entry of entries) {
    const user = entry.userInputMessage;
    const assistant = entry.assistantResponseMessage;
    if (Boolean(user) === Boolean(assistant)) {
      throw new Error("Kiro conversation entries must contain exactly one message role");
    }
    const role = user ? "user" : "assistant";
    if (role === previousRole) throw new Error("Kiro conversation roles must alternate");
    previousRole = role;

    if (user) {
      const hasPayload = Boolean(user.content.trim())
        || Boolean(user.images?.length)
        || Boolean(user.userInputMessageContext?.toolResults?.length);
      if (!hasPayload) throw new Error("Kiro user messages must not be empty");
      for (const result of user.userInputMessageContext?.toolResults ?? []) {
        if (!pendingToolUses.delete(result.toolUseId)) {
          throw new Error(`Kiro tool result has no matching tool use ${JSON.stringify(result.toolUseId)}`);
        }
        if (!result.content.some(part => part.text.trim())) {
          throw new Error(`Kiro tool result must not be empty ${JSON.stringify(result.toolUseId)}`);
        }
      }
      continue;
    }

    const toolUses = assistant?.toolUses ?? [];
    if (!assistant?.content.trim() && toolUses.length === 0) {
      throw new Error("Kiro assistant messages must not be empty");
    }
    for (const toolUse of toolUses) {
      if (pendingToolUses.has(toolUse.toolUseId)) {
        throw new Error(`Kiro conversation contains duplicate tool use ${JSON.stringify(toolUse.toolUseId)}`);
      }
      pendingToolUses.add(toolUse.toolUseId);
    }
  }
  if (pendingToolUses.size > 0) throw new Error("Kiro conversation contains an unanswered tool use");
}

function boundedInjectedInstruction(text: string, used: { value: number }): string | undefined {
  const remaining = MAX_KIRO_INJECTED_INSTRUCTION_CHARS - used.value;
  if (remaining <= 0 || !text) return undefined;
  let result = text.length <= remaining ? text : text.slice(0, remaining);
  // Never end the slice on a lone high surrogate: encoding it substitutes
  // U+FFFD into the injected instruction. One step back keeps a valid pair
  // out instead of a broken half.
  if (result.length > 0) {
    const last = result.charCodeAt(result.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) result = result.slice(0, -1);
  }
  used.value += result.length;
  return result.length > 0 ? result : undefined;
}

/** Test-only: exercise the surrogate-safe instruction bound directly. */
export function boundedInjectedInstructionForTests(text: string, used: { value: number }): string | undefined {
  return boundedInjectedInstruction(text, used);
}

function kiroCompletionTool(): Record<string, unknown> {
  return {
    toolSpecification: {
      name: KIRO_COMPLETION_TOOL_NAME,
      // The shared tool-catalog nudge enumerates this name next to ordinary tools and tells every
      // listed name to count a call only after its tool result returns. Nothing returns a result
      // here: a valid call becomes the turn's terminal. Left undescribed, the model reads one more
      // deferrable work tool and keeps calling tools with a finished answer already written as
      // commentary. So the description states the distinction, the obligation, and the terminality
      // where the model is actually choosing between tools.
      //
      // It also has to name the blocked-on-user state, for the same reason the prose contract does.
      // This is the surface the model reads while CHOOSING; if it admits only "fully complete", a
      // model holding a question that blocks progress reads this tool as unavailable and keeps
      // working instead, which is the measured defect. The two surfaces must not disagree.
      description: "Terminal completion channel, not an ordinary work tool. When the task is fully complete and no more work or tool calls are needed, you must call this tool exactly once instead of providing the final answer as ordinary assistant text. Call it the same way when you cannot continue until the user supplies a decision, information, or a clarification that only they can give: the question itself is the answer. Put the complete user-facing final answer in `answer`. The call is complete when issued: it ends the turn, returns no tool result, and no text or tool call may follow it.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            answer: {
              type: "string",
              description: "The complete final answer to show the user, or the blocking question you need the user to answer before you can continue.",
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
  wireClient: KiroWireClient = "ide",
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
  // A turn whose history already ENDS with a delivered final answer has nothing to complete.
  // Leaving completion "required" here would keep advertising codex_kiro_final_answer with its
  // instructions, so the model answers again, or replies with ordinary text and trips the
  // `needsFallback` retry, which ends its payload with KIRO_COMPLETION_RETRY_MESSAGE and reopens
  // the finished task. Suppressing the mode is what actually closes that loop; the neutral
  // acknowledgement below only stops the resume wording.
  //
  // Read from parsed messages because `completionMode` is needed to build the tool catalog, which
  // happens before the turn list exists. `forcedCompletionMode` still wins: the fallback retry
  // passes "text_fallback" explicitly and must not be silently downgraded.
  const trailingDeliveredAnswer = hasTrailingDeliveredFinalAnswer(kiroPayloadMessages(parsed), parsed);
  const completionMode: KiroCompletionMode = forcedCompletionMode
    ?? (ordinaryTools.length > 0 && !trailingDeliveredAnswer ? "required" : "disabled");
  const kiroTools = completionMode === "disabled"
    ? ordinaryTools
    : [...ordinaryTools, kiroCompletionTool()];
  const nameMap = toolContext.nameMap;
  const systemParts: string[] = [];
  const injectedChars = { value: 0 };
  // Name the Kiro model id actually sent on the wire without leaking the proxy identity upstream.
  if (parsed.context.systemPrompt?.length) {
    systemParts.push(identifyRoutedModel(parsed.context.systemPrompt.join("\n\n"), modelId));
  }
  for (const addition of toolContext.systemAdditions) {
    const boundedAddition = boundedInjectedInstruction(addition, injectedChars);
    if (boundedAddition) systemParts.push(boundedAddition);
  }
  // Kiro renames tools to satisfy its wire constraints, so resolve neighbor names through the
  // registry's existing aliases; a bare-name comparison would forbid tools this turn actually
  // advertises. Read the recorded mapping instead of calling `alias()`, which would REGISTER a
  // name for a tool that was never advertised and pollute the collision domain.
  const advertisedAlias = new Map<string, string>();
  for (const [alias, wireName] of registry.nameMap) advertisedAlias.set(wireName, alias);
  // Code mode is decided on the EMITTED catalog, not the requested list.
  //
  // `freeform` only exists on the requested tool objects -- `kiroToolWireNames` has already
  // reduced the emitted catalog to strings -- so the predicates must read the objects. But the
  // SHAPE that matters is the one the model receives: the count/byte budget can drop a requested
  // `exec_command` while `exec` survives, and scanning the requested list would then find a shell
  // bridge the model cannot call and suppress code mode for a catalog that is code-mode-shaped.
  // Intersecting the two keeps `tool_choice: "none"` and budget omission correct for free: both
  // empty the emitted set, so nothing can be named.
  const emittedToolNames = new Set(kiroToolWireNames(kiroTools));
  const emittedAlias = (tool: OcxTool): string | undefined => {
    const wireName = namespacedToolName(tool.namespace, tool.name);
    // Read the recorded mapping; `registry.alias()` would REGISTER a name here.
    const alias = advertisedAlias.get(wireName) ?? wireName;
    return emittedToolNames.has(alias) ? alias : undefined;
  };
  const requestedTools = parsed.context.tools ?? [];
  const emittedCodeModeExec = requestedTools.find(tool => isCodexCodeModeExecTool(tool) && emittedAlias(tool));
  const emittedShellBridge = requestedTools.some(tool => isBareShellBridgeTool(tool) && emittedAlias(tool));
  const codeModeExecName = emittedCodeModeExec && !emittedShellBridge
    ? emittedAlias(emittedCodeModeExec)
    : undefined;
  const toolCatalogNudge = buildNonOpenAIToolCatalogNudgeFromNames(
    kiroToolWireNames(kiroTools),
    name => advertisedAlias.get(name) ?? name,
    codeModeExecName,
  );
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
  const pushAssistant = (content: string, toolUses: KiroToolUse[], redactedReasoning?: string, finalAnswer?: boolean): void => {
    const last = turns.at(-1);
    if (last?.kind === "assistant") {
      last.content = appendTurnText(last.content, content);
      last.toolUses.push(...toolUses);
      // Merged turns keep the newest blob: it covers the reasoning up to the merged turn's end.
      if (redactedReasoning) last.redactedReasoning = redactedReasoning;
      // A merged turn is final only if its LAST component was: commentary appended after a final
      // answer means the model kept working, so the turn is no longer terminal.
      last.finalAnswer = finalAnswer === true;
    } else {
      turns.push({
        kind: "assistant",
        content,
        toolUses: [...toolUses],
        ...(redactedReasoning ? { redactedReasoning } : {}),
        ...(finalAnswer ? { finalAnswer: true } : {}),
      });
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
      // `phase` survives the Responses round trip (parser.ts assistant branch), so a replayed
      // final answer is identifiable here rather than guessed from turn position.
      pushAssistant(text, toolUses, aMsg.kiroRedactedReasoning, aMsg.phase === "final_answer" && toolUses.length === 0);
    } else if (msg.role === "toolResult") {
      const tr = msg as OcxToolResultMessage;
      if (tr.containsEncryptedContent) {
        throw new Error(`Kiro cannot translate encrypted output for tool call ${JSON.stringify(tr.toolCallId)}`);
      }
      const text = userContentText(tr.content);
      // An empty code-mode exec result needs the SPECIFIC reason, not the generic fallback: the
      // model otherwise reads a blank result, concludes its earlier context was lost, and restarts
      // the task instead of calling text()/notify(). Checked before `text.trim()` because the
      // wrapper form ("Script completed\nWall time ...\nOutput:\n") is non-blank and would
      // otherwise pass through as if it were real output.
      const resultText = normalizeEmptyExecToolResultText(text, {
        toolName: tr.toolName,
        toolNamespace: tr.toolNamespace,
      }) ?? (text.trim() ? text : KIRO_EMPTY_TOOL_RESULT_MESSAGE);
      const images = extractKiroImages(tr.content);
      const toolUseId = normalizeToolId(tr.toolCallId);
      if (!priorCalls.has(toolUseId)) {
        throw new Error(`Kiro history contains an orphaned tool result for call ${JSON.stringify(tr.toolCallId)}`);
      }
      // Carrier text is a placeholder for an OTHERWISE EMPTY tool-result turn, not a prefix.
      // Passing it here would push proxy filler AHEAD of a human instruction that Claude Code
      // sends in the same turn (mid-turn steering / queued_command, issue #543), burying the
      // newest user intent behind boilerplate. Backfill below only when nothing else speaks.
      pushUser("", images, [{
        content: [{ text: resultText }],
        status: tr.isError ? "error" : "success",
        toolUseId,
      }]);
    }
  }

  if (turns.length === 0 || turns[0].kind === "assistant") {
    turns.unshift({ kind: "user", content: KIRO_CONTINUATION_MESSAGE, images: [], toolResults: [] });
  }
  // Kiro requires the request to end with a user turn, so a trailing assistant turn always gets
  // one appended (the pop below throws otherwise). What that turn SAYS is the load-bearing part.
  //
  // Normally a trailing assistant turn means the model stopped mid-task, and a continuation/retry
  // prompt is correct. A DELIVERED final answer is the exception: the turn already ended, and
  // telling that model to "continue" or to call the completion tool again reopens finished work —
  // the completed-task-behaves-like-an-open-goal loop. It gets a neutral acknowledgement instead:
  // structurally valid, but carrying no instruction to resume.
  const trailing = turns.at(-1);
  if (trailing?.kind === "assistant") {
    const resumeText = completionMode === "text_fallback" ? KIRO_COMPLETION_RETRY_MESSAGE : KIRO_CONTINUATION_MESSAGE;
    turns.push({
      kind: "user",
      content: trailing.finalAnswer ? KIRO_ANSWER_DELIVERED_MESSAGE : resumeText,
      images: [],
      toolResults: [],
      ...(trailing.finalAnswer ? { answerDeliveredAck: true } : {}),
    });
  }

  // Give tool-result turns a carrier sentence ONLY when they carry no other text. This runs
  // before the pop below so the current turn is covered too: skipping it there would ship an
  // empty current content, which validateKiroConversationState accepts (tool results count as
  // payload) and would therefore fail silently.
  for (const turn of turns) {
    if (turn.kind === "user" && !turn.content.trim() && turn.toolResults.length > 0) {
      turn.content = KIRO_TOOL_RESULT_CARRIER_MESSAGE;
    }
  }

  const currentTurn = turns.pop();
  if (!currentTurn || currentTurn.kind !== "user") throw new Error("Kiro request must end with a user turn");
  // Survives the pop as state, so the checks below never infer intent from user-supplied text.
  const answerDeliveredAck = currentTurn.answerDeliveredAck === true;
  const toEntry = (turn: KiroTurn): KiroHistoryEntry => turn.kind === "assistant"
    ? {
        assistantResponseMessage: {
          content: turn.content,
          ...(turn.toolUses.length > 0 ? { toolUses: turn.toolUses } : {}),
          ...(turn.redactedReasoning ? { reasoningContent: { redactedContent: turn.redactedReasoning } } : {}),
        },
      }
    : {
        userInputMessage: {
          content: turn.content,
          modelId,
          origin: wireClient === "cli" ? "KIRO_CLI" : "AI_EDITOR",
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
    // Never append the retry instruction onto the answer-delivered acknowledgement: it exists
    // precisely to avoid asking a finished turn for another completion call, and appending here
    // would reinstate the loop it prevents.
    if (currentUim.content !== KIRO_COMPLETION_RETRY_MESSAGE && !answerDeliveredAck) {
      currentUim.content = appendTurnText(currentUim.content, KIRO_COMPLETION_RETRY_MESSAGE);
    }
  } else if (
    !currentUim.userInputMessageContext?.toolResults
    && currentUim.content !== KIRO_CONTINUATION_MESSAGE
    && !answerDeliveredAck
  ) {
    currentUim.content = injectKiroThinkingTags(currentUim.content, parsed);
  }

  validateKiroConversationState(history, currentEntry);
  const conversationId = stableConversationId(parsed);
  const payload: Record<string, unknown> = {
    conversationState: {
      chatTriggerType: "MANUAL",
      ...(wireClient === "cli" ? {
        agentContinuationId: crypto.randomUUID(),
        agentTaskType: "vibe",
      } : {}),
      conversationId,
      currentMessage: { userInputMessage: currentUim },
      ...(history.length > 0 ? { history } : {}),
    },
  };
  const effort = parsed.options.reasoning;
  const effortField = kiroNativeEffortField(parsed.modelId);
  if (effortField && effort && effort !== "none") {
    if (!KIRO_NATIVE_EFFORTS.includes(effort)) {
      throw new Error(`Kiro ${normalizeKiroModelId(parsed.modelId)} does not support reasoning effort ${JSON.stringify(effort)}`);
    }
    payload.additionalModelRequestFields = { [effortField]: { effort } };
  }
  if (profileArn) payload.profileArn = profileArn;
  return { payload, nameMap, conversationId, completionMode };
}

// Stream parsing (shared by parseStream + parseResponse)
// CodeWhisperer GenerateAssistantResponse ALWAYS returns an AWS eventstream body (there is no
// non-streaming wire mode), so the streaming bridge and non-streaming Responses path decode the
// same way — parseResponse just collects what parseStream yields.
interface KiroAttemptParseResult {
  terminal?: AdapterEvent;
  needsFallback?: boolean;
  usage?: OcxUsage;
  providerState?: { kiro: { conversationId: string } };
  assistantText: string;
  sawReasoning: boolean;
}

interface KiroAttemptResult extends KiroAttemptParseResult {
  releaseRetained(): void;
}

interface KiroAttemptRetention {
  trackReplacement(previousBytes: number, nextBytes: number): void;
  retainEvent(event: AdapterEvent, bytes: number): void;
  releaseEvent(event: AdapterEvent): void;
  releaseAll(): void;
}

function createKiroAttemptRetention(budget: TranslatorBudget): KiroAttemptRetention {
  let retainedBytes = 0;
  const eventBytes = new Map<AdapterEvent, number>();
  return {
    trackReplacement(previousBytes, nextBytes) {
      retainedBytes = Math.max(0, retainedBytes - previousBytes) + nextBytes;
    },
    retainEvent(event, bytes) {
      retainedBytes += bytes;
      eventBytes.set(event, bytes);
    },
    releaseEvent(event) {
      const bytes = eventBytes.get(event);
      if (bytes === undefined) return;
      eventBytes.delete(event);
      retainedBytes = Math.max(0, retainedBytes - bytes);
      budget.releaseRetained(bytes, { kind: "retained_collectors" });
    },
    releaseAll() {
      if (retainedBytes > 0) budget.releaseRetained(retainedBytes, { kind: "retained_collectors" });
      retainedBytes = 0;
      eventBytes.clear();
    },
  };
}

interface KiroFallbackAttempt {
  response: Response;
  inputTokens: number;
  contextInputEstimate: number;
  nameMap: Map<string, string>;
  conversationId: string;
  releaseRequestBody?: () => void;
}

function appendedUtf8Bytes(previous: string, previousBytes: number, fragment: string): number {
  let nextBytes = previousBytes + Buffer.byteLength(fragment);
  const previousLast = previous.charCodeAt(previous.length - 1);
  const fragmentFirst = fragment.charCodeAt(0);
  if (previousLast >= 0xd800 && previousLast <= 0xdbff
    && fragmentFirst >= 0xdc00 && fragmentFirst <= 0xdfff) {
    nextBytes -= 2;
  }
  return nextBytes;
}

/** Exact UTF-8 size JSON.stringify() will use for a string, without materializing that copy. */
function jsonStringSerializedUtf8Bytes(value: string): number {
  let bytes = 2; // Opening and closing quotes.
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      bytes += 2;
    } else if (code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
      bytes += 2;
    } else if (code < 0x20) {
      bytes += 6;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index++;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

interface KiroContextWindowState {
  value?: number;
}

type KiroFallbackFactory = (
  conversationId: string | undefined,
  assistantText: string,
  sawReasoning: boolean,
  budget: TranslatorBudget,
) => Promise<KiroFallbackAttempt>;

function mergeKiroUsage(
  first: OcxUsage | undefined,
  second: OcxUsage | undefined,
  preserveFirstContextGrowth = false,
): OcxUsage | undefined {
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
  const carriedContextTotal = preserveFirstContextGrowth && typeof first.contextTotalTokens === "number"
    ? first.contextTotalTokens + second.outputTokens
    : undefined;
  const combinedOutputTokens = first.outputTokens + second.outputTokens;
  return {
    inputTokens: first.inputTokens + second.inputTokens,
    outputTokens: combinedOutputTokens,
    ...(typeof first.contextTotalTokens === "number" || typeof second.contextTotalTokens === "number"
      ? {
          contextTotalTokens: Math.max(
            first.contextTotalTokens ?? 0,
            second.contextTotalTokens ?? 0,
            carriedContextTotal ?? 0,
            combinedOutputTokens,
          ),
        }
      : {}),
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
  retryable = true,
): AdapterEvent {
  return {
    type: "incomplete",
    reason,
    message,
    usage,
    retryable,
    endTurn: false,
    ...(providerState ? { providerState } : {}),
  };
}

/**
 * Catch-path retryability for #519: only transport/socket failures with no emitted output
 * are replay-safe. Malformed event payloads (`invalid Kiro …`) and any post-output failure
 * stay terminal — same spirit as cursor's emittedOutput gate.
 */
export function isRetryableKiroStreamCatchError(err: unknown, emittedOutput: boolean): boolean {
  if (emittedOutput) return false;
  const message = err instanceof Error ? err.message : String(err);
  if (/^invalid Kiro\b/i.test(message)) return false;
  // Include Smithy/eventstream truncation (`eventstream: truncated message at end of stream`):
  // partial frame + clean EOF with zero output is the same replay-safe class as a socket close.
  return /socket connection was closed|connection(?: was)? closed unexpectedly|ECONNRESET|EPIPE|UND_ERR_|fetch failed|decoder failed|premature close|other side closed|unexpected EOF|network connection lost|terminated|truncated message at end of stream|eventstream:\s*truncated/i
    .test(message);
}

/** Native clean-stop reason eligible for bounded private-completion validation. */
const KIRO_END_TURN_STOP_REASON = "END_TURN";

async function* parseKiroAttempt(
  response: Response,
  budget: TranslatorBudget,
  mode: KiroCompletionMode,
  modelId: string | undefined,
  inputTokens: number,
  contextWindowState: KiroContextWindowState,
  nameMap: Map<string, string> | undefined,
  conversationId: string | undefined,
  contextInputEstimate?: number,
  /** True when an earlier attempt already flushed visible content to the client (#520). */
  priorEmittedOutput = false,
): AsyncGenerator<AdapterEvent, KiroAttemptResult> {
  // `required` mode holds staged commentary until a real tool call or terminal metadata identifies
  // the attempt boundary. Anything the inner parser leaves behind is flushed before the terminal.
  const deferred: AdapterEvent[] = [];
  const retention = createKiroAttemptRetention(budget);
  const attempt = parseKiroAttemptEvents(
    response,
    budget,
    mode,
    modelId,
    inputTokens,
    contextWindowState,
    nameMap,
    conversationId,
    deferred,
    retention,
    contextInputEstimate,
    priorEmittedOutput,
  );
  let handedOff = false;
  try {
    const result = yield* attempt;
    for (const event of deferred.splice(0)) {
      try { yield event; } finally { retention.releaseEvent(event); }
    }
    handedOff = true;
    return { ...result, releaseRetained: () => retention.releaseAll() };
  } finally {
    if (!handedOff) retention.releaseAll();
  }
}

async function* parseKiroAttemptEvents(
  response: Response,
  budget: TranslatorBudget,
  mode: KiroCompletionMode,
  modelId: string | undefined,
  inputTokens: number,
  contextWindowState: KiroContextWindowState,
  nameMap: Map<string, string> | undefined,
  conversationId: string | undefined,
  deferred: AdapterEvent[],
  retention: KiroAttemptRetention,
  contextInputEstimate?: number,
  priorEmittedOutput = false,
): AsyncGenerator<AdapterEvent, KiroAttemptParseResult> {
  const emptyResult = (): KiroAttemptParseResult => ({ assistantText: "", sawReasoning: false });
  if (!response.body) {
    return {
      ...emptyResult(),
      terminal: { type: "error", message: "Kiro response has no body", status: 502, errorType: "upstream_error" },
    };
  }

  let open: { id: string; name: string; chunks: string[]; completion: boolean } | null = null;
  let openCallId: string | undefined;
  const closeOpenCall = () => {
    if (!openCallId) return;
    budget.closeCall(openCallId);
    openCallId = undefined;
  };
  let outputChars = "";
  let outputCharsBytes = 0;
  let contextUsagePercentage: number | undefined;
  let returnedConversationId = conversationId;
  let assistantText = "";
  let assistantTextBytes = 0;
  let sawText = false;
  let sawReasoning = false;
  let sawRealTool = false;
  let completionAnswer: string | undefined;
  let completionCalls = 0;
  let authoritativeUsage: OcxUsage | undefined;
  let stopReason: string | undefined;
  const fallbackEvents: AdapterEvent[] = [];
  const thinking = new KiroThinkingParser(budget);

  const retainedEventBytes = (event: AdapterEvent): number => Buffer.byteLength(JSON.stringify(event));
  const retainEvent = (event: AdapterEvent): void => {
    const bytes = retainedEventBytes(event);
    budget.chargeRetained(bytes, { kind: "retained_collectors" });
    retention.retainEvent(event, bytes);
  };
  const emitRetained = async function* (events: Iterable<AdapterEvent>): AsyncGenerator<AdapterEvent> {
    for (const event of events) {
      try { yield event; } finally { retention.releaseEvent(event); }
    }
  };
  // A valid private completion answer supersedes the progress prose staged during the SAME
  // inference: Kiro emits answer-like text and then calls the completion tool, so releasing both
  // makes the bridge close the commentary message and open a second one with near-identical text
  // (#2819 follow-up). Consume the collection instead — drop the redundant text, keep every
  // non-text event, and release retention either way.
  //
  // This is deliberately the ONLY suppression site. The outer drain in `parseKiroAttempt` is also
  // the leftover flush for early terminal returns (stream, protocol, and provider failures), so
  // teaching it to discard text would hide the only commentary a failed turn ever produced.
  // Splicing here leaves that drain empty on the completion path and untouched everywhere else.
  const consumeSupersededByCompletion = async function* (
    events: AdapterEvent[],
  ): AsyncGenerator<AdapterEvent> {
    for (const event of events.splice(0)) {
      try {
        if (event.type !== "text_delta") yield event;
      } finally {
        retention.releaseEvent(event);
      }
    }
  };

  const providerState = (): { kiro: { conversationId: string } } | undefined =>
    returnedConversationId ? { kiro: { conversationId: returnedConversationId } } : undefined;

  const contextUsageTotalFloor = (): number | undefined => {
    if (contextUsagePercentage === undefined || !contextWindowState.value) return undefined;
    const floor = Math.ceil(contextWindowState.value * Math.min(contextUsagePercentage, 100) / 100);
    return Number.isFinite(floor) && floor > 0 ? floor : undefined;
  };
  const usage = (): OcxUsage => {
    const base = authoritativeUsage ?? {
      inputTokens,
      outputTokens: estimateKiroTokens(outputChars, modelId),
      estimated: true,
    };
    const estimatedContextTotal = contextInputEstimate !== undefined
      ? contextInputEstimate + base.outputTokens
      : undefined;
    const authoritativeTurnTotal = base.inputTokens + base.outputTokens;
    const contextTotal = Math.max(
      estimatedContextTotal ?? 0,
      contextUsageTotalFloor() ?? 0,
      authoritativeTurnTotal,
    );
    return contextTotal > 0 ? { ...base, contextTotalTokens: contextTotal } : base;
  };

  const classifiedTerminal = (failure: KiroErrorClassification): AdapterEvent => {
    // Upstream exception/error frames can arrive after commentary was already staged (and will be
    // flushed before this terminal is yielded). Replaying after that content would duplicate it.
    const emittedOutput = priorEmittedOutput
      || sawText
      || sawReasoning
      || sawRealTool
      || assistantText.length > 0
      || deferred.length > 0
      || completionAnswer !== undefined
      || completionCalls > 0
      || open !== null
      || fallbackEvents.length > 0;
    if (failure.status === 429 && failure.retryable) noteKiroTransientThrottle();
    return {
      type: "error",
      message: failure.message,
      status: failure.status,
      errorType: failure.errorType,
      code: failure.code,
      retryable: emittedOutput ? false : failure.retryable,
      usage: usage(),
    };
  };

  const protocolTerminal = (message: string, malformedCompletion = false): AdapterEvent => {
    if (mode === "text_fallback" && malformedCompletion) {
      return retryableKiroIncomplete(
        "malformed_kiro_completion",
        message,
        usage(),
        providerState(),
        // First-attempt progress was already flushed before this bounded fallback (#520).
        !priorEmittedOutput,
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

  // In `required` mode Kiro's stop reason only arrives on the terminal metadata event, so staged
  // commentary is held until either a real tool call proves the turn continues (flush as
  // commentary) or the stream ends (relabel as the final answer when END_TURN says so). A heartbeat
  // stands in for each held event so the bridge's stall watchdog stays armed.
  const defer = (event: AdapterEvent): AdapterEvent[] => {
    if (sawRealTool) return [...deferred.splice(0), event];
    if (event.type !== "text_delta" && deferred.length === 0) return [event];
    deferred.push(event);
    retainEvent(event);
    return [{ type: "heartbeat" }];
  };

  const stage = (event: AdapterEvent): AdapterEvent[] => {
    if (event.type === "text_delta") {
      const nextAssistantTextBytes = appendedUtf8Bytes(assistantText, assistantTextBytes, event.text);
      const assistantReservation = budget.reserveTransient(nextAssistantTextBytes, { kind: "retained_collectors" });
      assistantText += event.text;
      assistantReservation.commitRetained();
      budget.releaseRetained(assistantTextBytes, { kind: "retained_collectors" });
      retention.trackReplacement(assistantTextBytes, nextAssistantTextBytes);
      assistantTextBytes = nextAssistantTextBytes;
      if (event.text.trim()) sawText = true;
      const nextOutputCharsBytes = appendedUtf8Bytes(outputChars, outputCharsBytes, event.text);
      const outputReservation = budget.reserveTransient(nextOutputCharsBytes, { kind: "retained_collectors" });
      outputChars += event.text;
      outputReservation.commitRetained();
      budget.releaseRetained(outputCharsBytes, { kind: "retained_collectors" });
      retention.trackReplacement(outputCharsBytes, nextOutputCharsBytes);
      outputCharsBytes = nextOutputCharsBytes;
      const phased = mode === "disabled"
        ? event
        : { ...event, phase: "commentary" as const };
      if (mode === "text_fallback") {
        fallbackEvents.push(phased);
        retainEvent(phased);
        return [];
      }
      return mode === "required" ? defer(phased) : [phased];
    }
    if (event.type === "reasoning_raw_delta" || event.type === "thinking_delta") {
      const text = event.type === "reasoning_raw_delta" ? event.text : event.thinking;
      if (text.trim()) sawReasoning = true;
      const nextOutputCharsBytes = appendedUtf8Bytes(outputChars, outputCharsBytes, text);
      const reasoningReservation = budget.reserveTransient(nextOutputCharsBytes, { kind: "retained_collectors" });
      outputChars += text;
      reasoningReservation.commitRetained();
      budget.releaseRetained(outputCharsBytes, { kind: "retained_collectors" });
      retention.trackReplacement(outputCharsBytes, nextOutputCharsBytes);
      outputCharsBytes = nextOutputCharsBytes;
    }
    if (mode === "text_fallback" && event.type !== "heartbeat") {
      fallbackEvents.push(event);
      retainEvent(event);
      return [];
    }
    return mode === "required" ? defer(event) : [event];
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
    closeOpenCall();
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
          if (ev.stopReason !== undefined) stopReason = ev.stopReason;
          break;
        case "message_metadata":
          if (isValidKiroConversationId(ev.conversationId)) returnedConversationId = ev.conversationId;
          break;
        case "content":
          if (ev.modelId) {
            contextWindowState.value = kiroUpstreamContextWindow(ev.modelId) ?? contextWindowState.value;
          }
          if (open) {
            open = null;
            return { assistantText, sawReasoning, terminal: protocolTerminal(kiroTruncationErrorMessage("content arrived before tool stop")) };
          }
          if (ev.data) {
            for (const contentEvent of thinking.feed(ev.data)) {
              yield* emitRetained(stage(contentEvent));
            }
          }
          break;
        case "reasoning":
          for (const contentEvent of thinking.flush()) {
            yield* emitRetained(stage(contentEvent));
          }
          if (ev.data) {
            yield* emitRetained(stage({ type: "reasoning_raw_delta", text: ev.data }));
          }
          if (ev.redactedContent) {
            yield* emitRetained(stage({ type: "kiro_redacted_reasoning", data: ev.redactedContent }));
          }
          break;
        case "context_usage":
          if (ev.contextUsagePercentage > 0) contextUsagePercentage = ev.contextUsagePercentage;
          break;
        case "tool": {
          for (const contentEvent of thinking.flush()) {
            yield* emitRetained(stage(contentEvent));
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
            budget.openCall(open.id);
            openCallId = open.id;
          } else if (
            (ev.toolUseId && ev.toolUseId !== open.id)
            || (ev.name && open.name !== "unknown" && ev.name !== open.name)
          ) {
            closeOpenCall();
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
            const previousCallBytes = open.chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk), 0);
            const nextCallBytes = previousCallBytes + Buffer.byteLength(ev.input);
            const callReservation = budget.reserveTransient(nextCallBytes, { kind: "tool_args", callId: open.id });
            open.chunks.push(ev.input);
            callReservation.commitRetained();
            budget.releaseRetained(previousCallBytes, { kind: "tool_args", callId: open.id });
            const nextOutputCharsBytes = appendedUtf8Bytes(outputChars, outputCharsBytes, ev.input);
            const toolOutputReservation = budget.reserveTransient(nextOutputCharsBytes, { kind: "retained_collectors" });
            outputChars += ev.input;
            toolOutputReservation.commitRetained();
            budget.releaseRetained(outputCharsBytes, { kind: "retained_collectors" });
            retention.trackReplacement(outputCharsBytes, nextOutputCharsBytes);
            outputCharsBytes = nextOutputCharsBytes;
          }
          if (ev.stop === true) {
            const flushed = flushOpen();
            if (flushed.terminal) return { assistantText, sawReasoning, terminal: flushed.terminal };
            for (const event of flushed.events) {
              yield* emitRetained(stage(event));
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
      yield* emitRetained(stage(contentEvent));
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
        yield* emitRetained(stage(event));
      }
    }

    const finalUsage = usage();
    const finalProviderState = providerState();
    if (contextUsagePercentage !== undefined) {
      debugProviderDiagnostic("kiro", "context_usage", {
        contextUsagePercentage,
        ...(contextWindowState.value ? { upstreamContextWindow: contextWindowState.value } : {}),
      });
    }
    // Native stop metadata proves that this inference ended, but it does not prove that ordinary
    // text is a final answer. Kiro has emitted END_TURN for progress prose, so tool-enabled turns
    // still require the private completion call to distinguish commentary from completion (#531).
    const normalizedStopReason = stopReason?.trim().toUpperCase();
    const nativeCompletionStop = (normalizedStopReason === KIRO_END_TURN_STOP_REASON
      || normalizedStopReason === "STOP_SEQUENCE")
      && sawText
      && !sawRealTool
      && completionAnswer === undefined
      && completionCalls === 0;

    debugProviderDiagnostic("kiro", "attempt_complete", {
      mode,
      sawText,
      sawReasoning,
      sawRealTool,
      completionCalls,
      nativeCompletionStop,
      ...(stopReason !== undefined ? { stopReason } : {}),
      assistantChars: assistantText.length,
    });

    if (mode === "required") {
      // A valid completion answer makes this inference's staged prose redundant; anything else
      // still flushes exactly as before (bounded fallback, explicit stops, real tool calls).
      if (completionAnswer !== undefined) yield* consumeSupersededByCompletion(deferred);
      else yield* emitRetained(deferred.splice(0));
    }

    if (mode === "text_fallback") {
      if (completionAnswer !== undefined) {
        yield* consumeSupersededByCompletion(fallbackEvents);
        yield { type: "text_delta", text: completionAnswer, phase: "final_answer" };
        return {
          assistantText,
          sawReasoning,
          terminal: { type: "done", usage: finalUsage, endTurn: true, ...(finalProviderState ? { providerState: finalProviderState } : {}) },
        };
      }
      if (sawRealTool) {
        yield* emitRetained(fallbackEvents);
        return {
          assistantText,
          sawReasoning,
          terminal: { type: "done", usage: finalUsage, endTurn: false, ...(finalProviderState ? { providerState: finalProviderState } : {}) },
        };
      }
      if (sawText) {
        for (const event of fallbackEvents) {
          try {
            if (event.type !== "text_delta") yield event;
            else yield { ...event, phase: "final_answer" };
          } finally {
            retention.releaseEvent(event);
          }
        }
        return {
          assistantText,
          sawReasoning,
          terminal: { type: "done", usage: finalUsage, endTurn: true, ...(finalProviderState ? { providerState: finalProviderState } : {}) },
        };
      }
      yield* emitRetained(fallbackEvents);
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
          // First-attempt progress was already flushed before this bounded fallback (#520).
          !priorEmittedOutput,
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
    if (mode === "required" && nativeCompletionStop) {
      return {
        assistantText,
        sawReasoning,
        needsFallback: true,
        usage: finalUsage,
        providerState: finalProviderState,
      };
    }

    // An explicit non-completion stop reason has already terminated this inference. Converting it into
    // another model request would hide truncation behind a second paid call, and for context
    // exhaustion it would resubmit a request that cannot fit. Only a MISSING stop reason falls
    // through to the bounded compatibility fallback below.
    //
    // END_TURN and STOP_SEQUENCE with text take the bounded validation path above; reaching here
    // with either means the turn produced no replayable text.
    if (mode === "required" && normalizedStopReason !== undefined) {
      const providerStateField = finalProviderState ? { providerState: finalProviderState } : {};
      const incomplete = (reason: string, retryable: boolean) => ({
        assistantText,
        sawReasoning,
        terminal: {
          type: "incomplete" as const,
          reason,
          message: `Kiro stopped with ${normalizedStopReason} before an explicit final answer`,
          usage: finalUsage,
          retryable,
          endTurn: false,
          ...providerStateField,
        },
      });

      if (normalizedStopReason === "MODEL_CONTEXT_WINDOW_EXCEEDED") {
        // Reuse the existing context-length contract (kiro-errors.ts) instead of inventing an
        // incomplete reason: an unrecognized incomplete becomes a retryable 529 in Claude
        // outbound, and `max_output_tokens` would make responses/state.ts cache this partial
        // for continuation replay. Both invite a retry that cannot succeed.
        return {
          assistantText,
          sawReasoning,
          terminal: {
            type: "error" as const,
            message: "Kiro stopped because the model context window was exhausted",
            status: 400,
            errorType: "invalid_request_error",
            code: "context_length_exceeded",
            retryable: false,
            usage: finalUsage,
          },
        };
      }
      if (normalizedStopReason === "MAX_TOKENS") return incomplete("max_output_tokens", true);
      if (normalizedStopReason === "CONTENT_FILTERED" || normalizedStopReason === "GUARDRAIL_INTERVENED") {
        return incomplete("content_filter", false);
      }
      if (normalizedStopReason === "MALFORMED_TOOL_USE") return incomplete("kiro_malformed_tool_use", false);
      if (normalizedStopReason === "MALFORMED_MODEL_OUTPUT") return incomplete("kiro_malformed_model_output", false);
      // TOOL_USE here means Kiro claimed a tool call it never emitted.
      if (normalizedStopReason === "TOOL_USE") return incomplete("kiro_tool_use_without_call", false);
      if (normalizedStopReason === KIRO_END_TURN_STOP_REASON || normalizedStopReason === "STOP_SEQUENCE") {
        return incomplete(`kiro_${normalizedStopReason.toLowerCase()}_without_text`, false);
      }
      return incomplete(`kiro_${normalizedStopReason.toLowerCase() || "unknown_stop"}`, false);
    }
    // Kiro text has no trustworthy final/progress marker. When completion is required, ordinary
    // text and reasoning remain unfinished until the one bounded fallback validates the turn.
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
    if (isTranslatorBudgetExceededError(err)) {
      closeOpenCall();
      return {
        assistantText,
        sawReasoning,
        terminal: {
          type: "error",
          status: 502,
          errorType: "upstream_error",
          code: "translation_buffer_limit",
          message: "upstream translation buffer exceeded the safe limit",
        },
      };
    }
    // Mid-stream socket closes after response.created / heartbeats only must stay retryable:
    // nothing was relayed to the client, so a string-body replay is safe (see #519 / cursor's
    // emittedOutput gate). Once any assistant text, reasoning, tool, or deferred content exists
    // — including content flushed by a prior attempt before a bounded fallback — fail closed;
    // the client may already have partial output. Protocol parse throws stay non-retryable even
    // with zero output.
    const emittedOutput = priorEmittedOutput
      || sawText
      || sawReasoning
      || sawRealTool
      || assistantText.length > 0
      || deferred.length > 0
      || completionAnswer !== undefined
      || completionCalls > 0
      || open !== null
      || fallbackEvents.length > 0;
    return {
      assistantText,
      sawReasoning,
      terminal: {
        type: "error",
        message: safeKiroErrorMessage({}, err instanceof Error ? err.message : String(err)),
        status: 502,
        errorType: "server_error",
        code: "kiro_stream_protocol_error",
        retryable: isRetryableKiroStreamCatchError(err, emittedOutput),
        usage: usage(),
      },
    };
  } finally {
    thinking.dispose();
    closeOpenCall();
  }
}

export async function* parseKiroStream(
  response: Response,
  budget: TranslatorBudget,
  modelId?: string,
  inputTokens = 0,
  contextWindow?: number,
  nameMap?: Map<string, string>,
  conversationId?: string,
  completionMode: KiroCompletionMode = "disabled",
  fallbackFactory?: KiroFallbackFactory,
  contextInputEstimate?: number,
): AsyncGenerator<AdapterEvent> {
  const contextWindowState: KiroContextWindowState = { value: contextWindow };
  const firstResult = yield* parseKiroAttempt(
    response,
    budget,
    completionMode,
    modelId,
    inputTokens,
    contextWindowState,
    nameMap,
    conversationId,
    contextInputEstimate,
    false,
  );
  try {
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
    // First attempt already flushed deferred progress before this point. Gate fallback
    // setup/HTTP failures the same way as the second-stream catch so a replay cannot
    // duplicate visible commentary (#520).
    const priorEmittedOutput = Boolean(firstResult.assistantText.trim()) || firstResult.sawReasoning;
    let firstAssistantText = firstResult.assistantText;
    const firstHadAssistantText = firstAssistantText.length > 0;
    let fallback: KiroFallbackAttempt;
    try {
      fallback = await fallbackFactory(
        firstResult.providerState?.kiro.conversationId ?? conversationId,
        firstAssistantText,
        firstResult.sawReasoning,
        budget,
      );
    } catch (err) {
      firstAssistantText = "";
      firstResult.assistantText = "";
      firstResult.releaseRetained();
      if (isTranslatorBudgetExceededError(err)) {
        yield {
          type: "error",
          message: "upstream translation buffer exceeded the safe limit",
          status: 502,
          errorType: "upstream_error",
          code: "translation_buffer_limit",
          usage: firstResult.usage,
        };
        return;
      }
      yield {
        type: "error",
        message: safeKiroErrorMessage({}, err instanceof Error ? err.message : String(err)),
        status: err instanceof Error && err.name === "TimeoutError" ? 504 : 502,
        errorType: "upstream_error",
        retryable: !priorEmittedOutput,
        usage: firstResult.usage,
      };
      return;
    }
    // The factory has finished using the live first-attempt alias and has retained its own retry
    // serialization through the fetch boundary. The discarded parser collectors can now release
    // before the second attempt begins on the same turn budget.
    firstAssistantText = "";
    firstResult.assistantText = "";
    firstResult.releaseRetained();
    fallback.releaseRequestBody?.();
    if (!fallback.response.ok) {
      const payload = await fallback.response.text().catch(() => "");
      const failure = classifyKiroHttpError(fallback.response.status, fallback.response.headers, payload);
      yield {
        type: "error",
        message: failure.message,
        status: failure.status,
        errorType: failure.errorType,
        code: failure.code,
        retryable: priorEmittedOutput ? false : failure.retryable,
        usage: firstResult.usage,
      };
      return;
    }

    const secondResult = yield* parseKiroAttempt(
      fallback.response,
      budget,
      "text_fallback",
      modelId,
      fallback.inputTokens,
      contextWindowState,
      fallback.nameMap,
      fallback.conversationId,
      fallback.contextInputEstimate,
      // First attempt already flushed deferred progress to the client before this fallback.
      // A zero-output transport failure here must stay non-retryable to avoid duplicating that text.
      priorEmittedOutput,
    );
    try {
      if (!secondResult.terminal) {
        yield retryableKiroIncomplete(
          "empty_kiro_fallback",
          "Kiro's bounded completion retry ended without a terminal result",
          mergeKiroUsage(firstResult.usage, secondResult.usage, firstHadAssistantText)
            ?? { inputTokens, outputTokens: 0, estimated: true },
          secondResult.providerState ?? firstResult.providerState,
          !priorEmittedOutput,
        );
        return;
      }
      if (secondResult.terminal.type === "done" || secondResult.terminal.type === "incomplete") {
        yield {
          ...secondResult.terminal,
          // Belt-and-suspenders: never advertise a replay-safe incomplete after flushed progress.
          ...(secondResult.terminal.type === "incomplete" && priorEmittedOutput
            ? { retryable: false as const }
            : {}),
          usage: mergeKiroUsage(firstResult.usage, secondResult.terminal.usage, firstHadAssistantText),
          providerState: secondResult.terminal.providerState ?? firstResult.providerState,
        };
        return;
      }
      yield {
        ...secondResult.terminal,
        ...(secondResult.terminal.type === "error"
          ? { usage: mergeKiroUsage(firstResult.usage, secondResult.terminal.usage, firstHadAssistantText) }
          : {}),
      };
    } finally {
      secondResult.releaseRetained();
    }
  } finally {
    firstResult.releaseRetained();
  }
}

// Adapter
export function createKiroAdapter(provider: OcxProviderConfig): ProviderAdapter {
  // Per-request closure (resolveAdapter builds a fresh adapter per request — server.ts:440 — so this
  // is race-free) carrying the heuristic input-token estimate from buildRequest into the stream.
  let inputTokens = 0;
  let contextInputEstimate = 0;
  let modelId: string | undefined;
  let contextWindow: number | undefined;
  let toolNameMap: Map<string, string> | undefined;
  let conversationId: string | undefined;
  let completionMode: KiroCompletionMode = "disabled";
  let requestSnapshot: OcxParsedRequest | undefined;
  let firstRequestBodyBytes = 0;
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
    contextInputEstimate: number;
  }> => {
    if (typeof provider.apiKey !== "string" || provider.apiKey.trim() === "") {
      throw new Error("kiro token missing — run ocx login kiro");
    }
    const region = resolveKiroApiRegion(parsed._kiroAuthContext);
    // Request-scoped: an AWS Builder ID account has no profile of its own and resolves to Kiro's
    // fixed service profile here, without that value ever becoming the account's stored identity.
    const requestProfile = resolveKiroRequestProfile(parsed._kiroAuthContext);
    const resolvedProfileArn = requestProfile.profileArn;
    const isApiKey = provider.apiKey.trim().startsWith("ksk_");
    const profileArn = isApiKey ? undefined : resolvedProfileArn;
    // Builder ID and Kiro API keys are accepted only on Kiro's CLI request path; enterprise
    // profiles retain the IDE-shaped request. Builder ID now carries a profile ARN, so a truthy
    // `profileArn` no longer implies "enterprise". The wire path reads the resolver's own verdict
    // rather than re-deriving it, so the accountless path — where the auth type comes from the
    // local import, not the request context — cannot send the fallback inside an IDE-shaped call.
    const isBuilderId = requestProfile.builderIdFallback;
    const wireClient: KiroWireClient = isApiKey || isBuilderId || !profileArn ? "cli" : "ide";
    const fp = fingerprint().slice(0, 64);
    const headers: Record<string, string> = wireClient === "cli" ? {
      authorization: `Bearer ${provider.apiKey}`,
      "content-type": "application/x-amz-json-1.0",
      accept: "*/*",
      "x-amz-target": AMZ_TARGET,
      "user-agent": kiroCliUserAgent(true),
      "x-amz-user-agent": kiroCliUserAgent(false),
      "x-amzn-codewhisperer-optout": "true",
      "amz-sdk-request": "attempt=1; max=3",
      "amz-sdk-invocation-id": invocationId(),
      ...(isApiKey ? { tokentype: "API_KEY" } : {}),
    } : {
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
    const built = buildKiroPayload(parsed, profileArn, forcedCompletionMode, wireClient);
    await normalizeKiroImages(built.payload);
    const contextInputEstimate = estimateKiroPayloadInputTokens(built.payload, parsed.modelId);
    const body = JSON.stringify(built.payload);
    debugProviderDiagnostic("kiro", "request", {
      region,
      requestedModel: parsed.modelId,
      completionMode: built.completionMode,
      bodyBytes: new TextEncoder().encode(body).length,
      messageCount: kiroPayloadMessages(parsed).length,
      toolCount: parsed.context.tools?.length ?? 0,
      hasProfileArn: Boolean(profileArn),
      wireClient,
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
      contextInputEstimate,
    };
  };

  const fallbackFactory: KiroFallbackFactory = async (
    returnedConversationId,
    assistantText,
    _sawReasoning,
    budget,
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
    // Reasoning is not replayable on the Kiro wire. Adding an empty assistant turn merely to mark
    // that reasoning existed creates REQUEST_BODY_INVALID; only visible text earns a replay turn.
    if (assistantText.trim()) {
      retryParsed.context.messages.push({
        role: "assistant",
        content: [{ type: "text" as const, text: assistantText }],
        phase: "commentary",
        model: retryParsed.modelId,
        timestamp: Date.now(),
      });
    }
    // The retry starts from the already measured first wire body, adds one JSON-escaped replay
    // string, and only changes bounded Kiro-owned fields (completion prompt/tool, history wrapper,
    // and <=256-byte conversation id). 64 KiB is a conservative envelope for those fixed fields.
    // Reserve that complete upper bound while the first-attempt collectors are still charged so a
    // near-cap turn fails before build() can materialize the retry payload or serialized body.
    const retryBodyUpperBound = firstRequestBodyBytes
      + jsonStringSerializedUtf8Bytes(assistantText)
      + KIRO_FALLBACK_SERIALIZATION_ENVELOPE_BYTES;
    const retryBodyReservation = budget.reserveTransient(retryBodyUpperBound, { kind: "request_copies" });
    let retryBodyBytes = 0;
    let retryBodyRetained = false;
    let requestBodyReleased = false;
    const releaseRequestBody = () => {
      if (requestBodyReleased) return;
      requestBodyReleased = true;
      if (retryBodyRetained) budget.releaseRetained(retryBodyBytes, { kind: "request_copies" });
      else retryBodyReservation.release();
    };
    try {
      const retry = await build(retryParsed, "text_fallback");
      retryBodyBytes = Buffer.byteLength(retry.request.body);
      if (retryBodyBytes > retryBodyUpperBound) {
        throw new Error("Kiro retry serialization exceeded its pre-admitted upper bound");
      }
      retryBodyReservation.commitRetained();
      retryBodyRetained = true;
      budget.releaseRetained(retryBodyUpperBound - retryBodyBytes, { kind: "request_copies" });
      const response = await fetchKiroWithRetry(retry.request, {
        abortSignal: requestAbortSignal,
        returnRawErrors: true,
        stream: true,
      });
      return {
        response,
        inputTokens: retry.inputTokens,
        contextInputEstimate: retry.contextInputEstimate,
        nameMap: retry.nameMap,
        conversationId: retry.conversationId,
        releaseRequestBody,
      };
    } catch (error) {
      releaseRequestBody();
      throw error;
    }
  };

  return {
    name: "kiro",
    // A replayed history that already ENDS with a delivered final answer has nothing to ask Kiro.
    // Before this hook the adapter still appended a trailing user turn — a neutral acknowledgement,
    // but structurally still a prompt — and performed a real inference, so the model answered the
    // closed task again and the finished turn behaved like a still-open goal.
    //
    // Suppressing the completion contract (above) removed the instruction to complete; it could not
    // remove the inference. This is the boundary: no request is built, nothing is sent, and no token
    // estimate is recorded.
    //
    // The forced-fallback build is deliberately NOT consulted here: this hook runs on the inbound
    // turn only, and the adapter-owned bounded retry passes "text_fallback" through `build`
    // directly, never through this path.
    localTerminal(parsed: OcxParsedRequest) {
      return hasTrailingDeliveredFinalAnswer(kiroPayloadMessages(parsed), parsed)
        ? { reason: "kiro_final_answer_already_delivered" }
        : undefined;
    },

    async buildRequest(parsed: OcxParsedRequest, incoming) {
      const built = await build(parsed);
      modelId = parsed.modelId;
      contextWindow = kiroUpstreamContextWindow(parsed.modelId);
      inputTokens = built.inputTokens;
      contextInputEstimate = built.contextInputEstimate;
      toolNameMap = built.nameMap;
      conversationId = built.conversationId;
      completionMode = built.completionMode;
      requestSnapshot = structuredClone(parsed);
      firstRequestBodyBytes = Buffer.byteLength(built.request.body);
      requestAbortSignal = incoming?.abortSignal;
      return built.request;
    },

    parseStream(response: Response, budget: TranslatorBudget): AsyncGenerator<AdapterEvent> {
      return parseKiroStream(
        response,
        budget,
        modelId,
        inputTokens,
        contextWindow,
        toolNameMap,
        conversationId,
        completionMode,
        completionMode === "required" ? fallbackFactory : undefined,
        contextInputEstimate,
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

    // Kiro always returns an event stream, including for non-streaming Responses requests. Drain
    // the decoder into a budget-owned batch so an upstream stream cannot grow this array without
    // bound while the caller waits for the complete JSON response.
    async parseResponse(response: Response, budget: TranslatorBudget): Promise<AdapterEvent[]> {
      const events: AdapterEvent[] = [];
      try {
        for await (const e of parseKiroStream(
          response,
          budget,
          modelId,
          inputTokens,
          contextWindow,
          toolNameMap,
          conversationId,
          completionMode,
          completionMode === "required" ? fallbackFactory : undefined,
          contextInputEstimate,
        )) {
          retainTranslatedEvent(e, budget, events.at(-1));
          events.push(e);
        }
        return events;
      } catch (error) {
        for (const event of events) releaseTranslatedEvent(event, budget);
        throw error;
      }
    },
  };
}
