import type {
  OcxAssistantMessage,
  OcxMessage,
  OcxToolCall,
  OcxToolResultMessage,
} from "../types";

function isAssistantToolCall(message: OcxMessage): message is OcxAssistantMessage {
  return message.role === "assistant";
}

function isToolResult(message: OcxMessage): message is OcxToolResultMessage {
  return message.role === "toolResult";
}

/**
 * Repair incomplete tool exchanges before assigning provider-visible ids.
 *
 * CCA translates Gemini function calls and responses into Anthropic tool blocks,
 * which requires both sides of every exchange. A result is valid only when its
 * call appeared earlier in the history, and a call is valid only when a result
 * appears later. Filtering the history first also prevents orphan results from
 * reserving ids in the request-scoped allocator.
 */
export function repairGoogleToolPairs(messages: readonly OcxMessage[]): OcxMessage[] {
  const matchedCallIds = new Set<string>();
  const callIdsBeforeResult = new Set<string>();

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (isAssistantToolCall(message)) {
      for (const part of message.content) {
        if (part.type !== "toolCall") continue;
        const toolCall = part as OcxToolCall;
        for (let later = index + 1; later < messages.length; later++) {
          const candidate = messages[later]!;
          if (isToolResult(candidate) && candidate.toolCallId === toolCall.id) {
            matchedCallIds.add(toolCall.id);
            break;
          }
        }
      }
    } else if (isToolResult(message)) {
      for (let earlier = index - 1; earlier >= 0; earlier--) {
        const candidate = messages[earlier]!;
        if (!isAssistantToolCall(candidate)) continue;
        if (candidate.content.some(part => part.type === "toolCall" && (part as OcxToolCall).id === message.toolCallId)) {
          callIdsBeforeResult.add(message.toolCallId);
          break;
        }
      }
    }
  }

  const repaired: OcxMessage[] = [];
  for (const message of messages) {
    if (isToolResult(message)) {
      if (callIdsBeforeResult.has(message.toolCallId)) repaired.push(message);
      continue;
    }
    if (!isAssistantToolCall(message)) {
      repaired.push(message);
      continue;
    }

    const content = message.content.filter(part =>
      part.type !== "toolCall" || matchedCallIds.has((part as OcxToolCall).id));
    if (content.length > 0) {
      repaired.push(content.length === message.content.length ? message : { ...message, content });
    }
  }
  return repaired;
}

/**
 * Claude interprets a final model turn as a prefilled assistant response.
 * CCA expects the next turn to be generated instead, except when that model
 * turn is the entire conversation and must remain as the initial context.
 */
export function stripTrailingClaudePrefill(contents: unknown[]): unknown[] {
  while (contents.length >= 2) {
    const last = contents[contents.length - 1];
    if (typeof last !== "object" || last === null || (last as { role?: unknown }).role !== "model") break;
    contents.pop();
  }
  return contents;
}
