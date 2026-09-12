import type { OcxContentPart } from "../types";
import { normalizeImageTargets, type NormalizeOptions, type NormalizeTarget } from "./anthropic-image-normalize";

// CodeWhisperer native image part (matches Kiro IDE wire format): the base64 bytes live directly in
// userInputMessage.images, NOT in userInputMessageContext. Verified against kiro-gateway.
export interface KiroImage {
  format: string; // "jpeg" | "png" | "webp" | "gif" — derived from the media subtype
  source: { bytes: string }; // pure base64, no "data:...;base64," prefix
}

// Codex sends each image as a `data:` URL (base64) or a remote https URL. Only data URLs can be
// inlined as bytes here; remote URLs are not fetchable at request-build time.
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

/**
 * Conservative POLICY caps for the CodeWhisperer GenerateAssistantResponse payload,
 * whose limits are undocumented. Derived from adjacent AWS surfaces
 * (devlog/260714_image_normalization_pipeline/050): Bedrock `Message` allows 20 images
 * per message (Converse), and `InvokeModel` caps requests at 25,000,000 bytes — 18MiB
 * bounds the IMAGE share of the body with headroom for text/tools.
 */
export const KIRO_IMAGE_BASE64_BUDGET = 18 * 1024 * 1024;
export const KIRO_MAX_IMAGES_PER_MESSAGE = 20;

const COUNT_CAP_NOTE = "[image omitted: exceeded the 20-image per-message cap; oldest images in this message were dropped]";

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

/**
 * Apply the generous image pipeline to a built CodeWhisperer payload (mutates in
 * place): per-message 20-image cap first (oldest dropped), then the shared tier
 * machinery with the kiro budget and terminal-overflow DROP (kiro has no downstream
 * guard). Test seams (encode/validate) forward into the core.
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
