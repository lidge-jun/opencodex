/**
 * Anthropic per-request image limits (docs.anthropic.com Vision, verified 2026-07-06):
 * - <= 20 images: each image may be up to 8000px on a side.
 * - > 20 images ("many-image request"): each image is capped at 2000px per side;
 *   one offender 400s the whole request:
 *   "At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels"
 * - Hard cap: 100 images per request.
 *
 * Image-local normalization runs first. This guard textifies only individually unsafe
 * images; request-level limits reject the request instead of rewriting its history.
 */

export const MANY_IMAGE_THRESHOLD = 20;
export const MANY_IMAGE_MAX_DIMENSION = 2000;
export const ABSOLUTE_MAX_DIMENSION = 8000;
export const MAX_IMAGES_PER_REQUEST = 100;

/**
 * Anthropic rejects any single image over 5MiB ("image exceeds 5 MB maximum", HTTP 400)
 * regardless of dimensions or count. The unit is the BASE64 STRING LENGTH, not decoded
 * bytes — verified in Claude Code's apiLimits.ts against Anthropic's internal API source
 * (devlog/260714_image_normalization_pipeline/001_prior_art.md §1). A decoded-bytes
 * comparison would let images with base64 length in (5.24MiB, 6.99MiB] through to a 400.
 */
export const MAX_IMAGE_BASE64_LENGTH = 5 * 1024 * 1024;

/** @deprecated Renamed — the cap is measured in base64 chars. Use MAX_IMAGE_BASE64_LENGTH. */
export const MAX_IMAGE_FILE_BYTES = MAX_IMAGE_BASE64_LENGTH;

/**
 * Image share admission is separate from the final serialized UTF-8 body check:
 * system text, tool schemas and framing also consume the upstream request budget.
 */
export const TOTAL_IMAGE_BASE64_BUDGET = 20 * 1024 * 1024;

const OVERSIZED_TEXT = "[image omitted: exceeds Anthropic's 8000px per-side limit]";
const PER_IMAGE_TOO_LARGE_TEXT = "[image omitted: exceeds Anthropic's 5MB per-image limit]";
export const MAX_ANTHROPIC_REQUEST_BYTES = 32_000_000;

/** A caller must compact or reduce its input; retrying with degraded history is unsafe. */
export class AnthropicImageLimitError extends Error {
  readonly status = 413;

  constructor(readonly code: string, message: string) {
    super(`${message} Compact the conversation or start a new session before retrying.`);
    this.name = "AnthropicImageLimitError";
  }
}

export function assertAnthropicRequestBodySize(body: string): void {
  if (Buffer.byteLength(body, "utf8") > MAX_ANTHROPIC_REQUEST_BYTES) {
    throw new AnthropicImageLimitError("anthropic_request_body_too_large", "The serialized Anthropic request exceeds 32 MB.");
  }
}

interface ImageDimensions { width: number; height: number }

/** Read big-endian u16/u32 helpers over a byte array. */
function u16be(b: Uint8Array, o: number): number { return (b[o] << 8) | b[o + 1]; }
function u32be(b: Uint8Array, o: number): number { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
function u16le(b: Uint8Array, o: number): number { return b[o] | (b[o + 1] << 8); }
function u24le(b: Uint8Array, o: number): number { return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16); }

function pngDimensions(b: Uint8Array): ImageDimensions | null {
  // 8-byte signature + IHDR chunk (len+type at 8..16, data at 16).
  if (b.length < 24) return null;
  if (b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

function jpegDimensions(b: Uint8Array): ImageDimensions | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) { o++; continue; }
    const marker = b[o + 1];
    // Skip padding/fill bytes and standalone markers (RSTn, TEM) which have no length.
    if (marker === 0xff) { o++; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue; }
    // SOF0-SOF15 carry dimensions, excluding DHT(0xc4)/JPG(0xc8)/DAC(0xcc).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: u16be(b, o + 5), width: u16be(b, o + 7) };
    }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / start of scan: no SOF found
    const len = u16be(b, o + 2);
    if (len < 2) return null;
    o += 2 + len;
  }
  return null;
}

function gifDimensions(b: Uint8Array): ImageDimensions | null {
  if (b.length < 10) return null;
  if (b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46) return null;
  return { width: u16le(b, 6), height: u16le(b, 8) };
}

function webpDimensions(b: Uint8Array): ImageDimensions | null {
  if (b.length < 30) return null;
  if (b[0] !== 0x52 || b[1] !== 0x49 || b[2] !== 0x46 || b[3] !== 0x46) return null; // RIFF
  if (b[8] !== 0x57 || b[9] !== 0x45 || b[10] !== 0x42 || b[11] !== 0x50) return null; // WEBP
  const fourcc = String.fromCharCode(b[12], b[13], b[14], b[15]);
  if (fourcc === "VP8X") {
    return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  }
  if (fourcc === "VP8 ") {
    // Lossy: frame tag at 20, sync code 9d 01 2a, then 14-bit width/height.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (fourcc === "VP8L") {
    if (b[20] !== 0x2f) return null;
    // VP8L stores 14-bit width-1 / height-1 little-endian-bit-packed.
    const raw = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    const width = (raw & 0x3fff) + 1;
    const height = ((raw >> 14) & 0x3fff) + 1;
    return { width, height };
  }
  return null;
}

/**
 * Sniff pixel dimensions from the first bytes of a base64 image. Returns null when the
 * format is unrecognized or the header is malformed — callers must treat null as
 * "unknown, assume within limits" so we never drop an image we cannot prove oversized.
 */
export function sniffImageDimensions(base64: string): ImageDimensions | null {
  // ~48KB of decoded header is enough for every sniffer above, including JPEGs whose
  // SOF sits behind large EXIF/APPn segments (segments are skipped by length).
  const slice = base64.slice(0, 65536);
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(slice.length % 4 === 0 ? slice : slice.slice(0, slice.length - (slice.length % 4))), c => c.charCodeAt(0));
  } catch {
    return null;
  }
  return pngDimensions(bytes) ?? jpegDimensions(bytes) ?? gifDimensions(bytes) ?? webpDimensions(bytes) ?? null;
}

export interface ImageBlockRef {
  /** The array holding the block (message content or tool_result content). */
  container: unknown[];
  index: number;
  base64: string | null;
}

function isImageBlock(block: unknown): block is { type: "image"; source: Record<string, unknown> } {
  return typeof block === "object" && block !== null && (block as { type?: unknown }).type === "image";
}

/** Collect refs to every image block in wire order (oldest first), descending into tool_result content. */
export function collectImageRefs(messages: unknown[]): ImageBlockRef[] {
  const refs: ImageBlockRef[] = [];
  const scanArray = (arr: unknown[]): void => {
    for (let i = 0; i < arr.length; i++) {
      const block = arr[i];
      if (isImageBlock(block)) {
        const source = block.source as { type?: unknown; data?: unknown };
        refs.push({
          container: arr,
          index: i,
          base64: source?.type === "base64" && typeof source.data === "string" ? source.data : null,
        });
      } else if (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "tool_result") {
        const content = (block as { content?: unknown }).content;
        if (Array.isArray(content)) scanArray(content);
      }
    }
  };
  for (const msg of messages) {
    const content = (msg as { content?: unknown })?.content;
    if (Array.isArray(content)) scanArray(content);
  }
  return refs;
}

function textify(ref: ImageBlockRef, text: string): void {
  ref.container[ref.index] = { type: "text", text };
}

/**
 * Textify only individually invalid images, independently of other messages.
 * Reject request-level overflow without dropping or degrading any valid history.
 */
export function enforceAnthropicImageLimits(messages: unknown[]): void {
  const refs = collectImageRefs(messages);
  if (refs.length === 0) return;
  if (refs.length > MAX_IMAGES_PER_REQUEST) {
    throw new AnthropicImageLimitError("anthropic_image_count_exceeded", `Anthropic accepts at most ${MAX_IMAGES_PER_REQUEST} images per request.`);
  }

  const dims = refs.map(r => (r.base64 ? sniffImageDimensions(r.base64) : null));
  const live = new Set<number>(refs.keys());

  // Rule 1: images over the absolute 8000px cap are invalid in any request.
  for (let i = 0; i < refs.length; i++) {
    const d = dims[i];
    if (d && (d.width > ABSOLUTE_MAX_DIMENSION || d.height > ABSOLUTE_MAX_DIMENSION)) {
      textify(refs[i], OVERSIZED_TEXT);
      live.delete(i);
    }
  }

  // Rule 1b: images over the 5MiB per-image cap (base64 chars) are invalid in any request.
  for (let i = 0; i < refs.length; i++) {
    if (!live.has(i)) continue;
    const b64 = refs[i].base64;
    if (b64 && b64.length > MAX_IMAGE_BASE64_LENGTH) {
      textify(refs[i], PER_IMAGE_TOO_LARGE_TEXT);
      live.delete(i);
    }
  }

  // Unknown URL dimensions cannot prove admission for a many-image request.
  const hasRiskyForMany = [...live].some(i => {
    const d = dims[i];
    return d === null || d.width > MANY_IMAGE_MAX_DIMENSION || d.height > MANY_IMAGE_MAX_DIMENSION;
  });
  if (hasRiskyForMany && live.size > MANY_IMAGE_THRESHOLD) {
    throw new AnthropicImageLimitError("anthropic_image_dimensions_exceeded", "Requests with more than 20 images require known dimensions of at most 2000px per side.");
  }

  let base64Sum = 0;
  for (const i of live) base64Sum += refs[i].base64?.length ?? 0;
  if (base64Sum > TOTAL_IMAGE_BASE64_BUDGET) {
    throw new AnthropicImageLimitError("anthropic_image_budget_exceeded", "The total Anthropic image payload exceeds 20 MiB of base64 data.");
  }
}
