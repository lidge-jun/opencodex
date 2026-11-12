// Parsing produces data only. It does not establish schema validity or trust.
import { snapshotUpdateBytes } from "./update-bytes.mjs";
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const MAX_DEPTH = 16;
const MAX_MEMBERS = 32;
const MAX_ITEMS = 4096;
const MAX_TEXT_BYTES = 16384;
// The six maximal capability arrays require 73,735 values including containers.
const MAX_VALUES = 81920;
const NUMBER = /-?(?:0|[1-9][0-9]*)/y;

function invalid() {
  throw new Error("Invalid bounded update JSON");
}

function validUnicode(text) {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

/** Parse bounded UTF-8 JSON, refusing ambiguous names and unsafe numbers. */
export function parseBoundedJson(bytes, maxBytes) {
  if (!(bytes instanceof Uint8Array) || !Number.isSafeInteger(maxBytes)
      || maxBytes < 1 || maxBytes > MAX_DOCUMENT_BYTES) invalid();
  let source;
  try {
    const snapshot = snapshotUpdateBytes(bytes, maxBytes);
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(snapshot);
  } catch {
    invalid();
  }
  let offset = 0;
  let values = 0;
  const whitespace = () => {
    while (source[offset] === " " || source[offset] === "\n"
        || source[offset] === "\r" || source[offset] === "\t") offset++;
  };
  const readString = () => {
    if (source[offset] !== '"') invalid();
    const start = offset++;
    while (offset < source.length) {
      const char = source[offset++];
      if (char === '"') {
        let result;
        try { result = JSON.parse(source.slice(start, offset)); } catch { invalid(); }
        if (!validUnicode(result) || Buffer.byteLength(result, "utf8") > MAX_TEXT_BYTES) invalid();
        return result;
      }
      if (char === "\\") offset++;
      else if (char.charCodeAt(0) < 0x20) invalid();
    }
    invalid();
  };
  const readValue = (depth) => {
    if (++values > MAX_VALUES) invalid();
    whitespace();
    const first = source[offset];
    if (first === '"') return readString();
    if (first === "{" || first === "[") {
      if (depth >= MAX_DEPTH) invalid();
      offset++;
      whitespace();
      if (first === "{") {
        const result = Object.create(null);
        const names = new Set();
        if (source[offset] === "}") { offset++; return result; }
        while (true) {
          whitespace();
          const key = readString();
          if (names.has(key) || names.size >= MAX_MEMBERS) invalid();
          names.add(key);
          whitespace();
          if (source[offset++] !== ":") invalid();
          result[key] = readValue(depth + 1);
          whitespace();
          const delimiter = source[offset++];
          if (delimiter === "}") return result;
          if (delimiter !== ",") invalid();
        }
      }
      const result = [];
      if (source[offset] === "]") { offset++; return result; }
      while (true) {
        if (result.length >= MAX_ITEMS) invalid();
        result.push(readValue(depth + 1));
        whitespace();
        const delimiter = source[offset++];
        if (delimiter === "]") return result;
        if (delimiter !== ",") invalid();
      }
    }
    for (const [literal, value] of [["true", true], ["false", false], ["null", null]]) {
      if (source.startsWith(literal, offset)) { offset += literal.length; return value; }
    }
    NUMBER.lastIndex = offset;
    const match = NUMBER.exec(source);
    if (!match || match[0] === "-0") invalid();
    const number = Number(match[0]);
    if (!Number.isSafeInteger(number)) invalid();
    offset = NUMBER.lastIndex;
    return number;
  };
  const value = readValue(0);
  whitespace();
  if (offset !== source.length) invalid();
  return value;
}
