import { parseDataUrl } from "./image";
import { sniffImageDimensions } from "./anthropic-image-guard";
import { MAX_INPUT_PIXELS } from "./anthropic-image-codec";
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

/** Longest edge an undersized image may be stretched to while reaching the minimum edge. */
export const OPENAI_CHAT_UPSCALE_MAX_EDGE = 4096;

/** Resizes decoded image bytes to exactly `width` x `height` and returns base64 plus media type. */
export type UpscaleFn = (input: Buffer, width: number, height: number) => Promise<{ data: string; mediaType: string }>;

/** Default upscaler: Bun.Image resize, re-encoded as PNG so small text strips stay sharp. */
export const bunImageUpscale: UpscaleFn = async (input, width, height) => {
  const out = await new Bun.Image(input).resize(width, height).png().toBuffer();
  return { data: Buffer.from(out).toString("base64"), mediaType: "image/png" };
};

export interface NormalizeOpenAIChatImagesOptions
  extends Pick<NormalizeOptions, "encode" | "tierBias" | "validate"> {
  abortSignal?: AbortSignal;
}

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
 * Target size for an image whose short edge is below `minEdge`, or null when it already
 * fits or cannot be handled safely. Aspect ratio is kept; the long edge is clamped to
 * OPENAI_CHAT_UPSCALE_MAX_EDGE, which only distorts extreme strips.
 */
export function upscaledImageSize(width: number, height: number, minEdge: number): { width: number; height: number } | null {
  if (!(width > 0 && height > 0) || Math.min(width, height) >= minEdge) return null;
  if (width * height > MAX_INPUT_PIXELS) return null;
  const scale = minEdge / Math.min(width, height);
  const clamp = (edge: number): number => Math.min(OPENAI_CHAT_UPSCALE_MAX_EDGE, Math.max(minEdge, Math.ceil(edge * scale)));
  return { width: clamp(width), height: clamp(height) };
}

/** Whether any inline image has a sniffable short edge below `minEdge`. */
export function hasUndersizedOpenAIChatImages(messages: unknown, minEdge: number): boolean {
  let found = false;
  forEachImagePart(messages, (_imageUrl, url) => {
    const source = parseDataUrl(url);
    const dims = source ? sniffImageDimensions(source.base64) : null;
    if (dims && upscaledImageSize(dims.width, dims.height, minEdge)) {
      found = true;
      return false;
    }
  });
  return found;
}

/**
 * Upscale inline images below `minEdge` in already-built Chat Completions messages, in place.
 * Runs after budget normalization, because that step can itself floor a wide screenshot
 * under the minimum. An image that cannot be decoded keeps its original URL.
 */
export async function upscaleUndersizedOpenAIChatImages(
  messages: unknown,
  minEdge: number,
  options: { upscale?: UpscaleFn; abortSignal?: AbortSignal } = {},
): Promise<void> {
  const upscale = options.upscale ?? bunImageUpscale;
  const jobs: Array<{ imageUrl: Record<string, unknown>; base64: string; width: number; height: number }> = [];
  forEachImagePart(messages, (imageUrl, url) => {
    const source = parseDataUrl(url);
    const dims = source ? sniffImageDimensions(source.base64) : null;
    const target = dims ? upscaledImageSize(dims.width, dims.height, minEdge) : null;
    if (source && target) jobs.push({ imageUrl, base64: source.base64, ...target });
  });
  for (const job of jobs) {
    if (options.abortSignal?.aborted) throw options.abortSignal.reason ?? new DOMException("Aborted", "AbortError");
    try {
      const out = await upscale(Buffer.from(job.base64, "base64"), job.width, job.height);
      job.imageUrl.url = `data:${out.mediaType};base64,${out.data}`;
    } catch {
      // Keep the original image; the upstream reports its own validation error.
    }
  }
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
