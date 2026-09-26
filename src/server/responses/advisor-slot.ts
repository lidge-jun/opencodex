/**
 * Core-owned registration slot for the optional advisor subsystem (src/advisor).
 *
 * This file is the ONLY thing the core Responses path knows about the advisor. It holds the
 * structural plan interface and the event-stream guard — pure protocol machinery over
 * src/types — and imports nothing from src/advisor at runtime. The optional subsystem registers
 * a plan through the sidecar planner; an advisor-disabled install therefore executes no advisor
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
 * - consultations are bounded per request; past the bound the worker receives an explicit
 *   limit-reached tool result instead of a silent drop.
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
import { mergeUsage } from "./terminal-guard";

export const ADVISOR_TOOL_NAME = "advisor";

/** Hard bound on advisor consultations per worker request (recursion guard). */
export const MAX_ADVISOR_CONSULTATIONS_PER_REQUEST = 3;

/** Per-leg retention caps for rebuilding the assistant message (see terminal-guard's bounded retention). */
const MAX_LEG_TEXT_CHARS = 16 * 1_024;
const MAX_LEG_THINKING_CHARS = 16 * 1_024;

/** Outcome of one consultation, as the plan reports it to the guard. */
export interface AdvisorConsultOutcome {
  ok: boolean;
  /** Formatted, wrapper-marked advice text ready to hand to the worker. */
  content: string;
  isError: boolean;
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
  ): Promise<AdvisorConsultOutcome>;
}

interface HeldAdvisorCall {
  id: string;
  name: string;
  argsBuf: string;
  closed: boolean;
  providerMetadata?: import("../../types").OcxProviderOpaqueToolCallMetadata;
}

function parseAdvisorArgs(argsBuf: string): { question?: string } {
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
): OcxAssistantMessage | undefined {
  let text = "";
  let thinking = "";
  let signature: string | undefined;
  const redacted: string[] = [];
  for (const event of events) {
    if (event.type === "text_delta") text += event.text;
    else if (event.type === "thinking_delta") thinking += event.thinking;
    else if (event.type === "thinking_signature") signature = event.signature;
    else if (event.type === "redacted_thinking") redacted.push(event.data);
  }
  if (text.length > MAX_LEG_TEXT_CHARS) text = text.slice(0, MAX_LEG_TEXT_CHARS);
  if (thinking.length > MAX_LEG_THINKING_CHARS) thinking = thinking.slice(0, MAX_LEG_THINKING_CHARS);
  const content: OcxAssistantContentPart[] = [];
  if (thinking || signature || redacted.length > 0) {
    content.push({ type: "thinking", thinking, ...(signature ? { signature } : {}), ...(redacted.length > 0 ? { redacted } : {}) });
  }
  if (text) content.push({ type: "text", text });
  for (const call of held) {
    if (!call.closed) continue;
    content.push({
      type: "toolCall",
      id: call.id,
      name: call.name,
      arguments: parseAdvisorArgs(call.argsBuf),
      ...(call.providerMetadata ? { providerMetadata: call.providerMetadata } : {}),
    });
  }
  if (content.length === 0) return undefined;
  return { role: "assistant", content, timestamp };
}

function advisorToolResult(
  call: HeldAdvisorCall,
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
  return async function* guardAdvisorStream(options: Omit<AdvisorGuardOptions, "plan">): AsyncGenerator<AdapterEvent> {
    const maxConsultations = MAX_ADVISOR_CONSULTATIONS_PER_REQUEST;
    let parsed = options.parsed;
    let consultations = 0;
    let accumulatedUsage: OcxUsage | undefined;
    let source: AsyncIterable<AdapterEvent> = options.firstEvents;

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
      let terminalConsumed = false;
      let terminalEvent: Extract<AdapterEvent, { type: "done" }> | undefined;

      for await (const event of source) {
        if (event.type === "tool_call_start") {
          if (pending) { held.push(pending); pending = null; }
          pending = { id: event.id, name: event.name, argsBuf: "", closed: false, ...(event.providerMetadata ? { providerMetadata: event.providerMetadata } : {}) };
          holdingCurrent = event.name === ADVISOR_TOOL_NAME;
          if (!holdingCurrent) hasRealToolCall = true;
          else continue;
        } else if (event.type === "tool_call_delta") {
          if (pending) pending.argsBuf += event.arguments;
          if (holdingCurrent) continue;
        } else if (event.type === "tool_call_end") {
          if (pending) {
            pending.closed = true;
            if (pending.name === ADVISOR_TOOL_NAME) held.push(pending);
            pending = null;
          }
          if (holdingCurrent) {
            holdingCurrent = false;
            continue;
          }
        } else if (event.type === "done") {
          if (pending) { held.push(pending); pending = null; }
          terminalEvent = event;
          terminalConsumed = true;
          break;
        } else if (event.type === "incomplete" || event.type === "error") {
          // A broken leg cannot safely anchor a continuation: surface the terminal as-is.
          if (pending) { pending = null; }
          const usage = mergeUsage(accumulatedUsage, event.usage);
          yield usage ? { ...event, usage } : event;
          return;
        } else {
          // Retain (bounded) the leg's visible content so the rebuilt assistant message is complete.
          if (event.type === "text_delta") {
            legTextChars += event.text.length;
            if (legTextChars <= MAX_LEG_TEXT_CHARS) legEvents.push(event);
          } else if (event.type === "thinking_delta") {
            legThinkingChars += event.thinking.length;
            if (legThinkingChars <= MAX_LEG_THINKING_CHARS) legEvents.push(event);
          } else if (
            event.type === "thinking_signature"
            || event.type === "redacted_thinking"
          ) {
            legEvents.push(event);
          }
        }
        yield event;
      }

      const advisorCalls = held.filter(call => call.name === ADVISOR_TOOL_NAME && call.closed);
      const shouldIntercept = terminalConsumed
        && terminalEvent?.stopReason !== "max_tokens"
        && terminalEvent?.stopReason !== "content_filter"
        && advisorCalls.length > 0
        && !hasRealToolCall;

      if (!shouldIntercept) {
        // Plain leg: surface the terminal with merged usage from any earlier intercepted legs.
        if (terminalEvent) {
          const usage = mergeUsage(accumulatedUsage, terminalEvent.usage);
          yield usage ? { ...terminalEvent, usage } : terminalEvent;
        }
        return;
      }

      // Consume this leg's done — the continuation replaces it.
      accumulatedUsage = mergeUsage(accumulatedUsage, terminalEvent?.usage);
      const timestamp = Date.now();
      const assistant = assistantMessageFromLeg(legEvents, advisorCalls, timestamp);
      const messages: OcxMessage[] = [...parsed.context.messages];
      if (assistant) messages.push(assistant);

      for (const call of advisorCalls) {
        if (consultations >= maxConsultations) {
          messages.push(advisorToolResult(call, {
            ok: false,
            isError: true,
            content: [
              "<opencodex_advisor>",
              "Advisor consultation limit reached for this request; no further advice is available.",
              "Continue the task with your own judgment.",
              "</opencodex_advisor>",
            ].join("\n"),
          }, timestamp));
          continue;
        }
        consultations += 1;
        const args = parseAdvisorArgs(call.argsBuf);
        let outcome: AdvisorConsultOutcome;
        try {
          outcome = await plan.consult(parsed, "manual", args.question);
        } catch (error) {
          outcome = {
            ok: false,
            isError: true,
            content: [
              "<opencodex_advisor>",
              `The advisor consultation failed: ${error instanceof Error ? error.message : String(error)}`,
              "Continue the task with your own judgment. This is not advice.",
              "</opencodex_advisor>",
            ].join("\n"),
          };
        }
        messages.push(advisorToolResult(call, outcome, timestamp));
      }

      const nextParsed: OcxParsedRequest = { ...parsed, context: { ...parsed.context, messages } };
      parsed = nextParsed;
      yield { type: "assistant_boundary" };
      try {
        source = await options.continuation(parsed);
      } catch (error) {
        yield {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
          ...(accumulatedUsage ? { usage: accumulatedUsage } : {}),
        };
        return;
      }
    }
  };
}
