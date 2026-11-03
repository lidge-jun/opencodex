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

/** Exactly Kimi Code's native Responses endpoint; lookalike hosts and other Kimi paths do not match. */
export function isKimiCodingResponsesUrl(responseUrl: string): boolean {
  let url: URL;
  try { url = new URL(responseUrl); } catch { return false; }
  return url.hostname === "api.kimi.com" && /^\/coding\/v1\/responses\/?$/.test(url.pathname);
}

/** The same endpoint over HTTPS on the default port only, for request rewrites scoped to Kimi Code itself. */
export function isKimiCodingResponsesHttpsUrl(responseUrl: string): boolean {
  if (!isKimiCodingResponsesUrl(responseUrl)) return false;
  const url = new URL(responseUrl);
  return url.protocol === "https:" && url.port === "";
}

/** Kimi Code rejects content-empty assistant messages even on its native Responses endpoint. */
export function stripKimiEmptyAssistantMessages(body: unknown, responseUrl: string): unknown {
  if (!isKimiCodingResponsesUrl(responseUrl)) return body;
  if (!isPlainObject(body) || !Array.isArray(body.input)) return body;
  const referencedIds = new Set<string>();
  for (const item of body.input) {
    if (isPlainObject(item) && item.type === "item_reference" && typeof item.id === "string") referencedIds.add(item.id);
  }
  const input = body.input.filter(item => !isEmptyAssistantMessage(item)
    || (isPlainObject(item) && typeof item.id === "string" && referencedIds.has(item.id)));
  return input.length === body.input.length ? body : { ...body, input };
}
