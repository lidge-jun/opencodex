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
 *
 * The allocator maps one raw id to one wire id, so a second complete exchange
 * that reuses the same raw id would serialize as a colliding pair. Keep only
 * the first matched occurrence per raw id.
 *
 * Direct Gemini and Vertex accept an unmatched trailing `functionCall`, so
 * `dropUnmatchedCalls` is CCA-only. Orphan results are still dropped in every
 * Google mode so they cannot reserve allocator slots or emit a lone
 * `functionResponse`.
 */
export function repairGoogleToolPairs(
  messages: readonly OcxMessage[],
  opts: { dropUnmatchedCalls?: boolean } = {},
): OcxMessage[] {
  const dropUnmatchedCalls = opts.dropUnmatchedCalls ?? true;
  const pendingCalls = new Map<string, Array<{ messageIndex: number; partIndex: number }>>();
  const seenRawCallIds = new Set<string>();
  const matchedCallParts = new Set<string>();
  const matchedResultIndexes = new Set<number>();

  const enqueueCall = (id: string, messageIndex: number, partIndex: number) => {
    if (seenRawCallIds.has(id)) return;
    seenRawCallIds.add(id);
    const queue = pendingCalls.get(id) ?? [];
    queue.push({ messageIndex, partIndex });
    pendingCalls.set(id, queue);
  };

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex]!;
    if (isAssistantToolCall(message)) {
      message.content.forEach((part, partIndex) => {
        if (part.type !== "toolCall") return;
        enqueueCall((part as OcxToolCall).id, messageIndex, partIndex);
      });
      continue;
    }
    if (!isToolResult(message)) continue;
    const queue = pendingCalls.get(message.toolCallId);
    const slot = queue?.shift();
    if (!slot) continue;
    matchedCallParts.add(`${slot.messageIndex}:${slot.partIndex}`);
    matchedResultIndexes.add(messageIndex);
  }

  const repaired: OcxMessage[] = [];
  for (const [messageIndex, message] of messages.entries()) {
    if (isToolResult(message)) {
      if (matchedResultIndexes.has(messageIndex)) repaired.push(message);
      continue;
    }
    if (!isAssistantToolCall(message)) {
      repaired.push(message);
      continue;
    }

    const content = message.content.filter((part, partIndex) =>
      part.type !== "toolCall"
      || matchedCallParts.has(`${messageIndex}:${partIndex}`)
      || !dropUnmatchedCalls);
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
export function stripTrailingClaudePrefill(contents: unknown[]): boolean {
  let strippedModelTail = false;
  while (contents.length >= 2) {
    const last = contents[contents.length - 1];
    if (typeof last !== "object" || last === null || (last as { role?: unknown }).role !== "model") break;
    contents.pop();
    strippedModelTail = true;
  }
  return strippedModelTail;
}
