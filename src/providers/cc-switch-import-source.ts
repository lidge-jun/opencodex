/**
 * Byte-level and SQLite scalar source readers for keyless CC-Switch provider import.
 *
 * Enforces pre-decode metadata validation, comment-free TOML value extraction,
 * descriptor-verified non-blocking opens, and private SQLite snapshot copies.
 */
import { Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmdirSync,
  truncateSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertPlainLocalPath } from "../codex/orca-auth-source";

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
  | "secret_in_nonsecret_field"
  | "malformed_entry";

export const SECRET_REFUSED_SENTINEL = "__SECRET_REFUSED__";
const MAX_SQLITE_BYTES = 32 * 1024 * 1024;
export const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_CODEX_TOML_BYTES = 64 * 1024;
const SQLITE_MAGIC_PREFIX = "SQLite format 3";

let sourceOpenHookForTests: ((resolvedPath: string) => void) | null = null;
export function setCcSwitchSourceOpenHookForTests(hook: ((resolvedPath: string) => void) | null): void {
  sourceOpenHookForTests = hook;
}

export interface RawExtractedRow {
  id: string;
  appType: string;
  settingsType: string | null;
  claudeBaseUrl: string | null;
  claudeModel: string | null;
  genericBaseUrl: string | null;
  genericModel: string | null;
  genericWireApi: string | null;
  codexTomlLines: string | null;
  codexProjection?: { ok: true; value: CodexTomlProjection } | { ok: false; reason: CcSwitchInvalidReason };
}

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

/**
 * Strict byte-level metadata policy enforced BEFORE decoding into a JavaScript string.
 * Rejects both prefixed and prefixless credentials (hex keys, high-entropy mixed tokens,
 * digit-heavy random segments, and credential-bearing URL path segments).
 */
export function isAllowedMetadataBytes(slice: Uint8Array, kind: MetadataFieldKind): boolean {
  const len = slice.length;
  if (len === 0) return false;
  for (let i = 0; i < len; i++) {
    const b = slice[i]!;
    if (b <= 0x20 || b >= 0x7f) return false;
  }
  if (containsForbiddenBytes(slice)) return false;

  if (kind === "app") {
    if (len > 16) return false;
    for (let i = 0; i < len; i++) {
      const b = slice[i]!;
      if (!isAlphaByte(b) && b !== 0x2d && b !== 0x5f) return false;
    }
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
      // Reject @, ?, #, quotes, backslashes
      if (b === 0x40 || b === 0x3f || b === 0x23 || b === 0x22 || b === 0x27 || b === 0x5c) return false;
      if (!isAlphaByte(b) && !isDigitByte(b) && b !== 0x2e && b !== 0x2d && b !== 0x5f && b !== 0x3a && b !== 0x2f && b !== 0x7e && b !== 0x25 && b !== 0x5b && b !== 0x5d) {
        return false;
      }
      if (b === 0x2f && firstPathSlash < 0) firstPathSlash = i;
    }
    if (firstPathSlash < 0) return true;
    const pathLen = len - firstPathSlash;
    if (pathLen > 48) return false;

    let segStart = firstPathSlash + 1;
    let segCount = 0;
    let totalPathDigits = 0;
    for (let i = firstPathSlash + 1; i <= len; i++) {
      if (i < len && slice[i] !== 0x2f) continue;
      const segLen = i - segStart;
      if (segLen > 0) {
        segCount++;
        if (segCount > 4 || segLen > 20) return false;
        let segDigits = 0;
        let segHex = true;
        let hasLower = false;
        let hasUpper = false;
        for (let k = segStart; k < i; k++) {
          const b = slice[k]!;
          if (!isAlphaByte(b) && !isDigitByte(b) && b !== 0x2e && b !== 0x2d && b !== 0x5f) return false;
          if (isDigitByte(b)) segDigits++;
          if (!isHexByte(b)) segHex = false;
          if (isLowerByte(b)) hasLower = true;
          if (isUpperByte(b)) hasUpper = true;
        }
        totalPathDigits += segDigits;
        if (segDigits >= 3) return false;
        if (segHex && segLen >= 10) return false;
        if (segLen >= 12 && hasLower && hasUpper) return false;
      }
      segStart = i + 1;
    }
    if (totalPathDigits > 2) return false;
    return true;
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
  if (totalDigits > (kind === "id" ? 5 : 8)) return false;

  let segStart = 0;
  let mixedDigitsTotal = 0;
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
      if (!segAllDigits) {
        if (segHex && segLen >= 10) return false;
        if (segDigits >= 4) return false;
        if (segLen >= 10 && hasLower && hasUpper && segDigits >= 1) return false;
        mixedDigitsTotal += segDigits;
      }
    }
    segStart = i + 1;
  }
  if (mixedDigitsTotal >= 5) return false;
  return true;
}

export function looksLikeSecretValue(value: string, kind: MetadataFieldKind): boolean {
  if (value === SECRET_REFUSED_SENTINEL || hasControlChars(value)) return true;
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

function parseTomlQuotedString(line: string, startIndex: number): { value: string; restIndex: number } | null {
  const quote = line[startIndex];
  if (quote !== '"' && quote !== "'") return null;
  if (line.slice(startIndex, startIndex + 3) === quote.repeat(3)) return null;
  let out = "";
  let i = startIndex + 1;
  while (i < line.length) {
    const ch = line[i]!;
    if (quote === '"' && ch === "\\") {
      i++;
      if (i >= line.length) return null;
      const esc = line[i]!;
      if (esc === '"' || esc === "\\" || esc === "/") out += esc;
      else if (esc === "n") out += "\n";
      else if (esc === "r") out += "\r";
      else if (esc === "t") out += "\t";
      else if (esc === "b") out += "\b";
      else if (esc === "f") out += "\f";
      else if (esc === "u" && /^[0-9A-Fa-f]{4}$/.test(line.slice(i + 1, i + 5))) {
        out += String.fromCharCode(parseInt(line.slice(i + 1, i + 5), 16));
        i += 4;
      } else return null;
      i++;
      continue;
    }
    if (ch === quote) return { value: out, restIndex: i + 1 };
    if (hasControlChars(ch)) return null;
    out += ch;
    i++;
  }
  return null;
}

function hasOnlyTomlCommentOrSpace(line: string, fromIndex: number): boolean {
  const rest = line.slice(fromIndex).trimStart();
  return rest === "" || rest.startsWith("#");
}

function parseTableHeader(trimmed: string): { kind: "root_other" } | { kind: "model_provider"; id: string } | null {
  if (!trimmed.startsWith("[") || trimmed.startsWith("[[")) return null;
  let i = 1;
  const segments: string[] = [];
  while (i < trimmed.length) {
    while (i < trimmed.length && (trimmed[i] === " " || trimmed[i] === "\t")) i++;
    if (i >= trimmed.length) return null;
    let seg = "";
    if (trimmed[i] === '"' || trimmed[i] === "'") {
      const parsed = parseTomlQuotedString(trimmed, i);
      if (!parsed) return null;
      seg = parsed.value;
      i = parsed.restIndex;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(trimmed.slice(i));
      if (!m) return null;
      seg = m[0];
      i += seg.length;
    }
    if (!seg) return null;
    segments.push(seg);
    while (i < trimmed.length && (trimmed[i] === " " || trimmed[i] === "\t")) i++;
    if (trimmed[i] === ".") {
      i++;
      continue;
    }
    if (trimmed[i] === "]") {
      if (!hasOnlyTomlCommentOrSpace(trimmed, i + 1)) return null;
      if (segments.length === 2 && segments[0] === "model_providers") {
        return { kind: "model_provider", id: segments[1]! };
      }
      return { kind: "root_other" };
    }
    return null;
  }
  return null;
}

const ALLOWED_TOML_KEYS = new Set(["model", "model_provider", "base_url", "openai_base_url", "wire_api"]);

function tomlKeyMetadataKind(key: string): MetadataFieldKind {
  if (key === "model") return "model";
  if (key === "model_provider") return "id";
  if (key === "wire_api") return "wire";
  return "url";
}

/**
 * Unescape a single-line TOML quoted string slice (without surrounding quotes) into a transient
 * Uint8Array. Caller must zero `out` in finally.
 */
function unescapeTomlStringBytes(
  raw: Uint8Array,
  quoteByte: number,
  decoder: TextDecoder,
  encoder: TextEncoder,
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
        if (r + 4 > raw.length) { out.fill(0); return null; }
        let hex = "";
        try { hex = decoder.decode(raw.subarray(r, r + 4)); } catch { out.fill(0); return null; }
        if (!/^[0-9A-Fa-f]{4}$/.test(hex)) { out.fill(0); return null; }
        r += 4;
        const cp = parseInt(hex, 16);
        if (cp <= 0x20 || cp >= 0x7f) { out.fill(0); return null; }
        const enc = encoder.encode(String.fromCodePoint(cp));
        out.set(enc, w);
        w += enc.length;
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

export function parseCodexTomlBytes(bytes: Uint8Array): { ok: true; value: CodexTomlProjection } | { ok: false; reason: CcSwitchInvalidReason } {
  if (bytes.length > MAX_CODEX_TOML_BYTES) return { ok: false, reason: "malformed_entry" };
  const projection: CodexTomlProjection = { providers: new Map() };
  let currentSection: { kind: "root" } | { kind: "model_provider"; id: string } | { kind: "other" } = { kind: "root" };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  let lineStart = 0;

  for (let idx = 0; idx <= bytes.length; idx++) {
    if (idx < bytes.length && bytes[idx] !== 0x0a) continue;
    let lineEnd = idx;
    if (lineEnd > lineStart && bytes[lineEnd - 1] === 0x0d) lineEnd--;
    const slice = bytes.subarray(lineStart, lineEnd);
    lineStart = idx + 1;

    let p = 0;
    while (p < slice.length && (slice[p] === 0x20 || slice[p] === 0x09)) p++;
    if (p >= slice.length || slice[p] === 0x23) continue;
    if (slice[p] === 0x5b) {
      // Scan table header in raw bytes so trailing '# comment' after ']' is never decoded into JS!
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
      let headerLine: string;
      try { headerLine = decoder.decode(slice.subarray(p, closeB + 1)); } catch { return { ok: false, reason: "malformed_entry" }; }
      if (headerLine === "[__MULTILINE_REFUSED__]" || headerLine === "[__MALFORMED_LINE__]") {
        return { ok: false, reason: "malformed_entry" };
      }
      if (headerLine === "[__SECRET_REFUSED__]") {
        return { ok: false, reason: "secret_in_nonsecret_field" };
      }
      const header = parseTableHeader(headerLine);
      if (!header) return { ok: false, reason: "malformed_entry" };
      if (header.kind === "model_provider") {
        const idBytes = encoder.encode(header.id.replace(/["\\]/g, "_"));
        const allowed = isAllowedMetadataBytes(idBytes, "id");
        idBytes.fill(0);
        if (!allowed) return { ok: false, reason: "secret_in_nonsecret_field" };
      }
      currentSection = header.kind === "model_provider" ? header : { kind: "other" };
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
    if (kEnd - kStart <= 0 || kEnd - kStart > 48) return { ok: false, reason: "malformed_entry" };

    let keyRaw: string;
    try { keyRaw = decoder.decode(slice.subarray(kStart, kEnd)); } catch { return { ok: false, reason: "malformed_entry" }; }
    let key = keyRaw;
    if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
      const kp = parseTomlQuotedString(key, 0);
      if (!kp || kp.restIndex !== key.length) return { ok: false, reason: "malformed_entry" };
      key = kp.value;
    } else if (!/^[A-Za-z0-9_-]+$/.test(key)) {
      return { ok: false, reason: "malformed_entry" };
    }

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
      (currentSection.kind === "root" && ALLOWED_TOML_KEYS.has(key))
      || (currentSection.kind === "model_provider" && (key === "base_url" || key === "wire_api"));
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
    const unescaped = unescapeTomlStringBytes(slice.subarray(vStart + 1, vEnd), slice[vStart]!, decoder, encoder);
    if (!unescaped || unescaped.length === 0) return { ok: false, reason: "malformed_entry" };
    let value: string;
    try {
      let checkSlice = unescaped;
      if (key === "model_provider") {
        const sanitized = new Uint8Array(unescaped.length);
        for (let i = 0; i < unescaped.length; i++) {
          const b = unescaped[i]!;
          sanitized[i] = b === 0x22 || b === 0x5c ? 0x5f : b;
        }
        checkSlice = sanitized;
      }
      try {
        if (!isAllowedMetadataBytes(checkSlice, tomlKeyMetadataKind(key))) {
          return { ok: false, reason: "secret_in_nonsecret_field" };
        }
      } finally {
        if (checkSlice !== unescaped) checkSlice.fill(0);
      }
      value = decoder.decode(unescaped);
      if (value === SECRET_REFUSED_SENTINEL) return { ok: false, reason: "secret_in_nonsecret_field" };
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

function sqlLineExpr(col: string): string {
  return `trim(replace(substr(${col}, 1, instr(${col}, char(10)) - 1), char(13), ''))`;
}

function sqlDigitCount(expr: string): string {
  let out = expr;
  for (let d = 0; d <= 9; d++) out = `replace(${out}, '${d}', '')`;
  return `(length(${expr}) - length(${out}))`;
}

function sqlHasSecretSubstring(expr: string): string {
  return `(
    lower(${expr}) GLOB '*sk-*'
    OR lower(${expr}) GLOB '*rk-*'
    OR lower(${expr}) GLOB '*pk-*'
    OR lower(${expr}) GLOB '*ak-*'
    OR lower(${expr}) GLOB '*ghp_*'
    OR lower(${expr}) GLOB '*gho_*'
    OR lower(${expr}) GLOB '*github_pat_*'
    OR lower(${expr}) GLOB '*xox[baprs]-*'
    OR lower(${expr}) GLOB '*aiza*'
    OR lower(${expr}) GLOB '*eyj*'
    OR lower(${expr}) GLOB '*bearer*'
    OR lower(${expr}) GLOB '*secret*'
    OR lower(${expr}) GLOB '*apikey*'
    OR lower(${expr}) GLOB '*api_key*'
    OR lower(${expr}) GLOB '*passwd*'
    OR lower(${expr}) GLOB '*password*'
    OR lower(${expr}) GLOB '*private_key*'
    OR lower(${expr}) GLOB '*access_token*'
    OR lower(${expr}) GLOB '*refresh_token*'
    OR lower(${expr}) GLOB '*auth_token*'
    OR lower(${expr}) GLOB '*[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]*'
  )`;
}

function sqlSafeScalar(expr: string, kind: "id" | "model" | "url" | "wire"): string {
  if (kind === "wire") {
    return `CASE
      WHEN ${expr} IS NULL THEN NULL
      WHEN lower(${expr}) IN ('responses', 'openai-responses', 'chat', 'chat_completions', 'openai-completions', 'openai-chat')
      THEN lower(${expr})
      ELSE '${SECRET_REFUSED_SENTINEL}'
    END`;
  }
  if (kind === "id") {
    return `CASE
      WHEN ${expr} IS NULL THEN NULL
      WHEN length(${expr}) BETWEEN 1 AND 48
        AND ${expr} NOT GLOB '*[^A-Za-z0-9._-]*'
        AND (length(${expr}) < 16 OR instr(${expr}, '-') > 0 OR instr(${expr}, '.') > 0 OR instr(${expr}, '_') > 0)
        AND ${expr} NOT GLOB '*[A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9]*'
        AND ${sqlDigitCount(expr)} <= 5
        AND NOT ${sqlHasSecretSubstring(expr)}
      THEN ${expr}
      ELSE '${SECRET_REFUSED_SENTINEL}'
    END`;
  }
  if (kind === "model") {
    return `CASE
      WHEN ${expr} IS NULL THEN NULL
      WHEN length(${expr}) BETWEEN 1 AND 80
        AND ${expr} NOT GLOB '*[^A-Za-z0-9._:/-]*'
        AND (length(${expr}) < 16 OR instr(${expr}, '-') > 0 OR instr(${expr}, '.') > 0 OR instr(${expr}, '_') > 0 OR instr(${expr}, '/') > 0 OR instr(${expr}, ':') > 0)
        AND ${expr} NOT GLOB '*[A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9]*'
        AND ${sqlDigitCount(expr)} <= 8
        AND NOT ${sqlHasSecretSubstring(expr)}
      THEN ${expr}
      ELSE '${SECRET_REFUSED_SENTINEL}'
    END`;
  }
  // kind === "url"
  const afterScheme = `(CASE WHEN lower(substr(${expr}, 1, 8)) = 'https://' THEN substr(${expr}, 9) ELSE substr(${expr}, 8) END)`;
  const urlPath = `(CASE WHEN instr(${afterScheme}, '/') > 0 THEN substr(${afterScheme}, instr(${afterScheme}, '/')) ELSE '' END)`;
  return `CASE
    WHEN ${expr} IS NULL THEN NULL
    WHEN length(${expr}) BETWEEN 8 AND 256
      AND (lower(substr(${expr}, 1, 7)) = 'http://' OR lower(substr(${expr}, 1, 8)) = 'https://')
      AND replace(replace(${expr}, '[', ''), ']', '') NOT GLOB '*[^A-Za-z0-9._:/~%-]*'
      AND length(${urlPath}) <= 48
      AND ${urlPath} NOT GLOB '*[A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9]*'
      AND ${sqlDigitCount(urlPath)} <= 2
      AND NOT ${sqlHasSecretSubstring(expr)}
    THEN ${expr}
    ELSE '${SECRET_REFUSED_SENTINEL}'
  END`;
}

function sqlModelProvidersHeaderPredicate(line: string): string {
  const inner = `trim(substr(${line}, 2, instr(${line}, ']') - 2))`;
  const afterKey = `ltrim(substr(${inner}, 16))`;
  const seg = `trim(substr(${afterKey}, 2))`;
  return `(
    substr(${line}, 1, 1) = '['
    AND substr(${line}, 1, 2) != '[['
    AND instr(${line}, ']') > 1
    AND substr(${inner}, 1, 15) = 'model_providers'
    AND substr(${afterKey}, 1, 1) = '.'
    AND ${seg} != ''
    AND (
      (
        substr(${seg}, 1, 1) = '"'
        AND length(${seg}) >= 3
        AND substr(${seg}, -1, 1) = '"'
        AND substr(replace(${seg}, char(92) || char(92), ''), -2, 2) != (char(92) || '"')
        AND instr(replace(replace(substr(${seg}, 2, length(${seg}) - 2), char(92) || char(92), ''), char(92) || char(34), ''), '"') = 0
      )
      OR (
        substr(${seg}, 1, 1) = ''''
        AND length(${seg}) >= 3
        AND substr(${seg}, -1, 1) = ''''
        AND instr(substr(${seg}, 2, length(${seg}) - 2), '''') = 0
      )
      OR (
        substr(${seg}, 1, 1) NOT IN ('"', '''')
        AND instr(${seg}, '.') = 0
        AND instr(${seg}, ' ') = 0
        AND instr(${seg}, char(9)) = 0
      )
    )
  )`;
}

const SQLITE_SAFE_QUERY = `
WITH RECURSIVE
  raw_base AS (
    SELECT
      rowid AS rid,
      CAST(id AS TEXT) AS raw_id,
      CAST(app_type AS TEXT) AS app_type,
      COALESCE(sort_index, 0) AS sort_ord,
      CASE WHEN json_valid(settings_config) THEN json_type(settings_config) ELSE NULL END AS settings_type,
      CASE WHEN json_valid(settings_config) AND json_type(settings_config, ?1) = 'text' THEN json_extract(settings_config, ?1) ELSE NULL END AS raw_claude_url,
      CASE
        WHEN json_valid(settings_config) AND json_type(settings_config, ?2) = 'text' THEN json_extract(settings_config, ?2)
        WHEN json_valid(settings_config) AND json_type(settings_config, ?3) = 'text' THEN json_extract(settings_config, ?3)
        ELSE NULL
      END AS raw_claude_model,
      CASE
        WHEN json_valid(settings_config) AND json_type(settings_config, ?4) = 'text' THEN json_extract(settings_config, ?4)
        WHEN json_valid(settings_config) AND json_type(settings_config, ?5) = 'text' THEN json_extract(settings_config, ?5)
        WHEN json_valid(settings_config) AND json_type(settings_config, ?6) = 'text' THEN json_extract(settings_config, ?6)
        WHEN json_valid(settings_config) AND json_type(settings_config, ?7) = 'text' THEN json_extract(settings_config, ?7)
        ELSE NULL
      END AS raw_generic_url,
      CASE
        WHEN json_valid(settings_config) AND json_type(settings_config, ?8) = 'text' THEN json_extract(settings_config, ?8)
        WHEN json_valid(settings_config) AND json_type(settings_config, ?9) = 'text' THEN json_extract(settings_config, ?9)
        WHEN json_valid(settings_config) AND json_type(settings_config, ?10) = 'text' THEN json_extract(settings_config, ?10)
        WHEN json_valid(settings_config) AND json_type(settings_config, ?11) = 'text' THEN json_extract(settings_config, ?11)
        ELSE NULL
      END AS raw_generic_model,
      CASE WHEN json_valid(settings_config) AND json_type(settings_config, ?12) = 'text' THEN json_extract(settings_config, ?12) ELSE NULL END AS raw_wire_api,
      CASE
        WHEN json_valid(settings_config) AND json_type(settings_config, ?13) = 'text' THEN
          CASE
            WHEN length(CAST(json_extract(settings_config, ?13) AS BLOB)) > ${MAX_CODEX_TOML_BYTES}
              THEN '[__MALFORMED_LINE__]' || char(10)
            WHEN instr(json_extract(settings_config, ?13), '"""') > 0 OR instr(json_extract(settings_config, ?13), '''''''') > 0
              THEN '[__MULTILINE_REFUSED__]' || char(10)
            ELSE json_extract(settings_config, ?13) || char(10)
          END
        ELSE NULL
      END AS raw_cfg
    FROM providers
  ),
  base AS (
    SELECT
      rid,
      ${sqlSafeScalar("raw_id", "id")} AS id,
      app_type,
      sort_ord,
      settings_type,
      ${sqlSafeScalar("raw_claude_url", "url")} AS claude_base_url,
      ${sqlSafeScalar("raw_claude_model", "model")} AS claude_model,
      ${sqlSafeScalar("raw_generic_url", "url")} AS generic_base_url,
      ${sqlSafeScalar("raw_generic_model", "model")} AS generic_model,
      ${sqlSafeScalar("raw_wire_api", "wire")} AS generic_wire_api,
      raw_cfg
    FROM raw_base
  ),
  lines(rid, line, rest, idx, sec) AS (
    SELECT
      rid,
      ${sqlLineExpr("raw_cfg")},
      substr(raw_cfg, instr(raw_cfg, char(10)) + 1),
      1,
      CASE
        WHEN substr(${sqlLineExpr("raw_cfg")}, 1, 1) = '[' THEN
          CASE
            WHEN ${sqlModelProvidersHeaderPredicate(sqlLineExpr("raw_cfg"))} THEN 'mp'
            ELSE 'other'
          END
        ELSE 'root'
      END
    FROM base WHERE raw_cfg IS NOT NULL AND instr(raw_cfg, char(10)) > 0
    UNION ALL
    SELECT
      rid,
      ${sqlLineExpr("rest")},
      substr(rest, instr(rest, char(10)) + 1),
      idx + 1,
      CASE
        WHEN substr(${sqlLineExpr("rest")}, 1, 1) = '[' THEN
          CASE
            WHEN ${sqlModelProvidersHeaderPredicate(sqlLineExpr("rest"))} THEN 'mp'
            ELSE 'other'
          END
        ELSE sec
      END
    FROM lines WHERE instr(rest, char(10)) > 0 AND idx <= 500
  ),
  split_lines AS (
    SELECT
      rid,
      idx,
      sec,
      line,
      instr(line, ']') AS close_b,
      trim(replace(replace(trim(substr(ltrim(substr(trim(substr(line, 2, instr(line, ']') - 2)), 16)), 2)), char(92) || char(34), '_'), char(92) || char(92), '_'), ' ''' || char(34)) AS hdr_id,
      trim(trim(substr(line, 1, instr(line, '=') - 1)), ' ''' || char(34)) AS norm_key,
      ltrim(substr(line, instr(line, '=') + 1)) AS rhs
    FROM lines
  ),
  quoted_lines AS (
    SELECT
      rid,
      idx,
      sec,
      line,
      close_b,
      hdr_id,
      norm_key,
      rhs,
      CASE
        WHEN substr(rhs, 1, 1) = char(34) AND substr(rhs, 1, 3) != '"""'
          THEN instr(replace(replace(substr(rhs, 2), char(92) || char(92), '__'), char(92) || char(34), '__'), char(34))
        WHEN substr(rhs, 1, 1) = '''' AND substr(rhs, 1, 3) != ''''''''
          THEN instr(substr(rhs, 2), '''')
        ELSE 0
      END AS end_q
    FROM split_lines
  ),
  val_lines AS (
    SELECT
      rid,
      idx,
      sec,
      line,
      close_b,
      hdr_id,
      norm_key,
      rhs,
      end_q,
      substr(rhs, 2, end_q - 1) AS val_body,
      replace(replace(substr(rhs, 2, end_q - 1), char(92) || char(34), '_'), char(92) || char(92), '_') AS val_id_clean,
      ltrim(substr(rhs, end_q + 2)) AS tail
    FROM quoted_lines
  ),
  projected_lines AS (
    SELECT rid, idx,
      CASE
        WHEN idx > 500 THEN '[__MALFORMED_LINE__]'
        WHEN line = '' OR substr(line, 1, 1) = '#' THEN NULL
        WHEN line IN ('[__MULTILINE_REFUSED__]', '[__MALFORMED_LINE__]') THEN line
        WHEN substr(line, 1, 1) = '[' THEN
          CASE
            WHEN sec = 'mp' AND close_b > 0 AND (ltrim(substr(line, close_b + 1)) = '' OR substr(ltrim(substr(line, close_b + 1)), 1, 1) = '#') THEN
              CASE
                WHEN ${sqlSafeScalar("hdr_id", "id")} = '${SECRET_REFUSED_SENTINEL}'
                  THEN '[${SECRET_REFUSED_SENTINEL}]'
                ELSE substr(line, 1, close_b)
              END
            WHEN close_b > 0 AND (ltrim(substr(line, close_b + 1)) = '' OR substr(ltrim(substr(line, close_b + 1)), 1, 1) = '#') THEN '[other]'
            ELSE '[__MALFORMED_LINE__]'
          END
        WHEN instr(line, '=') = 0 THEN '[__MALFORMED_LINE__]'
        WHEN (sec = 'root' AND norm_key IN ('model', 'model_provider', 'base_url', 'openai_base_url', 'wire_api'))
          OR (sec = 'mp' AND norm_key IN ('base_url', 'wire_api')) THEN
          CASE
            WHEN end_q = 0 OR (tail != '' AND substr(tail, 1, 1) != '#') THEN '[__MALFORMED_LINE__]'
            WHEN norm_key = 'model' THEN 'model = "' || ${sqlSafeScalar("val_body", "model")} || '"'
            WHEN norm_key IN ('base_url', 'openai_base_url') THEN norm_key || ' = "' || ${sqlSafeScalar("val_body", "url")} || '"'
            WHEN norm_key = 'model_provider' THEN
              CASE
                WHEN ${sqlSafeScalar("val_id_clean", "id")} = '${SECRET_REFUSED_SENTINEL}'
                  THEN 'model_provider = "${SECRET_REFUSED_SENTINEL}"'
                ELSE 'model_provider = ' || substr(rhs, 1, end_q + 1)
              END
            WHEN norm_key = 'wire_api' THEN
              CASE
                WHEN ${sqlSafeScalar("val_body", "wire")} = '${SECRET_REFUSED_SENTINEL}' THEN '[__MALFORMED_LINE__]'
                ELSE 'wire_api = "' || lower(val_body) || '"'
              END
            ELSE 'ignored_key = "omitted"'
          END
        ELSE 'ignored_key = "omitted"'
      END AS safe_line
    FROM val_lines
  )
SELECT
  b.rid AS rid,
  b.id AS id,
  b.app_type AS appType,
  b.settings_type AS settingsType,
  b.claude_base_url AS claudeBaseUrl,
  b.claude_model AS claudeModel,
  b.generic_base_url AS genericBaseUrl,
  b.generic_model AS genericModel,
  b.generic_wire_api AS genericWireApi,
  p.idx AS lineIdx,
  p.safe_line AS safeLine
FROM base b
LEFT JOIN projected_lines p ON b.rid = p.rid AND p.safe_line IS NOT NULL
ORDER BY b.sort_ord ASC, b.id ASC, b.app_type ASC, b.rid ASC, p.idx ASC
`;

export function readSqliteRows(sourcePath: string): RawExtractedRow[] {
  let db: Database | undefined;
  try {
    db = new Database(sourcePath, { readonly: true, create: false });
    const rawRows = db.query(SQLITE_SAFE_QUERY).all(
      "$.env.ANTHROPIC_BASE_URL",
      "$.env.ANTHROPIC_MODEL",
      "$.env.ANTHROPIC_DEFAULT_SONNET_MODEL",
      "$.baseUrl",
      "$.base_url",
      "$.env.OPENAI_BASE_URL",
      "$.env.GEMINI_BASE_URL",
      "$.model",
      "$.defaultModel",
      "$.env.OPENAI_MODEL",
      "$.env.GEMINI_MODEL",
      "$.wire_api",
      "$.config",
    ) as Array<Omit<RawExtractedRow, "codexTomlLines"> & { rid: number; lineIdx: number | null; safeLine: string | null }>;
    const byRid = new Map<number, { row: RawExtractedRow; lines: Array<{ idx: number; text: string }> }>();
    for (const item of rawRows) {
      let group = byRid.get(item.rid);
      if (!group) {
        group = {
          row: {
            id: item.id,
            appType: item.appType,
            settingsType: item.settingsType,
            claudeBaseUrl: item.claudeBaseUrl,
            claudeModel: item.claudeModel,
            genericBaseUrl: item.genericBaseUrl,
            genericModel: item.genericModel,
            genericWireApi: item.genericWireApi,
            codexTomlLines: null,
          },
          lines: [],
        };
        byRid.set(item.rid, group);
      }
      if (item.lineIdx !== null && item.safeLine !== null) {
        group.lines.push({ idx: item.lineIdx, text: item.safeLine });
      }
    }
    const result: RawExtractedRow[] = [];
    for (const group of byRid.values()) {
      if (group.lines.length > 0) {
        group.lines.sort((a, b) => a.idx - b.idx);
        group.row.codexTomlLines = group.lines.map(l => l.text).join("\n");
      }
      result.push(group.row);
    }
    return result;
  } catch {
    throw new CcSwitchImportError("CC-Switch SQLite source could not be read or has an unsupported schema.");
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/**
 * Byte-level UTF-8 JSON scanner for legacy CC-Switch JSON files.
 * Walks the JSON structure on a transient Uint8Array (zeroed in finally) and decodes ONLY
 * allowlisted non-secret scalar fields, skipping over secret values without decoding them into JS strings.
 */
export function scanCcSwitchJsonBytes(bytes: Uint8Array): RawExtractedRow[] {
  try {
    return scanCcSwitchJsonBytesInternal(bytes);
  } finally {
    bytes.fill(0);
  }
}

function scanCcSwitchJsonBytesInternal(bytes: Uint8Array): RawExtractedRow[] {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  let pos = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    pos = 3;
  }

  function skipWs(): void {
    while (pos < bytes.length) {
      const b = bytes[pos]!;
      if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) pos++;
      else break;
    }
  }

  function scanStringBounds(): { start: number; end: number; hasEscapes: boolean } {
    if (bytes[pos] !== 0x22) throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
    pos++;
    const start = pos;
    let hasEscapes = false;
    while (pos < bytes.length) {
      const b = bytes[pos]!;
      if (b < 0x20) throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
      if (b === 0x5c) {
        hasEscapes = true;
        pos += 2;
        if (pos > bytes.length) throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
        continue;
      }
      if (b === 0x22) {
        const end = pos;
        pos++;
        return { start, end, hasEscapes };
      }
      pos++;
    }
    throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
  }

  function decodeBoundedString(bounds: { start: number; end: number; hasEscapes: boolean }): string {
    if (bounds.end - bounds.start > 64) {
      throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
    }
    const raw = decoder.decode(bytes.subarray(bounds.start, bounds.end));
    if (!bounds.hasEscapes) return raw;
    try {
      return JSON.parse(`"${raw}"`) as string;
    } catch {
      throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
    }
  }

  /**
   * Unescape a JSON string token into a transient Uint8Array, enforce the strict metadata byte
   * policy BEFORE calling TextDecoder.decode, and zero the transient buffer in finally.
   */
  function decodeMetadataStringFromBounds(bounds: { start: number; end: number }, kind: MetadataFieldKind): string {
    if (bounds.end - bounds.start > 512) return SECRET_REFUSED_SENTINEL;
    const out = new Uint8Array(bounds.end - bounds.start);
    let readIdx = bounds.start;
    let writeIdx = 0;
    try {
      while (readIdx < bounds.end) {
        const b = bytes[readIdx]!;
        if (b !== 0x5c) {
          out[writeIdx++] = b;
          readIdx++;
          continue;
        }
        readIdx++;
        if (readIdx >= bounds.end) return SECRET_REFUSED_SENTINEL;
        const esc = bytes[readIdx]!;
        readIdx++;
        if (esc === 0x22 || esc === 0x5c || esc === 0x2f) out[writeIdx++] = esc;
        else if (esc === 0x6e || esc === 0x72 || esc === 0x74 || esc === 0x62 || esc === 0x66) {
          return SECRET_REFUSED_SENTINEL;
        } else if (esc === 0x75) {
          if (readIdx + 4 > bounds.end) return SECRET_REFUSED_SENTINEL;
          const hex = decoder.decode(bytes.subarray(readIdx, readIdx + 4));
          if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return SECRET_REFUSED_SENTINEL;
          readIdx += 4;
          const cp = parseInt(hex, 16);
          if (cp <= 0x20 || cp >= 0x7f) return SECRET_REFUSED_SENTINEL;
          const encoded = encoder.encode(String.fromCodePoint(cp));
          out.set(encoded, writeIdx);
          writeIdx += encoded.length;
        } else {
          return SECRET_REFUSED_SENTINEL;
        }
      }
      const view = out.subarray(0, writeIdx);
      if (!isAllowedMetadataBytes(view, kind)) return SECRET_REFUSED_SENTINEL;
      return decoder.decode(view);
    } finally {
      out.fill(0);
    }
  }

  function parseJsonEscapedTomlInPlace(bounds: { start: number; end: number }): { ok: true; value: CodexTomlProjection } | { ok: false; reason: CcSwitchInvalidReason } {
    if (bounds.end - bounds.start > MAX_CODEX_TOML_BYTES) return { ok: false, reason: "malformed_entry" };
    const out = new Uint8Array(bounds.end - bounds.start);
    const encodeInto = new TextEncoder();
    let readIdx = bounds.start;
    let writeIdx = 0;
    try {
      while (readIdx < bounds.end) {
        const b = bytes[readIdx]!;
        if (b !== 0x5c) {
          out[writeIdx++] = b;
          readIdx++;
          continue;
        }
        readIdx++;
        if (readIdx >= bounds.end) return { ok: false, reason: "malformed_entry" };
        const esc = bytes[readIdx]!;
        readIdx++;
        if (esc === 0x22 || esc === 0x5c || esc === 0x2f) out[writeIdx++] = esc;
        else if (esc === 0x6e) out[writeIdx++] = 0x0a;
        else if (esc === 0x72) out[writeIdx++] = 0x0d;
        else if (esc === 0x74) out[writeIdx++] = 0x09;
        else if (esc === 0x62) out[writeIdx++] = 0x08;
        else if (esc === 0x66) out[writeIdx++] = 0x0c;
        else if (esc === 0x75) {
          if (readIdx + 4 > bounds.end) return { ok: false, reason: "malformed_entry" };
          const hex = decoder.decode(bytes.subarray(readIdx, readIdx + 4));
          if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return { ok: false, reason: "malformed_entry" };
          readIdx += 4;
          let codePoint = parseInt(hex, 16);
          if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
            if (readIdx + 6 > bounds.end || bytes[readIdx] !== 0x5c || bytes[readIdx + 1] !== 0x75) {
              return { ok: false, reason: "malformed_entry" };
            }
            const lowHex = decoder.decode(bytes.subarray(readIdx + 2, readIdx + 6));
            if (!/^[0-9A-Fa-f]{4}$/.test(lowHex)) return { ok: false, reason: "malformed_entry" };
            const low = parseInt(lowHex, 16);
            if (low < 0xdc00 || low > 0xdfff) return { ok: false, reason: "malformed_entry" };
            readIdx += 6;
            codePoint = ((codePoint - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
          } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
            return { ok: false, reason: "malformed_entry" };
          }
          const encoded = encodeInto.encode(String.fromCodePoint(codePoint));
          out.set(encoded, writeIdx);
          writeIdx += encoded.length;
        } else {
          return { ok: false, reason: "malformed_entry" };
        }
      }
      return parseCodexTomlBytes(out.subarray(0, writeIdx));
    } finally {
      out.fill(0);
    }
  }

  function skipPrimitive(): void {
    const start = pos;
    while (pos < bytes.length) {
      const b = bytes[pos]!;
      if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x2c || b === 0x7d || b === 0x5d) break;
      pos++;
    }
    if (pos === start) throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
    const token = decoder.decode(bytes.subarray(start, pos));
    if (token !== "true" && token !== "false" && token !== "null" && !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token)) {
      throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
    }
  }

  function skipValue(depth = 0): void {
    if (depth > 64) throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
    skipWs();
    if (pos >= bytes.length) throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
    const b = bytes[pos]!;
    if (b === 0x22) {
      scanStringBounds();
    } else if (b === 0x7b) {
      pos++;
      skipWs();
      if (bytes[pos] === 0x7d) { pos++; return; }
      for (;;) {
        skipWs();
        scanStringBounds();
        skipWs();
        if (bytes[pos] !== 0x3a) throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
        pos++;
        skipValue(depth + 1);
        skipWs();
        if (bytes[pos] === 0x2c) { pos++; continue; }
        if (bytes[pos] === 0x7d) { pos++; break; }
        throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
      }
    } else if (b === 0x5b) {
      pos++;
      skipWs();
      if (bytes[pos] === 0x5d) { pos++; return; }
      for (;;) {
        skipValue(depth + 1);
        skipWs();
        if (bytes[pos] === 0x2c) { pos++; continue; }
        if (bytes[pos] === 0x5d) { pos++; break; }
        throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
      }
    } else {
      skipPrimitive();
    }
  }

  function readOptionalScalarString(kind: MetadataFieldKind): string | null {
    skipWs();
    if (bytes[pos] === 0x22) return decodeMetadataStringFromBounds(scanStringBounds(), kind);
    skipValue();
    return null;
  }

  function parseSettingsObject(row: RawExtractedRow): void {
    skipWs();
    if (bytes[pos] !== 0x7b) {
      row.settingsType = null;
      skipValue();
      return;
    }
    row.settingsType = "object";
    pos++;
    skipWs();
    if (bytes[pos] === 0x7d) { pos++; return; }
    for (;;) {
      skipWs();
      const key = decodeBoundedString(scanStringBounds());
      skipWs();
      if (bytes[pos] !== 0x3a) throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
      pos++;
      skipWs();
      if (key === "env" && bytes[pos] === 0x7b) {
        pos++;
        skipWs();
        if (bytes[pos] === 0x7d) { pos++; }
        else {
          for (;;) {
            skipWs();
            const envKey = decodeBoundedString(scanStringBounds());
            skipWs();
            if (bytes[pos] !== 0x3a) throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
            pos++;
            if (envKey === "ANTHROPIC_BASE_URL") row.claudeBaseUrl = readOptionalScalarString("url");
            else if (envKey === "ANTHROPIC_MODEL") {
              const v = readOptionalScalarString("model");
              if (v) row.claudeModel = v;
            } else if (envKey === "ANTHROPIC_DEFAULT_SONNET_MODEL") {
              const v = readOptionalScalarString("model");
              if (v && !row.claudeModel) row.claudeModel = v;
            } else if (envKey === "OPENAI_BASE_URL" || envKey === "GEMINI_BASE_URL") {
              const v = readOptionalScalarString("url");
              if (v && !row.genericBaseUrl) row.genericBaseUrl = v;
            } else if (envKey === "OPENAI_MODEL" || envKey === "GEMINI_MODEL") {
              const v = readOptionalScalarString("model");
              if (v && !row.genericModel) row.genericModel = v;
            } else {
              skipValue();
            }
            skipWs();
            if (bytes[pos] === 0x2c) { pos++; continue; }
            if (bytes[pos] === 0x7d) { pos++; break; }
            throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
          }
        }
      } else if (key === "baseUrl" || key === "base_url") {
        const v = readOptionalScalarString("url");
        if (v && !row.genericBaseUrl) row.genericBaseUrl = v;
      } else if (key === "model" || key === "defaultModel") {
        const v = readOptionalScalarString("model");
        if (v && !row.genericModel) row.genericModel = v;
      } else if (key === "wire_api") {
        const v = readOptionalScalarString("wire");
        if (v) row.genericWireApi = v;
      } else if (key === "config") {
        skipWs();
        if (bytes[pos] === 0x22) {
          row.codexProjection = parseJsonEscapedTomlInPlace(scanStringBounds());
        } else {
          skipValue();
        }
      } else {
        skipValue();
      }
      skipWs();
      if (bytes[pos] === 0x2c) { pos++; continue; }
      if (bytes[pos] === 0x7d) { pos++; break; }
      throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
    }
  }

  function parseProviderEntryObject(fallbackId = "", fallbackApp = ""): RawExtractedRow {
    skipWs();
    if (bytes[pos] !== 0x7b) throw new CcSwitchImportError("Malformed CC-Switch JSON provider entry.");
    pos++;
    const row: RawExtractedRow = {
      id: fallbackId,
      appType: fallbackApp,
      settingsType: null,
      claudeBaseUrl: null,
      claudeModel: null,
      genericBaseUrl: null,
      genericModel: null,
      genericWireApi: null,
      codexTomlLines: null,
    };
    skipWs();
    if (bytes[pos] === 0x7d) { pos++; return row; }
    for (;;) {
      skipWs();
      const key = decodeBoundedString(scanStringBounds());
      skipWs();
      if (bytes[pos] !== 0x3a) throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
      pos++;
      if (key === "id") {
        const v = readOptionalScalarString("id");
        if (v !== null) row.id = v;
      } else if (key === "app_type" || key === "appType") {
        const v = readOptionalScalarString("app");
        if (v !== null) row.appType = v;
      } else if (key === "settings_config" || key === "settingsConfig") {
        parseSettingsObject(row);
      } else {
        // Never decode free-text "name", "notes", "websiteUrl", "meta", or unknown fields!
        skipValue();
      }
      skipWs();
      if (bytes[pos] === 0x2c) { pos++; continue; }
      if (bytes[pos] === 0x7d) { pos++; break; }
      throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
    }
    return row;
  }

  function parseProvidersCollection(appHint = ""): RawExtractedRow[] {
    const out: RawExtractedRow[] = [];
    skipWs();
    if (bytes[pos] === 0x5b) {
      pos++;
      skipWs();
      if (bytes[pos] === 0x5d) { pos++; return out; }
      for (;;) {
        out.push(parseProviderEntryObject("", appHint));
        skipWs();
        if (bytes[pos] === 0x2c) { pos++; continue; }
        if (bytes[pos] === 0x5d) { pos++; break; }
        throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
      }
    } else if (bytes[pos] === 0x7b) {
      pos++;
      skipWs();
      if (bytes[pos] === 0x7d) { pos++; return out; }
      for (;;) {
        skipWs();
        const id = decodeMetadataStringFromBounds(scanStringBounds(), "id");
        skipWs();
        if (bytes[pos] !== 0x3a) throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
        pos++;
        out.push(parseProviderEntryObject(id, appHint));
        skipWs();
        if (bytes[pos] === 0x2c) { pos++; continue; }
        if (bytes[pos] === 0x7d) { pos++; break; }
        throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
      }
    } else {
      throw new CcSwitchImportError("Malformed CC-Switch JSON providers section.");
    }
    return out;
  }

  function parseAppSection(appName: string): RawExtractedRow[] {
    const out: RawExtractedRow[] = [];
    skipWs();
    if (bytes[pos] !== 0x7b) { skipValue(); return out; }
    pos++;
    skipWs();
    if (bytes[pos] === 0x7d) { pos++; return out; }
    for (;;) {
      skipWs();
      const k = decodeBoundedString(scanStringBounds());
      skipWs();
      if (bytes[pos] !== 0x3a) throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
      pos++;
      if (k === "providers") out.push(...parseProvidersCollection(appName));
      else skipValue();
      skipWs();
      if (bytes[pos] === 0x2c) { pos++; continue; }
      if (bytes[pos] === 0x7d) { pos++; break; }
      throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
    }
    return out;
  }

  const rows: RawExtractedRow[] = [];
  let sawStructure = false;
  skipWs();
  if (bytes[pos] !== 0x7b) throw new CcSwitchImportError("CC-Switch JSON source must be a JSON object.");
  pos++;
  skipWs();
  if (bytes[pos] === 0x7d) {
    pos++;
  } else {
    for (;;) {
      skipWs();
      const topKey = decodeBoundedString(scanStringBounds());
      skipWs();
      if (bytes[pos] !== 0x3a) throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
      pos++;
      if (topKey === "providers") {
        sawStructure = true;
        rows.push(...parseProvidersCollection(""));
      } else if (topKey === "apps") {
        sawStructure = true;
        skipWs();
        if (bytes[pos] !== 0x7b) throw new CcSwitchImportError("Malformed CC-Switch JSON apps section.");
        pos++;
        skipWs();
        if (bytes[pos] === 0x7d) { pos++; }
        else {
          for (;;) {
            skipWs();
            const appName = decodeMetadataStringFromBounds(scanStringBounds(), "app");
            skipWs();
            if (bytes[pos] !== 0x3a) throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
            pos++;
            rows.push(...parseAppSection(appName));
            skipWs();
            if (bytes[pos] === 0x2c) { pos++; continue; }
            if (bytes[pos] === 0x7d) { pos++; break; }
            throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
          }
        }
      } else if (topKey === "claude" || topKey === "codex" || topKey === "openai" || topKey === "gemini" || topKey === "opencode") {
        sawStructure = true;
        rows.push(...parseAppSection(topKey));
      } else {
        skipValue();
      }
      skipWs();
      if (bytes[pos] === 0x2c) { pos++; continue; }
      if (bytes[pos] === 0x7d) { pos++; break; }
      throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
    }
  }
  skipWs();
  if (pos !== bytes.length || !sawStructure) {
    throw new CcSwitchImportError("CC-Switch JSON source does not contain a recognized providers structure.");
  }
  return rows;
}

export function readSourceRows(sourcePath: string): RawExtractedRow[] {
  const resolved = resolve(sourcePath);
  let beforeStat: ReturnType<typeof lstatSync>;
  try {
    assertPlainLocalPath(resolved);
    beforeStat = lstatSync(resolved);
  } catch {
    throw new CcSwitchImportError("CC-Switch source path must be a plain regular local file without symlink traversal.");
  }
  if (!beforeStat.isFile()) {
    throw new CcSwitchImportError("CC-Switch source path must be a regular file.");
  }
  sourceOpenHookForTests?.(resolved);
  let fd: number | undefined;
  let isSqlite = false;
  let size = 0;
  const header = Buffer.alloc(16);
  const copyChunk = Buffer.alloc(64 * 1024);
  let jsonBuf: Buffer | undefined;
  let snapDir: string | undefined;
  let snapPath: string | undefined;
  let snapFd: number | undefined;
  try {
    try {
      fd = openSync(
        resolved,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
      const opened = fstatSync(fd);
      if (!opened.isFile()) {
        throw new CcSwitchImportError("CC-Switch source path must be a regular file.");
      }
      if (opened.dev !== beforeStat.dev || opened.ino !== beforeStat.ino || opened.uid !== beforeStat.uid) {
        throw new CcSwitchImportError("CC-Switch source file changed while opening.");
      }
      size = opened.size;
      const n = readSync(fd, header, 0, 16, 0);
      if (n === 16 && header.subarray(0, 15).toString("ascii") === SQLITE_MAGIC_PREFIX && header[15] === 0) {
        isSqlite = true;
        if (size === 0 || size > MAX_SQLITE_BYTES) {
          throw new CcSwitchImportError("CC-Switch SQLite source exceeds the maximum supported size.");
        }
        snapDir = mkdtempSync(join(tmpdir(), "ocx-cc-switch-snap-"));
        try { chmodSync(snapDir, 0o700); } catch { /* ignore on Windows */ }
        snapPath = join(snapDir, "source.db");
        snapFd = openSync(
          snapPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        let offset = 0;
        while (offset < size) {
          const toRead = Math.min(copyChunk.length, size - offset);
          const got = readSync(fd, copyChunk, 0, toRead, offset);
          if (got <= 0) break;
          let written = 0;
          while (written < got) {
            written += writeSync(snapFd, copyChunk, written, got - written);
          }
          offset += got;
        }
        const extra = readSync(fd, copyChunk, 0, 1, size);
        if (offset !== size || extra !== 0) {
          throw new CcSwitchImportError("CC-Switch SQLite source changed while reading.");
        }
        closeSync(snapFd);
        snapFd = undefined;
      } else if (/\.(?:db|sqlite|sqlite3)$/i.test(resolved)) {
        throw new CcSwitchImportError("CC-Switch SQLite source is not a valid SQLite 3 file.");
      } else {
        if (size === 0 || size > MAX_JSON_BYTES) {
          throw new CcSwitchImportError("CC-Switch JSON source is empty or exceeds the maximum supported size.");
        }
        jsonBuf = Buffer.alloc(size + 1);
        let offset = 0;
        while (offset < jsonBuf.length) {
          const got = readSync(fd, jsonBuf, offset, jsonBuf.length - offset, offset);
          if (got <= 0) break;
          offset += got;
        }
        if (offset !== size) {
          throw new CcSwitchImportError("CC-Switch JSON source changed while reading.");
        }
      }
      assertPlainLocalPath(resolved);
      const afterStat = lstatSync(resolved);
      const afterFd = fstatSync(fd);
      if (
        afterStat.dev !== opened.dev
        || afterStat.ino !== opened.ino
        || afterStat.size !== opened.size
        || afterStat.mtimeMs !== opened.mtimeMs
        || afterFd.size !== opened.size
        || afterFd.mtimeMs !== opened.mtimeMs
      ) {
        throw new CcSwitchImportError("CC-Switch source file changed while reading.");
      }
    } catch (error) {
      if (error instanceof CcSwitchImportError) throw error;
      throw new CcSwitchImportError("CC-Switch source file could not be opened.");
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
      if (snapFd !== undefined) {
        try { closeSync(snapFd); } catch { /* ignore */ }
      }
    }

    if (isSqlite) {
      return readSqliteRows(snapPath!);
    }
    return scanCcSwitchJsonBytes(jsonBuf!.subarray(0, size));
  } finally {
    header.fill(0);
    copyChunk.fill(0);
    jsonBuf?.fill(0);
    if (snapPath !== undefined) {
      try { truncateSync(snapPath, 0); } catch { /* ignore */ }
      try { unlinkSync(snapPath); } catch { /* ignore */ }
    }
    if (snapDir !== undefined) {
      try { rmdirSync(snapDir); } catch { /* ignore */ }
    }
  }
}
