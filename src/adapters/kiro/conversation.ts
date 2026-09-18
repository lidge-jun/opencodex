import { hasRecordedTrailingDeliveredFinalAnswer } from "../../responses/turn-termination";
import type {
  OcxAssistantMessage,
  OcxMessage,
  OcxParsedRequest,
} from "../../types";
import type { KiroImage } from "../kiro-images";
import type { KiroHistoryEntry, KiroToolResult, KiroToolUse } from "./wire";

export function validateKiroCapabilities(parsed: OcxParsedRequest): void {
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

export type KiroTurn =
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
export function hasTrailingDeliveredFinalAnswer(messages: readonly OcxMessage[], parsed?: OcxParsedRequest): boolean {
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

export function appendTurnText(target: string, next: string): string {
  if (!next) return target;
  return target ? `${target}\n\n${next}` : next;
}

export function validateKiroConversationState(history: KiroHistoryEntry[], currentMessage: KiroHistoryEntry): void {
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
