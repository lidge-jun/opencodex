import { isPlainObject } from "./internal";

const ZAI_RESPONSES_URL = "https://api.z.ai/api/v1/responses";

function degradeImageDetail(part: unknown): unknown {
  return isPlainObject(part) && part.type === "input_image" && part.detail === "original"
    ? { ...part, detail: "high" }
    : part;
}

function mapArrayParts(parts: readonly unknown[]): { changed: boolean; parts: unknown[] } {
  let changed = false;
  const mapped = parts.map((part) => {
    const next = degradeImageDetail(part);
    if (next !== part) changed = true;
    return next;
  });
  return { changed, parts: changed ? mapped : (parts as unknown[]) };
}

export function normalizeZaiResponsesInput(body: unknown, url: string): unknown {
  if (url !== ZAI_RESPONSES_URL || !isPlainObject(body) || !Array.isArray(body.input)) {
    return body;
  }
  let changed = false;
  const nextInput = body.input.map((item) => {
    if (!isPlainObject(item)) return item;
    if (Array.isArray(item.content)) {
      const { changed: c, parts } = mapArrayParts(item.content);
      if (c) {
        changed = true;
        return { ...item, content: parts };
      }
    }
    if (Array.isArray(item.output)) {
      const { changed: c, parts } = mapArrayParts(item.output);
      if (c) {
        changed = true;
        return { ...item, output: parts };
      }
    }
    return item;
  });
  return changed ? { ...body, input: nextInput } : body;
}
