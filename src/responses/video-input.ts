import type { OcxContentPart, OcxMessage } from "../types";

/**
 * Largest inline video, in decoded bytes, that OpenCodex forwards to any wire.
 *
 * 50 MiB is the strictest inline limit a mapped carrier publishes: Qwen's OpenAI-compatible
 * API caps a base64 video string at 50 MiB (Alibaba Cloud Model Studio "vision" guide, updated
 * 2026-11-24), and Gemini recommends its Files API above a 20 MB request and documents inline
 * data under 100 MB (Gemini video-understanding guide). A larger clip belongs in the provider's
 * file storage, referenced by URL, and every copy the translation makes of a base64 string this
 * size is a request-sized allocation, so the proxy refuses it before the adapter runs.
 */
export const MAX_INLINE_VIDEO_BYTES = 50 * 1024 * 1024;

/**
 * Decoded size of a `data:` URL, computed from its length; undefined for anything else.
 * Nothing is decoded or copied. A base64 payload decodes to three bytes per four characters;
 * any other payload (percent-encoded or plain) is charged its UTF-8 length, the most it can put
 * on the wire, so neither a non-base64 spelling nor non-ASCII text can slip under the cap.
 */
export function inlineVideoDecodedBytes(videoUrl: string): number | undefined {
  if (!videoUrl.startsWith("data:")) return undefined;
  const comma = videoUrl.indexOf(",");
  // A `data:` URL with no payload separator carries nothing a wire could send; charge its length.
  if (comma < 0) return Buffer.byteLength(videoUrl, "utf8");
  const payload = videoUrl.length - comma - 1;
  if (payload <= 0) return 0;
  const base64 = videoUrl.slice(5, comma).split(";").slice(1).some(parameter => parameter.trim().toLowerCase() === "base64");
  // Measured over the whole URL so the payload is never sliced into a copy; the header is short.
  if (!base64) return Buffer.byteLength(videoUrl, "utf8") - Buffer.byteLength(videoUrl.slice(0, comma + 1), "utf8");
  let padding = 0;
  if (videoUrl.endsWith("==")) padding = 2;
  else if (videoUrl.endsWith("=")) padding = 1;
  return Math.max(0, Math.floor((payload * 3) / 4) - padding);
}

/** Fixed vocabulary only: the refusal never names the clip, its URL or its bytes. */
export const OVERSIZED_INLINE_VIDEO_MESSAGE = "OpenCodex refuses inline video larger than 50 MiB. "
  + "Upload the video to the provider's file storage and send its URL instead.";

/**
 * Whether a Chat Completions body carries a `video_url` part over the inline cap, in any message.
 *
 * Both Chat conversions (the projection onto the Responses core and the direct IR lane) run this
 * before they build or serialize anything, so an oversized clip is refused before translation
 * makes request-sized copies of it. Only typed content parts are read; nothing is decoded.
 */
export function chatBodyHasOversizedInlineVideo(body: unknown): boolean {
  if (!isRecord(body) || !Array.isArray(body.messages)) return false;
  for (const message of body.messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isRecord(part) || part.type !== "video_url") continue;
      const url = typeof part.video_url === "string" ? part.video_url
        : isRecord(part.video_url) && typeof part.video_url.url === "string" ? part.video_url.url : undefined;
      const bytes = url === undefined ? undefined : inlineVideoDecodedBytes(url);
      if (bytes !== undefined && bytes > MAX_INLINE_VIDEO_BYTES) return true;
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Every video part the normalized request carries, with the role of the message holding it. */
export function videoParts(messages: readonly OcxMessage[]): Array<{ role: OcxMessage["role"]; part: Extract<OcxContentPart, { type: "video" }> }> {
  const found: Array<{ role: OcxMessage["role"]; part: Extract<OcxContentPart, { type: "video" }> }> = [];
  for (const message of messages) {
    const content: unknown = message.content;
    if (!Array.isArray(content)) continue;
    for (const part of content as ReadonlyArray<{ type: string }>) {
      if (part.type === "video") found.push({ role: message.role, part: part as Extract<OcxContentPart, { type: "video" }> });
    }
  }
  return found;
}
