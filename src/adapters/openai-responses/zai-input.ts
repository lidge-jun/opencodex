import { isPlainObject } from "./internal";

const ZAI_RESPONSES_URL = "https://api.z.ai/api/v1/responses";

function degradeOriginalDetail(part: unknown): unknown {
  return isPlainObject(part) && part.type === "input_image" && part.detail === "original"
    ? { ...part, detail: "high" }
    : part;
}

/** Returns the same array when no part changes, so unchanged items keep their identity. */
function degradeParts(parts: unknown[]): unknown[] {
  let changed = false;
  const next = parts.map(part => {
    const projected = degradeOriginalDetail(part);
    if (projected !== part) changed = true;
    return projected;
  });
  return changed ? next : parts;
}

/**
 * Z.AI's Responses endpoint accepts image detail auto|low|high only. codex-rs sends
 * `detail: "original"` when the catalog row advertises `supports_image_detail_original`,
 * and Z.AI answers the whole request with HTTP 400 "Invalid API parameter". Because the
 * image stays in history, every later turn of the thread fails the same way. Message content
 * and every array-valued tool output (`function_call_output`, `custom_tool_call_output`, ...)
 * degrade "original" to "high", the codex default. Image bytes, part order and every other
 * field are unchanged; other destinations and the source body are untouched.
 */
export function normalizeZaiResponsesInput(body: unknown, url: string): unknown {
  // Exact-URL boundary, the same shape as the OpenGateway projection: a query-routed or
  // lookalike destination is a different upstream.
  if (url !== ZAI_RESPONSES_URL || !isPlainObject(body) || !Array.isArray(body.input)) return body;
  let changed = false;
  const input = body.input.map(item => {
    if (!isPlainObject(item)) return item;
    let next = item;
    if (Array.isArray(item.content)) {
      const content = degradeParts(item.content);
      if (content !== item.content) next = { ...next, content };
    }
    if (Array.isArray(item.output)) {
      const output = degradeParts(item.output);
      if (output !== item.output) next = { ...next, output };
    }
    if (next !== item) changed = true;
    return next;
  });
  return changed ? { ...body, input } : body;
}
