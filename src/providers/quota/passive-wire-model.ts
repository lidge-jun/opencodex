// Limits apply to UTF-16 code units, before any scan or candidate allocation.
const MAX_WIRE_BODY_LENGTH = 16 * 1024 * 1024;
const MAX_JSON_DEPTH = 128;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/** Extract the last top-level wire model only from a complete, bounded JSON object. */
export function extractPassiveWireModel(body: BodyInit | null | undefined): string | undefined {
  if (typeof body !== "string" || body.length > MAX_WIRE_BODY_LENGTH) return undefined;
  const input = body;
  let index = 0;
  let model: string | undefined;

  function whitespace(): void {
    while (input[index] === " " || input[index] === "\n" || input[index] === "\r" || input[index] === "\t") index++;
  }

  function string(): boolean {
    if (input[index++] !== '"') return false;
    while (index < input.length) {
      const code = input.charCodeAt(index++);
      if (code === 34) return true;
      if (code < 32) return false;
      if (code !== 92) continue;
      const escape = input[index++];
      if (escape === "u") {
        for (let n = 0; n < 4; n++) {
          const hex = input.charCodeAt(index++);
          if (!((hex >= 48 && hex <= 57) || (hex >= 65 && hex <= 70) || (hex >= 97 && hex <= 102))) return false;
        }
      } else if (escape !== '"' && escape !== "\\" && escape !== "/" && escape !== "b" && escape !== "f" && escape !== "n" && escape !== "r" && escape !== "t") {
        return false;
      }
    }
    return false;
  }

  function digit(): boolean {
    const code = input.charCodeAt(index);
    return code >= 48 && code <= 57;
  }

  function modelKey(start: number, end: number): boolean {
    if (end - start < 7 || end - start > 32) return false;
    let position = start + 1;
    for (const expected of "model") {
      if (input[position] === "\\") {
        if (input[position + 1] !== "u" || parseInt(input.slice(position + 2, position + 6), 16) !== expected.charCodeAt(0)) return false;
        position += 6;
      } else if (input[position++] !== expected) return false;
    }
    return position === end - 1;
  }

  function number(): boolean {
    if (input[index] === "-") index++;
    if (input[index] === "0") index++;
    else {
      if (!digit()) return false;
      while (digit()) index++;
    }
    if (input[index] === ".") {
      index++;
      if (!digit()) return false;
      while (digit()) index++;
    }
    if (input[index] === "e" || input[index] === "E") {
      index++;
      if (input[index] === "+" || input[index] === "-") index++;
      if (!digit()) return false;
      while (digit()) index++;
    }
    return true;
  }

  function value(depth: number): boolean {
    whitespace();
    const char = input[index];
    if (char === '"') return string();
    if (char === "{" || char === "[") return container(depth + 1, char === "{");
    if (char === "-" || digit()) return number();
    if (input.startsWith("true", index) || input.startsWith("null", index)) { index += 4; return true; }
    if (input.startsWith("false", index)) { index += 5; return true; }
    return false;
  }

  function container(depth: number, object: boolean): boolean {
    if (depth > MAX_JSON_DEPTH) return false;
    index++;
    whitespace();
    const close = object ? "}" : "]";
    if (input[index] === close) { index++; return true; }
    while (index < input.length) {
      let isModel = false;
      if (object) {
        const start = index;
        if (!string()) return false;
        if (depth === 1) isModel = modelKey(start, index);
        whitespace();
        if (input[index++] !== ":") return false;
        whitespace();
      }
      if (isModel) {
        model = undefined;
        if (input[index] === '"') {
          const start = index;
          if (!string()) return false;
          // 128 decoded characters can occupy at most 768 escaped code units.
          if (index - start <= 770) {
            const candidate: string = JSON.parse(input.slice(start, index));
            if (MODEL_PATTERN.test(candidate)) model = candidate;
          }
        } else if (!value(depth)) return false;
      } else if (!value(depth)) return false;
      whitespace();
      if (input[index] === close) { index++; return true; }
      if (input[index++] !== ",") return false;
      whitespace();
    }
    return false;
  }

  whitespace();
  if (input[index] !== "{" || !container(1, true)) return undefined;
  whitespace();
  return index === input.length ? model : undefined;
}
