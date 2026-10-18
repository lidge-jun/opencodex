import type { AdapterEvent, OcxAssistantContentPart, OcxThinkingContent, OcxToolCall } from "../types";

/** Rebuild one validated Anthropic model response without changing its search arguments or order. */
export function anthropicSearchAssistantContent(events: readonly AdapterEvent[]): OcxAssistantContentPart[] {
  const content: OcxAssistantContentPart[] = [];
  let thinking: OcxThinkingContent | undefined;
  let text: Extract<OcxAssistantContentPart, { type: "text" }> | undefined;
  let call: OcxToolCall | undefined;
  let argumentsText = "";
  for (const event of events) {
    if (event.type === "heartbeat") continue;
    // A signature is a replacement snapshot until the next semantic block starts.
    if (thinking?.signature !== undefined && event.type !== "thinking_signature") thinking = undefined;
    if (event.type !== "text_delta") text = undefined;
    switch (event.type) {
      case "thinking_delta":
        if (!thinking) { thinking = { type: "thinking", thinking: "" }; content.push(thinking); }
        thinking.thinking += event.thinking;
        break;
      case "thinking_signature":
        if (!thinking) { thinking = { type: "thinking", thinking: "" }; content.push(thinking); }
        thinking.signature = event.signature;
        break;
      case "redacted_thinking":
        thinking = undefined;
        content.push({ type: "thinking", thinking: "", redacted: [event.data] });
        break;
      case "text_delta":
        thinking = undefined;
        if (event.anthropicThinkingSignature) {
          text = undefined;
          content.push({ type: "thinking", thinking: event.text, signature: event.anthropicThinkingSignature });
          break;
        }
        if (!text) { text = { type: "text", text: "" }; content.push(text); }
        text.text += event.text;
        break;
      case "tool_call_start":
        thinking = undefined;
        call = { type: "toolCall", id: event.id, name: event.name, arguments: {},
          ...(event.providerMetadata ? { providerMetadata: event.providerMetadata } : {}) };
        content.push(call);
        argumentsText = "";
        break;
      case "tool_call_delta":
        argumentsText += event.arguments;
        break;
      case "tool_call_end": {
        if (!call) throw new Error("search history has an unpaired tool call");
        const args: unknown = JSON.parse(argumentsText || "{}");
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("search history tool input is not an object");
        call.arguments = args as Record<string, unknown>;
        call = undefined;
        break;
      }
    }
  }
  return content;
}
