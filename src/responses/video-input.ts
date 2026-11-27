import { parseMediaDataUrl, type ParsedMediaDataUrl } from "../lib/media-data-url";
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

/** Fixed vocabulary only: the refusal never names the clip, its URL or its bytes. */
export const OVERSIZED_INLINE_VIDEO_MESSAGE = "OpenCodex refuses inline video larger than 50 MiB. "
  + "Upload the video to the provider's file storage and send its URL instead.";

/**
 * Fixed vocabulary only. The one accepted inline form is the canonical base64 data URL that
 * `parseMediaDataUrl` (src/lib/media-data-url.ts) defines.
 */
export const VIDEO_DATA_URL_FORM_MESSAGE = "OpenCodex cannot send this inline video: it must be a data:<type>/<subtype>;base64, URL "
  + "whose payload is standard padded base64 with no URL escapes or whitespace.";

/**
 * An inline video URL through the shared decoder, capped at `MAX_INLINE_VIDEO_BYTES`. Admission,
 * the input guard, both Chat conversions and the Gemini and translated-Chat builders all read
 * video data URLs through this one call, so none of them can accept what another refuses.
 */
export function parseInlineVideo(url: string): ParsedMediaDataUrl {
  return parseMediaDataUrl(url, { maxBytes: MAX_INLINE_VIDEO_BYTES });
}

/** The fixed refusal for an inline video the decoder rejects; undefined for a remote URL or an accepted one. */
export function inlineVideoRefusal(url: string): string | undefined {
  const parsed = parseInlineVideo(url);
  if (parsed.ok || parsed.reason === "not_data_url") return undefined;
  return parsed.reason === "too_large" ? OVERSIZED_INLINE_VIDEO_MESSAGE : VIDEO_DATA_URL_FORM_MESSAGE;
}

/**
 * The refusal for the first Chat Completions `video_url` part the decoder rejects, in any message.
 *
 * Both Chat conversions (the projection onto the Responses core and the direct IR lane) run this
 * before they build or serialize anything, so a refused clip is never copied by translation. Only
 * typed content parts are read; the size cap is applied from the payload length before any scan.
 */
export function chatBodyVideoRefusal(body: unknown): string | undefined {
  if (!isRecord(body) || !Array.isArray(body.messages)) return undefined;
  for (const message of body.messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isRecord(part) || part.type !== "video_url") continue;
      const url = typeof part.video_url === "string" ? part.video_url
        : isRecord(part.video_url) && typeof part.video_url.url === "string" ? part.video_url.url : undefined;
      const refusal = url === undefined ? undefined : inlineVideoRefusal(url);
      if (refusal) return refusal;
    }
  }
  return undefined;
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
