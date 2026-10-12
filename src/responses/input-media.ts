import { isInlineDocumentDataUrl } from "./inline-document";

/** Input kinds for which the normalized request has no lossless content carrier. */
export type UntranslatedInputMedia = "audio" | "file";

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Whether the position being scanned has a converter that builds a document part.
 *
 * Only user content does. A tool output, a system or assistant message, and a Chat `developer`
 * message are all flattened to text by their converters, so exempting an attachment there would
 * turn today's explicit refusal into the silent drop this scanner exists to prevent.
 */
type CarrierPosition = "user-content" | "flattened";

function mediaKind(value: unknown, position: CarrierPosition): UntranslatedInputMedia | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === "input_audio" || value.type === "audio") return "audio";
  if (value.type === "input_file" || value.type === "file" || value.type === "document") {
    // A document that carries its own bytes has a lossless carrier in user content, so refusing
    // it there would reject the very request #5212 exists to preserve. A reference with no
    // payload has none anywhere: translated adapters cannot dereference a file_id or a remote
    // source.
    return position === "user-content" && carriesInlineDocumentBytes(value) ? undefined : "file";
  }
  // A file-id-only image is not pixels: translated adapters cannot dereference it.
  if (value.type === "input_image" && typeof value.file_id === "string" && value.file_id.length > 0
      && !(typeof value.image_url === "string" && value.image_url.length > 0)) return "file";
  return undefined;
}

/** Presence of a base64 payload only. No payload is read, decoded, copied or returned. */
function carriesInlineDocumentBytes(value: RecordValue): boolean {
  if (isInlineDocumentDataUrl(value.file_data)) return true;
  // Chat Completions nests the payload under `file`.
  if (isRecord(value.file) && isInlineDocumentDataUrl(value.file.file_data)) return true;
  // Anthropic nests it under a base64 `source`.
  return isRecord(value.source)
    && value.source.type === "base64"
    && typeof value.source.data === "string"
    && value.source.data.length > 0;
}

function contentMedia(content: unknown, position: CarrierPosition): UntranslatedInputMedia | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    const kind = mediaKind(part, position);
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
    const direct = mediaKind(item, "flattened");
    if (direct) return direct;
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      const kind = contentMedia(item.output, "flattened");
      if (kind) return kind;
    } else if (item.type === "message" || item.type === undefined) {
      // `inputContentParts` runs for user and developer messages only; a system message is
      // flattened to text by the parser.
      const role = item.role;
      const kind = contentMedia(item.content, role === "user" || role === "developer" ? "user-content" : "flattened");
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
    // Only the `user` branch of the Chat projection builds content blocks. `system`,
    // `developer`, `assistant` and `tool` all reduce their content to a string.
    const kind = contentMedia(message.content, message.role === "user" ? "user-content" : "flattened");
    if (kind) return kind;
  }
  return undefined;
}

/** Fixed vocabulary only: never interpolate filenames, URLs or client metadata. */
export function untranslatedInputMediaMessage(kind: UntranslatedInputMedia): string {
  return `OpenCodex cannot translate ${kind} input on this route. Use a native input wire that supports the attachment, or convert it to text first.`;
}
