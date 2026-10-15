import type { AdapterEvent, OcxAssistantContentPart } from "../types";

/** Rebuild text and signed blocks in event order, never joining separately signed blocks. */
export function assistantReplayContent(events: readonly AdapterEvent[]): OcxAssistantContentPart[] {
  const content: OcxAssistantContentPart[] = [];
  let text = "";
  let thinking: string | undefined;
  let signature: string | undefined;
  const flush = () => {
    if (text) content.push({ type: "text", text });
    if (thinking !== undefined || signature !== undefined) content.push({ type: "thinking", thinking: thinking ?? "", ...(signature !== undefined ? { signature } : {}) });
    text = "";
    thinking = signature = undefined;
  };
  for (const event of events) {
    if (event.type === "heartbeat") continue;
    if (signature !== undefined && event.type !== "thinking_signature") flush();
    if (event.type === "text_delta" && event.anthropicThinkingSignature) {
      flush();
      content.push({ type: "thinking", thinking: event.text, signature: event.anthropicThinkingSignature });
    } else if (event.type === "text_delta") {
      if (thinking !== undefined) flush();
      text += event.text;
    } else if (event.type === "thinking_delta") {
      if (text) flush();
      thinking = (thinking ?? "") + event.thinking;
    } else if (event.type === "thinking_signature") signature = event.signature;
    else if (event.type === "redacted_thinking") {
      flush();
      content.push({ type: "thinking", thinking: "", redacted: [event.data] });
    } else flush();
  }
  flush();
  return content;
}
