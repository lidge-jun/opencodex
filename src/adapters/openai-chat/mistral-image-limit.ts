import type { OcxProviderConfig } from "../../types";
import { declaredModelCapabilities, mergeReasoningModelCapabilities } from "../../providers/reasoning-capabilities";
import { registryEntryForProviderDestination } from "../../providers/registry";
import { isMistralChatTarget } from "./wire";

/**
 * Mistral counts every image in the replayed history against a per-request cap. Its vision guide
 * (https://docs.mistral.ai/capabilities/vision/) documents 8, and most vision models refuse a ninth
 * with HTTP 400 ("Total number of images exceeds the maximum allowed of 8"). Models that accept more
 * declare `modelCapabilities.<id>.mistralMaxImages`: the registry row carries measured caps, matched
 * by destination so a renamed Mistral row keeps them, and an operator declaration outranks it.
 */
export const MISTRAL_DEFAULT_MAX_IMAGES = 8;

/** The images one Chat request may carry for this model at this destination. */
export function mistralMaxImages(provider: OcxProviderConfig, modelId: string): number {
  const rows = mergeReasoningModelCapabilities(registryEntryForProviderDestination(provider)?.modelCapabilities, provider.modelCapabilities);
  return declaredModelCapabilities(rows, modelId)?.mistralMaxImages ?? MISTRAL_DEFAULT_MAX_IMAGES;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Checks for a nonempty image URL string in either supported shape, not URL syntax or reachability. */
function hasUsableImageUrl(part: Record<string, unknown>): boolean {
  if (part.type !== "image_url") return false;
  const imageUrl = part.image_url;
  return (typeof imageUrl === "string" && imageUrl.length > 0)
    || (isRecord(imageUrl) && typeof imageUrl.url === "string" && imageUrl.url.length > 0);
}

/**
 * Keep the newest images a first-party Mistral request may carry and replace older ones with a
 * text note, across every message (promoted tool-result images included). Normalizes the outbound
 * copy only: messages that change are copied, so history and other destinations stay intact.
 */
export function limitMistralChatImages(messages: unknown, provider: OcxProviderConfig, modelId: string): unknown {
  if (!isMistralChatTarget(provider) || !Array.isArray(messages)) return messages;
  const maxImages = mistralMaxImages(provider, modelId);
  const note = { type: "text", text: `[image omitted: Mistral accepts at most ${maxImages} images per request for this model; older images were dropped]` };
  const missingNote = { type: "text", text: "[image omitted: missing or malformed image URL]" };
  let imagesKept = 0;
  let out: unknown[] | undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    const content = message.content;
    let nextContent: unknown[] | undefined;
    for (let partIndex = content.length - 1; partIndex >= 0; partIndex--) {
      const part = content[partIndex];
      if (!isRecord(part) || part.type !== "image_url") continue;
      const usable = hasUsableImageUrl(part);
      if (usable && imagesKept++ < maxImages) continue;
      nextContent ??= content.slice();
      nextContent[partIndex] = usable ? note : missingNote;
    }
    if (!nextContent) continue;
    out ??= messages.slice();
    out[index] = { ...message, content: nextContent };
  }
  return out ?? messages;
}
