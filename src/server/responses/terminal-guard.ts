import type {
  AdapterEvent,
  OcxAssistantContentPart,
  OcxAssistantMessage,
  OcxParsedRequest,
  OcxUsage,
} from "../../types";

const ACTIONABLE_REQUEST_RE = /(?:\b(?:add|change|check|continue|create|debug|delete|deploy|edit|execute|fix|implement|inspect|keep going|modify|patch|proceed|refactor|remove|review|run|test|update|write)\b|继续|接着|往下|升级|修改|改(?:一下|下)?|修复|实现|添加|新增|删除|重构|更新|运行|执行|检查|查看|排查|调试|创建|写入|提交|推送|部署|看下|改成|修一下)/iu;
const PLAN_ONLY_REQUEST_RE = /(?:只(?:给|要|需)(?:我)?(?:一个|个|一下)?(?:计划|方案)|先(?:给|说)(?:我)?(?:一个|个|一下)?(?:计划|方案)|暂时不要(?:调用|使用)工具|不要调用工具|不用执行|只回复(?:计划|方案)|\b(?:just give|provide)\s+(?:me\s+)?(?:a\s+)?plan\b|\b(?:do not|don't)\s+(?:use|call)\s+tools?\b)/iu;
const PLAN_INTENT_RE = /(?:\b(?:i(?:'|’)m going to|i will|i(?:'|’)ll|let me|next i)\b|我(?:先|会|将|接下来)|下一步)/iu;
const PLAN_OR_COMPLETION_RE = /(?:\b(?:i(?:'|’)m going to|i will|i(?:'|’)ll|let me|next i|i(?:'|’)ve (?:already )?(?:added|applied|changed|completed|fixed|implemented|modified|updated))\b|\b(?:done|completed|fixed|implemented|updated|applied)\b|我(?:先|会|将|接下来)|下一步|已(?:经)?(?:修改|修复|完成|应用|更新|实现|处理)|完成了|已经好了)/iu;
const WAITING_FOR_USER_RE = /(?:[?？]\s*$|需要我|请(?:确认|选择|提供)|是否|要不要|可以吗|\b(?:do you want|should i|which file|please confirm|please provide)\b)/iu;
const EXPLICIT_CONTINUE_RE = /^(?:继续|接着|往下|go on|continue|proceed|keep going)\s*[.!。！]?$/iu;
const MAX_ANNOUNCEMENT_CHARS = 280;

export const TERMINAL_GUARD_NUDGE =
  "你刚才只描述了计划，没有执行任何工具。不要再次解释计划，现在立即调用必要工具执行用户任务。" +
  "只有工具返回后才总结；如果确实无法执行，请明确说明阻塞原因。";

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

function recentTurnHasToolActivity(parsed: OcxParsedRequest): boolean {
  let latestUserIndex = -1;
  for (let i = parsed.context.messages.length - 1; i >= 0; i -= 1) {
    if (parsed.context.messages[i]?.role === "user") {
      latestUserIndex = i;
      break;
    }
  }
  if (latestUserIndex < 0) return false;
  let lastAssistant: OcxAssistantMessage | undefined;
  for (let i = latestUserIndex - 1; i >= 0; i -= 1) {
    const message = parsed.context.messages[i];
    if (message.role === "assistant") {
      lastAssistant = message;
      break;
    }
  }
  if (lastAssistant?.role === "assistant") {
    const hasToolCall = lastAssistant.content.some(part => part.type === "toolCall");
    const text = lastAssistant.content
      .filter(part => part.type === "text")
      .map(part => part.text)
      .join("");
    if (!hasToolCall && PLAN_INTENT_RE.test(text)) return false;
  }
  for (let i = latestUserIndex - 1; i >= 0 && parsed.context.messages[i]?.role !== "user"; i -= 1) {
    const message = parsed.context.messages[i];
    if (message.role === "toolResult") return true;
    if (message.role === "assistant" && message.content.some(part => part.type === "toolCall")) return true;
  }
  return false;
}

function assistantText(events: readonly AdapterEvent[]): string {
  return events
    .filter((event): event is Extract<AdapterEvent, { type: "text_delta" }> => event.type === "text_delta")
    .map(event => event.text)
    .join("");
}

export function analyzeTerminalTurn(parsed: OcxParsedRequest, events: readonly AdapterEvent[]): TerminalTurnAnalysis {
  const userText = latestUserText(parsed);
  const text = assistantText(events);
  const hasToolCall = events.some(event => event.type === "tool_call_start");
  if (hasToolCall) {
    return { decision: "pass", reason: "normal", assistantText: text, userText, hasToolCall };
  }
  if (!parsed.context.tools || parsed.context.tools.length === 0 || parsed.options.toolChoice === "none") {
    return { decision: "pass", reason: "no_tools", assistantText: text, userText, hasToolCall };
  }
  if (!ACTIONABLE_REQUEST_RE.test(userText)) {
    return { decision: "pass", reason: "no_actionable_request", assistantText: text, userText, hasToolCall };
  }
  if (PLAN_ONLY_REQUEST_RE.test(userText)) {
    return { decision: "pass", reason: "no_actionable_request", assistantText: text, userText, hasToolCall };
  }
  if (EXPLICIT_CONTINUE_RE.test(userText) && recentTurnHasToolActivity(parsed)) {
    return { decision: "pass", reason: "recent_tool_activity", assistantText: text, userText, hasToolCall };
  }
  if (WAITING_FOR_USER_RE.test(text)) {
    return { decision: "pass", reason: "waiting_for_user", assistantText: text, userText, hasToolCall };
  }
  if (text.trim().length > MAX_ANNOUNCEMENT_CHARS) {
    return { decision: "pass", reason: "substantive_answer", assistantText: text, userText, hasToolCall };
  }
  if (!PLAN_OR_COMPLETION_RE.test(text)) {
    return { decision: "ambiguous", reason: "no_execution_claim", assistantText: text, userText, hasToolCall };
  }
  return { decision: "continue", reason: "suspicious_no_tool", assistantText: text, userText, hasToolCall };
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
        const normalStop = event.stopReason !== "max_tokens" && event.stopReason !== "content_filter";
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
