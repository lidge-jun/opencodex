import { Buffer } from "node:buffer";

/**
 * UTF-8 byte length of JSON.stringify(value) for a JSON.parse result, computed without
 * recursion: a valid body nested deeper than the call stack must be measured, not crash.
 */
export function serializedJsonByteLength(value: unknown): number {
  let bytes = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === null || typeof item !== "object") {
      bytes += Buffer.byteLength(JSON.stringify(item) ?? "null", "utf8");
    } else if (Array.isArray(item)) {
      bytes += 2 + Math.max(0, item.length - 1);
      for (let i = item.length - 1; i >= 0; i--) stack.push(item[i]);
    } else {
      const record = item as Record<string, unknown>;
      const keys = Object.keys(record);
      bytes += 2 + Math.max(0, keys.length - 1);
      for (const key of keys) {
        bytes += Buffer.byteLength(JSON.stringify(key), "utf8") + 1;
        stack.push(record[key]);
      }
    }
  }
  return bytes;
}
