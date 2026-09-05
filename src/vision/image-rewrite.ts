import type { OcxContentPart, OcxParsedRequest, OcxTextContent } from "../types";
import type { TranslatorBudget } from "../lib/translator-budget";

export const descriptionEncoder = new TextEncoder();

/** A user/developer/toolResult message can carry images (toolResult: e.g. Codex view_image output). */
export function carriesImages(role: string): boolean {
  return role === "user" || role === "developer" || role === "toolResult";
}


const IMAGE_OMITTED_TEXT = "[image omitted: this model is text-only and the vision sidecar is unavailable (no ChatGPT login)]";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keep the native Responses passthrough body aligned with image replacements made in the parsed
 * message graph. The passthrough adapter serializes `_rawBody`, while translated adapters serialize
 * `context.messages`; updating only the latter would send the original pixels to a text-only
 * Responses upstream even after the vision sidecar produced a caption.
 *
 * Rewrites only image-bearing user/developer messages and tool outputs. All other native Responses
 * items (reasoning, calls, ids, compaction, and provider-specific metadata) remain byte-structurally
 * untouched.
 */
export function syncRawBodyImageDescriptions(parsed: OcxParsedRequest, descriptions: readonly string[]): void {
  const rawBody = parsed._rawBody;
  if (!isPlainRecord(rawBody) || !Array.isArray(rawBody.input)) return;

  let nextDescription = 0;
  const rewriteImages = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      let changed = false;
      const rewritten = value.map(entry => {
        const next = rewriteImages(entry);
        if (next !== entry) changed = true;
        return next;
      });
      return changed ? rewritten : value;
    }
    if (!isPlainRecord(value)) return value;
    if (value.type === "input_image" && typeof value.image_url === "string") {
      // Both message and tool-output parsers exclude empty URLs from caption jobs.
      if (value.image_url.length === 0) {
        const fileId = typeof value.file_id === "string" && value.file_id.length > 0 ? value.file_id : undefined;
        return { type: "input_text", text: fileId ? `[image: ${fileId}]` : IMAGE_OMITTED_TEXT };
      }
      const description = descriptions[nextDescription++];
      return { type: "input_text", text: description ?? IMAGE_OMITTED_TEXT };
    }
    return value;
  };

  let changed = false;
  const input = rawBody.input.map(item => {
    if (!isPlainRecord(item)) return item;
    const type = typeof item.type === "string" ? item.type : (typeof item.role === "string" ? "message" : "");
    const role = typeof item.role === "string" ? item.role : "";
    const isMessageContent = (
      (type === "message" && (role === "user" || role === "developer"))
      || type === "agent_message"
    );
    const field = isMessageContent
      ? "content"
      : (type === "function_call_output" || type === "custom_tool_call_output")
        ? "output"
        : undefined;
    if (!field) return item;
    const rewritten = rewriteImages(item[field]);
    if (rewritten === item[field]) return item;
    changed = true;
    return { ...item, [field]: rewritten };
  });

  if (changed) rawBody.input = input;
}

/**
 * Fail-closed image strip for sidecar-covered models when NO sidecar plan exists (no forward
 * provider / missing forwarded auth / sidecar disabled): the upstream is text-only, so forwarding
 * raw images would 400 or silently confuse it. Replace each image with an explicit marker so the
 * model (and the user, via its reply) knows the image was dropped rather than ignored.
 */
export function stripImagesInPlace(parsed: OcxParsedRequest, translatorBudget?: TranslatorBudget): boolean {
  let stripped = false;
  const descriptions: string[] = [];
  for (const msg of parsed.context.messages) {
    if (!carriesImages(msg.role) || !Array.isArray(msg.content)) continue;
    const parts = msg.content as OcxContentPart[];
    if (!parts.some(p => p.type === "image")) continue;
    msg.content = parts.map(p => {
      if (p.type !== "image") return p;
      const replacement = { type: "text", text: IMAGE_OMITTED_TEXT } as OcxContentPart;
      descriptions.push((replacement as OcxTextContent).text);
      const reservation = translatorBudget?.reserveTransient(
        descriptionEncoder.encode((replacement as OcxTextContent).text).byteLength,
        { kind: "request_copies" },
      );
      reservation?.commitRetained();
      return replacement;
    });
    stripped = true;
  }
  syncRawBodyImageDescriptions(parsed, descriptions);
  return stripped;
}
