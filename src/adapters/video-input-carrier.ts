// Type-only: erased at compile time, so this does not create an import cycle with the registry.
import type { AdapterWire } from "./registry";
import { geminiFetchableVideoUri, GEMINI_UNFETCHABLE_VIDEO_MESSAGE } from "./google-video-uri";
import { untranslatedInputMediaMessage } from "../responses/input-media";
import {
  inlineVideoDecodedBytes,
  MAX_INLINE_VIDEO_BYTES,
  OVERSIZED_INLINE_VIDEO_MESSAGE,
  videoParts,
} from "../responses/video-input";
import { modelRecordValue } from "../reasoning-effort";
import type { OcxParsedRequest, OcxProviderConfig } from "../types";

/**
 * Whether the routed wire has a published carrier for every video the request holds.
 *
 * Video is the one input kind whose carrier depends on the MODEL, not only the wire. Gemini's
 * generateContent takes it on every model (inline_data, or file_data for YouTube and Files API
 * URIs). The Chat Completions `video_url` part is documented by OpenRouter, Qwen (DashScope
 * OpenAI-compatible) and Kimi, but a Chat wire in general — xAI's Grok chat models included,
 * which xAI documents as text and image input only — has none, so the translated Chat adapter
 * carries video only for a model that declares it. Every other wire refuses.
 *
 * Before this check the translated Chat, Anthropic and Cursor wires replaced the clip with a
 * text marker, and Gemini flattened an arbitrary remote URL to one, and the request still went
 * upstream and came back as an ordinary answer about a video the model never saw.
 */
export function unrepresentableVideo(
  parsed: OcxParsedRequest,
  wire: AdapterWire,
  provider: OcxProviderConfig | undefined,
): string | undefined {
  const videos = videoParts(parsed.context.messages);
  if (videos.length === 0) return undefined;
  for (const { part } of videos) {
    const bytes = inlineVideoDecodedBytes(part.videoUrl);
    if (bytes !== undefined && bytes > MAX_INLINE_VIDEO_BYTES) return OVERSIZED_INLINE_VIDEO_MESSAGE;
  }
  if (wire === "google") {
    const unfetchable = videos.some(({ part }) => !part.videoUrl.startsWith("data:") && !geminiFetchableVideoUri(part.videoUrl));
    return unfetchable ? GEMINI_UNFETCHABLE_VIDEO_MESSAGE : undefined;
  }
  // `provider.adapter`, not the effective wire: adapters that inherit the Chat contract rebuild
  // messages with their own builders, and only the translated Chat builder emits `video_url`.
  if (wire === "openai-chat" && provider?.adapter === "openai-chat") {
    // Developer content becomes instruction text on this wire; only a user message carries media.
    if (videos.some(({ role }) => role !== "user")) return untranslatedInputMediaMessage("video");
    return modelDeclaresVideoInput(provider, parsed.modelId) ? undefined : UNDECLARED_CHAT_VIDEO_MESSAGE;
  }
  return untranslatedInputMediaMessage("video");
}

/** Fixed vocabulary only: never the model id, URL or bytes. */
export const UNDECLARED_CHAT_VIDEO_MESSAGE = "OpenCodex cannot send video input to this model: no video input is declared for it. "
  + "Add \"video\" to the model's modelCapabilities inputModalities when its provider accepts Chat video_url parts, "
  + "or route the request to a video-capable model.";

/**
 * The model's declared input modalities, in the precedence the image path uses: the exact
 * `modelCapabilities` entry, the per-model map (registry seed beneath operator entries), then
 * the provider-wide list. Absent evidence is not video support.
 */
export function modelDeclaresVideoInput(
  provider: Pick<OcxProviderConfig, "modelCapabilities" | "modelInputModalities" | "inputModalities">,
  modelId: string,
): boolean {
  const declared = Object.hasOwn(provider.modelCapabilities ?? {}, modelId)
    ? provider.modelCapabilities?.[modelId]?.inputModalities
    : undefined;
  const modalities = declared ?? modelRecordValue(provider.modelInputModalities, modelId) ?? provider.inputModalities;
  return Array.isArray(modalities) && modalities.includes("video");
}
