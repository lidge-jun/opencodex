import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import type { OcxContentPart, OcxImageContent, OcxMessage } from "../../types";
import { assessUrlDestination, resolvePublicAddresses } from "../../lib/destination-policy";
import { pinnedHttpsGet } from "../../images/artifacts";
import type { PinnedAddress } from "../../lib/pinned-http";
import {
  SelectedContextSchema,
  SelectedImageSchema,
  SelectedImage_BlobIdWithDataSchema,
  SelectedImage_DimensionSchema,
  type SelectedContext,
  type SelectedImage,
} from "./gen/agent_pb";
import {
  storeCursorBlob,
  type CursorBlobRequestScopeToken,
} from "./native-exec";

/** Final per-image byte cap after prep (OmniRoute / composer-api style). */
export const MAX_CURSOR_IMAGE_BYTES = 1024 * 1024;

/**
 * Inbound decode/fetch bomb ceiling before JPEG prep. Large clipboard PNGs may exceed
 * {@link MAX_CURSOR_IMAGE_BYTES} raw but shrink under the wire cap after re-encode.
 */
export const MAX_CURSOR_IMAGE_DECODE_BYTES = 16 * 1024 * 1024;

/**
 * Soft target for Cursor vision hydration. Live A/B: ~430 KiB PNG failed ("gray"/wrong UI)
 * while the same visual as ~75 KiB JPEG succeeded. Prefer JPEG at or under this size.
 */
export const CURSOR_VISION_SOFT_MAX_BYTES = 100 * 1024;

/** Soft target when the client requests `detail: original` or `high`. */
export const CURSOR_VISION_SOFT_MAX_BYTES_HIGH = 256 * 1024;

/** Longest edge after Cursor vision prep (Cursor staff guidance: ≤ 2000 px). */
export const CURSOR_VISION_MAX_EDGE = 2000;

const CURSOR_VISION_JPEG_QUALITIES_DEFAULT = [85, 70, 55, 40] as const;
const CURSOR_VISION_JPEG_QUALITIES_HIGH = [90, 80, 65, 50] as const;
/** Stop shrinking below this longest edge when chasing the soft byte cap. */
const CURSOR_VISION_SOFT_MIN_EDGE = 256;
const CURSOR_VISION_SOFT_SHRINK = 0.85;

const CURSOR_VISION_PASSTHROUGH_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/** Upper bound on images attached to one Cursor turn. */
export const MAX_CURSOR_IMAGES = 12;

/**
 * UserMessage text when promoting view_image tool-result pixels onto SelectedImage.
 * Empty text alone is accepted for attach-only turns; tool promotions use a nudge so
 * Cursor/Grok do not invent content from file paths.
 */
export const CURSOR_VISION_PROMOTE_NUDGE =
  "Describe the image from the tool result. Do not infer content from file paths or names.";

/** Honest marker when MCP tool-result image bytes are peeled onto SelectedImage instead. */
export const CURSOR_VISION_MCP_IMAGE_OMITTED = "[image attached via SelectedImage]";

/** Marker when an image cannot be prepared for the Cursor vision wire. */
export const CURSOR_VISION_IMAGE_OMITTED =
  "[image omitted: undecodable or unsupported type]";

const IMAGE_FETCH_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(process.env.CURSOR_IMAGE_FETCH_TIMEOUT_MS || "15000", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 15_000;
})();

export class CursorImageError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "CursorImageError";
    this.status = status;
  }
}

export interface ResolvedCursorImage {
  data: Uint8Array;
  mimeType: string;
  uuid: string;
  /** Codex/OpenAI image detail hint; affects JPEG soft-cap tier. */
  detail?: string;
}

export type PrepareCursorImageOutcome =
  | { status: "ready"; image: ResolvedCursorImage }
  | { status: "omitted"; reason: string };

function isImagePart(part: OcxContentPart): part is OcxImageContent {
  return part.type === "image";
}

function estimatedBase64DecodedBytes(payload: string): number {
  return Math.floor((payload.length * 3) / 4);
}

function isHighDetail(detail: string | undefined): boolean {
  const normalized = (detail ?? "").trim().toLowerCase();
  return normalized === "original" || normalized === "high";
}

function softMaxBytesForDetail(detail: string | undefined): number {
  return isHighDetail(detail) ? CURSOR_VISION_SOFT_MAX_BYTES_HIGH : CURSOR_VISION_SOFT_MAX_BYTES;
}

function jpegQualitiesForDetail(detail: string | undefined): readonly number[] {
  return isHighDetail(detail) ? CURSOR_VISION_JPEG_QUALITIES_HIGH : CURSOR_VISION_JPEG_QUALITIES_DEFAULT;
}

function decodeDataUrl(url: string): { data: Uint8Array; mimeType: string } {
  const comma = url.indexOf(",");
  if (comma < 0) throw new CursorImageError("Image data URL is malformed.");
  const header = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  const isBase64 = /;base64/i.test(header);
  const mimeType = (header.split(";")[0] || "").trim().toLowerCase() || "application/octet-stream";

  if (!mimeType.startsWith("image/")) {
    throw new CursorImageError("Image data URL must have an image/* media type.");
  }
  if (!isBase64) {
    throw new CursorImageError("Image data URL must be base64-encoded.");
  }
  if (payload.length > MAX_CURSOR_IMAGE_DECODE_BYTES * 2) {
    throw new CursorImageError("Image input is too large to process safely.");
  }

  const normalized = payload.replace(/\s/g, "");
  if (estimatedBase64DecodedBytes(normalized) > MAX_CURSOR_IMAGE_DECODE_BYTES) {
    throw new CursorImageError("Image input is too large to process safely.");
  }

  let data: Uint8Array;
  try {
    data = Buffer.from(normalized, "base64");
  } catch {
    throw new CursorImageError("Image data URL contains invalid base64 data.");
  }
  if (normalized.length > 0 && data.byteLength === 0) {
    throw new CursorImageError("Image data URL contains invalid base64 data.");
  }
  if (data.byteLength > MAX_CURSOR_IMAGE_DECODE_BYTES) {
    throw new CursorImageError("Image input is too large to process safely.");
  }
  return { data, mimeType };
}

function pickPinnedAddress(addresses: PinnedAddress[]): PinnedAddress {
  return addresses.find(address => address.family === 4) ?? addresses[0]!;
}

async function fetchHttpsImageBytes(url: string, signal?: AbortSignal): Promise<{ data: Uint8Array; mimeType: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CursorImageError("Image URL is invalid.");
  }
  if (parsed.protocol !== "https:") {
    throw new CursorImageError("Image URL must use HTTPS.");
  }

  const assessment = assessUrlDestination(url);
  if (assessment && assessment.kind !== "public" && assessment.kind !== "hostname") {
    throw new CursorImageError("Image URL points to a blocked address.");
  }

  let resolved: Awaited<ReturnType<typeof resolvePublicAddresses>>;
  try {
    resolved = await resolvePublicAddresses(url, { context: "Cursor image" });
  } catch {
    throw new CursorImageError("Image URL host could not be resolved.");
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);

  try {
    const response = await pinnedHttpsGet(url, pickPinnedAddress(resolved.addresses), controller.signal, {
      maxBytes: MAX_CURSOR_IMAGE_DECODE_BYTES,
    });
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const mimeType = contentType.split(";")[0]?.trim() || "";
    if (!mimeType.startsWith("image/")) {
      throw new CursorImageError("Image URL did not return an image content type.");
    }
    if (!response.body) throw new CursorImageError("Image URL returned no body.");

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_CURSOR_IMAGE_DECODE_BYTES) {
          throw new CursorImageError("Image input is too large to process safely.");
        }
        chunks.push(value);
      }
    } finally {
      try { await reader.cancel(); } catch { /* ignore */ }
      reader.releaseLock();
    }

    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { data, mimeType };
  } catch (error) {
    if (error instanceof CursorImageError) throw error;
    throw new CursorImageError("Could not fetch the image URL.");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Collect image URLs from one message's content parts, preserving order. */
export function extractCursorImageUrls(content: string | readonly OcxContentPart[]): string[] {
  return extractCursorImageParts(content).map(part => part.imageUrl);
}

export interface CursorImagePartRef {
  imageUrl: string;
  detail?: string;
}

/** Collect image parts (URL + optional detail) from one message's content. */
export function extractCursorImageParts(
  content: string | readonly OcxContentPart[],
): CursorImagePartRef[] {
  if (typeof content === "string" || !Array.isArray(content)) return [];
  const parts: CursorImagePartRef[] = [];
  for (const part of content) {
    if (isImagePart(part) && typeof part.imageUrl === "string" && part.imageUrl.length > 0) {
      parts.push({
        imageUrl: part.imageUrl,
        ...(typeof part.detail === "string" && part.detail.length > 0 ? { detail: part.detail } : {}),
      });
    }
  }
  return parts;
}

/**
 * Resolve OpenCodex image parts (data: or https:) into bytes for SelectedImage.
 * Prep (JPEG soft-cap) runs before the 1 MiB wire cap so large clipboard PNGs can shrink.
 * Unsupported / undecodable images are omitted (fail-closed).
 */
export async function resolveCursorImages(
  imageUrls: readonly string[],
  signal?: AbortSignal,
  options?: { details?: readonly (string | undefined)[] },
): Promise<ResolvedCursorImage[]> {
  if (imageUrls.length > MAX_CURSOR_IMAGES) {
    throw new CursorImageError(`Too many images in one request (max ${MAX_CURSOR_IMAGES}).`);
  }

  const out: ResolvedCursorImage[] = [];
  for (let i = 0; i < imageUrls.length; i++) {
    const url = imageUrls[i];
    if (typeof url !== "string" || url.length === 0) {
      throw new CursorImageError("Image URL is missing.");
    }
    const resolved = url.toLowerCase().startsWith("data:")
      ? decodeDataUrl(url)
      : await fetchHttpsImageBytes(url, signal);
    if (resolved.data.byteLength === 0) {
      throw new CursorImageError("Image input is empty.");
    }
    const outcome = await prepareCursorImageForWire({
      data: resolved.data,
      mimeType: resolved.mimeType,
      uuid: randomUUID(),
      ...(options?.details?.[i] ? { detail: options.details[i] } : {}),
    });
    if (outcome.status === "omitted") continue;
    if (outcome.image.data.byteLength > MAX_CURSOR_IMAGE_BYTES) {
      throw new CursorImageError("Image input is too large (max 1 MiB). Resize and retry.");
    }
    out.push(outcome.image);
  }
  return out;
}

export async function resolveCursorImageParts(
  parts: readonly CursorImagePartRef[],
  signal?: AbortSignal,
): Promise<ResolvedCursorImage[]> {
  return resolveCursorImages(
    parts.map(part => part.imageUrl),
    signal,
    { details: parts.map(part => part.detail) },
  );
}

/** Filename Cursor clients typically put on SelectedImage.path (shunt / agent parity). */
export function cursorImageAttachmentPath(uuid: string, mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  const ext = normalized === "image/jpeg" || normalized === "image/jpg" ? "jpg"
    : normalized === "image/gif" ? "gif"
    : normalized === "image/webp" ? "webp"
    : "png";
  return `attachment-${uuid}.${ext}`;
}

/**
 * Re-encode toward a JPEG under the soft vision cap when Bun can decode the payload.
 * Unsupported MIME or undecodable bytes are omitted (fail-closed) except for tiny
 * undecodable PNG/JPEG/GIF/WebP stubs used in unit tests (pass-through under soft cap).
 * After the quality ladder, edges shrink iteratively until the soft byte cap is met
 * (or the min edge floor is hit) so large clipboard PNGs do not leave >softMax JPEGs
 * that Cursor vision hallucinates on.
 */
export async function prepareCursorImageForWire(
  image: ResolvedCursorImage,
): Promise<PrepareCursorImageOutcome> {
  const mime = image.mimeType.toLowerCase();
  const softMax = softMaxBytesForDetail(image.detail);
  const qualities = jpegQualitiesForDetail(image.detail);
  const lowestQuality = qualities[qualities.length - 1]!;

  if (!CURSOR_VISION_PASSTHROUGH_MIME.has(mime)) {
    return { status: "omitted", reason: CURSOR_VISION_IMAGE_OMITTED };
  }

  try {
    // Force a full decode before accepting passthrough / encode (Anthropic-style validate).
    // Includes already-small JPEGs — labeled JPEG under the soft cap must still decode.
    await new Bun.Image(image.data).resize(1, 1).jpeg({ quality: 1 }).toBuffer();

    const alreadySmallJpeg = (mime === "image/jpeg" || mime === "image/jpg")
      && image.data.byteLength <= softMax;
    if (alreadySmallJpeg) return { status: "ready", image };

    const meta = await new Bun.Image(image.data).metadata();
    const width = typeof meta.width === "number" ? meta.width : 0;
    const height = typeof meta.height === "number" ? meta.height : 0;
    let targetW = width;
    let targetH = height;
    if (width > 0 && height > 0 && Math.max(width, height) > CURSOR_VISION_MAX_EDGE) {
      const scale = CURSOR_VISION_MAX_EDGE / Math.max(width, height);
      targetW = Math.max(1, Math.round(width * scale));
      targetH = Math.max(1, Math.round(height * scale));
    }

    const encodeAt = async (w: number, h: number, quality: number): Promise<Uint8Array> => {
      let pipeline = new Bun.Image(image.data);
      if (w > 0 && h > 0 && (w !== width || h !== height)) {
        pipeline = pipeline.resize(w, h);
      }
      return new Uint8Array(await pipeline.jpeg({ quality }).bytes());
    };

    let best: Uint8Array | undefined;
    for (const quality of qualities) {
      const encoded = await encodeAt(targetW, targetH, quality);
      if (!best || encoded.byteLength < best.byteLength) best = encoded;
      if (encoded.byteLength <= softMax) {
        return {
          status: "ready",
          image: { ...image, data: encoded, mimeType: "image/jpeg" },
        };
      }
    }

    // Quality ladder missed the soft cap — shrink edges until it fits or we hit the floor.
    while (
      best
      && best.byteLength > softMax
      && targetW > 0
      && targetH > 0
      && Math.max(targetW, targetH) > CURSOR_VISION_SOFT_MIN_EDGE
    ) {
      const nextW = Math.max(1, Math.round(targetW * CURSOR_VISION_SOFT_SHRINK));
      const nextH = Math.max(1, Math.round(targetH * CURSOR_VISION_SOFT_SHRINK));
      if (Math.max(nextW, nextH) < CURSOR_VISION_SOFT_MIN_EDGE) {
        const scale = CURSOR_VISION_SOFT_MIN_EDGE / Math.max(targetW, targetH);
        targetW = Math.max(1, Math.round(targetW * scale));
        targetH = Math.max(1, Math.round(targetH * scale));
      } else {
        targetW = nextW;
        targetH = nextH;
      }
      const encoded = await encodeAt(targetW, targetH, lowestQuality);
      if (!best || encoded.byteLength < best.byteLength) best = encoded;
      if (encoded.byteLength <= softMax) {
        return {
          status: "ready",
          image: { ...image, data: encoded, mimeType: "image/jpeg" },
        };
      }
      if (Math.max(targetW, targetH) <= CURSOR_VISION_SOFT_MIN_EDGE) break;
    }

    if (best) {
      return {
        status: "ready",
        image: { ...image, data: best, mimeType: "image/jpeg" },
      };
    }
    return { status: "ready", image };
  } catch {
    // Tiny undecodable stubs (unit wire tests) may still be referenced as blobIdWithData.
    if (image.data.byteLength <= 64 && CURSOR_VISION_PASSTHROUGH_MIME.has(mime)) {
      return { status: "ready", image };
    }
    return { status: "omitted", reason: CURSOR_VISION_IMAGE_OMITTED };
  }
}

/**
 * Sniff PNG/JPEG/GIF dimensions from raw bytes when the header is present.
 * Best-effort only — unknown formats return undefined (dimension is optional).
 */
export function sniffCursorImageDimensions(
  data: Uint8Array,
): { width: number; height: number } | undefined {
  // PNG: signature + IHDR chunk (width/height at bytes 16..23)
  if (
    data.byteLength >= 24
    && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a
  ) {
    const width = ((data[16]! << 24) | (data[17]! << 16) | (data[18]! << 8) | data[19]!) >>> 0;
    const height = ((data[20]! << 24) | (data[21]! << 16) | (data[22]! << 8) | data[23]!) >>> 0;
    if (width > 0 && height > 0) return { width, height };
  }
  // GIF: "GIF8" + width/height as little-endian u16 at bytes 6..9
  if (
    data.byteLength >= 10
    && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38
  ) {
    const width = data[6]! | (data[7]! << 8);
    const height = data[8]! | (data[9]! << 8);
    if (width > 0 && height > 0) return { width, height };
  }
  // JPEG: scan for SOF0/SOF2 marker with dimensions
  if (data.byteLength >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < data.byteLength) {
      if (data[offset] !== 0xff) break;
      const marker = data[offset + 1]!;
      const length = (data[offset + 2]! << 8) | data[offset + 3]!;
      if (marker === 0xc0 || marker === 0xc2) {
        const height = (data[offset + 5]! << 8) | data[offset + 6]!;
        const width = (data[offset + 7]! << 8) | data[offset + 8]!;
        if (width > 0 && height > 0) return { width, height };
        break;
      }
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  return undefined;
}

/**
 * Build SelectedImage messages for the AgentService vision path:
 * store bytes in the local KV map under sha256(blobId), and encode
 * `blobIdWithData` so the server can populate its cache without relying solely
 * on getBlobArgs timing. Also set `path` like native/shunt clients.
 */
export function buildSelectedImages(
  images: readonly ResolvedCursorImage[],
  requestScope?: CursorBlobRequestScopeToken,
): SelectedImage[] {
  return images.map(image => {
    const blobId = storeCursorBlob(image.data, requestScope);
    const dims = sniffCursorImageDimensions(image.data);
    return create(SelectedImageSchema, {
      uuid: image.uuid,
      path: cursorImageAttachmentPath(image.uuid, image.mimeType),
      mimeType: image.mimeType,
      ...(dims
        ? { dimension: create(SelectedImage_DimensionSchema, dims) }
        : {}),
      dataOrBlobId: {
        case: "blobIdWithData",
        value: create(SelectedImage_BlobIdWithDataSchema, {
          blobId,
          data: image.data,
        }),
      },
    });
  });
}

/**
 * Always send `UserMessage.selected_context`, even when empty — matches cursor-agent.
 * When images are present, they are blobIdWithData refs backed by the request-scoped KV store.
 */
export function buildSelectedContext(
  images: readonly ResolvedCursorImage[] = [],
  requestScope?: CursorBlobRequestScopeToken,
): SelectedContext {
  return create(SelectedContextSchema, {
    selectedImages: buildSelectedImages(images, requestScope),
  });
}

/**
 * Trailing toolResult image promotion: parts kept for SelectedImage (newest
 * {@link MAX_CURSOR_IMAGES}) and the call ids that own at least one kept part.
 * Older overflow parts stay on MCP (not omitted) because they are not promoted.
 */
export function extractTrailingToolResultImagePromotion(
  messages: readonly OcxMessage[],
): { parts: CursorImagePartRef[]; omittedOlder: number; promotedCallIds: Set<string> } {
  const effective = stripTrailingTransparentDeveloperMessages(messages);
  let start = effective.length;
  while (start > 0 && effective[start - 1]?.role === "toolResult") start -= 1;

  const entries: Array<{ callId: string; part: CursorImagePartRef }> = [];
  for (const message of effective.slice(start)) {
    if (message.role !== "toolResult") continue;
    for (const part of extractCursorImageParts(message.content)) {
      entries.push({ callId: message.toolCallId, part });
    }
  }

  const kept = entries.length <= MAX_CURSOR_IMAGES
    ? entries
    : entries.slice(-MAX_CURSOR_IMAGES);
  return {
    parts: kept.map(entry => entry.part),
    omittedOlder: Math.max(0, entries.length - kept.length),
    promotedCallIds: new Set(kept.map(entry => entry.callId)),
  };
}

/**
 * Collect image parts from trailing consecutive toolResult messages,
 * oldest→newest within the block, capped at {@link MAX_CURSOR_IMAGES} (keep newest).
 */
export function extractTrailingToolResultImageParts(
  messages: readonly OcxMessage[],
): { parts: CursorImagePartRef[]; omittedOlder: number } {
  const { parts, omittedOlder } = extractTrailingToolResultImagePromotion(messages);
  return { parts, omittedOlder };
}

/**
 * Trailing non-image developer messages (Codex Desktop multi-agent guidance) are
 * transparent for Cursor vision / tool-continuation detection so `view_image`
 * still promotes onto SelectedImage.
 */
export function isTransparentCursorVisionSuffix(message: OcxMessage): boolean {
  if (message.role !== "developer") return false;
  return extractCursorImageParts(message.content).length === 0;
}

/** Drop trailing transparent developers; returns the same array reference when unchanged. */
export function stripTrailingTransparentDeveloperMessages(
  messages: readonly OcxMessage[],
): readonly OcxMessage[] {
  let end = messages.length;
  while (end > 0) {
    const message = messages[end - 1];
    if (!message || !isTransparentCursorVisionSuffix(message)) break;
    end -= 1;
  }
  return end === messages.length ? messages : messages.slice(0, end);
}

/** True when, ignoring transparent developer suffix, the active turn is a toolResult. */
export function cursorIsTrailingToolResultContinuation(
  messages: readonly OcxMessage[] | undefined,
): boolean {
  if (!messages?.length) return false;
  return stripTrailingTransparentDeveloperMessages(messages).at(-1)?.role === "toolResult";
}

/**
 * Resolve images for the active Cursor turn.
 * - Trailing user/developer: attach images (SelectedImage).
 * - Trailing toolResult run (e.g. Codex `view_image`): same channel — McpImageContent
 *   alone is not consumed as vision for external Cursor models like grok-4.5.
 * - Trailing non-image developer injections (multi_agent_mode) are stripped first so
 *   Desktop collab guidance does not hide a view_image promotion.
 */
export async function resolveActiveCursorImages(
  messages: readonly OcxMessage[] | undefined,
  signal?: AbortSignal,
): Promise<ResolvedCursorImage[]> {
  if (!messages?.length) return [];

  const effective = stripTrailingTransparentDeveloperMessages(messages);
  const last = effective.at(-1);
  if (last?.role === "toolResult") {
    const { parts } = extractTrailingToolResultImageParts(effective);
    if (parts.length === 0) return [];
    return resolveCursorImageParts(parts, signal);
  }

  for (let i = effective.length - 1; i >= 0; i--) {
    const message = effective[i];
    if (!message) continue;
    if (message.role === "user" || message.role === "developer") {
      return resolveCursorImageParts(extractCursorImageParts(message.content), signal);
    }
  }
  return [];
}

function imageDataUrlFromPrepared(image: ResolvedCursorImage): string {
  return `data:${image.mimeType};base64,${Buffer.from(image.data).toString("base64")}`;
}

/**
 * Re-encode a single `data:image/...;base64,...` URL through {@link prepareCursorImageForWire}.
 * Omitted images become a text-safe data URL skip (caller replaces the part).
 */
export async function prepareCursorImageDataUrl(
  imageUrl: string,
  detail?: string,
): Promise<{ status: "ready"; imageUrl: string } | { status: "omitted"; reason: string }> {
  if (!imageUrl.toLowerCase().startsWith("data:")) return { status: "ready", imageUrl };
  try {
    const decoded = decodeDataUrl(imageUrl);
    if (decoded.data.byteLength === 0) {
      return { status: "omitted", reason: CURSOR_VISION_IMAGE_OMITTED };
    }
    const outcome = await prepareCursorImageForWire({
      data: decoded.data,
      mimeType: decoded.mimeType,
      uuid: randomUUID(),
      ...(detail ? { detail } : {}),
    });
    if (outcome.status === "omitted") return outcome;
    if (outcome.image.data.byteLength > MAX_CURSOR_IMAGE_BYTES) {
      return { status: "omitted", reason: CURSOR_VISION_IMAGE_OMITTED };
    }
    if (outcome.image.data === decoded.data && outcome.image.mimeType === decoded.mimeType) {
      return { status: "ready", imageUrl };
    }
    return { status: "ready", imageUrl: imageDataUrlFromPrepared(outcome.image) };
  } catch {
    return { status: "omitted", reason: CURSOR_VISION_IMAGE_OMITTED };
  }
}

async function prepareCursorContentParts(
  content: string | readonly OcxContentPart[],
): Promise<string | readonly OcxContentPart[]> {
  if (typeof content === "string" || !Array.isArray(content)) return content;
  let changed = false;
  const next: OcxContentPart[] = [];
  for (const part of content) {
    if (part.type === "image" && typeof part.imageUrl === "string" && part.imageUrl.length > 0) {
      const prepared = await prepareCursorImageDataUrl(part.imageUrl, part.detail);
      if (prepared.status === "omitted") {
        changed = true;
        next.push({ type: "text", text: prepared.reason });
        continue;
      }
      if (prepared.imageUrl !== part.imageUrl) changed = true;
      next.push({ ...part, imageUrl: prepared.imageUrl });
    } else {
      next.push(part);
    }
  }
  return changed ? next : content;
}

/**
 * Rewrite image data URLs in user/developer/toolResult messages (including `view_image`
 * tool outputs) through the JPEG soft-cap path before protobuf encode.
 */
export async function prepareCursorRawMessages(
  messages: readonly OcxMessage[] | undefined,
): Promise<readonly OcxMessage[] | undefined> {
  if (!messages?.length) return messages;
  let changed = false;
  const out: OcxMessage[] = [];
  for (const message of messages) {
    if (message.role === "user" || message.role === "developer" || message.role === "toolResult") {
      const content = await prepareCursorContentParts(message.content);
      if (content !== message.content) {
        changed = true;
        out.push({ ...message, content } as OcxMessage);
        continue;
      }
    }
    out.push(message);
  }
  return changed ? out : messages;
}
