import { isCanonicalMistralChat } from "../../providers/mistral-transport";
import type { OcxProviderConfig } from "../../types";
import { chatContentEvents } from "./response-events";

type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue => value !== null && typeof value === "object" && !Array.isArray(value);
type Destination = Pick<OcxProviderConfig, "adapter" | "authMode" | "baseUrl">;

/** Normalize both Chat deltas and completion messages with the translated adapter's typed parser. */
export function normalizeNativeChatContent(value: RecordValue, provider?: Destination): RecordValue {
  if (!provider || !isCanonicalMistralChat(provider) || !Array.isArray(value.choices)) return value;
  let invalid = false;
  const choices = value.choices.map(choice => {
    if (!isRecord(choice)) return choice;
    const out = { ...choice };
    for (const field of ["delta", "message"] as const) {
      const message = choice[field];
      if (!isRecord(message) || !Array.isArray(message.content)) continue;
      const events = chatContentEvents(message.content, provider.baseUrl);
      if (events.some(event => event.type === "error")) { invalid = true; continue; }
      const text = events.filter(event => event.type === "text_delta").map(event => event.text).join("");
      const reasoning = events.filter(event => event.type === "reasoning_raw_delta").map(event => event.text).join("");
      out[field] = { ...message, content: text,
        ...(reasoning ? { reasoning_content: (typeof message.reasoning_content === "string" ? message.reasoning_content : "") + reasoning } : {}),
      };
    }
    return out;
  });
  return invalid
    ? { error: { status: 502, type: "upstream_error", message: "unsupported Mistral content block" } }
    : { ...value, choices };
}
