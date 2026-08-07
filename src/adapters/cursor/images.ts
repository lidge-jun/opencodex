import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import type { OcxContentPart, OcxImageContent, OcxMessage } from "../../types";
import { assessUrlDestination, resolvePublicAddresses } from "../../lib/destination-policy";
import { pinnedHttpsGet } from "../../images/artifacts";
import type { PinnedAddress } from "../../lib/pinned-http";
import {
  SelectedContextSchema,
  SelectedImageSchema,
  type SelectedContext,
  type SelectedImage,
} from "./gen/agent_pb";

/** Matches OmniRoute / composer-api per-image byte cap. */
export const MAX_CURSOR_IMAGE_BYTES = 1024 * 1024;

/** Upper bound on images attached to one Cursor turn. */
export const MAX_CURSOR_IMAGES = 12;

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
}

function isImagePart(part: OcxContentPart): part is OcxImageContent {
  return part.type === "image";
}

function estimatedBase64DecodedBytes(payload: string): number {
  return Math.floor((payload.length * 3) / 4);
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
  if (payload.length > MAX_CURSOR_IMAGE_BYTES * 2) {
    throw new CursorImageError("Image input is too large (max 1 MiB). Resize and retry.");
  }

  const normalized = payload.replace(/\s/g, "");
  if (estimatedBase64DecodedBytes(normalized) > MAX_CURSOR_IMAGE_BYTES) {
    throw new CursorImageError("Image input is too large (max 1 MiB). Resize and retry.");
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
      maxBytes: MAX_CURSOR_IMAGE_BYTES,
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
        if (total > MAX_CURSOR_IMAGE_BYTES) {
          throw new CursorImageError("Image input is too large (max 1 MiB). Resize and retry.");
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
  if (typeof content === "string" || !Array.isArray(content)) return [];
  const urls: string[] = [];
  for (const part of content) {
    if (isImagePart(part) && typeof part.imageUrl === "string" && part.imageUrl.length > 0) {
      urls.push(part.imageUrl);
    }
  }
  return urls;
}

/**
 * Resolve OpenCodex image parts (data: or https:) into bytes for SelectedImage.
 * Remote fetches reuse the repo SSRF destination policy + DNS-pinned HTTPS path.
 */
export async function resolveCursorImages(
  imageUrls: readonly string[],
  signal?: AbortSignal,
): Promise<ResolvedCursorImage[]> {
  if (imageUrls.length > MAX_CURSOR_IMAGES) {
    throw new CursorImageError(`Too many images in one request (max ${MAX_CURSOR_IMAGES}).`);
  }

  const out: ResolvedCursorImage[] = [];
  for (const url of imageUrls) {
    if (typeof url !== "string" || url.length === 0) {
      throw new CursorImageError("Image URL is missing.");
    }
    const resolved = url.toLowerCase().startsWith("data:")
      ? decodeDataUrl(url)
      : await fetchHttpsImageBytes(url, signal);
    if (resolved.data.byteLength === 0) {
      throw new CursorImageError("Image input is empty.");
    }
    if (resolved.data.byteLength > MAX_CURSOR_IMAGE_BYTES) {
      throw new CursorImageError("Image input is too large (max 1 MiB). Resize and retry.");
    }
    out.push({
      data: resolved.data,
      mimeType: resolved.mimeType,
      uuid: randomUUID(),
    });
  }
  return out;
}

/** Build SelectedImage messages with inline `data` (field 8), matching OmniRoute. */
export function buildSelectedImages(images: readonly ResolvedCursorImage[]): SelectedImage[] {
  return images.map(image => create(SelectedImageSchema, {
    uuid: image.uuid,
    mimeType: image.mimeType,
    dataOrBlobId: { case: "data", value: image.data },
  }));
}

/**
 * OmniRoute always sends `UserMessage.selected_context`, even when empty.
 * Cursor accepts the request without it, but vision turns are more reliable
 * when the placeholder matches cursor-agent's wire format.
 */
export function buildSelectedContext(images: readonly ResolvedCursorImage[] = []): SelectedContext {
  return create(SelectedContextSchema, {
    selectedImages: buildSelectedImages(images),
  });
}

/**
 * Resolve images for the active user/developer turn of a Cursor request.
 * History stays text-only; only the current UserMessageAction carries SelectedImage.
 */
export async function resolveActiveCursorImages(
  messages: readonly OcxMessage[] | undefined,
  signal?: AbortSignal,
): Promise<ResolvedCursorImage[]> {
  if (!messages?.length) return [];
  if (messages.at(-1)?.role === "toolResult") return [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    if (message.role === "user" || message.role === "developer") {
      return resolveCursorImages(extractCursorImageUrls(message.content), signal);
    }
  }
  return [];
}
