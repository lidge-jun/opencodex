/** Input kinds for which the normalized request has no lossless content carrier. */
export type UntranslatedInputMedia = "audio" | "file";

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mediaKind(value: unknown): UntranslatedInputMedia | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === "input_audio" || value.type === "audio") return "audio";
  if (value.type === "input_file" || value.type === "file" || value.type === "document") return "file";
  // A file-id-only image is not pixels: translated adapters cannot dereference it.
  if (value.type === "input_image" && typeof value.file_id === "string" && value.file_id.length > 0
      && !(typeof value.image_url === "string" && value.image_url.length > 0)) return "file";
  return undefined;
}

function contentMedia(content: unknown): UntranslatedInputMedia | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    const kind = mediaKind(part);
    if (kind) return kind;
  }
  return undefined;
}

/**
 * Inspect only typed input items and their content arrays, never strings, tool
 * arguments, schema properties, or arbitrary nested objects. No payload is copied,
 * decoded, fetched or included in the returned value.
 */
export function untranslatedResponsesInputMedia(body: unknown): UntranslatedInputMedia | undefined {
  if (!isRecord(body) || !Array.isArray(body.input)) return undefined;
  for (const item of body.input) {
    if (!isRecord(item)) continue;
    const direct = mediaKind(item);
    if (direct) return direct;
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      const kind = contentMedia(item.output);
      if (kind) return kind;
    } else if (item.type === "message" || item.type === undefined) {
      const kind = contentMedia(item.content);
      if (kind) return kind;
    }
  }
  return undefined;
}

/** Used only when Chat is actually projected, not on the native Chat fast path. */
export function untranslatedChatInputMedia(body: unknown): UntranslatedInputMedia | undefined {
  if (!isRecord(body) || !Array.isArray(body.messages)) return undefined;
  for (const message of body.messages) {
    if (!isRecord(message)) continue;
    const kind = contentMedia(message.content);
    if (kind) return kind;
  }
  return undefined;
}

/** Fixed vocabulary only: never interpolate filenames, URLs or client metadata. */
export function untranslatedInputMediaMessage(kind: UntranslatedInputMedia): string {
  return `OpenCodex cannot translate ${kind} input on this route. Use a native input wire that supports the attachment, or convert it to text first.`;
}
