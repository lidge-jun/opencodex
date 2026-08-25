import type { OcxContentPart } from "../types";

/**
 * Parse a `data:<media-type>;base64,<data>` URL into its parts. Codex sends inline images as base64
 * data URLs (`into_data_url()`), which Anthropic/Google need split into media_type + raw base64.
 * Returns null for non-data URLs (e.g. a remote https image), which callers pass through differently.
 */
export function parseDataUrl(url: string): { mediaType: string; base64: string } | null {
  const m = url.match(/^data:([^;,]+);base64,(.*)$/s);
  if (!m) return null;
  return { mediaType: m[1], base64: m[2] };
}

/**
 * Flatten tool-result content to a string for chat/Gemini tool messages (which are text-only). After
 * the vision sidecar runs, images are already text; this is the fallback for an undescribed image
 * (vision model via view_image): a short marker, never the token-exploding image_url.
 */
export function contentPartsToText(content: string | OcxContentPart[]): string {
  if (typeof content === "string") return content;
  const text = content.map(p => p.type === "text" ? p.text : p.type === "image" ? "[image]" : "[video]").join("");
  return text || "[image]";
}
