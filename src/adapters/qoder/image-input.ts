import type { OcxParsedRequest } from "../../types";
import { buildConversationInput } from "../coding-agent/protocol";

// Local resource policy: #7516 verifies a 96x96 PNG, not a vendor size maximum.
// 1 MiB leaves ample room over its 36 KiB RGBA raster while bounding stdin copies.
const MAX_CN_PNG_BYTES = 1024 * 1024;
const MAX_CN_PNG_EDGE = 8192;
const MAX_CN_PNG_PIXELS = 16_000_000;
const PNG_DATA_PREFIX = "data:image/png;base64,";
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_DEPTHS: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16],
};

function boundedPngDataUrl(imageUrl: string): boolean {
  // Bound encoded input before slicing, scanning, decoding or making stdin copies.
  if (!imageUrl.startsWith(PNG_DATA_PREFIX)
    || imageUrl.length > PNG_DATA_PREFIX.length + 4 * Math.ceil(MAX_CN_PNG_BYTES / 3)) return false;
  const data = imageUrl.slice(PNG_DATA_PREFIX.length);
  if (!data.length || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return false;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  if (data.length / 4 * 3 - padding > MAX_CN_PNG_BYTES) return false;
  const bytes = Buffer.from(data, "base64");
  // Bun's decoder is permissive; round-trip also rejects nonzero padding bits.
  if (bytes.toString("base64") !== data || bytes.length < 33
    || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
    || bytes.readUInt32BE(8) !== 13 || bytes.readUInt32BE(12) !== 0x49484452) return false;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  // Bound declared raster work before the child can decode compressed pixels.
  return width > 0 && width <= MAX_CN_PNG_EDGE && height > 0 && height <= MAX_CN_PNG_EDGE
    && width * height <= MAX_CN_PNG_PIXELS
    && (PNG_DEPTHS[bytes[25]!] ?? []).includes(bytes[24]!)
    && bytes[26] === 0 && bytes[27] === 0 && (bytes[28] === 0 || bytes[28] === 1);
}

/** #7516 live evidence: qoderclicn 1.1.70, one user PNG on stream-json stdin. */
export function qoderCnImageInputSupported(parsed: OcxParsedRequest): boolean {
  const messages = parsed.context.messages;
  const imageMessages = messages.filter(message => Array.isArray(message.content)
    && message.content.some(part => part.type === "image"));
  if (imageMessages.length === 0) return true;
  const nonDev = messages.filter(message => message.role !== "developer");
  if (imageMessages.length !== 1 || nonDev.length !== 1 || imageMessages[0] !== nonDev[0]
    || nonDev[0]!.role !== "user"
    || !["DeepSeek-Flash", "Qwen3.8-Flash"].includes(parsed.modelId)) return false;
  const content = nonDev[0]!.content;
  if (!Array.isArray(content)) return false;
  const images = content.filter(part => part.type === "image");
  return images.length === 1 && boundedPngDataUrl(images[0]!.imageUrl);
}

/** Keep Qoder omission markers out of CodeBuddy's and Claude's replay formats. */
export const buildQoderConversationInput: typeof buildConversationInput = (parsed, options = {}) =>
  buildConversationInput(parsed, { ...options, markUnsupportedImages: true });
