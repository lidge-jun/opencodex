import { Buffer } from "node:buffer";

type Frame =
  | { items: readonly unknown[]; index: number }
  | { record: Record<string, unknown>; keys: readonly string[]; index: number };

/**
 * UTF-8 byte length of JSON.stringify(value) for a JSON.parse result, computed without
 * recursion: a valid body nested deeper than the call stack must be measured, not crash.
 * Each open container keeps one cursor frame, so arrays add no per-element queue; an object
 * frame retains its key list, which stays bounded by the input size.
 */
export function serializedJsonByteLength(value: unknown): number {
  let bytes = 0;
  const stack: Frame[] = [];
  const visit = (item: unknown): void => {
    if (item === null || typeof item !== "object") {
      bytes += Buffer.byteLength(JSON.stringify(item) ?? "null", "utf8");
    } else if (Array.isArray(item)) {
      bytes += 2 + Math.max(0, item.length - 1);
      stack.push({ items: item, index: 0 });
    } else {
      const record = item as Record<string, unknown>;
      const keys = Object.keys(record);
      bytes += 2 + Math.max(0, keys.length - 1);
      stack.push({ record, keys, index: 0 });
    }
  };
  visit(value);
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if ("items" in frame) {
      if (frame.index < frame.items.length) visit(frame.items[frame.index++]);
      else stack.pop();
    } else if (frame.index < frame.keys.length) {
      const key = frame.keys[frame.index++]!;
      bytes += Buffer.byteLength(JSON.stringify(key), "utf8") + 1;
      visit(frame.record[key]);
    } else {
      stack.pop();
    }
  }
  return bytes;
}
