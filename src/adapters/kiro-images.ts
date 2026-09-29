import type { OcxContentPart } from "../types";
import { normalizeImageTargets, type NormalizeOptions, type NormalizeTarget } from "./anthropic-image-normalize";
import { MAX_INPUT_BASE64_LENGTH, MAX_INPUT_PIXELS } from "./anthropic-image-codec";
import { sniffImageDimensions } from "./anthropic-image-guard";

// CodeWhisperer native image part (matches Kiro IDE wire format): the base64 bytes live directly in
// userInputMessage.images, NOT in userInputMessageContext. Verified against kiro-gateway.
export interface KiroImage {
  format: string; // "jpeg" | "png" | "webp" | "gif" — derived from the media subtype
  source: { bytes: string }; // pure base64, no "data:...;base64," prefix
}

/** Parse inline image bytes; remote URLs are not fetched at request-build time. */
function parseDataUrlImage(imageUrl: string): KiroImage | undefined {
  if (!imageUrl.startsWith("data:")) return undefined;
  const comma = imageUrl.indexOf(",");
  if (comma === -1) return undefined;
  const header = imageUrl.slice(5, comma);
  const bytes = imageUrl.slice(comma + 1);
  if (!bytes) return undefined;
  const mediaType = header.split(";")[0] || "image/jpeg";
  const subtype = (mediaType.includes("/") ? mediaType.split("/")[1] : mediaType) || "jpeg";
  // CodeWhisperer/Bedrock expects "jpeg", not the "jpg" alias.
  const format = subtype.toLowerCase() === "jpg" ? "jpeg" : subtype.toLowerCase();
  return { format, source: { bytes } };
}

export function extractKiroImages(content: string | OcxContentPart[]): KiroImage[] {
  if (typeof content === "string") return [];
  const out: KiroImage[] = [];
  for (const p of content) {
    if (p.type !== "image") continue;
    const img = parseDataUrlImage(p.imageUrl);
    if (img) out.push(img);
  }
  return out;
}

/**
 * Count images Kiro cannot inline, so the loss is never silent.
 *
 * Kiro's wire carries base64 bytes only, so a remote reference genuinely cannot be
 * sent, and this proxy does not fetch one on a request path. Such a part used to be
 * dropped with neither bytes nor any trace that an attachment existed. Counting them
 * lets the payload builder attach a bounded marker instead.
 *
 * The count is all that crosses: a remote image URL can carry a signed token, so the
 * URL itself is never echoed into prose.
 */
export function countKiroUninlinableImages(content: string | OcxContentPart[]): number {
  if (typeof content === "string") return 0;
  let count = 0;
  for (const p of content) {
    if (p.type !== "image") continue;
    // Keyed on the scheme, not on parse success: a malformed data URL also fails
    // parseDataUrlImage, and labelling that "remote reference" would misstate the cause.
    if (!p.imageUrl.startsWith("data:")) count++;
  }
  return count;
}

/** Bounded, content-free marker for images Kiro could not inline. */
export function kiroUninlinableImageMarker(count: number): string {
  if (count <= 0) return "";
  if (count === 1) return "[image omitted: remote image references are not supported by this provider]";
  return "[" + String(count) + " images omitted: remote image references are not supported by this provider]";
}

/** Report malformed inline references separately from remote URLs. */
export function kiroImageOmissionMarker(content: string | OcxContentPart[]): string {
  if (typeof content === "string") return "";
  const remote = kiroUninlinableImageMarker(countKiroUninlinableImages(content));
  let malformed = 0;
  for (const part of content) {
    if (part.type === "image" && part.imageUrl.startsWith("data:") && !parseDataUrlImage(part.imageUrl)) malformed++;
  }
  const inline = malformed === 1
    ? "[image omitted: malformed inline image data URL]"
    : malformed > 1 ? `[${malformed} images omitted: malformed inline image data URLs]` : "";
  return [remote, inline].filter(Boolean).join("\n");
}

/**
 * Conservative POLICY caps for the CodeWhisperer GenerateAssistantResponse payload.
 * The 100-image request cap comes from Kiro's IMAGE_COUNT_EXCEEDED error
 * ("101 exceeds limit 100"); the per-message and byte limits are undocumented
 * and derived from adjacent AWS surfaces
 * (devlog/260714_image_normalization_pipeline/050): Bedrock `Message` allows 20 images
 * per message (Converse), and `InvokeModel` caps requests at 25,000,000 bytes — 18MiB
 * bounds the IMAGE share of the body with headroom for text/tools.
 */
export const KIRO_IMAGE_BASE64_BUDGET = 18 * 1024 * 1024;
export const KIRO_MAX_IMAGES_PER_MESSAGE = 20;
export const KIRO_MAX_IMAGES_PER_REQUEST = 100;

const COUNT_CAP_NOTE = "[image omitted: exceeded the 20-image per-message cap; oldest images in this message were dropped]";
const REQUEST_CAP_NOTE = "[images omitted: exceeded the 100-image request cap; oldest images in this message were dropped]";
const REQUEST_CAP_EMPTY_NOTE = "[images omitted: exceeded the 100-image request cap; no images remain in this message]";

/** A kiro wire message that can carry images (history userInputMessage or currentMessage). */
interface KiroImageCarrier {
  content?: string;
  images?: KiroImage[];
}

function isCarrier(v: unknown): v is KiroImageCarrier {
  return typeof v === "object" && v !== null;
}

/** Collect image-bearing userInputMessages in wire order (history oldest-first, then current). */
function collectKiroImageCarriers(payload: unknown): KiroImageCarrier[] {
  const state = (payload as { conversationState?: { history?: unknown[]; currentMessage?: { userInputMessage?: unknown } } })?.conversationState;
  if (!state) return [];
  const carriers: KiroImageCarrier[] = [];
  for (const entry of state.history ?? []) {
    const uim = (entry as { userInputMessage?: unknown })?.userInputMessage;
    if (isCarrier(uim)) carriers.push(uim);
  }
  const current = state.currentMessage?.userInputMessage;
  if (isCarrier(current)) carriers.push(current);
  return carriers;
}

function appendNote(carrier: KiroImageCarrier, note: string): void {
  carrier.content = carrier.content ? `${carrier.content}\n${note}` : note;
}

/** Cheap structural check (no decode or encode) for the request-wide count. */
function countsTowardRequestCap(image: KiroImage): boolean {
  const b64 = typeof image.source?.bytes === "string" ? image.source.bytes : "";
  if (b64.length === 0 || b64.length > MAX_INPUT_BASE64_LENGTH) return false;
  const dims = sniffImageDimensions(b64);
  return dims !== null && dims.width * dims.height <= MAX_INPUT_PIXELS;
}

/**
 * Apply the generous image pipeline to a built CodeWhisperer payload (mutates in
 * place): per-message 20-image cap, then the 100-image request cap over
 * structurally usable images (oldest dropped), then the shared tier machinery
 * with the kiro budget and terminal-overflow DROP (kiro has no downstream guard).
 * Test seams (encode/validate) forward into the core.
 */
export async function normalizeKiroImages(
  payload: unknown,
  opts?: Pick<NormalizeOptions, "encode" | "validate">,
): Promise<void> {
  const carriers = collectKiroImageCarriers(payload);
  if (carriers.length === 0) return;

  // Pre-pass: per-message count cap (drop oldest within the message).
  for (const carrier of carriers) {
    const images = carrier.images;
    if (!images || images.length <= KIRO_MAX_IMAGES_PER_MESSAGE) continue;
    images.splice(0, images.length - KIRO_MAX_IMAGES_PER_MESSAGE);
    appendNote(carrier, COUNT_CAP_NOTE);
  }

  // Request count cap BEFORE the byte budget: a surplus image must not push survivors to
  // lower tiers, which #4532 then pins across turns. Only structurally usable images count
  // (bytes present, within the bomb limits, dimensions sniffable), so a corrupt image cannot
  // evict valid history; the normalizer below still drops it with its own marker. This stays
  // a cheap header check: truncated data that still sniffs as an image does count.
  let excess = carriers.reduce((count, carrier) => count + (carrier.images ?? []).filter(countsTowardRequestCap).length, 0)
    - KIRO_MAX_IMAGES_PER_REQUEST;
  for (const carrier of carriers) {
    if (excess <= 0) break;
    const images = carrier.images;
    if (!images?.length) continue;
    const kept: KiroImage[] = [];
    for (const image of images) {
      if (excess > 0 && countsTowardRequestCap(image)) excess--;
      else kept.push(image);
    }
    if (kept.length === images.length) continue;
    if (kept.length === 0) delete carrier.images;
    else carrier.images = kept;
    appendNote(carrier, kept.length === 0 ? REQUEST_CAP_EMPTY_NOTE : REQUEST_CAP_NOTE);
  }

  // Targets over the survivors, oldest→newest across carriers. Drops resolve the image
  // by OBJECT IDENTITY at execution time (indices go stale after earlier splices) and
  // delete an emptied images field per the builder's omission contract.
  const targets: NormalizeTarget[] = [];
  for (const carrier of carriers) {
    for (const img of carrier.images ?? []) {
      targets.push({
        base64: typeof img.source?.bytes === "string" && img.source.bytes.length > 0 ? img.source.bytes : null,
        mediaType: `image/${(img.format || "jpeg").toLowerCase()}`,
        replace: (data: string, mediaType: string) => {
          img.source.bytes = data;
          img.format = (mediaType.split("/")[1] ?? "jpeg").toLowerCase();
        },
        drop: (note: string) => {
          const arr = carrier.images;
          if (arr) {
            const idx = arr.indexOf(img);
            if (idx !== -1) arr.splice(idx, 1);
            if (arr.length === 0) delete carrier.images;
          }
          appendNote(carrier, note);
        },
      });
    }
  }
  await normalizeImageTargets(targets, {
    budget: KIRO_IMAGE_BASE64_BUDGET,
    overflowAction: "drop",
    ...(opts ?? {}),
  });
}
