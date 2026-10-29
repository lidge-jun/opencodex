import { assistantReplayContent } from "../../responses/assistant-replay";
/**
 * Core-owned registration slot for the optional advisor subsystem (src/advisor).
 *
 * This file is the ONLY thing the core Responses path knows about the advisor. It holds the
 * structural plan interface and the event-stream guard — pure protocol machinery over
 * src/types — and imports nothing from src/advisor at runtime. The optional subsystem registers
 * a factory through advisor-plan-slot at host activation; an advisor-disabled install therefore executes no advisor
 * code and imports no advisor module (same seam discipline as src/lab).
 *
 * Guard semantics (mirrors guardTerminalEventStream):
 * - synthetic `advisor` tool-call events are HELD — the Codex client never sees the tool, the
 *   call, or its arguments;
 * - on a clean `done`, each held call is consulted through the plan, the advice is appended as a
 *   paired assistant-toolCall + toolResult message pair, and the worker is re-dispatched via the
 *   SAME continuation machinery the terminal guard uses;
 * - real (non-advisor) tool calls end interception for the leg: the turn belongs to the client;
 * - usage from intercepted legs is merged into the final terminal event so worker accounting
 *   stays complete; the advisor's own usage is a separate loopback request and never merges here;
 * - consultations and worker continuations have separate hard per-request bounds. Exhaustion
 *   removes the tool; one final limit-result continuation is allowed, then a typed error ends it.
 */
import type {
  AdapterEvent,
  OcxAssistantContentPart,
  OcxAssistantMessage,
  OcxMessage,
  OcxParsedRequest,
  OcxToolResultMessage,
  OcxUsage,
} from "../../types";
import { jsonStringPartsUtf8Bytes, jsonUtf8Bytes } from "../../lib/json-byte-size";
import { isTranslatorBudgetExceededError, TRANSLATOR_MAX_CALL_ARGUMENT_BYTES, TranslatorBudgetExceededError, type TranslatorBudget } from "../../lib/translator-budget";
import { AdvisorRetention } from "./advisor-retention";

export const ADVISOR_TOOL_NAME = "advisor";

/** Hard bound on advisor consultations per worker request (recursion guard). */
export const MAX_ADVISOR_CONSULTATIONS_PER_REQUEST = 3;
/** At most one final worker continuation after consultation exhaustion. */
export const MAX_ADVISOR_CONTINUATIONS_PER_REQUEST = MAX_ADVISOR_CONSULTATIONS_PER_REQUEST + 1;

/** Per-leg retention caps for rebuilding the assistant message (see terminal-guard's bounded retention). */
const MAX_LEG_TEXT_CHARS = 16 * 1_024;
const MAX_LEG_THINKING_CHARS = 16 * 1_024;

/** Outcome of one consultation, as the plan reports it to the guard. */
export interface AdvisorConsultOutcome {
  ok: boolean;
  /** Formatted, wrapper-marked advice text ready to hand to the worker. */
  content: string;
  isError: boolean;
  /** The consultation was cancelled by the caller (client abort) — not a provider failure. */
  cancelled?: boolean;
  /**
   * Operator config blocked the consultation before any outbound call. Not a provider
   * failure: preflight must release a claim instead of recording a cooldown.
   */
  blocked?: "consent" | "settings" | "budget" | "limit";
}

/** The structural plan the optional advisor subsystem registers per request. */
export interface AdvisorPlan {
  /**
   * Run one consultation for the current conversation state. Implementations own dedup,
   * logging, and usage accounting; the guard only consumes the outcome.
   */
  consult(
    parsed: OcxParsedRequest,
    reason: "manual",
    question: string | undefined,
    abortSignal?: AbortSignal,
  ): Promise<AdvisorConsultOutcome>;
  /**
   * Runtime-owned text for a failed or limited consultation. The guard never composes failure
   * prose itself: the implementation neutralizes untrusted text so no guard path can emit
   * something the provenance detector would read as genuine advice.
   */
  formatUnavailable(kind: "manual" | "limit", error: string): string;
}

export interface AdvisorSidecarCall {
  id: string;
  name: string;
  question?: string;
  providerMetadata?: import("../../types").OcxProviderOpaqueToolCallMetadata;
}

/**
 * Shares continuation/consultation bounds between the normal guard and fetch sidecar loops.
 * Each leg is reserved before any expert await, while repeated calls receive one bounded limit
 * result instead of starting another consultation. The tool result preserves the worker call id.
 */
export function createAdvisorSidecarStep(plan: AdvisorPlan) {
  let consultations = 0;
  let continuations = 0;
  let finalContinuationUsed = false;
  return {
    beginLeg(): Extract<AdapterEvent, { type: "error" }> | undefined {
      const final = consultations >= MAX_ADVISOR_CONSULTATIONS_PER_REQUEST;
      if (continuations >= MAX_ADVISOR_CONTINUATIONS_PER_REQUEST || finalContinuationUsed) {
        return {
          type: "error",
          status: 502,
          errorType: "advisor_continuation_limit",
          message: "Advisor worker continuation limit reached; no further worker calls were sent.",
        };
      }
      continuations += 1;
      finalContinuationUsed ||= final;
      return undefined;
    },
    async consultCall(parsed: OcxParsedRequest, call: AdvisorSidecarCall, abortSignal?: AbortSignal) {
      let outcome: AdvisorConsultOutcome;
      if (consultations >= MAX_ADVISOR_CONSULTATIONS_PER_REQUEST) {
        outcome = {
          ok: false,
          isError: true,
          content: plan.formatUnavailable("limit", "consultation limit reached for this request"),
        };
      } else {
        consultations += 1;
        try {
          outcome = await plan.consult(parsed, "manual", call.question, abortSignal);
        } catch (error) {
          if (isTranslatorBudgetExceededError(error)) throw error;
          outcome = {
            ok: false,
            isError: true,
            content: plan.formatUnavailable("manual", error instanceof Error ? error.message : String(error)),
          };
        }
      }
      return { outcome, message: advisorToolResult(call, outcome, Date.now()) };
    },
    exhausted(): boolean {
      return consultations >= MAX_ADVISOR_CONSULTATIONS_PER_REQUEST;
    },
  };
}

export type AdvisorSidecarStep = ReturnType<typeof createAdvisorSidecarStep>;

interface HeldAdvisorCall {
  id: string;
  name: string;
  args: string[];
  argumentBytes: number;
  question?: string;
  closed: boolean;
  providerMetadata?: import("../../types").OcxProviderOpaqueToolCallMetadata;
}

function parseAdvisorArgs(call: HeldAdvisorCall, retention: AdvisorRetention): { question?: string } {
  // Reserve both the joined input and parsed JSON before either is materialized.
  return retention.copy(call.argumentBytes * 2 + 4, () => parseAdvisorQuestionArgs(call.args.join("")));
}

export function parseAdvisorQuestionArgs(argsBuf: string): { question?: string } {
  if (argsBuf.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(argsBuf);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const question = (parsed as { question?: unknown }).question;
      if (typeof question === "string" && question.trim() !== "") return { question: question.slice(0, 2_000) };
    }
  } catch { /* malformed args → no focus question */ }
  return {};
}

function assistantMessageFromLeg(
  events: readonly AdapterEvent[],
  held: readonly HeldAdvisorCall[],
  timestamp: number,
  retention: AdvisorRetention,
): OcxAssistantMessage | undefined {
  const content = assistantReplayContent(events);
  for (const call of held) {
    if (!call.closed) continue;
    const args = parseAdvisorArgs(call, retention);
    call.question = args.question;
    content.push({
      type: "toolCall",
      id: call.id,
      name: call.name,
      arguments: args,
      ...(call.providerMetadata ? { providerMetadata: call.providerMetadata } : {}),
    });
  }
  if (content.length === 0) return undefined;
  return { role: "assistant", content, timestamp };
}

function advisorToolResult(
  call: AdvisorSidecarCall,
  outcome: AdvisorConsultOutcome,
  timestamp: number,
): OcxToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: ADVISOR_TOOL_NAME,
    content: outcome.content,
    isError: outcome.isError,
    timestamp,
  };
}

export interface AdvisorGuardOptions {
  parsed: OcxParsedRequest;
  plan: AdvisorPlan;
  firstEvents: AsyncIterable<AdapterEvent>;
  /** Independent guard ownership within the optional shared request budget. */
  translatorBudget?: TranslatorBudget;
  /** One bounded worker continuation re-dispatch (same machinery as the terminal guard). */
  continuation: (parsed: OcxParsedRequest) => AsyncIterable<AdapterEvent> | Promise<AsyncIterable<AdapterEvent>>;
}

/**
 * Wrap a worker event stream with advisor interception. Registered on the parsed request as
 * `_advisorGuard` by the sidecar planner; adapter delivery applies it when present.
 */
export function createAdvisorStreamGuard(options: AdvisorGuardOptions): AsyncGenerator<AdapterEvent> {
  const guard = createAdvisorGuard(options.plan);
  return guard(options);
}
export function createAdvisorGuard(plan: AdvisorPlan): NonNullable<OcxParsedRequest["_advisorGuard"]> {
  // Shared across invocations of this request's guard, including an empty-completion retry.
  const sidecar = createAdvisorSidecarStep(plan);
  return async function* guardAdvisorStream(options: Omit<AdvisorGuardOptions, "plan">): AsyncGenerator<AdapterEvent> {
    let parsed = options.parsed;
    let accumulatedUsage: OcxUsage | undefined;
    let source: AsyncIterable<AdapterEvent> = options.firstEvents;
    const retention = new AdvisorRetention(options.translatorBudget);
    try {
    while (true) {
      const held: HeldAdvisorCall[] = [];
      const legEvents: AdapterEvent[] = [];
      let legTextChars = 0;
      let legThinkingChars = 0;
      let pending: HeldAdvisorCall | null = null;
      // While a tool call is open, its delta/end events belong to that call. Advisor calls are
      // held from the output; real calls pass through untouched.
      let holdingCurrent = false;
      let hasRealToolCall = false;
      let hasIncompleteToolCall = false;
      let terminalConsumed = false;
      let terminalEvent: Extract<AdapterEvent, { type: "done" }> | undefined;

      for await (const event of source) {
        if (event.type === "tool_call_start") {
          if (pending) { held.push(pending); pending = null; }
          holdingCurrent = event.name === ADVISOR_TOOL_NAME;
          if (!holdingCurrent) {
            hasRealToolCall = true;
            // No continuation can use this leg. Real-tool arguments are never copied.
            held.length = legEvents.length = 0;
            retention.releaseLeg();
          } else {
            if (!hasRealToolCall) {
              retention.retain(event, true);
              pending = { id: event.id, name: event.name, args: [], argumentBytes: 0, closed: false, ...(event.providerMetadata ? { providerMetadata: event.providerMetadata } : {}) };
            }
            continue;
          }
        } else if (event.type === "tool_call_delta") {
          if (pending) {
            const bytes = jsonStringPartsUtf8Bytes([event.arguments], TRANSLATOR_MAX_CALL_ARGUMENT_BYTES + 2) - 2;
            if (bytes > TRANSLATOR_MAX_CALL_ARGUMENT_BYTES - pending.argumentBytes) {
              throw new TranslatorBudgetExceededError("tool_args", TRANSLATOR_MAX_CALL_ARGUMENT_BYTES);
            }
            retention.retain(event);
            pending.argumentBytes += bytes;
            pending.args.push(event.arguments);
          }
          if (holdingCurrent) continue;
        } else if (event.type === "tool_call_end") {
          hasIncompleteToolCall ||= event.incomplete === true;
          if (pending) {
            retention.retain(event);
            pending.closed = !event.incomplete;
            if (pending.name === ADVISOR_TOOL_NAME) held.push(pending);
            pending = null;
          }
          if (holdingCurrent) {
            holdingCurrent = false;
            continue;
          }
        } else if (event.type === "done") {
          if (!hasRealToolCall) retention.retain(event);
          if (pending) { held.push(pending); pending = null; }
          terminalEvent = event;
          terminalConsumed = true;
          break;
        } else if (event.type === "incomplete" || event.type === "error") {
          // A broken leg cannot safely anchor a continuation: surface the terminal as-is.
          if (pending) { pending = null; }
          accumulatedUsage = retention.usage(accumulatedUsage, event.usage);
          yield accumulatedUsage ? { ...event, usage: accumulatedUsage } : event;
          return;
        } else {
          // Retain (bounded) the leg's visible content so the rebuilt assistant message is complete.
          if (event.type === "text_delta") {
            legTextChars += event.text.length;
            // Empty deltas add nothing to the rebuilt message; non-empty ones are bounded by the cap.
            if (!hasRealToolCall && event.text !== "" && legTextChars <= MAX_LEG_TEXT_CHARS) { retention.retain(event, false, false); legEvents.push(event); }
          } else if (event.type === "thinking_delta") {
            legThinkingChars += event.thinking.length;
            if (!hasRealToolCall && event.thinking !== "" && legThinkingChars <= MAX_LEG_THINKING_CHARS) { retention.retain(event, false, false); legEvents.push(event); }
          } else if (
            event.type === "thinking_signature"
            || event.type === "redacted_thinking"
          ) {
            if (!hasRealToolCall) { retention.retain(event); legEvents.push(event); }
          }
        }
        yield event;
      }

      const advisorCalls = held.filter(call => call.name === ADVISOR_TOOL_NAME && call.closed);
      const shouldIntercept = terminalConsumed
        && terminalEvent?.stopReason !== "max_tokens"
        && terminalEvent?.stopReason !== "content_filter"
        && advisorCalls.length > 0
        && !hasRealToolCall && !hasIncompleteToolCall;

      if (!shouldIntercept) {
        // Plain leg: surface the terminal with merged usage from any earlier intercepted legs.
        if (terminalEvent) {
          accumulatedUsage = retention.usage(accumulatedUsage, terminalEvent.usage);
          yield accumulatedUsage ? { ...terminalEvent, usage: accumulatedUsage } : terminalEvent;
        }
        return;
      }

      // Consume this leg's done — the continuation replaces it.
      accumulatedUsage = retention.usage(accumulatedUsage, terminalEvent?.usage);
      const continuationError = sidecar.beginLeg();
      if (continuationError) {
        yield accumulatedUsage ? { ...continuationError, usage: accumulatedUsage } : continuationError;
        return;
      }
      const timestamp = Date.now();
      const assistant = retention.history(retention.replayReservation(), () => assistantMessageFromLeg(legEvents, advisorCalls, timestamp, retention));
      const messages: OcxMessage[] = [...parsed.context.messages];
      if (assistant) messages.push(assistant);

      for (const call of advisorCalls) {
        // Later calls in the same leg must see what came before them: the rebuilt worker turn
        // and every earlier advisor result in this leg's accumulated messages.
        const consultParsed: OcxParsedRequest = {
          ...parsed,
          context: { ...parsed.context, messages },
        };
        const consulted = await sidecar.consultCall(consultParsed, call);
        messages.push(retention.history(jsonUtf8Bytes(consulted.outcome) + jsonUtf8Bytes(call.id) + 256, () => consulted.message)!);
      }

      const exhausted = sidecar.exhausted();
      const tools = exhausted
        ? parsed.context.tools?.filter(tool => !tool.advisor && tool.name !== ADVISOR_TOOL_NAME)
        : parsed.context.tools;
      const choice = parsed.options.toolChoice;
      const nextParsed: OcxParsedRequest = {
        ...parsed,
        context: { ...parsed.context, messages, tools },
        options: exhausted && ((typeof choice === "object" && choice !== null && "name" in choice && choice.name === ADVISOR_TOOL_NAME)
          || (choice === "required" && !tools?.length))
          ? { ...parsed.options, toolChoice: "auto" }
          : parsed.options,
      };
      parsed = nextParsed;
      // All replay owners were admitted while the raw leg was still live.
      held.length = legEvents.length = advisorCalls.length = 0;
      pending = null;
      terminalEvent = undefined;
      retention.releaseLeg();
      yield { type: "assistant_boundary" };
      try {
        source = await options.continuation(parsed);
      } catch (error) {
        if (isTranslatorBudgetExceededError(error)) throw error;
        yield {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
          ...(accumulatedUsage ? { usage: accumulatedUsage } : {}),
        };
        return;
      }
    }
    } catch (error) {
      if (!isTranslatorBudgetExceededError(error)) throw error;
      yield { type: "error", status: 502, errorType: "upstream_error", code: "translation_buffer_limit",
        message: "upstream translation buffer exceeded the safe limit", ...(accumulatedUsage ? { usage: accumulatedUsage } : {}) };
    } finally { retention.release(); }
  };
}
