import { isPlainObject } from "./internal";

const MESSAGE_FIELDS = new Set(["type", "role", "content", "id", "status", "phase"]);

function isEmptyTextPart(part: unknown): boolean {
  if (!isPlainObject(part) || !["text", "input_text", "output_text"].includes(String(part.type)) || part.text !== "") return false;
  // Nonempty annotations and unknown fields may carry information despite the blank text.
  return Object.keys(part).every(key => key === "type" || key === "text"
    || ((key === "annotations" || key === "logprobs") && Array.isArray(part[key]) && part[key].length === 0));
}

function isEmptyAssistantMessage(item: unknown): boolean {
  if (!isPlainObject(item) || item.role !== "assistant" || (item.type !== undefined && item.type !== "message")) return false;
  // Never discard tools, reasoning, opaque state or unknown extension fields on a message.
  if (!Object.keys(item).every(key => MESSAGE_FIELDS.has(key))) return false;
  return item.content === "" || (Array.isArray(item.content) && item.content.every(isEmptyTextPart));
}

/** Kimi Code rejects content-empty assistant messages even on its native Responses endpoint. */
export function stripKimiEmptyAssistantMessages(body: unknown, responseUrl: string): unknown {
  let url: URL;
  try { url = new URL(responseUrl); } catch { return body; }
  if (url.hostname !== "api.kimi.com" || !/^\/coding\/v1\/responses\/?$/.test(url.pathname)) return body;
  if (!isPlainObject(body) || !Array.isArray(body.input)) return body;
  const referencedIds = new Set<string>();
  for (const item of body.input) {
    if (isPlainObject(item) && item.type === "item_reference" && typeof item.id === "string") referencedIds.add(item.id);
  }
  const input = body.input.filter(item => !isEmptyAssistantMessage(item)
    || (isPlainObject(item) && typeof item.id === "string" && referencedIds.has(item.id)));
  return input.length === body.input.length ? body : { ...body, input };
}
