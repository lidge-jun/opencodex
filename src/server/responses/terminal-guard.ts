import type {
  AdapterEvent,
  OcxAssistantContentPart,
  OcxAssistantMessage,
  OcxParsedRequest,
  OcxToolChoice,
  OcxUsage,
} from "../../types";
import { isAllowedToolChoice } from "../../types";

// User-intent gates. These classify what the USER asked for, not whether the model executed —
// keep them. `ACTIONABLE_REQUEST_RE` decides whether the turn is an execution request at all;
// `PLAN_ONLY_REQUEST_RE` honors an explicit "just give me a plan / don't call tools" request.
const ACTIONABLE_REQUEST_RE = /(?:\b(?:add|change|check|continue|create|debug|delete|deploy|edit|execute|fix|implement|inspect|keep going|modify|patch|proceed|refactor|remove|review|run|test|update|write)\b|继续|接着|往下|升级|修改|改(?:一下|下)?|修复|实现|添加|新增|删除|重构|更新|运行|执行|检查|查看|排查|调试|创建|写入|提交|推送|部署|看下|改成|修一下)/iu;
const PLAN_ONLY_REQUEST_RE = /(?:只(?:给|要|需)(?:我)?(?:一个|个|一下)?(?:计划|方案)|先(?:给|说)(?:我)?(?:一个|个|一下)?(?:计划|方案)|暂时不要(?:调用|使用)工具|不要调用工具|不用执行|只回复(?:计划|方案)|\b(?:just give|provide)\s+(?:me\s+)?(?:a\s+)?plan\b|\b(?:do not|don't)\s+(?:use|call)\s+tools?\b)/iu;
// Waiting-for-user is a SAFE PASS heuristic (not a reliable classifier): if the model appears to
// be asking the user something, never auto-continue.
const WAITING_FOR_USER_RE = /(?:[?？]\s*$|需要我|请(?:确认|选择|提供)|是否|要不要|可以吗|\b(?:do you want|should i|which file|please confirm|please provide)\b)/iu;
const EXPLICIT_CONTINUE_RE = /^(?:继续|接着|往下|go on|continue|proceed|keep going)\s*[.!。！]?$/iu;

// Length is a precision/recall knob, NOT proof of a substantive answer. A short correct final
// answer ("已修复 README") can fall under it; a long plan can exceed it. We use a conservative
// base and widen it only when the current task segment already shows real tool activity.
const MAX_AUTO_CONTINUATION_TEXT_CHARS = 200;
const MAX_AUTO_CONTINUATION_TEXT_CHARS_WITH_ACTIVITY = 280;

// Neutral nudge: on misfire the model may actually have produced a correct short final answer, so
// do NOT assert "you only described a plan". Ask for execution OR an explicit blocker/no-op reason.
export const TERMINAL_GUARD_NUDGE =
  "本回合没有调用任何工具。如果用户任务需要执行，请立即调用必要工具；" +
  "如果无需执行或确实无法执行，请明确说明无需执行的原因或具体阻塞点。不要只重复计划。";

export type TerminalGuardDecision = "pass" | "continue" | "ambiguous";

export interface TerminalTurnAnalysis {
  decision: TerminalGuardDecision;
  reason: "normal" | "waiting_for_user" | "no_tools" | "no_actionable_request" | "no_execution_claim" | "recent_tool_activity" | "substantive_answer" | "suspicious_no_tool";
  assistantText: string;
  userText: string;
  hasToolCall: boolean;
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter((part): part is { type?: unknown; text?: unknown } => !!part && typeof part === "object")
    .filter(part => part.type === "text" && typeof part.text === "string")
    .map(part => part.text as string)
    .join("");
}

function latestUserText(parsed: OcxParsedRequest): string {
  for (let i = parsed.context.messages.length - 1; i >= 0; i -= 1) {
    const message = parsed.context.messages[i];
    if (message.role === "user") return messageText(message.content);
  }
  return "";
}

// Structural "task is in-progress" signal, scoped to the CURRENT task segment only: scan back from
// the latest user message to the previous user message. Tool activity in an OLDER, unrelated
// segment must not count as the current task still executing (avoids cross-task bleed). This is a
// confidence/threshold enhancer, NEVER a hard gate — a first-turn actionable request has no prior
// activity yet must still be eligible to auto-continue.
function recentTurnHasToolActivity(parsed: OcxParsedRequest): boolean {
  let latestUserIndex = -1;
  for (let i = parsed.context.messages.length - 1; i >= 0; i -= 1) {
    if (parsed.context.messages[i]?.role === "user") {
      latestUserIndex = i;
      break;
    }
  }
  if (latestUserIndex < 0) return false;
  for (let i = latestUserIndex - 1; i >= 0 && parsed.context.messages[i]?.role !== "user"; i -= 1) {
    const message = parsed.context.messages[i];
    // An orphan toolResult (no matching assistant toolCall) still evidences execution in this
    // segment, so count it — but only within the current segment because of the loop bound.
    if (message.role === "toolResult") return true;
    if (message.role === "assistant" && message.content.some(part => part.type === "toolCall")) return true;
  }
  return false;
}

// STRUCTURAL high-confidence signal: the request forced a tool call (toolChoice `required`, a
// specific `{ name }`, or `{ mode: "required" }`) but the turn produced none. That is a protocol
// mismatch, independent of any language, so it can trigger a continuation on its own.
function toolChoiceRequiresTool(choice: OcxToolChoice | undefined): boolean {
  if (choice === "required") return true;
  if (typeof choice === "object" && choice !== null) {
    if (isAllowedToolChoice(choice)) return choice.mode === "required";
    if ("name" in choice) return true;
  }
  return false;
}

// STRUCTURAL signal that the model itself labeled this output a final answer (Responses phase).
// When present it is authoritative — never auto-continue over a declared final answer.
function turnIsFinalAnswer(events: readonly AdapterEvent[]): boolean {
  return events.some(event => event.type === "text_delta" && event.phase === "final_answer");
}

// The Anthropic adapter normally does not attach a phase to fresh output events. When a client
// explicitly says "continue", a persisted prior assistant phase is therefore the only structural
// evidence that the preceding task was already handed back as a final answer.
function priorAssistantIsFinalAnswer(parsed: OcxParsedRequest): boolean {
  let latestUserIndex = -1;
  for (let i = parsed.context.messages.length - 1; i >= 0; i -= 1) {
    if (parsed.context.messages[i]?.role === "user") {
      latestUserIndex = i;
      break;
    }
  }
  if (latestUserIndex < 0) return false;
  for (let i = latestUserIndex - 1; i >= 0; i -= 1) {
    const message = parsed.context.messages[i];
    if (message.role === "assistant") return message.phase === "final_answer";
  }
  return false;
}

function assistantText(events: readonly AdapterEvent[]): string {
  return events
    .filter((event): event is Extract<AdapterEvent, { type: "text_delta" }> => event.type === "text_delta")
    .map(event => event.text)
    .join("");
}

// Structure-first terminal analysis. We deliberately do NOT parse the assistant's wording to guess
// whether it "only described a plan" — that heuristic was language-fragile and mixed up "about to do" with
// "already done". Instead we combine reliable structural facts (tool calls this turn, tool
// availability, toolChoice, final-answer phase, current-segment activity) with two USER-INTENT
// gates and one length knob. This lowers the frequency of premature `end_turn` stops; it cannot
// guarantee elimination because the stop decision ultimately lives in the model.
export function analyzeTerminalTurn(parsed: OcxParsedRequest, events: readonly AdapterEvent[]): TerminalTurnAnalysis {
  const userText = latestUserText(parsed);
  const text = assistantText(events);
  const trimmedLength = text.trim().length;
  const hasToolCall = events.some(event => event.type === "tool_call_start");
  const explicitContinue = EXPLICIT_CONTINUE_RE.test(userText);
  const base = { assistantText: text, userText, hasToolCall } as const;

  // A real tool call happened this turn → this is a normal in-progress terminal.
  if (hasToolCall) {
    return { decision: "pass", reason: "normal", ...base };
  }

  // Nothing to continue toward when tools are unavailable or explicitly disabled.
  const toolChoice = parsed.options.toolChoice;
  const hasTools = !!parsed.context.tools && parsed.context.tools.length > 0;
  if (!hasTools || toolChoice === "none") {
    return { decision: "pass", reason: "no_tools", ...base };
  }

  // The model itself declared a final answer → authoritative, never auto-continue.
  if (turnIsFinalAnswer(events) || (explicitContinue && priorAssistantIsFinalAnswer(parsed))) {
    return { decision: "pass", reason: "substantive_answer", ...base };
  }

  // Appears to be asking the user something → safe pass (heuristic, not a classifier).
  if (WAITING_FOR_USER_RE.test(text)) {
    return { decision: "pass", reason: "waiting_for_user", ...base };
  }

  // The user's explicit plan-only/no-tools instruction takes precedence over a conflicting tool
  // choice in the request body — do not manufacture execution the user explicitly declined.
  if (PLAN_ONLY_REQUEST_RE.test(userText)) {
    return { decision: "pass", reason: "no_actionable_request", ...base };
  }

  // High-confidence structural trigger: a forced tool call produced no tool. Language-independent.
  if (toolChoiceRequiresTool(toolChoice)) {
    return { decision: "continue", reason: "suspicious_no_tool", ...base };
  }

  // For ordinary `auto` tool selection we require a user-intent signal that this turn was an
  // execution request at all (otherwise every tool-enabled Q&A would be eligible), and honor an
  // explicit "just give me a plan / don't call tools" request.
  if (!ACTIONABLE_REQUEST_RE.test(userText)) {
    return { decision: "pass", reason: "no_actionable_request", ...base };
  }

  // Length is a precision/recall knob, not proof. Widen it only when the current task segment
  // already shows real tool activity (higher prior that a longer message is still mid-task).
  const lengthCap = recentTurnHasToolActivity(parsed)
    ? MAX_AUTO_CONTINUATION_TEXT_CHARS_WITH_ACTIVITY
    : MAX_AUTO_CONTINUATION_TEXT_CHARS;
  if (trimmedLength > lengthCap) {
    return { decision: "pass", reason: "substantive_answer", ...base };
  }

  // Actionable request, tools available, not forced, not waiting on the user, no declared final
  // answer, and a short output: a suspicious early stop → auto-continue once (bounded upstream).
  return { decision: "continue", reason: "suspicious_no_tool", ...base };
}

function assistantMessageFromEvents(events: readonly AdapterEvent[]): OcxAssistantMessage | undefined {
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
  const content: OcxAssistantContentPart[] = [];
  if (thinking || signature || redacted.length > 0) {
    content.push({ type: "thinking", thinking, ...(signature ? { signature } : {}), ...(redacted.length > 0 ? { redacted } : {}) });
  }
  if (text) content.push({ type: "text", text });
  if (content.length === 0) return undefined;
  return { role: "assistant", content, timestamp: Date.now() };
}

export function buildContinuationRequest(parsed: OcxParsedRequest, events: readonly AdapterEvent[]): OcxParsedRequest {
  const messages = [...parsed.context.messages];
  const assistant = assistantMessageFromEvents(events);
  if (assistant) messages.push(assistant);
  messages.push({ role: "developer", content: TERMINAL_GUARD_NUDGE, timestamp: Date.now() });
  return { ...parsed, context: { ...parsed.context, messages } };
}

export interface GuardedEventStreamOptions {
  parsed: OcxParsedRequest;
  firstEvents: AsyncIterable<AdapterEvent>;
  continuation: (parsed: OcxParsedRequest) => AsyncIterable<AdapterEvent> | Promise<AsyncIterable<AdapterEvent>>;
  adapterName?: string;
  maxAutoContinuations?: number;
}

function mergeUsage(first: OcxUsage | undefined, second: OcxUsage | undefined): OcxUsage | undefined {
  if (!first) return second;
  if (!second) return first;
  const sumOptional = (key: keyof OcxUsage): number | undefined => {
    const left = first[key];
    const right = second[key];
    return typeof left === "number" || typeof right === "number"
      ? (typeof left === "number" ? left : 0) + (typeof right === "number" ? right : 0)
      : undefined;
  };
  const cachedInputTokens = sumOptional("cachedInputTokens");
  const cacheReadInputTokens = sumOptional("cacheReadInputTokens");
  const cacheCreationInputTokens = sumOptional("cacheCreationInputTokens");
  const reasoningOutputTokens = sumOptional("reasoningOutputTokens");
  const inputTokens = first.inputTokens + second.inputTokens;
  const outputTokens = first.outputTokens + second.outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(first.estimated || second.estimated ? { estimated: true } : {}),
  };
}

/** Preserve normal terminals, but withhold one suspicious no-tool terminal for a bounded re-ask. */
export async function* guardTerminalEventStream(options: GuardedEventStreamOptions): AsyncGenerator<AdapterEvent> {
  const maxContinuations = Math.max(0, Math.min(2, Math.floor(options.maxAutoContinuations ?? 1)));
  let parsed = options.parsed;
  let continuations = 0;
  let accumulatedUsage: OcxUsage | undefined;
  let source: AsyncIterable<AdapterEvent> = options.firstEvents;

  while (true) {
    const seen: AdapterEvent[] = [];
    let terminalSeen = false;
    for await (const event of source) {
      if (event.type === "done") {
        terminalSeen = true;
        const analysis = options.adapterName === "anthropic"
          ? analyzeTerminalTurn(parsed, seen)
          : { decision: "pass" as const };
        // Only a normal `end_turn` is eligible for auto-continuation. Other terminal reasons
        // (`max_tokens`, `content_filter`, `stop_sequence`, and even an explicit `tool_use` stop)
        // must never be re-asked. `undefined` is tolerated because several adapters omit the field
        // on a clean stop and the tests exercise that shape.
        const normalStop = event.stopReason === undefined || event.stopReason === "end_turn";
        if (normalStop && analysis.decision === "continue" && continuations < maxContinuations) {
          accumulatedUsage = mergeUsage(accumulatedUsage, event.usage);
          continuations += 1;
          parsed = buildContinuationRequest(parsed, seen);
          yield { type: "assistant_boundary" };
          try {
            source = await options.continuation(parsed);
          } catch (error) {
            yield { type: "error", message: error instanceof Error ? error.message : String(error) };
            return;
          }
          break;
        }
        const usage = mergeUsage(accumulatedUsage, event.usage);
        yield usage ? { ...event, usage } : event;
        return;
      }
      if (event.type === "incomplete" || event.type === "error") {
        terminalSeen = true;
        const usage = mergeUsage(accumulatedUsage, event.usage);
        yield usage ? { ...event, usage } : event;
        return;
      }
      seen.push(event);
      yield event;
    }
    if (!terminalSeen) return;
  }
}
