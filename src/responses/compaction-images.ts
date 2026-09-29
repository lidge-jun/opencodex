import type { OcxMessage } from "../types";

export const COMPACTION_IMAGE_NOTE = "[Earlier image omitted from this compaction request. "
  + "Retain existing analysis and source references; reopen the original attachment if visual details are still needed.]";

/**
 * Summarize earlier image-bearing turns from their text, without paying their vision cost again.
 * A later explicit final answer is a structural boundary, not proof that every image was read.
 * Keep unphased/commentary-only turns and pending images. Never rewrite stored/raw history.
 */
export function omitEarlierCompactionImages(messages: readonly OcxMessage[]): OcxMessage[] {
  let finalAnswerSeen = false;
  const result = [...messages];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "assistant") {
      if (message.phase === "final_answer"
        && message.content.some(part => part.type === "text" && part.text.trim())) finalAnswerSeen = true;
      continue;
    }
    if (!finalAnswerSeen || (message.role !== "user" && message.role !== "toolResult")
      || !Array.isArray(message.content) || !message.content.some(part => part.type === "image")) continue;
    result[index] = { ...message, content: message.content.map(part => part.type === "image"
      ? { type: "text" as const, text: COMPACTION_IMAGE_NOTE } : part) };
  }
  return result;
}
