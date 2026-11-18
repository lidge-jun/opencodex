import type { AdapterRequest } from "../../adapters/base";
import type { OcxMessage, OcxParsedRequest, OcxProviderContinuationOwner } from "../../types";
import type { ProviderFetchOptions } from "./fetch-helpers";

/** Authority from the physical send that returned a 413. Only that credential may read the history. */
export interface AnthropicImageRecoveryPin {
  owner: OcxProviderContinuationOwner;
  request: AdapterRequest;
  isCurrent(): boolean;
  dispatchOverride(request: AdapterRequest, parsed: OcxParsedRequest): NonNullable<ProviderFetchOptions["dispatchOverride"]>;
}

function inlineImage(message: OcxMessage): boolean {
  return Array.isArray(message.content) && message.content.some(part =>
    part.type === "image" && part.imageUrl.startsWith("data:"));
}

/** Keep the current user turn and every open tool call with its results. */
export function splitAnthropicImageContext(messages: OcxMessage[]): {
  history: OcxMessage[];
  retained: OcxMessage[];
} | undefined {
  const open = new Set<string>();
  let cut = 0;
  let sawImage = false;
  const newestImage = messages.findLastIndex(inlineImage);
  for (const [index, message] of messages.entries()) {
    if (index <= newestImage && message.role === "user" && open.size === 0 && sawImage) cut = index;
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "toolCall") open.add(part.id);
      }
    } else if (message.role === "toolResult") {
      open.delete(message.toolCallId);
    }
    sawImage ||= inlineImage(message);
  }
  if (cut === 0) return;
  const history = messages.slice(0, cut);
  // Only conversational turns can be replaced. Instruction roles have to stay verbatim.
  if (history.some(({ role }) => role !== "user" && role !== "assistant" && role !== "toolResult")) return;
  return { history, retained: messages.slice(cut) };
}
