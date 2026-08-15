import { PublicEvidenceValidationError } from "./validate";

const MAX_PUBLIC_JSON_BYTES = 2 * 1024 * 1024;
const MAX_PUBLIC_JSON_DEPTH = 8;
const MAX_PUBLIC_JSON_OBJECT_KEYS = 64;
const MAX_PUBLIC_JSON_ARRAY_ELEMENTS = 512;
const MAX_PUBLIC_JSON_STRING_BYTES = 384 * 1024;

function isJsonWhitespace(value: string | undefined): boolean {
  return value === " " || value === "\n" || value === "\r" || value === "\t";
}

function malformedJson(code: string, message: string): never {
  throw new PublicEvidenceValidationError(code, message);
}

function assertStrictPublicJsonShape(text: string, invalidCode: string): void {
  let index = 0;
  let depth = 0;

  function invalid(message: string): never {
    return malformedJson(invalidCode, message);
  }

  function skipWhitespace(): void {
    while (isJsonWhitespace(text[index])) index += 1;
  }

  function parseStringToken(): string {
    if (text[index] !== '"') invalid("public JSON contains an invalid string token");
    const start = index;
    index += 1;
    let escaped = false;
    while (index < text.length) {
      const ch = text[index++]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        if (Buffer.byteLength(text.slice(start + 1, index - 1), "utf8") > MAX_PUBLIC_JSON_STRING_BYTES) {
          invalid(`public JSON string exceeds ${MAX_PUBLIC_JSON_STRING_BYTES} bytes`);
        }
        try {
          const decoded = JSON.parse(text.slice(start, index));
          if (typeof decoded !== "string") invalid("public JSON contains an invalid string token");
          return decoded;
        } catch (error) {
          if (error instanceof PublicEvidenceValidationError) throw error;
          invalid("public JSON contains an invalid string token");
        }
      }
      if (ch.charCodeAt(0) < 0x20) invalid("public JSON contains an invalid control character");
    }
    invalid("public JSON contains an unterminated string token");
  }

  function parseScalar(): void {
    const start = index;
    while (index < text.length) {
      const ch = text[index];
      if (ch === "," || ch === "]" || ch === "}" || isJsonWhitespace(ch)) break;
      index += 1;
    }
    if (start === index) invalid("public JSON contains an invalid value");
    try {
      const parsed = JSON.parse(text.slice(start, index));
      if (parsed !== null && typeof parsed === "object") invalid("public JSON contains an invalid scalar value");
    } catch (error) {
      if (error instanceof PublicEvidenceValidationError) throw error;
      invalid("public JSON contains an invalid scalar value");
    }
  }

  function enterContainer(): void {
    depth += 1;
    if (depth > MAX_PUBLIC_JSON_DEPTH) {
      invalid(`public JSON nesting depth exceeds ${MAX_PUBLIC_JSON_DEPTH}`);
    }
  }

  function parseArray(): void {
    enterContainer();
    try {
      index += 1;
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      let elementCount = 0;
      while (index < text.length) {
        elementCount += 1;
        if (elementCount > MAX_PUBLIC_JSON_ARRAY_ELEMENTS) {
          invalid(`public JSON array exceeds ${MAX_PUBLIC_JSON_ARRAY_ELEMENTS} elements`);
        }
        parseValue();
        skipWhitespace();
        if (text[index] === "]") {
          index += 1;
          return;
        }
        if (text[index] !== ",") invalid("public JSON array is malformed");
        index += 1;
        skipWhitespace();
        if (text[index] === "]") invalid("public JSON array contains a trailing comma");
      }
      invalid("public JSON array is unterminated");
    } finally {
      depth -= 1;
    }
  }

  function parseObject(): void {
    enterContainer();
    try {
      index += 1;
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      const keys = new Set<string>();
      while (index < text.length) {
        if (text[index] !== '"') invalid("public JSON object key must be a string");
        const key = parseStringToken();
        if (keys.has(key)) {
          throw new PublicEvidenceValidationError("duplicate_json_key", "duplicate JSON object key");
        }
        keys.add(key);
        if (keys.size > MAX_PUBLIC_JSON_OBJECT_KEYS) {
          invalid(`public JSON object exceeds ${MAX_PUBLIC_JSON_OBJECT_KEYS} keys`);
        }
        skipWhitespace();
        if (text[index] !== ":") invalid("public JSON object is missing a colon");
        index += 1;
        parseValue();
        skipWhitespace();
        if (text[index] === "}") {
          index += 1;
          return;
        }
        if (text[index] !== ",") invalid("public JSON object is malformed");
        index += 1;
        skipWhitespace();
        if (text[index] === "}") invalid("public JSON object contains a trailing comma");
      }
      invalid("public JSON object is unterminated");
    } finally {
      depth -= 1;
    }
  }

  function parseValue(): void {
    skipWhitespace();
    const ch = text[index];
    if (ch === "{") {
      parseObject();
      return;
    }
    if (ch === "[") {
      parseArray();
      return;
    }
    if (ch === '"') {
      parseStringToken();
      return;
    }
    parseScalar();
  }

  skipWhitespace();
  if (index === text.length) invalid("public JSON is empty");
  parseValue();
  skipWhitespace();
  if (index !== text.length) invalid("public JSON contains trailing data");
}

export function parseStrictPublicJson(
  bytes: Uint8Array,
  label = "public JSON",
  invalidCode = "public_json",
  maxBytes = MAX_PUBLIC_JSON_BYTES,
): unknown {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new PublicEvidenceValidationError(invalidCode, `${label} byte limit is invalid`);
  }
  if (bytes.byteLength > maxBytes) {
    throw new PublicEvidenceValidationError(invalidCode, `${label} exceeds ${maxBytes} bytes`);
  }
  const buffer = Buffer.from(bytes);
  const text = buffer.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(buffer)) {
    throw new PublicEvidenceValidationError(invalidCode, `${label} is not valid UTF-8 JSON`);
  }
  assertStrictPublicJsonShape(text, invalidCode);
  try {
    return JSON.parse(text);
  } catch {
    throw new PublicEvidenceValidationError(invalidCode, `${label} is not valid JSON`);
  }
}
