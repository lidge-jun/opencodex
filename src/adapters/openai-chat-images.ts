import { parseDataUrl } from "./image";
import {
  normalizeImageTargets,
  type NormalizeOptions,
  type NormalizeTarget,
} from "./anthropic-image-normalize";

/**
 * Best-effort base64 image budget for translated Chat requests. This leaves room for
 * other request fields but is not a guarantee that the complete body fits an upstream
 * limit. Remote URLs are never fetched by request construction.
 */
export const OPENAI_CHAT_IMAGE_BASE64_BUDGET = 3_670_016; // 3.5MiB

export interface NormalizeOpenAIChatImagesOptions
  extends Pick<NormalizeOptions, "encode" | "tierBias" | "validate"> {}

/** Whether `value` is a plain object, so message and part shapes can be walked safely. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Walk every well-formed `image_url` part in a Chat Completions message array, ignoring
 * malformed shapes rather than throwing on them. Returning false from `visit` stops the walk.
 */
function forEachImagePart(
  messages: unknown,
  visit: (imageUrl: Record<string, unknown>, url: string) => boolean | void,
): void {
  if (!Array.isArray(messages)) return;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isRecord(part) || part.type !== "image_url" || !isRecord(part.image_url)) continue;
      const imageUrl = part.image_url;
      if (typeof imageUrl.url !== "string") continue;
      if (visit(imageUrl, imageUrl.url) === false) return;
    }
  }
}

/**
 * Whether this turn carries inline image bytes worth normalizing. The adapter uses this
 * to stay synchronous for text-only turns, which is every turn on most providers.
 */
export function hasShrinkableOpenAIChatImages(messages: unknown): boolean {
  let total = 0;
  let found = false;
  forEachImagePart(messages, (_imageUrl, url) => {
    const source = parseDataUrl(url);
    if (!source) return;
    total += source.base64.length;
    if (total > OPENAI_CHAT_IMAGE_BASE64_BUDGET) {
      found = true;
      return false;
    }
  });
  return found;
}

/**
 * Normalize image_url parts in already-built Chat Completions messages, in place.
 *
 * The drop callback deliberately keeps the original URL. The shared normalizer calls
 * drop for corrupt or decode-bomb inputs, and this wire has no downstream guard that
 * would re-attach a dropped image, so dropping here would silently lose a user's
 * screenshot. Terminal-size overflow uses overflowAction "none" for the same reason:
 * an image floored at 320px stays attached rather than being removed.
 */
export async function normalizeOpenAIChatImages(
  messages: unknown,
  options: NormalizeOpenAIChatImagesOptions = {},
): Promise<void> {
  const targets: NormalizeTarget[] = [];
  forEachImagePart(messages, (imageUrl, url) => {
    const source = parseDataUrl(url);
    if (!source) return;
    targets.push({
      base64: source.base64,
      mediaType: source.mediaType,
      replace: (data: string, mediaType: string) => {
        imageUrl.url = `data:${mediaType};base64,${data}`;
      },
      drop: () => {
        // Preserve the original image URL when it cannot be normalized.
      },
      // The drop above is a no-op, so these bytes are still on the wire and must keep
      // counting against the budget. Without this the core would stop counting them and
      // the demotion loop could stop early, shipping a body that is still oversized.
      retainsBytesOnDrop: true,
    });
  });
  if (targets.length === 0) return;

  await normalizeImageTargets(targets, {
    budget: OPENAI_CHAT_IMAGE_BASE64_BUDGET,
    overflowAction: "none",
    ...options,
  });
}
