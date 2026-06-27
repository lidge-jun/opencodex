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

export function decodeCursorArgValue(value: Uint8Array): unknown {
  try {
    const parsed = fromBinary(ValueSchema, value);
    if (!sameBytes(toBinary(ValueSchema, parsed), value)) throw new Error("not canonical protobuf Value bytes");
    const jsonValue = toJson(ValueSchema, parsed);
    return typeof jsonValue === "string" ? parseJsonText(jsonValue) : jsonValue;
  } catch {
    return parseJsonText(textDecoder.decode(value));
  }
}

export function decodeCursorArgsMap(args: { [key: string]: Uint8Array } | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    out[key] = decodeCursorArgValue(value);
  }
  return out;
}
