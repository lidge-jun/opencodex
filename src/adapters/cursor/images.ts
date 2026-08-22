import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import type { OcxContentPart, OcxImageContent, OcxMessage } from "../../types";
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

/**
 * Decode bomb: reject images whose sniffed longest edge exceeds this before Bun.Image.
 * Separate from {@link CURSOR_VISION_MAX_EDGE} (output resize target).
 */
export const MAX_CURSOR_IMAGE_DECODE_EDGE = 8192;

/** Decode bomb: reject images whose sniffed pixel count exceeds this before Bun.Image. */
export const MAX_CURSOR_IMAGE_PIXELS = 25_000_000;

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

/** Marker when an image cannot be prepared for the Cursor vision wire. */
export const CURSOR_VISION_IMAGE_OMITTED =
  "[image omitted: undecodable or unsupported type]";

/** Short text-only stand-in for an image part on replayed (historical) turns. Never includes bytes. */
export const CURSOR_VISION_IMAGE_HISTORY_MARKER = "[image attached]";

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

export function decodeCursorImageDataUrl(url: string): { data: Uint8Array; mimeType: string } {
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
  if (normalized.length === 0) {
    throw new CursorImageError("Image data URL contains invalid base64 data.");
  }
  // Reject lenient Buffer.from acceptances (wrong alphabet, bad padding, truncated groups).
  if (normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new CursorImageError("Image data URL contains invalid base64 data.");
  }
  if (estimatedBase64DecodedBytes(normalized) > MAX_CURSOR_IMAGE_DECODE_BYTES) {
    throw new CursorImageError("Image input is too large to process safely.");
  }

  let data: Uint8Array;
  try {
    data = Buffer.from(normalized, "base64");
  } catch {
    throw new CursorImageError("Image data URL contains invalid base64 data.");
  }
  if (data.byteLength === 0) {
    throw new CursorImageError("Image data URL contains invalid base64 data.");
  }
  // Round-trip guard: Node/Bun can silently drop trailing garbage.
  if (Buffer.from(data).toString("base64").replace(/=+$/, "") !== normalized.replace(/=+$/, "")) {
    throw new CursorImageError("Image data URL contains invalid base64 data.");
  }
  if (data.byteLength > MAX_CURSOR_IMAGE_DECODE_BYTES) {
    throw new CursorImageError("Image input is too large to process safely.");
  }
  return { data, mimeType };
}

function throwIfImagePhaseAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const err = new Error("Cursor image phase aborted");
  err.name = "AbortError";
  throw err;
}

/** Magic-byte format sniff (independent of declared MIME). */
export function sniffCursorImageFormat(
  data: Uint8Array,
): "png" | "jpeg" | "gif" | "webp" | undefined {
  if (
    data.byteLength >= 8
    && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a
  ) {
    return "png";
  }
  if (
    data.byteLength >= 6
    && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38
  ) {
    return "gif";
  }
  if (data.byteLength >= 4 && data[0] === 0xff && data[1] === 0xd8) return "jpeg";
  if (
    data.byteLength >= 12
    && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
    && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
  ) {
    return "webp";
  }
  return undefined;
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
 * Resolve OpenCodex image parts (data: URLs only) into bytes for SelectedImage.
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
    throwIfImagePhaseAborted(signal);
    const url = imageUrls[i];
    if (typeof url !== "string" || url.length === 0) {
      // Soft-omit missing URLs rather than aborting a mixed turn.
      continue;
    }
    // Remote URL fetching is deliberately out of scope here; https:// images are omitted.
    if (!url.toLowerCase().startsWith("data:")) continue;
    try {
      const resolved = decodeCursorImageDataUrl(url);
      if (resolved.data.byteLength === 0) continue;
      const outcome = await prepareCursorImageForWire({
        data: resolved.data,
        mimeType: resolved.mimeType,
        uuid: randomUUID(),
        ...(options?.details?.[i] ? { detail: options.details[i] } : {}),
      }, signal);
      if (outcome.status === "omitted") continue;
      if (outcome.image.data.byteLength > MAX_CURSOR_IMAGE_BYTES) continue;
      out.push(outcome.image);
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) throw err;
      if (err instanceof CursorImageError) continue;
      continue;
    }
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
 * Unsupported MIME, oversize dimensions/pixels, or undecodable bytes are omitted (fail-closed).
 * After the quality ladder, edges shrink iteratively until the soft byte cap is met
 * (or the min edge floor is hit) so large clipboard PNGs do not leave >softMax JPEGs
 * that Cursor vision hallucinates on.
 */
export async function prepareCursorImageForWire(
  image: ResolvedCursorImage,
  signal?: AbortSignal,
  testHooks?: { softMaxBytes?: number },
): Promise<PrepareCursorImageOutcome> {
  throwIfImagePhaseAborted(signal);
  const mime = image.mimeType.toLowerCase();
  const softMax = testHooks?.softMaxBytes ?? softMaxBytesForDetail(image.detail);
  const qualities = jpegQualitiesForDetail(image.detail);
  const lowestQuality = qualities[qualities.length - 1]!;

  if (!CURSOR_VISION_PASSTHROUGH_MIME.has(mime)) {
    return { status: "omitted", reason: CURSOR_VISION_IMAGE_OMITTED };
  }

  const format = sniffCursorImageFormat(image.data);
  // Peek headers before Bun.Image so huge compressed bombs fail closed cheaply.
  const sniffed = sniffCursorImageDimensions(image.data);
  if (!sniffed) {
    return { status: "omitted", reason: CURSOR_VISION_IMAGE_OMITTED };
  }
  const sniffedEdge = Math.max(sniffed.width, sniffed.height);
  const sniffedPixels = sniffed.width * sniffed.height;
  if (sniffedEdge > MAX_CURSOR_IMAGE_DECODE_EDGE || sniffedPixels > MAX_CURSOR_IMAGE_PIXELS) {
    return { status: "omitted", reason: CURSOR_VISION_IMAGE_OMITTED };
  }

  const declaredJpeg = mime === "image/jpeg" || mime === "image/jpg";

  try {
    throwIfImagePhaseAborted(signal);
    // metadata() decodes; reuse it as the Anthropic-style validate pass.
    const meta = await new Bun.Image(image.data).metadata();

    // Passthrough only after a successful decode, and only when declared MIME
    // matches actual JPEG magic (never PNG-as-JPEG or SOF-only junk).
    if (declaredJpeg && format === "jpeg" && image.data.byteLength <= softMax) {
      return { status: "ready", image };
    }

    throwIfImagePhaseAborted(signal);
    const width = typeof meta.width === "number" ? meta.width : 0;
    const height = typeof meta.height === "number" ? meta.height : 0;
    if (width > 0 && height > 0) {
      const edge = Math.max(width, height);
      if (edge > MAX_CURSOR_IMAGE_DECODE_EDGE || width * height > MAX_CURSOR_IMAGE_PIXELS) {
        return { status: "omitted", reason: CURSOR_VISION_IMAGE_OMITTED };
      }
    }
    let targetW = width;
    let targetH = height;
    if (width > 0 && height > 0 && Math.max(width, height) > CURSOR_VISION_MAX_EDGE) {
      const scale = CURSOR_VISION_MAX_EDGE / Math.max(width, height);
      targetW = Math.max(1, Math.round(width * scale));
      targetH = Math.max(1, Math.round(height * scale));
    }

    const encodeAt = async (w: number, h: number, quality: number): Promise<Uint8Array> => {
      throwIfImagePhaseAborted(signal);
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
      throwIfImagePhaseAborted(signal);
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

    if (best && best.byteLength <= softMax) {
      return {
        status: "ready",
        image: { ...image, data: best, mimeType: "image/jpeg" },
      };
    }
    if (best) {
      return { status: "omitted", reason: CURSOR_VISION_IMAGE_OMITTED };
    }
    // Undeclared/mismatched magic with no encode result — omit rather than lie about MIME.
    if (declaredJpeg && format !== "jpeg") {
      return { status: "omitted", reason: CURSOR_VISION_IMAGE_OMITTED };
    }
    return { status: "ready", image };
  } catch (err) {
    if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) throw err;
    return { status: "omitted", reason: CURSOR_VISION_IMAGE_OMITTED };
  }
}

/**
 * Sniff PNG/JPEG/GIF/WebP dimensions from raw bytes when the header is present.
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
  // WebP: RIFF....WEBP + VP8X / VP8 / VP8L (same layout as anthropic-image-guard).
  if (
    data.byteLength >= 30
    && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
    && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
  ) {
    const fourcc = String.fromCharCode(data[12]!, data[13]!, data[14]!, data[15]!);
    if (fourcc === "VP8X") {
      const width = 1 + (data[24]! | (data[25]! << 8) | (data[26]! << 16));
      const height = 1 + (data[27]! | (data[28]! << 8) | (data[29]! << 16));
      if (width > 0 && height > 0) return { width, height };
    } else if (fourcc === "VP8 ") {
      if (data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
        const width = (data[26]! | (data[27]! << 8)) & 0x3fff;
        const height = (data[28]! | (data[29]! << 8)) & 0x3fff;
        if (width > 0 && height > 0) return { width, height };
      }
    } else if (fourcc === "VP8L" && data[20] === 0x2f) {
      const raw = data[21]! | (data[22]! << 8) | (data[23]! << 16) | (data[24]! << 24);
      const width = (raw & 0x3fff) + 1;
      const height = ((raw >> 14) & 0x3fff) + 1;
      if (width > 0 && height > 0) return { width, height };
    }
  }
  // JPEG: scan for SOF0/SOF2 marker with dimensions
  if (data.byteLength >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < data.byteLength) {
      if (data[offset] !== 0xff) break;
      const marker = data[offset + 1]!;
      // Standalone markers (TEM, RSTn, SOI, EOI) carry no length payload.
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        offset += 2;
        continue;
      }
      const length = (data[offset + 2]! << 8) | data[offset + 3]!;
      // SOFn frame headers share the dimension layout. 0xc4/0xc8/0xcc are DHT/JPG/DAC, not SOF.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
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
 * Resolve data: images for the active user/developer turn onto SelectedImage.
 * Tool-result image promotion is intentionally out of scope in this slice.
 */
export async function resolveActiveCursorImages(
  messages: readonly OcxMessage[] | undefined,
  signal?: AbortSignal,
  preparedImages?: readonly ResolvedCursorImage[],
): Promise<ResolvedCursorImage[]> {
  if (!messages?.length) return [];
  // Same window the prepare pass rewrote; a divergent rule would attach unprepared bytes.
  const message = messages[cursorVisionPrepareStartIndex(messages)];
  if (!message || (message.role !== "user" && message.role !== "developer")) return [];
  if (preparedImages) return [...preparedImages];
  return resolveCursorImageParts(extractCursorImageParts(message.content), signal);
}

function imageDataUrlFromPrepared(image: ResolvedCursorImage): string {
  return `data:${image.mimeType};base64,${Buffer.from(image.data).toString("base64")}`;
}

/**
 * Re-encode a single image URL through {@link prepareCursorImageForWire}.
 * data: URLs only. Omitted images become text (caller replaces the part).
 */
export async function prepareCursorImageDataUrl(
  imageUrl: string,
  detail?: string,
  signal?: AbortSignal,
): Promise<
  | { status: "ready"; imageUrl: string; image: ResolvedCursorImage }
  | { status: "omitted"; reason: string }
> {
  try {
    const resolved = imageUrl.toLowerCase().startsWith("data:")
      ? decodeCursorImageDataUrl(imageUrl)
      : null;
    if (!resolved) {
      return { status: "omitted", reason: CURSOR_VISION_IMAGE_OMITTED };
    }
    if (resolved.data.byteLength === 0) {
      return { status: "omitted", reason: CURSOR_VISION_IMAGE_OMITTED };
    }
    const outcome = await prepareCursorImageForWire({
      data: resolved.data,
      mimeType: resolved.mimeType,
      uuid: randomUUID(),
      ...(detail ? { detail } : {}),
    }, signal);
    if (outcome.status === "omitted") return outcome;
    if (outcome.image.data.byteLength > MAX_CURSOR_IMAGE_BYTES) {
      return { status: "omitted", reason: CURSOR_VISION_IMAGE_OMITTED };
    }
    if (
      imageUrl.toLowerCase().startsWith("data:")
      && outcome.image.data === resolved.data
      && outcome.image.mimeType === resolved.mimeType
    ) {
      return { status: "ready", imageUrl, image: outcome.image };
    }
    return { status: "ready", imageUrl: imageDataUrlFromPrepared(outcome.image), image: outcome.image };
  } catch (err) {
    if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) throw err;
    return { status: "omitted", reason: CURSOR_VISION_IMAGE_OMITTED };
  }
}

async function prepareCursorContentParts(
  content: string | readonly OcxContentPart[],
  signal?: AbortSignal,
): Promise<{ content: string | readonly OcxContentPart[]; images: ResolvedCursorImage[] }> {
  if (typeof content === "string" || !Array.isArray(content)) {
    return { content, images: [] };
  }
  let changed = false;
  const next: OcxContentPart[] = [];
  const images: ResolvedCursorImage[] = [];
  for (const part of content) {
    if (part.type === "image" && typeof part.imageUrl === "string" && part.imageUrl.length > 0) {
      throwIfImagePhaseAborted(signal);
      const prepared = await prepareCursorImageDataUrl(part.imageUrl, part.detail, signal);
      if (prepared.status === "omitted") {
        changed = true;
        next.push({ type: "text", text: prepared.reason });
        continue;
      }
      images.push(prepared.image);
      if (prepared.imageUrl !== part.imageUrl) changed = true;
      next.push({ ...part, imageUrl: prepared.imageUrl });
    } else {
      next.push(part);
    }
  }
  return { content: changed ? next : content, images };
}

/**
 * First original-message index that still needs image prep for the active vision window.
 * Historical messages before this index are left untouched (no decode).
 */
export function cursorVisionPrepareStartIndex(messages: readonly OcxMessage[]): number {
  // Tool-result image preparation is out of scope in this slice.
  if (messages.at(-1)?.role === "toolResult") return messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i]?.role;
    if (role === "user" || role === "developer") return i;
  }
  return messages.length;
}

/**
 * Rewrite image data URLs in the active vision window (last user/developer turn) through
 * the JPEG soft-cap path before protobuf encode. Historical messages are left by
 * reference. Undecodable images become {@link CURSOR_VISION_IMAGE_OMITTED} text so
 * image-only turns stay userMessageAction.
 */
export interface PreparedCursorRawMessages {
  messages: readonly OcxMessage[] | undefined;
  images: ResolvedCursorImage[];
}

export async function prepareCursorRawMessages(
  messages: readonly OcxMessage[] | undefined,
  signal?: AbortSignal,
): Promise<PreparedCursorRawMessages> {
  if (!messages?.length) return { messages, images: [] };
  throwIfImagePhaseAborted(signal);
  const prepareFrom = cursorVisionPrepareStartIndex(messages);
  const active = messages[prepareFrom];
  if (
    active
    && (active.role === "user" || active.role === "developer")
    && extractCursorImageParts(active.content).length > MAX_CURSOR_IMAGES
  ) {
    throw new CursorImageError(`Too many images in one request (max ${MAX_CURSOR_IMAGES}).`);
  }
  let changed = false;
  const out: OcxMessage[] = [];
  const images: ResolvedCursorImage[] = [];
  for (let i = 0; i < messages.length; i++) {
    throwIfImagePhaseAborted(signal);
    const message = messages[i]!;
    if (
      i >= prepareFrom
      && (message.role === "user" || message.role === "developer")
    ) {
      const prepared = await prepareCursorContentParts(message.content, signal);
      images.push(...prepared.images);
      if (prepared.content !== message.content) {
        changed = true;
        out.push({ ...message, content: prepared.content } as OcxMessage);
        continue;
      }
    }
    out.push(message);
  }
  return { messages: changed ? out : messages, images };
}
