import { decodeEventStream } from "../../lib/eventstream-decoder";
import { debugProviderDiagnostic } from "../../lib/debug";
import {
  isTranslatorBudgetExceededError,
  type TranslatorBudget,
} from "../../lib/translator-budget";
import type { AdapterEvent, OcxUsage } from "../../types";
import { recordKiroCalibration, rekeyKiroCalibration } from "../kiro-calibration";
import { KIRO_COMPLETION_TOOL_NAME, type KiroCompletionMode } from "../kiro-constants";
import {
  classifyKiroEventError,
  classifyKiroHttpError,
  classifyKiroStreamError,
  safeKiroErrorMessage,
  type KiroErrorClassification,
} from "../kiro-errors";
import { parseKiroEvent } from "../kiro-events";
import { noteKiroTransientThrottle } from "../kiro-retry";
import { KiroThinkingParser } from "../kiro-thinking";
import { isCompleteKiroToolInput, kiroTruncationErrorMessage } from "../kiro-truncation";
import { isValidKiroConversationId } from "../kiro-wire";
import { estimateKiroTokens, kiroUpstreamContextWindow } from "./usage";

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
export function jsonStringSerializedUtf8Bytes(value: string): number {
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

export type KiroFallbackFactory = (
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
  // Shared box: the inner parser stages its calibration observation here on the completion path,
  // and this wrapper decides whether the attempt was terminal enough to commit it. A box rather
  // than a return field because the completion path has a dozen terminal returns and threading a
  // field through every one of them is exactly the kind of edit that misses one.
  const attemptCalibration: { value?: { conversationId: string; estimated: number; charged: number } } = {};
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
    attemptCalibration,
    contextInputEstimate,
    priorEmittedOutput,
  );
  let handedOff = false;
  try {
    const result = yield* attempt;
    // A staged observation only counts when this attempt is the LAST one for the user turn. An
    // attempt that asks for the bounded fallback streams again against a rebuilt payload, so
    // committing here would move the factor twice for one turn and score the second observation
    // against a payload the first had already inflated.
    const staged = attemptCalibration.value;
    attemptCalibration.value = undefined;
    if (staged && !result.needsFallback) {
      recordKiroCalibration(staged.conversationId, staged.estimated, staged.charged);
    }
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
  attemptCalibration: { value?: { conversationId: string; estimated: number; charged: number } },
  contextInputEstimate?: number,
  priorEmittedOutput = false,
): AsyncGenerator<AdapterEvent, KiroAttemptParseResult> {
  const emptyResult = (): KiroAttemptParseResult => ({ assistantText: "", sawReasoning: false });
  // Every early return below is a failure path that stages nothing; only the completion path
  // writes `attemptCalibration`, and the wrapper decides whether to commit it.
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
          if (isValidKiroConversationId(ev.conversationId)) {
            // Kiro can answer under a different conversation id than the request was built with.
            // Carry the calibration entry across so the record below finds its own raw estimate
            // instead of silently falling back to the already-corrected value.
            rekeyKiroCalibration(returnedConversationId, ev.conversationId);
            returnedConversationId = ev.conversationId;
          }
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
    // Upstream just told us what this payload cost. The ratio between that and our pre-request
    // estimate is this conversation's own measured error, and it is the only feedback the
    // estimator ever receives.
    //
    // Staged, not recorded. An attempt that sets `needsFallback` is not over: the adapter rebuilds
    // the payload and streams a second time for the SAME user turn. Learning here would apply the
    // fresh factor to that rebuild and then learn again from it, so one turn would move the factor
    // twice and the second observation would score a payload the first had already inflated. Only
    // the outer parser knows whether an attempt is terminal, so it commits.
    //
    // Subtract the output first. `contextUsageTotalFloor` is the absolute context size AFTER the
    // response (`OcxUsage.contextTotalTokens`, types/request.ts), while `contextInputEstimate`
    // covers the request payload alone. Dividing one by the other would charge generated tokens to
    // prompt-tokenization error, so a short prompt answered at length would learn a large factor
    // and inflate every later request in that conversation — the premature compaction this work
    // exists to prevent.
    const chargedTotal = contextUsageTotalFloor();
    if (chargedTotal !== undefined && contextInputEstimate !== undefined) {
      const chargedInput = chargedTotal - finalUsage.outputTokens;
      if (chargedInput > 0 && returnedConversationId) {
        attemptCalibration.value = { conversationId: returnedConversationId, estimated: contextInputEstimate, charged: chargedInput };
      }
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
