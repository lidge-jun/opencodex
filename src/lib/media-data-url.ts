/**
 * The one decoder for a media `data:` URL.
 *
 * Inline video used to be read three ways: input admission sized it, the input guard parsed it
 * and the Gemini builder parsed it again, and each pass disagreed with the others about header
 * flags, URL escapes and base64 padding (review rounds 4 to 6 on #9131). Every consumer now calls
 * `parseMediaDataUrl` and uses its result: admission charges `decodedBytes`, the guard refuses on
 * `ok: false`, and the Gemini and translated-Chat builders send `mime` and `base64` from it.
 *
 * Exactly one form is accepted:
 *
 *     data:<type>/<subtype>[;<attribute>=<value>]...;base64,<payload>
 *
 * `<payload>` is standard-alphabet base64 whose length is a multiple of four, with at most two
 * `=` and only at the end, and whose unused trailing bits are zero, which is exactly the set of
 * strings that decode and re-encode to themselves. URL escapes, whitespace, the URL-safe alphabet,
 * unpadded or over-padded payloads and a non-terminal `;base64` are refused, so no consumer has
 * to unescape or normalize anything, and the `base64` it sends is canonical by construction.
 *
 * Validation is one pass over the payload with no allocation, and the size cap is applied from
 * the payload length before that pass, so an oversized string is never scanned or decoded.
 * `decodeMediaDataUrl` performs the strict decode (decode, re-encode, compare) for a caller that
 * needs the bytes; `tests/lib/media-data-url.test.ts` proves the one-pass check accepts exactly
 * what that decode accepts. No consumer decodes on the request path: the wires take base64.
 */

export type MediaDataUrlRefusal =
  | "not_data_url"
  | "malformed_header"
  | "not_base64"
  | "too_large"
  | "malformed_payload";

export type ParsedMediaDataUrl =
  | {
    ok: true;
    /** `type/subtype`, lower-cased, without parameters. */
    mime: string;
    /** The canonical standard base64 payload. */
    base64: string;
    decodedBytes: number;
  }
  | {
    ok: false;
    reason: MediaDataUrlRefusal;
    /** Present when the payload length alone determines it (`too_large` included). */
    decodedBytes?: number;
  };

const TOKEN = "[A-Za-z0-9!#$&^_.+-]+";
const HEADER = new RegExp(`^(${TOKEN}/${TOKEN})((?:;${TOKEN}=${TOKEN})*);base64$`, "i");
/** Parse and validate; `maxBytes` caps the decoded size (default: no cap). */
export function parseMediaDataUrl(url: string, options: { maxBytes?: number } = {}): ParsedMediaDataUrl {
  // The scheme is case-insensitive (RFC 2397); a "DATA:" URL must not pass as a remote reference.
  if (url.slice(0, 5).toLowerCase() !== "data:") return { ok: false, reason: "not_data_url" };
  const comma = url.indexOf(",");
  if (comma < 0) return { ok: false, reason: "malformed_header" };
  const header = url.slice(5, comma);
  const match = HEADER.exec(header);
  if (!match) {
    // A header that names base64 somewhere but not in the one accepted place is malformed; one
    // that never names it is a plain (percent-encoded or raw) payload.
    const parameters = header.split(";").slice(1).map(parameter => parameter.trim().toLowerCase());
    return { ok: false, reason: parameters.includes("base64") ? "malformed_header" : "not_base64" };
  }
  const start = comma + 1;
  const length = url.length - start;
  if (length === 0 || length % 4 !== 0) return { ok: false, reason: "malformed_payload" };
  const padding = url.endsWith("==") ? 2 : url.endsWith("=") ? 1 : 0;
  const decodedBytes = (length / 4) * 3 - padding;
  if (options.maxBytes !== undefined && decodedBytes > options.maxBytes) return { ok: false, reason: "too_large", decodedBytes };
  const end = url.length - padding;
  for (let i = start; i < end; i++) {
    if (sextet(url.charCodeAt(i)) < 0) return { ok: false, reason: "malformed_payload", decodedBytes };
  }
  // Canonical: the bits a padded final quantum leaves unused must be zero, or the payload decodes
  // to the same bytes as a different string and would not survive a re-encode.
  if (padding === 2 && (sextet(url.charCodeAt(end - 1)) & 0x0f) !== 0) return { ok: false, reason: "malformed_payload", decodedBytes };
  if (padding === 1 && (sextet(url.charCodeAt(end - 1)) & 0x03) !== 0) return { ok: false, reason: "malformed_payload", decodedBytes };
  return { ok: true, mime: match[1]!.toLowerCase(), base64: url.slice(start), decodedBytes };
}

/**
 * The bytes of an accepted URL, decoded strictly: the decode is re-encoded and compared, and a
 * mismatch throws. Not used on the request path, where every wire takes the base64 itself.
 */
export function decodeMediaDataUrl(parsed: Extract<ParsedMediaDataUrl, { ok: true }>): Uint8Array {
  const bytes = Buffer.from(parsed.base64, "base64");
  if (bytes.toString("base64") !== parsed.base64) throw new Error("media data URL payload is not canonical base64");
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** The value of one standard base64 character, or -1. */
function sextet(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return -1;
}
