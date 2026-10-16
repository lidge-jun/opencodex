/** Whitelist native text completions; never serialize arbitrary provider payloads. */
import { redactSelectedKey } from "./access-data-client";
export type DataProtocol = "chat" | "responses" | "messages";
export interface SafeModelResponse {
  protocol: DataProtocol;
  text: string[];
  completion: "complete" | "limited";
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function usageOf(raw: unknown, protocol: DataProtocol): SafeModelResponse["usage"] {
  if (raw === undefined || raw === null) return undefined;
  const usage = record(raw);
  if (!usage) throw new Error("Invalid usage.");
  const result: NonNullable<SafeModelResponse["usage"]> = {};
  const fields = protocol === "chat"
    ? { inputTokens: "prompt_tokens", outputTokens: "completion_tokens", totalTokens: "total_tokens" } as const
    : { inputTokens: "input_tokens", outputTokens: "output_tokens", totalTokens: "total_tokens" } as const;
  for (const name of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    const value = usage[fields[name]];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid usage.");
    result[name] = value;
  }
  return Object.keys(result).length ? result : undefined;
}
export function projectModelResponse(raw: unknown, protocol: DataProtocol, key: string): SafeModelResponse {
  const row = record(raw);
  if (!row || (row.error !== undefined && row.error !== null)) throw new Error("Unsupported response.");
  const text: string[] = [];
  let limited = false;
  if (protocol === "responses") {
    if (row.object !== "response" || (row.status !== "completed" && row.status !== "incomplete") || !Array.isArray(row.output)) throw new Error("Unsupported response.");
    if (record(row.incomplete_details)?.reason === "content_filter") throw new Error("Unsupported response.");
    limited = row.status === "incomplete";
    for (const value of row.output) {
      const item = record(value);
      if (!item || item.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content)) {
        // Reasoning/tool entries are not text evidence and are never exposed.
        continue;
      }
      for (const blockValue of item.content) {
        const block = record(blockValue);
        if (block?.type !== "output_text" || typeof block.text !== "string") throw new Error("Unsupported response.");
        text.push(block.text);
      }
    }
  } else if (protocol === "chat") {
    if (row.object !== "chat.completion" || !Array.isArray(row.choices) || row.choices.length === 0) throw new Error("Unsupported response.");
    for (const value of row.choices) {
      const choice = record(value);
      const message = record(choice?.message);
      if (!choice || (choice.finish_reason !== "stop" && choice.finish_reason !== "length")
        || !message || message.role !== "assistant" || typeof message.content !== "string"
        || (message.refusal !== undefined && message.refusal !== null)) throw new Error("Unsupported response.");
      limited ||= choice.finish_reason === "length";
      text.push(message.content);
    }
  } else {
    if (row.type !== "message" || row.role !== "assistant" || !Array.isArray(row.content)
      || (row.stop_reason !== "end_turn" && row.stop_reason !== "stop_sequence" && row.stop_reason !== "max_tokens")) {
      throw new Error("Unsupported response.");
    }
    limited = row.stop_reason === "max_tokens";
    for (const value of row.content) {
      const block = record(value);
      if (block?.type === "text" && typeof block.text === "string") text.push(block.text);
      else if (block?.type !== "thinking" && block?.type !== "redacted_thinking") throw new Error("Unsupported response.");
    }
  }
  if (!text.length) throw new Error("Unsupported response.");
  const usage = usageOf(row.usage, protocol);
  return { protocol, text: text.map(value => redactSelectedKey(value, key)), completion: limited ? "limited" : "complete", ...(usage ? { usage } : {}) };
}
