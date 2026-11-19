import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

const MIN_BYTES = 128 * 1024;
const MAX_SYNC_BYTES = 16 * 1024 * 1024;
/**
 * The envelope marker. A dedicated key, never `version`: the payload owns `version`
 * (`RESPONSE_SPILL_VERSION` in spill-store.ts), so a future payload version can never be
 * mistaken for a compressed record.
 */
const CODEC_KEY = "ocxSpillCodec";
const CODEC_ZSTD = "zstd/1";
const ENVELOPE_KEYS = [CODEC_KEY, "decodedBytes", "data"];
export function responseSpillCodecInfo() {
  return { codec: CODEC_ZSTD, minEncodeBytes: MIN_BYTES, maxSyncEncodeBytes: MAX_SYNC_BYTES };
}
type Decoded = { ok: true; payload: unknown } | { ok: false; reason: "corrupt" | "too_large" };

/** Self-contained records preserve response-id replay without parent-file dependencies. */
export function encodeResponseSpill(bytes: Buffer, decodedLimit: number): Buffer {
  if (bytes.byteLength < MIN_BYTES || bytes.byteLength > Math.min(MAX_SYNC_BYTES, decodedLimit)) return bytes;
  try {
    const compressed = zstdCompressSync(bytes, { params: {
      [constants.ZSTD_c_compressionLevel]: 1,
      [constants.ZSTD_c_windowLog]: 20,
    } });
    // Include the base64 and JSON overhead in the savings decision.
    const envelope = Buffer.from(JSON.stringify({ [CODEC_KEY]: CODEC_ZSTD,
      decodedBytes: bytes.byteLength, data: compressed.toString("base64") }), "utf8");
    return envelope.byteLength <= bytes.byteLength * 0.875 ? envelope : bytes;
  } catch {
    // A codec failure must not make an otherwise valid continuation unretainable.
    return bytes;
  }
}

/** The caller has already verified the physical file size and content digest. */
export function decodeResponseSpill(bytes: Buffer, decodedLimit: number): Decoded {
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)
      || !Object.hasOwn(value, CODEC_KEY)) return { ok: true, payload: value };
    const envelope = value as Record<string, unknown>;
    if (Object.keys(envelope).some(key => !ENVELOPE_KEYS.includes(key))
      || envelope[CODEC_KEY] !== CODEC_ZSTD || typeof envelope.decodedBytes !== "number"
      || !Number.isSafeInteger(envelope.decodedBytes) || envelope.decodedBytes <= 0
      || typeof envelope.data !== "string") return { ok: false, reason: "corrupt" };
    if (envelope.decodedBytes > decodedLimit) return { ok: false, reason: "too_large" };
    const data = envelope.data;
    if (!data.length || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
      return { ok: false, reason: "corrupt" };
    }
    const decoded = zstdDecompressSync(Buffer.from(data, "base64"), { maxOutputLength: envelope.decodedBytes });
    if (decoded.byteLength !== envelope.decodedBytes) return { ok: false, reason: "corrupt" };
    // Only one envelope is accepted. Nested compressed records never recurse.
    return { ok: true, payload: JSON.parse(decoded.toString("utf8")) as unknown };
  } catch {
    return { ok: false, reason: "corrupt" };
  }
}
