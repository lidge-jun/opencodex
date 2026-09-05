import type { OcxContentPart, OcxTextContent } from "../types";

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

type InputBlock =
  | { type: "input_text"; text: string }
  | { type: "text"; text: string }
  | { type: "input_image"; image_url?: string; file_id?: string; detail?: string }
  | { type: "input_video"; video_url?: string }
  | { type: "input_file"; file_id?: string; filename?: string; file_data?: string };

/** A usable reference string, or undefined. Empty strings and non-strings are not references. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function inputContentParts(blocks: unknown): string | OcxContentPart[] {
  if (typeof blocks === "string") return blocks;
  // The catch-all can also hand back a non-array `content` (an object, a number), which would
  // throw at the loop below before any per-block guard runs.
  if (!Array.isArray(blocks)) return [];
  const parts: OcxContentPart[] = [];
  for (const raw of blocks) {
    // A malformed message item fails its strict schema and falls through to inputItemSchema's
    // permissive catch-all, so blocks reaching here are NOT guaranteed to match the declared
    // shape. Validate each field before use, as outputToToolResultContent already does.
    if (!isObj(raw)) continue;
    const block = raw as InputBlock;
    if (block.type === "input_text" || block.type === "text") {
      if (typeof raw.text === "string") parts.push({ type: "text", text: raw.text });
    } else if (block.type === "input_image") {
      const b = block as { image_url?: string; file_id?: string; detail?: string };
      const imageUrl = nonEmptyString(b.image_url);
      const fileId = nonEmptyString(b.file_id);
      const detail = nonEmptyString(b.detail);
      if (imageUrl) {
        // Preserve the image as a structured part — adapters send it as a native image block.
        // NEVER inline the (often base64 data-URL) image_url as text: that explodes the token count.
        parts.push({ type: "image", imageUrl, ...(detail ? { detail: normalizeImageDetail(detail) } : {}) });
      } else if (fileId) {
        parts.push({ type: "text", text: `[image: ${fileId}]` }); // file_id ref → no inline data
      }
      // No usable reference: omit the block. A "[image: ?]" marker would claim an attachment
      // the request never carried, which is worse than dropping malformed input.
    } else if (block.type === "input_video") {
      const videoUrl = nonEmptyString(block.video_url);
      if (videoUrl) parts.push({ type: "video", videoUrl });
    } else if (block.type === "input_file") {
      const b = block as { file_id?: string; filename?: string; file_data?: string };
      const fileId = nonEmptyString(b.file_id);
      const fileData = nonEmptyString(b.file_data);
      const filename = nonEmptyString(b.filename);
      if (fileId) {
        parts.push({ type: "text", text: `[file: ${fileId}]` });
      } else if (fileData) {
        // Inline file_data is often large base64. Preserve only its presence and name, never bytes.
        parts.push({ type: "text", text: filename ? `[file: ${filename}]` : "[file: inline data]" });
      }
      // A bare filename is not a file resource in the Responses schema, so omit it rather than
      // fabricating a "[file: ...]" marker for an attachment that was never sent.
    }
  }
  // Collapse to a plain string only for a single TEXT part; images must stay structured.
  if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
  return parts;
}

type OutputBlock = { type: "output_text"; text: string } | { type: "text"; text: string } | { type: "refusal"; refusal: string };

export function outputTextOf(blocks: unknown): OcxTextContent[] {
  if (typeof blocks === "string") return blocks.length > 0 ? [{ type: "text", text: blocks }] : [];
  if (!Array.isArray(blocks)) return [];
  const out: OcxTextContent[] = [];
  for (const raw of blocks) {
    // Same catch-all caveat as inputContentParts: validate before use.
    if (!isObj(raw)) continue;
    const b = raw as OutputBlock;
    if (b.type === "output_text" || b.type === "text") {
      if (typeof raw.text === "string") out.push({ type: "text", text: raw.text });
    } else if (b.type === "refusal") {
      if (typeof raw.refusal === "string") out.push({ type: "text", text: `[refusal: ${raw.refusal}]` });
    }
  }
  return out;
}

/**
 * Tool-call output content. Preserves images (e.g. Codex `view_image` returns
 * `input_image` items): returns content parts when any image is present, else a plain joined string.
 * Never inlines an image_url as text (that would explode the token count).
 */
export function outputToToolResultContent(output: string | unknown[] | undefined): string | OcxContentPart[] {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return "";
  const parts: OcxContentPart[] = [];
  let hasImage = false;
  for (const raw of output) {
    if (!isObj(raw)) continue;
    if (raw.type === "output_text" || raw.type === "text" || raw.type === "input_text") {
      if (typeof raw.text === "string") parts.push({ type: "text", text: raw.text });
    } else if (raw.type === "refusal" && typeof raw.refusal === "string") {
      parts.push({ type: "text", text: `[refusal: ${raw.refusal}]` });
    } else if (raw.type === "input_image") {
      const imageUrl = nonEmptyString(raw.image_url);
      const fileId = nonEmptyString(raw.file_id);
      if (imageUrl) {
        parts.push({ type: "image", imageUrl, ...(typeof raw.detail === "string" ? { detail: normalizeImageDetail(raw.detail) } : {}) });
        hasImage = true;
      } else if (fileId) {
        parts.push({ type: "text", text: `[image: ${fileId}]` });
      }
    } else if (raw.type === "encrypted_content") {
      // codex-rs FunctionCallOutputContentItem::EncryptedContent — opaque to routed models.
      parts.push({ type: "text", text: "[encrypted content omitted]" });
    }
  }
  if (!hasImage) return parts.map(p => (p.type === "text" ? p.text : "")).join("");
  return parts;
}

export function toolOutputContainsEncryptedContent(output: string | unknown[] | undefined): boolean {
  return Array.isArray(output) && output.some(raw => isObj(raw) && raw.type === "encrypted_content");
}

/**
 * codex-rs ImageDetail allows "original", but chat-completions providers only accept
 * auto|low|high on image_url.detail — degrade "original" to "high" (the codex default).
 */
function normalizeImageDetail(detail: string): string {
  return detail === "original" ? "high" : detail;
}
