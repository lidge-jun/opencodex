import { fromBinary, toBinary, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { textDecoder } from "./native-exec-common";

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * `preserveStrings` is for freeform tool bodies (#7049). A freeform `input` is text whatever it
 * looks like, so a body that happens to be valid JSON (`{}`, `42`, `null`) must not be
 * re-parsed into a non-string. A protobuf string Value is taken as-is; raw UTF-8 bytes are still
 * unquoted when they are one JSON string literal, and otherwise kept as the raw text.
 */
export function decodeCursorArgValue(value: Uint8Array, options: { preserveStrings?: boolean } = {}): unknown {
  try {
    const parsed = fromBinary(ValueSchema, value);
    if (!sameBytes(toBinary(ValueSchema, parsed), value)) throw new Error("not canonical protobuf Value bytes");
    const jsonValue = toJson(ValueSchema, parsed);
    if (typeof jsonValue !== "string") return jsonValue;
    return options.preserveStrings ? jsonValue : parseJsonText(jsonValue);
  } catch {
    const text = textDecoder.decode(value);
    const parsed = parseJsonText(text);
    return options.preserveStrings && typeof parsed !== "string" ? text : parsed;
  }
}

export function decodeCursorArgsMap(
  args: { [key: string]: Uint8Array } | undefined,
  options: { preserveStrings?: boolean } = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    out[key] = decodeCursorArgValue(value, options);
  }
  return out;
}
