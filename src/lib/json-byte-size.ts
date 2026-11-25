import { TRANSLATOR_MAX_TURN_BYTES, TranslatorBudgetExceededError } from "./translator-budget";

/** Count one JSON string formed from parts without joining, serializing or encoding it. */
export function jsonStringPartsUtf8Bytes(parts: readonly string[], limit = TRANSLATOR_MAX_TURN_BYTES): number {
  let bytes = 0;
  let highSurrogate = false;
  const add = (count: number) => {
    if (count > limit - bytes) throw new TranslatorBudgetExceededError("request_copies", limit);
    bytes += count;
  };
  add(2); // The joined string has one pair of JSON quotes.
  for (const text of parts) {
    if (text.length > limit - bytes) throw new TranslatorBudgetExceededError("request_copies", limit);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (highSurrogate) {
        highSurrogate = false;
        if (code >= 0xdc00 && code <= 0xdfff) { add(4); continue; }
        add(6);
      }
      if (code >= 0xd800 && code <= 0xdbff) highSurrogate = true;
      else if (code === 0x22 || code === 0x5c || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) add(2);
      else if (code < 0x20) add(6);
      else if (code < 0x80) add(1);
      else if (code < 0x800) add(2);
      else if (code >= 0xdc00 && code <= 0xdfff) add(6);
      else add(3);
    }
  }
  if (highSurrogate) add(6);
  return bytes;
}

/** Measure plain JSON data without allocating its serialized string or UTF-8 copy. */
export function jsonUtf8Bytes(value: unknown, limit = TRANSLATOR_MAX_TURN_BYTES): number {
  let bytes = 0;
  const add = (count: number) => {
    if (count > limit - bytes) throw new TranslatorBudgetExceededError("request_copies", limit);
    bytes += count;
  };
  const string = (text: string) => {
    // Every UTF-16 code unit needs at least one JSON UTF-8 byte; reject large inputs
    // before walking them. Escapes and unpaired surrogates are counted below.
    if (text.length + 2 > limit - bytes) throw new TranslatorBudgetExceededError("request_copies", limit);
    add(2);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === 0x22 || code === 0x5c || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) add(2);
      else if (code < 0x20) add(6);
      else if (code < 0x80) add(1);
      else if (code < 0x800) add(2);
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) { add(4); i++; }
        else add(6);
      } else if (code >= 0xdc00 && code <= 0xdfff) add(6);
      else add(3);
    }
  };
  // Iterative walk: caller-controlled data (tool schemas, request bodies) can nest deeper than
  // the call stack allows. One frame per open container keeps the recursive visit order, so
  // the walk stops at the first element that exceeds the budget however wide the container is.
  type Frame =
    | { readonly array: readonly unknown[]; index: number }
    | { readonly object: Record<string, unknown>; readonly keys: readonly string[]; index: number; first: boolean };
  const stack: Frame[] = [];
  const visit = (item: unknown): void => {
    if (item === null) { add(4); return; }
    if (typeof item === "string") { string(item); return; }
    if (typeof item === "boolean") { add(item ? 4 : 5); return; }
    if (typeof item === "number") { add(Number.isFinite(item) ? String(item).length : 4); return; }
    if (Array.isArray(item)) { add(2); stack.push({ array: item, index: 0 }); return; }
    if (typeof item === "object") {
      add(2);
      stack.push({ object: item as Record<string, unknown>, keys: Object.keys(item), index: 0, first: true });
      return;
    }
    throw new TypeError("Expected plain JSON data for translation sizing");
  };
  visit(value);
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if ("array" in frame) {
      if (frame.index >= frame.array.length) { stack.pop(); continue; }
      const index = frame.index++;
      if (index > 0) add(1);
      const element = frame.array[index];
      if (element === undefined) add(4);
      else visit(element);
      continue;
    }
    let field: unknown;
    let key: string | undefined;
    while (frame.index < frame.keys.length) {
      const candidate = frame.keys[frame.index++]!;
      field = frame.object[candidate];
      if (field !== undefined) { key = candidate; break; }
    }
    if (key === undefined) { stack.pop(); continue; }
    if (!frame.first) add(1);
    frame.first = false;
    string(key);
    add(1);
    visit(field);
  }
  return bytes;
}
