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

/**
 * Keep the newest images a first-party Mistral request may carry and replace older ones with a
 * text note, across every message (promoted tool-result images included). Normalizes the outbound
 * copy only: messages that change are copied, so history and other destinations stay intact.
 */
export function limitMistralChatImages(messages: unknown, provider: OcxProviderConfig, modelId: string): unknown {
  if (!isMistralChatTarget(provider) || !Array.isArray(messages)) return messages;
  const maxImages = mistralMaxImages(provider, modelId);
  const images: Array<{ message: number; part: number }> = [];
  messages.forEach((message, index) => {
    if (!isRecord(message) || !Array.isArray(message.content)) return;
    message.content.forEach((part, partIndex) => {
      if (isRecord(part) && part.type === "image_url") images.push({ message: index, part: partIndex });
    });
  });
  const excess = images.length - maxImages;
  if (excess <= 0) return messages;
  const note = { type: "text", text: `[image omitted: Mistral accepts at most ${maxImages} images per request for this model; older images were dropped]` };
  const out = [...messages];
  for (const { message, part } of images.slice(0, excess)) {
    const original = messages[message] as Record<string, unknown>;
    if (out[message] === original) out[message] = { ...original, content: [...(original.content as unknown[])] };
    ((out[message] as Record<string, unknown>).content as unknown[])[part] = note;
  }
  return out;
}
