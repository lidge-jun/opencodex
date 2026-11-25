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
 * Decoded size of a base64 `data:` URL, computed from its length; undefined for anything else.
 * Nothing is decoded or copied.
 */
export function inlineVideoDecodedBytes(videoUrl: string): number | undefined {
  if (!videoUrl.startsWith("data:")) return undefined;
  const comma = videoUrl.indexOf(",");
  if (comma < 0) return undefined;
  const payload = videoUrl.length - comma - 1;
  if (payload <= 0) return 0;
  let padding = 0;
  if (videoUrl.endsWith("==")) padding = 2;
  else if (videoUrl.endsWith("=")) padding = 1;
  return Math.max(0, Math.floor((payload * 3) / 4) - padding);
}

/** Fixed vocabulary only: the refusal never names the clip, its URL or its bytes. */
export const OVERSIZED_INLINE_VIDEO_MESSAGE = "OpenCodex refuses inline video larger than 50 MiB. "
  + "Upload the video to the provider's file storage and send its URL instead.";

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

