/**
 * Pure byte-level validators, RFC 8259 JSON string/key scanners, and Codex TOML byte parser
 * for keyless CC-Switch provider import.
 */
export class CcSwitchImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CcSwitchImportError";
  }
}

export type CcSwitchInvalidReason =
  | "missing_base_url"
  | "invalid_base_url"
  | "private_network_refused"
  | "invalid_provider_name"
  | "unsupported_app_type"
  | "ambiguous_codex_provider"
  | "disallowed_metadata"
  | "malformed_entry";

export const METADATA_REFUSED_SENTINEL = "__METADATA_REFUSED__";
export const URL_SYNTAX_REFUSED_SENTINEL = "__URL_REFUSED__";
const MAX_SQLITE_BYTES = 32 * 1024 * 1024;
export const MAX_CODEX_TOML_BYTES = 64 * 1024;

export type MetadataFieldKind = "id" | "app" | "model" | "url" | "wire";

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

function isDigitByte(b: number): boolean {
  return b >= 0x30 && b <= 0x39;
}
function isLowerByte(b: number): boolean {
  return b >= 0x61 && b <= 0x7a;
}
function isUpperByte(b: number): boolean {
  return b >= 0x41 && b <= 0x5a;
}
function isAlphaByte(b: number): boolean {
  return isLowerByte(b) || isUpperByte(b);
}
function isHexByte(b: number): boolean {
  return isDigitByte(b) || (b >= 0x61 && b <= 0x66) || (b >= 0x41 && b <= 0x46);
}
function toLowerByte(b: number): number {
  return isUpperByte(b) ? b + 32 : b;
}

export function equalsAsciiBytes(slice: Uint8Array, ascii: string): boolean {
  if (slice.length !== ascii.length) return false;
  for (let i = 0; i < ascii.length; i++) {
    if (slice[i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
}

export function parseHex4Bytes(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) return -1;
  let out = 0;
  for (let i = 0; i < 4; i++) {
    const b = bytes[offset + i]!;
    let v: number;
    if (b >= 0x30 && b <= 0x39) v = b - 0x30;
    else if (b >= 0x41 && b <= 0x46) v = b - 0x41 + 10;
    else if (b >= 0x61 && b <= 0x66) v = b - 0x61 + 10;
    else return -1;
    out = (out << 4) | v;
  }
  return out;
}

export function encodeCodePointUtf8(cp: number, target: Uint8Array, offset: number): number {
  if (cp <= 0x7f) {
    target[offset] = cp;
    return 1;
  }
  if (cp <= 0x7ff) {
    target[offset] = 0xc0 | (cp >> 6);
    target[offset + 1] = 0x80 | (cp & 0x3f);
    return 2;
  }
  if (cp <= 0xffff) {
    target[offset] = 0xe0 | (cp >> 12);
    target[offset + 1] = 0x80 | ((cp >> 6) & 0x3f);
    target[offset + 2] = 0x80 | (cp & 0x3f);
    return 3;
  }
  target[offset] = 0xf0 | (cp >> 18);
  target[offset + 1] = 0x80 | ((cp >> 12) & 0x3f);
  target[offset + 2] = 0x80 | ((cp >> 6) & 0x3f);
  target[offset + 3] = 0x80 | (cp & 0x3f);
  return 4;
}

/**
 * Strict RFC 8259 + UTF-8 byte-level JSON string validator.
 * Validates escapes (including paired UTF-16 surrogates) and multi-byte UTF-8 sequences
 * without decoding string contents into JavaScript strings.
 */
export function validateUtf8AndJsonStringBounds(
  bytes: Uint8Array,
  quotePos: number,
): { start: number; end: number; hasEscapes: boolean; nextPos: number } | null {
  if (quotePos >= bytes.length || bytes[quotePos] !== 0x22) return null;
  let pos = quotePos + 1;
  const start = pos;
  let hasEscapes = false;
  while (pos < bytes.length) {
    const b = bytes[pos]!;
    if (b < 0x20) return null;
    if (b === 0x22) {
      return { start, end: pos, hasEscapes, nextPos: pos + 1 };
    }
    if (b === 0x5c) {
      hasEscapes = true;
      pos++;
      if (pos >= bytes.length) return null;
      const esc = bytes[pos]!;
      pos++;
      if (
        esc === 0x22 || esc === 0x5c || esc === 0x2f
        || esc === 0x62 || esc === 0x66 || esc === 0x6e || esc === 0x72 || esc === 0x74
      ) {
        continue;
      }
      if (esc === 0x75) {
        const cu = parseHex4Bytes(bytes, pos);
        if (cu < 0) return null;
        pos += 4;
        if (cu >= 0xdc00 && cu <= 0xdfff) return null;
        if (cu >= 0xd800 && cu <= 0xdbff) {
          if (pos + 6 > bytes.length || bytes[pos] !== 0x5c || bytes[pos + 1] !== 0x75) return null;
          const low = parseHex4Bytes(bytes, pos + 2);
          if (low < 0xdc00 || low > 0xdfff) return null;
          pos += 6;
        }
        continue;
      }
      return null;
    }
    if (b < 0x80) {
      pos++;
      continue;
    }
    if (b >= 0xc2 && b <= 0xdf) {
      if (pos + 1 >= bytes.length) return null;
      const c1 = bytes[pos + 1]!;
      if ((c1 & 0xc0) !== 0x80) return null;
      pos += 2;
      continue;
    }
    if (b >= 0xe0 && b <= 0xef) {
      if (pos + 2 >= bytes.length) return null;
      const c1 = bytes[pos + 1]!;
      const c2 = bytes[pos + 2]!;
      if ((c1 & 0xc0) !== 0x80 || (c2 & 0xc0) !== 0x80) return null;
      if (b === 0xe0 && c1 < 0xa0) return null;
      if (b === 0xed && c1 >= 0xa0) return null;
      pos += 3;
      continue;
    }
    if (b >= 0xf0 && b <= 0xf4) {
      if (pos + 3 >= bytes.length) return null;
      const c1 = bytes[pos + 1]!;
      const c2 = bytes[pos + 2]!;
      const c3 = bytes[pos + 3]!;
      if ((c1 & 0xc0) !== 0x80 || (c2 & 0xc0) !== 0x80 || (c3 & 0xc0) !== 0x80) return null;
      if (b === 0xf0 && c1 < 0x90) return null;
      if (b === 0xf4 && c1 > 0x8f) return null;
      pos += 4;
      continue;
    }
    return null;
  }
  return null;
}

export function validateJsonPrimitiveBytes(bytes: Uint8Array, start: number, end: number): boolean {
  const slice = bytes.subarray(start, end);
  if (slice.length === 0) return false;
  if (equalsAsciiBytes(slice, "true") || equalsAsciiBytes(slice, "false") || equalsAsciiBytes(slice, "null")) {
    return true;
  }
  let i = 0;
  if (slice[i] === 0x2d) {
    i++;
    if (i >= slice.length) return false;
  }
  if (slice[i] === 0x30) {
    i++;
  } else if (slice[i]! >= 0x31 && slice[i]! <= 0x39) {
    while (i < slice.length && isDigitByte(slice[i]!)) i++;
  } else {
    return false;
  }
  if (i < slice.length && slice[i] === 0x2e) {
    i++;
    if (i >= slice.length || !isDigitByte(slice[i]!)) return false;
    while (i < slice.length && isDigitByte(slice[i]!)) i++;
  }
  if (i < slice.length && (slice[i] === 0x65 || slice[i] === 0x45)) {
    i++;
    if (i < slice.length && (slice[i] === 0x2b || slice[i] === 0x2d)) i++;
    if (i >= slice.length || !isDigitByte(slice[i]!)) return false;
    while (i < slice.length && isDigitByte(slice[i]!)) i++;
  }
  return i === slice.length;
}

export function unescapeJsonStringBytesBounded(
  bytes: Uint8Array,
  bounds: { start: number; end: number; hasEscapes: boolean },
  maxBytes: number,
): Uint8Array | null {
  const rawLen = bounds.end - bounds.start;
  if (rawLen > maxBytes * 6) return null;
  const out = new Uint8Array(Math.max(rawLen, 4));
  let r = bounds.start;
  let w = 0;
  while (r < bounds.end) {
    const b = bytes[r]!;
    if (b !== 0x5c) {
      out[w++] = b;
      r++;
      continue;
    }
    r++;
    const esc = bytes[r]!;
    r++;
    if (esc === 0x22 || esc === 0x5c || esc === 0x2f) out[w++] = esc;
    else if (esc === 0x62) out[w++] = 0x08;
    else if (esc === 0x66) out[w++] = 0x0c;
    else if (esc === 0x6e) out[w++] = 0x0a;
    else if (esc === 0x72) out[w++] = 0x0d;
    else if (esc === 0x74) out[w++] = 0x09;
    else if (esc === 0x75) {
      let cp = parseHex4Bytes(bytes, r);
      if (cp < 0) { out.fill(0); return null; }
      r += 4;
      if (cp >= 0xd800 && cp <= 0xdbff) {
        const low = parseHex4Bytes(bytes, r + 2);
        if (low < 0xdc00 || low > 0xdfff) { out.fill(0); return null; }
        r += 6;
        cp = ((cp - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
      } else if (cp >= 0xdc00 && cp <= 0xdfff) {
        out.fill(0);
        return null;
      }
      w += encodeCodePointUtf8(cp, out, w);
    } else {
      out.fill(0);
      return null;
    }
  }
  if (w > maxBytes) {
    out.fill(0);
    return null;
  }
  const result = new Uint8Array(w);
  result.set(out.subarray(0, w));
  out.fill(0);
  return result;
}

export function matchKnownJsonKeyBytes<T extends string>(
  bytes: Uint8Array,
  bounds: { start: number; end: number; hasEscapes: boolean },
  allowed: readonly T[],
): T | null {
  if (!bounds.hasEscapes) {
    const raw = bytes.subarray(bounds.start, bounds.end);
    for (const candidate of allowed) {
      if (equalsAsciiBytes(raw, candidate)) return candidate;
    }
    return null;
  }
  const unescaped = unescapeJsonStringBytesBounded(bytes, bounds, 48);
  if (!unescaped) return null;
  try {
    for (const candidate of allowed) {
      if (equalsAsciiBytes(unescaped, candidate)) return candidate;
    }
    return null;
  } finally {
    unescaped.fill(0);
  }
}

const FORBIDDEN_SUBSTRINGS_LOWER = [
  "sk-", "rk-", "pk-", "ak-", "ghp_", "gho_", "github_pat_", "xoxb-", "xoxp-", "xoxa-", "xoxr-", "xoxs-",
  "aiza", "eyj", "bearer", "secret", "apikey", "api_key", "passwd", "password", "private_key",
  "access_token", "refresh_token", "auth_token",
].map(s => Buffer.from(s, "ascii"));

function containsForbiddenBytes(slice: Uint8Array): boolean {
  for (const pat of FORBIDDEN_SUBSTRINGS_LOWER) {
    if (slice.length < pat.length) continue;
    for (let i = 0; i <= slice.length - pat.length; i++) {
      let match = true;
      for (let j = 0; j < pat.length; j++) {
        if (toLowerByte(slice[i + j]!) !== pat[j]!) {
          match = false;
          break;
        }
      }
      if (match) return true;
    }
  }
  // Reject 3+ grouped 4-hex segments like a1b2-c3d4-e5f6 (UUID / grouped hex key).
  if (slice.length >= 14) {
    for (let i = 0; i <= slice.length - 14; i++) {
      if (
        isHexByte(slice[i]!) && isHexByte(slice[i + 1]!) && isHexByte(slice[i + 2]!) && isHexByte(slice[i + 3]!)
        && slice[i + 4] === 0x2d
        && isHexByte(slice[i + 5]!) && isHexByte(slice[i + 6]!) && isHexByte(slice[i + 7]!) && isHexByte(slice[i + 8]!)
        && slice[i + 9] === 0x2d
        && isHexByte(slice[i + 10]!) && isHexByte(slice[i + 11]!) && isHexByte(slice[i + 12]!) && isHexByte(slice[i + 13]!)
      ) {
        return true;
      }
    }
  }
  return false;
}

const ALLOWED_API_TERMINAL_PATH_SEGMENTS = [
  "api", "openai", "anthropic", "codex", "chat", "responses", "gateway", "compat", "models", "inference", "llm", "proxy",
] as const;

function isCanonicalUuidBytes(slice: Uint8Array): boolean {
  if (slice.length !== 36) return false;
  for (let i = 0; i < 36; i++) {
    const b = slice[i]!;
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      if (b !== 0x2d) return false;
    } else if (!isHexByte(b)) {
      return false;
    }
  }
  return true;
}

function isModelParamSizeSeg(slice: Uint8Array, start: number, end: number): boolean {
  const n = end - start;
  if (n < 2 || n > 4 || slice[end - 1] !== 0x62) return false;
  const dStart = slice[start] === 0x61 ? start + 1 : start;
  if (dStart >= end - 1 || slice[dStart] === 0x30) return false;
  for (let k = dStart; k < end - 1; k++) if (!isDigitByte(slice[k]!)) return false;
  return true;
}

function isApiVersionSegmentBytes(seg: Uint8Array): boolean {
  // Matches v1..v9, v1.1, v1beta, v1beta1, etc.
  if (seg.length < 2 || seg.length > 10 || seg[0] !== 0x76 || !(seg[1]! >= 0x31 && seg[1]! <= 0x39)) {
    return false;
  }
  for (let i = 2; i < seg.length; i++) {
    const b = seg[i]!;
    if (!isLowerByte(b) && !isDigitByte(b) && b !== 0x2e) return false;
  }
  return seg[seg.length - 1] !== 0x2e;
}

function isAllowedTerminalUrlSegmentBytes(seg: Uint8Array): boolean {
  if (isApiVersionSegmentBytes(seg)) return true;
  for (const allowed of ALLOWED_API_TERMINAL_PATH_SEGMENTS) {
    if (equalsAsciiBytes(seg, allowed)) return true;
  }
  return false;
}

function validateAuthorityBytes(auth: Uint8Array): boolean {
  if (auth.length === 0 || auth.length > 190) return false;
  let hostEnd = auth.length;
  if (auth[0] === 0x5b) {
    // Bracketed IPv6 literal: [hex:...] with optional :port
    let closeIdx = -1;
    let sawColon = false;
    for (let i = 1; i < auth.length; i++) {
      const b = auth[i]!;
      if (b === 0x5d) { closeIdx = i; break; }
      if (b === 0x3a) sawColon = true;
      else if (!isHexByte(b) && b !== 0x2e) return false;
    }
    if (closeIdx < 3 || !sawColon) return false;
    if (closeIdx === auth.length - 1) return true;
    if (auth[closeIdx + 1] !== 0x3a) return false;
    hostEnd = closeIdx + 1;
  } else {
    const colonIdx = auth.indexOf(0x3a);
    if (colonIdx === 0) return false;
    const host = colonIdx > 0 ? auth.subarray(0, colonIdx) : auth;
    if (host.length === 0 || host.length > 180) return false;
    if (host[0] === 0x2e || host[0] === 0x2d || host[host.length - 1] === 0x2d) return false;
    for (let i = 0; i < host.length; i++) {
      const b = host[i]!;
      if (!isAlphaByte(b) && !isDigitByte(b) && b !== 0x2e && b !== 0x2d) return false;
      if (b === 0x2e && i > 0 && host[i - 1] === 0x2e) return false;
    }
    if (colonIdx < 0) return true;
    hostEnd = colonIdx;
  }
  // Validate :port (1..65535)
  const portSlice = auth.subarray(hostEnd + 1);
  if (portSlice.length === 0 || portSlice.length > 5) return false;
  let port = 0;
  for (let i = 0; i < portSlice.length; i++) {
    const b = portSlice[i]!;
    if (!isDigitByte(b)) return false;
    port = port * 10 + (b - 0x30);
  }
  return port >= 1 && port <= 65535;
}

/**
 * Byte-level syntax & defense-in-depth validation enforced BEFORE decoding into a JavaScript string.
 * Note: the primary security boundary is structural (secret-named fields are never read); this
 * enforces narrow URL/identifier/model syntax as defense in depth.
 */
export function isAllowedMetadataBytes(slice: Uint8Array, kind: MetadataFieldKind): boolean {
  const len = slice.length;
  if (len === 0) return false;
  for (let i = 0; i < len; i++) {
    const b = slice[i]!;
    if (b <= 0x20 || b >= 0x7f) return false;
  }
  // CC-Switch generates canonical 36-char randomUUID() primary keys for custom providers.
  if (kind === "id" && isCanonicalUuidBytes(slice)) return true;
  if (containsForbiddenBytes(slice)) return false;

  if (kind === "app") {
    if (len > 16) return false;
    let hasLower = false;
    let hasUpper = false;
    for (let i = 0; i < len; i++) {
      const b = slice[i]!;
      if (!isAlphaByte(b) && b !== 0x2d && b !== 0x5f) return false;
      if (isLowerByte(b)) hasLower = true;
      if (isUpperByte(b)) hasUpper = true;
    }
    if (len >= 10 && hasLower && hasUpper) return false;
    return true;
  }

  if (kind === "wire") {
    if (len > 24) return false;
    for (let i = 0; i < len; i++) {
      const b = slice[i]!;
      if (!isAlphaByte(b) && b !== 0x2d && b !== 0x5f) return false;
    }
    return true;
  }

  if (kind === "url") {
    if (len < 8 || len > 256) return false;
    // Must start with http:// or https://
    const isHttp =
      toLowerByte(slice[0]!) === 0x68 && toLowerByte(slice[1]!) === 0x74 && toLowerByte(slice[2]!) === 0x74
      && toLowerByte(slice[3]!) === 0x70;
    if (!isHttp) return false;
    let schemeEnd = 4;
    if (toLowerByte(slice[4]!) === 0x73) schemeEnd = 5;
    if (slice[schemeEnd] !== 0x3a || slice[schemeEnd + 1] !== 0x2f || slice[schemeEnd + 2] !== 0x2f) return false;

    let firstPathSlash = -1;
    for (let i = schemeEnd + 3; i < len; i++) {
      const b = slice[i]!;
      // Reject @, ?, #, %, ~, quotes, backslashes
      if (b === 0x40 || b === 0x3f || b === 0x23 || b === 0x25 || b === 0x7e || b === 0x22 || b === 0x27 || b === 0x5c) return false;
      if (b === 0x2f && firstPathSlash < 0) firstPathSlash = i;
    }
    const authorityEnd = firstPathSlash >= 0 ? firstPathSlash : len;
    if (!validateAuthorityBytes(slice.subarray(schemeEnd + 3, authorityEnd))) return false;
    if (firstPathSlash < 0) return true;
    const pathLen = len - firstPathSlash;
    if (pathLen === 1) return true;
    if (pathLen > 48) return false;

    const pathEnd = slice[len - 1] === 0x2f ? len - 1 : len;
    if (pathEnd <= firstPathSlash + 1) return false; // Reject "//"
    let segStart = firstPathSlash + 1;
    let segCount = 0;
    let totalPathDigits = 0;
    let lastSeg: Uint8Array | null = null;
    for (let i = firstPathSlash + 1; i <= pathEnd; i++) {
      if (i < pathEnd && slice[i] !== 0x2f) continue;
      const segLen = i - segStart;
      if (segLen <= 0 || segLen > 20) return false; // Reject empty interior segment "//"
      segCount++;
      if (segCount > 4) return false;
      const seg = slice.subarray(segStart, i);
      if (equalsAsciiBytes(seg, ".") || equalsAsciiBytes(seg, "..")) return false;
      const firstB = seg[0]!;
      const lastB = seg[segLen - 1]!;
      if ((!isLowerByte(firstB) && !isDigitByte(firstB)) || (!isLowerByte(lastB) && !isDigitByte(lastB))) {
        return false;
      }
      let segDigits = 0;
      let segHex = true;
      for (let k = 0; k < segLen; k++) {
        const b = seg[k]!;
        // Strict lowercase [a-z0-9._-] path grammar only
        if (!isLowerByte(b) && !isDigitByte(b) && b !== 0x2e && b !== 0x2d && b !== 0x5f) return false;
        if (isDigitByte(b)) segDigits++;
        if (!isHexByte(b)) segHex = false;
      }
      totalPathDigits += segDigits;
      if (segDigits >= 3) return false;
      if (segHex && segLen >= 8) return false;
      lastSeg = seg;
      segStart = i + 1;
    }
    if (totalPathDigits > 2) return false;
    return lastSeg !== null && isAllowedTerminalUrlSegmentBytes(lastSeg);
  }

  // kind === "id" or "model"
  const maxLen = kind === "id" ? 48 : 80;
  if (len > maxLen) return false;
  let sepCount = 0;
  let totalDigits = 0;
  for (let i = 0; i < len; i++) {
    const b = slice[i]!;
    const isSep = b === 0x2d || b === 0x5f || b === 0x2e || (kind === "model" && (b === 0x2f || b === 0x3a));
    if (isSep) {
      sepCount++;
      continue;
    }
    if (!isAlphaByte(b) && !isDigitByte(b)) return false;
    if (isDigitByte(b)) totalDigits++;
  }
  if (sepCount === 0 && len >= 16) return false;
  if (kind === "id" && totalDigits > 5) return false;

  let segStart = 0;
  let mixedDigitsTotal = 0;
  let nonDateDigits = totalDigits;
  let usedDateExemption = false;
  let skipHyphenDateParts = 0;
  let paramSizeSegs = 0;
  for (let i = 0; i <= len; i++) {
    const b = i < len ? slice[i]! : 0x2d;
    const isSep = i === len || b === 0x2d || b === 0x5f || b === 0x2e || b === 0x2f || b === 0x3a;
    if (!isSep) continue;
    const segLen = i - segStart;
    if (segLen > 16) return false;
    if (segLen > 0) {
      let segDigits = 0;
      let segAllDigits = true;
      let segHex = true;
      let hasLower = false;
      let hasUpper = false;
      for (let k = segStart; k < i; k++) {
        const cb = slice[k]!;
        if (isDigitByte(cb)) segDigits++;
        else segAllDigits = false;
        if (!isHexByte(cb)) segHex = false;
        if (isLowerByte(cb)) hasLower = true;
        if (isUpperByte(cb)) hasUpper = true;
      }
      if (segAllDigits) {
        if (skipHyphenDateParts > 0) {
          skipHyphenDateParts--;
          segStart = i + 1;
          continue;
        }
        const isDate8 =
          kind === "model" && !usedDateExemption && segLen === 8
          && slice[segStart] === 0x32 && slice[segStart + 1] === 0x30
          && ((slice[segStart + 4]! - 0x30) * 10 + (slice[segStart + 5]! - 0x30)) >= 1
          && ((slice[segStart + 4]! - 0x30) * 10 + (slice[segStart + 5]! - 0x30)) <= 12
          && ((slice[segStart + 6]! - 0x30) * 10 + (slice[segStart + 7]! - 0x30)) >= 1
          && ((slice[segStart + 6]! - 0x30) * 10 + (slice[segStart + 7]! - 0x30)) <= 31;
        const isHyphenDate =
          kind === "model" && !usedDateExemption && segLen === 4
          && slice[segStart] === 0x32 && slice[segStart + 1] === 0x30
          && segStart + 10 <= len && slice[segStart + 4] === 0x2d && slice[segStart + 7] === 0x2d
          && isDigitByte(slice[segStart + 5]!) && isDigitByte(slice[segStart + 6]!)
          && isDigitByte(slice[segStart + 8]!) && isDigitByte(slice[segStart + 9]!)
          && ((slice[segStart + 5]! - 0x30) * 10 + (slice[segStart + 6]! - 0x30)) >= 1
          && ((slice[segStart + 5]! - 0x30) * 10 + (slice[segStart + 6]! - 0x30)) <= 12
          && ((slice[segStart + 8]! - 0x30) * 10 + (slice[segStart + 9]! - 0x30)) >= 1
          && ((slice[segStart + 8]! - 0x30) * 10 + (slice[segStart + 9]! - 0x30)) <= 31
          && (segStart + 10 === len || [0x2d, 0x5f, 0x2e, 0x2f, 0x3a].includes(slice[segStart + 10]!));
        if (isDate8) {
          usedDateExemption = true;
          nonDateDigits -= 8;
        } else if (isHyphenDate) {
          usedDateExemption = true;
          skipHyphenDateParts = 2;
          nonDateDigits -= 8;
        } else if (segLen > 4) {
          return false;
        }
      } else {
        if (kind === "model" && paramSizeSegs < 2 && isModelParamSizeSeg(slice, segStart, i)) {
          paramSizeSegs++;
          nonDateDigits -= segDigits;
          segStart = i + 1;
          continue;
        }
        if (segHex && segLen >= 10) return false;
        if (segDigits >= 4) return false;
        if (segLen >= 10 && hasLower && hasUpper && segDigits >= 1) return false;
        mixedDigitsTotal += segDigits;
      }
    }
    segStart = i + 1;
  }
  if (kind === "model" && nonDateDigits > 8) return false;
  if (mixedDigitsTotal >= 5) return false;
  return true;
}

export function isDisallowedMetadataValue(value: string, kind: MetadataFieldKind): boolean {
  if (value === METADATA_REFUSED_SENTINEL || value === URL_SYNTAX_REFUSED_SENTINEL || hasControlChars(value)) return true;
  const bytes = Buffer.from(value, "utf8");
  try {
    return !isAllowedMetadataBytes(bytes, kind);
  } finally {
    bytes.fill(0);
  }
}

/**
 * Syntax-aware, single-line TOML projection for Codex settings_config.config.
 * Operates on a transient UTF-8 byte buffer (zeroed by the caller in finally) and decodes ONLY:
 * - [table] headers (bare or quoted)
 * - root model, model_provider, base_url, openai_base_url, wire_api
 * - [model_providers.<key>] base_url and wire_api
 * Rejects triple-quoted strings, inline tables, arrays, unclosed quotes, or non-assignment lines.
 */
export interface CodexTomlProjection {
  model?: string;
  modelProvider?: string;
  rootBaseUrl?: string;
  rootWireApi?: string;
  providers: Map<string, { baseUrl?: string; wireApi?: string }>;
}

const ALLOWED_TOML_KEYS = ["model", "model_provider", "base_url", "openai_base_url", "wire_api"] as const;
type AllowedTomlKey = (typeof ALLOWED_TOML_KEYS)[number];

function tomlKeyMetadataKind(key: AllowedTomlKey): MetadataFieldKind {
  if (key === "model") return "model";
  if (key === "model_provider") return "id";
  if (key === "wire_api") return "wire";
  return "url";
}

/**
 * Unescape a single-line TOML quoted string slice (without surrounding quotes) into a transient
 * Uint8Array. Caller must zero `out` in finally.
 */
export function unescapeTomlStringBytes(
  raw: Uint8Array,
  quoteByte: number,
): Uint8Array | null {
  const out = new Uint8Array(raw.length);
  let r = 0;
  let w = 0;
  while (r < raw.length) {
    const b = raw[r]!;
    if (b < 0x20 || b === 0x7f) {
      out.fill(0);
      return null;
    }
    if (quoteByte === 0x22 && b === 0x5c) {
      r++;
      if (r >= raw.length) { out.fill(0); return null; }
      const esc = raw[r]!;
      r++;
      if (esc === 0x22 || esc === 0x5c || esc === 0x2f) out[w++] = esc;
      else if (esc === 0x6e || esc === 0x72 || esc === 0x74 || esc === 0x62 || esc === 0x66) {
        out.fill(0);
        return null; // Control escapes are never valid in provider IDs, models, wire APIs, or URLs.
      } else if (esc === 0x75) {
        const cp = parseHex4Bytes(raw, r);
        if (cp <= 0x20 || cp >= 0x7f) { out.fill(0); return null; }
        r += 4;
        w += encodeCodePointUtf8(cp, out, w);
      } else {
        out.fill(0);
        return null;
      }
      continue;
    }
    out[w++] = b;
    r++;
  }
  return out.subarray(0, w);
}

function hasOnlyCommentOrSpaceBytes(slice: Uint8Array, fromIndex: number): boolean {
  let i = fromIndex;
  while (i < slice.length && (slice[i] === 0x20 || slice[i] === 0x09)) i++;
  return i >= slice.length || slice[i] === 0x23;
}

function findQuotedEndInBytes(slice: Uint8Array, quoteStart: number): number {
  const q = slice[quoteStart]!;
  if (q !== 0x22 && q !== 0x27) return -1;
  if (quoteStart + 2 < slice.length && slice[quoteStart + 1] === q && slice[quoteStart + 2] === q) {
    return -1; // Triple-quoted strings are forbidden.
  }
  let i = quoteStart + 1;
  while (i < slice.length) {
    const b = slice[i]!;
    if (b < 0x20 || b === 0x7f) return -1;
    if (q === 0x22 && b === 0x5c) {
      i += 2;
      continue;
    }
    if (b === q) return i;
    i++;
  }
  return -1;
}

function parseTomlHeaderBytes(
  innerRaw: Uint8Array,
  decoder: TextDecoder,
): { kind: "other" } | { kind: "model_provider"; id: string } | { kind: "error"; reason: CcSwitchInvalidReason } {
  let s = 0;
  let e = innerRaw.length;
  while (s < e && (innerRaw[s] === 0x20 || innerRaw[s] === 0x09)) s++;
  while (e > s && (innerRaw[e - 1] === 0x20 || innerRaw[e - 1] === 0x09)) e--;
  const inner = innerRaw.subarray(s, e);
  if (inner.length === 0) return { kind: "error", reason: "malformed_entry" };
  if (equalsAsciiBytes(inner, "__MULTILINE_REFUSED__") || equalsAsciiBytes(inner, "__MALFORMED_LINE__")) {
    return { kind: "error", reason: "malformed_entry" };
  }
  if (equalsAsciiBytes(inner, METADATA_REFUSED_SENTINEL)) {
    return { kind: "error", reason: "disallowed_metadata" };
  }

  const segments: Uint8Array[] = [];
  const owned: Uint8Array[] = [];
  try {
    let i = 0;
    while (i < inner.length) {
      while (i < inner.length && (inner[i] === 0x20 || inner[i] === 0x09)) i++;
      if (i >= inner.length) return { kind: "error", reason: "malformed_entry" };
      const b0 = inner[i]!;
      if (b0 === 0x22 || b0 === 0x27) {
        const qEnd = findQuotedEndInBytes(inner, i);
        if (qEnd < 0) return { kind: "error", reason: "malformed_entry" };
        const unesc = unescapeTomlStringBytes(inner.subarray(i + 1, qEnd), b0);
        if (!unesc || unesc.length === 0) return { kind: "error", reason: "malformed_entry" };
        owned.push(unesc);
        segments.push(unesc);
        i = qEnd + 1;
      } else {
        const segStart = i;
        while (i < inner.length) {
          const b = inner[i]!;
          if (isAlphaByte(b) || isDigitByte(b) || b === 0x5f || b === 0x2d) i++;
          else break;
        }
        if (i === segStart) return { kind: "error", reason: "malformed_entry" };
        segments.push(inner.subarray(segStart, i));
      }
      while (i < inner.length && (inner[i] === 0x20 || inner[i] === 0x09)) i++;
      if (i === inner.length) break;
      if (inner[i] === 0x2e) {
        i++;
        if (i >= inner.length) return { kind: "error", reason: "malformed_entry" };
        continue;
      }
      return { kind: "error", reason: "malformed_entry" };
    }

    if (segments.length === 2 && equalsAsciiBytes(segments[0]!, "model_providers")) {
      const idSlice = segments[1]!;
      if (!isAllowedMetadataBytes(idSlice, "id")) {
        return { kind: "error", reason: "disallowed_metadata" };
      }
      const id = decoder.decode(idSlice);
      return { kind: "model_provider", id };
    }
    return { kind: "other" };
  } catch {
    return { kind: "error", reason: "malformed_entry" };
  } finally {
    for (const buf of owned) buf.fill(0);
  }
}

function classifyTomlKeyBytes(keySlice: Uint8Array): AllowedTomlKey | "other_key" | null {
  const b0 = keySlice[0]!;
  if (b0 === 0x22 || b0 === 0x27) {
    const qEnd = findQuotedEndInBytes(keySlice, 0);
    if (qEnd !== keySlice.length - 1) return null;
    const unesc = unescapeTomlStringBytes(keySlice.subarray(1, qEnd), b0);
    if (!unesc || unesc.length === 0) return null;
    try {
      for (const allowed of ALLOWED_TOML_KEYS) {
        if (equalsAsciiBytes(unesc, allowed)) return allowed;
      }
      return "other_key";
    } finally {
      unesc.fill(0);
    }
  }
  for (let i = 0; i < keySlice.length; i++) {
    const b = keySlice[i]!;
    if (!isAlphaByte(b) && !isDigitByte(b) && b !== 0x5f && b !== 0x2d) return null;
  }
  for (const allowed of ALLOWED_TOML_KEYS) {
    if (equalsAsciiBytes(keySlice, allowed)) return allowed;
  }
  return "other_key";
}

export function parseCodexTomlBytes(bytes: Uint8Array): { ok: true; value: CodexTomlProjection } | { ok: false; reason: CcSwitchInvalidReason } {
  if (bytes.length > MAX_CODEX_TOML_BYTES) return { ok: false, reason: "malformed_entry" };
  const projection: CodexTomlProjection = { providers: new Map() };
  let currentSection: { kind: "root" } | { kind: "model_provider"; id: string } | { kind: "other" } = { kind: "root" };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let lineStart = 0;
  let lineCount = 0;

  for (let idx = 0; idx <= bytes.length; idx++) {
    if (idx < bytes.length && bytes[idx] !== 0x0a) continue;
    lineCount++;
    if (lineCount > 501) return { ok: false, reason: "malformed_entry" };
    let lineEnd = idx;
    if (lineEnd > lineStart && bytes[lineEnd - 1] === 0x0d) lineEnd--;
    const slice = bytes.subarray(lineStart, lineEnd);
    lineStart = idx + 1;

    let p = 0;
    while (p < slice.length && (slice[p] === 0x20 || slice[p] === 0x09)) p++;
    if (p >= slice.length || slice[p] === 0x23) continue;
    if (slice[p] === 0x5b) {
      // Scan and classify table headers in raw bytes so neither trailing comments nor unvalidated/unrelated headers are decoded.
      if (p + 1 < slice.length && slice[p + 1] === 0x5b) return { ok: false, reason: "malformed_entry" };
      let closeB = -1;
      let inQ = 0;
      for (let k = p + 1; k < slice.length; k++) {
        const b = slice[k]!;
        if (inQ === 0 && b === 0x23) break;
        if (inQ === 0 && (b === 0x22 || b === 0x27)) { inQ = b; continue; }
        if (inQ === 0x22 && b === 0x5c) { k++; continue; }
        if (inQ !== 0 && b === inQ) { inQ = 0; continue; }
        if (inQ === 0 && b === 0x5d) { closeB = k; break; }
      }
      if (closeB < 0 || !hasOnlyCommentOrSpaceBytes(slice, closeB + 1)) {
        return { ok: false, reason: "malformed_entry" };
      }
      const header = parseTomlHeaderBytes(slice.subarray(p + 1, closeB), decoder);
      if (header.kind === "error") return { ok: false, reason: header.reason };
      currentSection = header;
      continue;
    }

    let eq = -1;
    let inKeyQuote = 0;
    for (let k = p; k < slice.length; k++) {
      const b = slice[k]!;
      if (inKeyQuote === 0 && b === 0x23) break;
      if (inKeyQuote === 0 && (b === 0x22 || b === 0x27)) { inKeyQuote = b; continue; }
      if (inKeyQuote !== 0 && b === 0x5c && inKeyQuote === 0x22) { k++; continue; }
      if (inKeyQuote !== 0 && b === inKeyQuote) { inKeyQuote = 0; continue; }
      if (inKeyQuote === 0 && b === 0x3d) { eq = k; break; }
    }
    if (eq < 0) return { ok: false, reason: "malformed_entry" };
    let kStart = p;
    let kEnd = eq;
    while (kStart < kEnd && (slice[kStart] === 0x20 || slice[kStart] === 0x09)) kStart++;
    while (kEnd > kStart && (slice[kEnd - 1] === 0x20 || slice[kEnd - 1] === 0x09)) kEnd--;
    if (kEnd - kStart <= 0 || kEnd - kStart > 128) return { ok: false, reason: "malformed_entry" };

    const classifiedKey = classifyTomlKeyBytes(slice.subarray(kStart, kEnd));
    if (classifiedKey === null) return { ok: false, reason: "malformed_entry" };

    let vStart = eq + 1;
    while (vStart < slice.length && (slice[vStart] === 0x20 || slice[vStart] === 0x09)) vStart++;
    if (vStart >= slice.length) return { ok: false, reason: "malformed_entry" };
    if (
      vStart + 2 < slice.length
      && ((slice[vStart] === 0x22 && slice[vStart + 1] === 0x22 && slice[vStart + 2] === 0x22)
        || (slice[vStart] === 0x27 && slice[vStart + 1] === 0x27 && slice[vStart + 2] === 0x27))
    ) {
      return { ok: false, reason: "malformed_entry" };
    }

    const relevant =
      classifiedKey !== "other_key"
      && (
        currentSection.kind === "root"
        || (currentSection.kind === "model_provider" && (classifiedKey === "base_url" || classifiedKey === "wire_api"))
      );
    if (!relevant) {
      let q = 0;
      let depth = 0;
      for (let k = vStart; k < slice.length; k++) {
        const b = slice[k]!;
        if (q === 0 && b === 0x23) break;
        if (q === 0 && (b === 0x22 || b === 0x27)) { q = b; continue; }
        if (q !== 0 && b === 0x5c && q === 0x22) { k++; continue; }
        if (q !== 0 && b === q) { q = 0; continue; }
        if (q === 0 && (b === 0x5b || b === 0x7b)) depth++;
        if (q === 0 && (b === 0x5d || b === 0x7d)) {
          depth--;
          if (depth < 0) return { ok: false, reason: "malformed_entry" };
        }
      }
      if (q !== 0 || depth !== 0) return { ok: false, reason: "malformed_entry" };
      continue;
    }

    // Scan the quoted value in raw bytes so trailing '# comment' is never decoded!
    const vEnd = findQuotedEndInBytes(slice, vStart);
    if (vEnd < 0 || !hasOnlyCommentOrSpaceBytes(slice, vEnd + 1)) {
      return { ok: false, reason: "malformed_entry" };
    }
    const key: AllowedTomlKey = classifiedKey as AllowedTomlKey;
    const unescaped = unescapeTomlStringBytes(slice.subarray(vStart + 1, vEnd), slice[vStart]!);
    if (!unescaped || unescaped.length === 0) return { ok: false, reason: "malformed_entry" };
    let value: string;
    try {
      const metaKind = tomlKeyMetadataKind(key);
      if (metaKind === "url" && equalsAsciiBytes(unescaped, URL_SYNTAX_REFUSED_SENTINEL)) {
        return { ok: false, reason: "invalid_base_url" };
      }
      if (equalsAsciiBytes(unescaped, METADATA_REFUSED_SENTINEL)) {
        return { ok: false, reason: "disallowed_metadata" };
      }
      if (!isAllowedMetadataBytes(unescaped, metaKind)) {
        return { ok: false, reason: metaKind === "url" ? "invalid_base_url" : "disallowed_metadata" };
      }
      value = decoder.decode(unescaped);
      if (value === URL_SYNTAX_REFUSED_SENTINEL) return { ok: false, reason: "invalid_base_url" };
      if (value === METADATA_REFUSED_SENTINEL) return { ok: false, reason: "disallowed_metadata" };
    } catch {
      return { ok: false, reason: "malformed_entry" };
    } finally {
      unescaped.fill(0);
    }

    if (currentSection.kind === "root") {
      if (key === "model") projection.model = value;
      else if (key === "model_provider") projection.modelProvider = value;
      else if (key === "base_url" || key === "openai_base_url") projection.rootBaseUrl = value;
      else if (key === "wire_api") projection.rootWireApi = value;
    } else if (currentSection.kind === "model_provider") {
      const entry = projection.providers.get(currentSection.id) ?? {};
      if (key === "base_url") entry.baseUrl = value;
      else if (key === "wire_api") entry.wireApi = value;
      projection.providers.set(currentSection.id, entry);
    }
  }

  return { ok: true, value: projection };
}

export function resolveCodexProjection(proj: CodexTomlProjection): { ok: true; baseUrl: string; wireApi: string; defaultModel?: string } | { ok: false; reason: CcSwitchInvalidReason } {
  let baseUrl: string | undefined;
  let wireApi = proj.rootWireApi ?? "responses";
  if (proj.modelProvider !== undefined) {
    const selected = proj.providers.get(proj.modelProvider);
    if (!selected?.baseUrl) return { ok: false, reason: "missing_base_url" };
    baseUrl = selected.baseUrl;
    if (selected.wireApi) wireApi = selected.wireApi;
  } else if (proj.providers.size > 1) {
    return { ok: false, reason: "ambiguous_codex_provider" };
  } else if (proj.providers.size === 1) {
    const only = [...proj.providers.values()][0]!;
    if (!only.baseUrl) return { ok: false, reason: "missing_base_url" };
    baseUrl = only.baseUrl;
    if (only.wireApi) wireApi = only.wireApi;
  } else if (proj.rootBaseUrl) {
    baseUrl = proj.rootBaseUrl;
  } else {
    return { ok: false, reason: "missing_base_url" };
  }
  return {
    ok: true,
    baseUrl,
    wireApi,
    ...(proj.model ? { defaultModel: proj.model } : {}),
  };
}
