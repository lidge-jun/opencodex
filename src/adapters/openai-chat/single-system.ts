import type { OcxProviderConfig } from "../../types";

/** Normalize the outbound copy only; history and non-instruction messages stay intact. */
export function singleLeadingSystemMessages(messages: unknown, provider: OcxProviderConfig): unknown {
  if (provider.singleLeadingSystemMessage !== true || !Array.isArray(messages)) return messages;
  const instructions: string[] = [];
  const remaining: unknown[] = [];
  for (const message of messages) {
    if (message === null || typeof message !== "object" || Array.isArray(message)
      || (message.role !== "system" && message.role !== "developer")) {
      remaining.push(message);
      continue;
    }
    const content: unknown = message.content;
    if (typeof content === "string") instructions.push(content);
    else if (Array.isArray(content) && content.every(part => part !== null && typeof part === "object"
      && part.type === "text" && typeof part.text === "string")) {
      instructions.push(content.map(part => part.text).join(""));
    } else {
      throw new Error("singleLeadingSystemMessage requires text-only system/developer content");
    }
  }
  return instructions.length > 0 ? [{ role: "system", content: instructions.join("\n\n") }, ...remaining] : messages;
}
