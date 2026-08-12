import { PublicEvidenceValidationError } from "./validate";

function isJsonWhitespace(value: string | undefined): boolean {
  return value === " " || value === "\n" || value === "\r" || value === "\t";
}

function malformedJson(message: string): never {
  throw new PublicEvidenceValidationError("public_json", message);
}

function assertNoDuplicateJsonObjectKeys(text: string): void {
  let index = 0;

  function skipWhitespace(): void {
    while (isJsonWhitespace(text[index])) index += 1;
  }

  function parseStringToken(): string {
    if (text[index] !== '"') malformedJson("public JSON contains an invalid string token");
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
        try {
          const decoded = JSON.parse(text.slice(start, index));
          if (typeof decoded !== "string") malformedJson("public JSON contains an invalid string token");
          return decoded;
        } catch (error) {
          if (error instanceof PublicEvidenceValidationError) throw error;
          malformedJson("public JSON contains an invalid string token");
        }
      }
      if (ch.charCodeAt(0) < 0x20) malformedJson("public JSON contains an invalid control character");
    }
    malformedJson("public JSON contains an unterminated string token");
  }

  function parseScalar(): void {
    const start = index;
    while (index < text.length) {
      const ch = text[index];
      if (ch === "," || ch === "]" || ch === "}" || isJsonWhitespace(ch)) break;
      index += 1;
    }
    if (start === index) malformedJson("public JSON contains an invalid value");
    try {
      const parsed = JSON.parse(text.slice(start, index));
      if (parsed !== null && typeof parsed === "object") malformedJson("public JSON contains an invalid scalar value");
    } catch (error) {
      if (error instanceof PublicEvidenceValidationError) throw error;
      malformedJson("public JSON contains an invalid scalar value");
    }
  }

  function parseArray(): void {
    index += 1;
    skipWhitespace();
    if (text[index] === "]") {
      index += 1;
      return;
    }
    while (index < text.length) {
      parseValue();
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      if (text[index] !== ",") malformedJson("public JSON array is malformed");
      index += 1;
      skipWhitespace();
      if (text[index] === "]") malformedJson("public JSON array contains a trailing comma");
    }
    malformedJson("public JSON array is unterminated");
  }

  function parseObject(): void {
    index += 1;
    skipWhitespace();
    if (text[index] === "}") {
      index += 1;
      return;
    }
    const keys = new Set<string>();
    while (index < text.length) {
      if (text[index] !== '"') malformedJson("public JSON object key must be a string");
      const key = parseStringToken();
      if (keys.has(key)) {
        throw new PublicEvidenceValidationError("duplicate_json_key", `duplicate JSON object key: ${key}`);
      }
      keys.add(key);
      skipWhitespace();
      if (text[index] !== ":") malformedJson("public JSON object is missing a colon");
      index += 1;
      parseValue();
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      if (text[index] !== ",") malformedJson("public JSON object is malformed");
      index += 1;
      skipWhitespace();
      if (text[index] === "}") malformedJson("public JSON object contains a trailing comma");
    }
    malformedJson("public JSON object is unterminated");
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
  if (index === text.length) malformedJson("public JSON is empty");
  parseValue();
  skipWhitespace();
  if (index !== text.length) malformedJson("public JSON contains trailing data");
}

export function parseStrictPublicJson(bytes: Uint8Array, label = "public JSON"): unknown {
  const buffer = Buffer.from(bytes);
  const text = buffer.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(buffer)) {
    throw new PublicEvidenceValidationError("public_json", `${label} is not valid UTF-8 JSON`);
  }
  assertNoDuplicateJsonObjectKeys(text);
  try {
    return JSON.parse(text);
  } catch {
    throw new PublicEvidenceValidationError("public_json", `${label} is not valid JSON`);
  }
}
