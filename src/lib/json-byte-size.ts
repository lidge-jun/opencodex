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
  // the call stack allows. Tasks run in the order a recursive walk would visit them.
  // A task is [separator bytes, object key or undefined, value, undefined counts as null].
  const stack: [number, string | undefined, unknown, boolean][] = [[0, undefined, value, false]];
  while (stack.length > 0) {
    const [separator, key, item, undefinedIsNull] = stack.pop()!;
    if (separator > 0) add(separator);
    if (key !== undefined) { string(key); add(1); }
    if (item === null || (item === undefined && undefinedIsNull)) { add(4); continue; }
    if (typeof item === "string") { string(item); continue; }
    if (typeof item === "boolean") { add(item ? 4 : 5); continue; }
    if (typeof item === "number") { add(Number.isFinite(item) ? String(item).length : 4); continue; }
    if (Array.isArray(item)) {
      add(2);
      for (let i = item.length - 1; i >= 0; i--) stack.push([i > 0 ? 1 : 0, undefined, item[i], true]);
      continue;
    }
    if (typeof item === "object") {
      add(2);
      const fields: [string, unknown][] = [];
      for (const field of Object.keys(item)) {
        const entry = (item as Record<string, unknown>)[field];
        if (entry !== undefined) fields.push([field, entry]);
      }
      for (let i = fields.length - 1; i >= 0; i--) stack.push([i > 0 ? 1 : 0, fields[i]![0], fields[i]![1], false]);
      continue;
    }
    throw new TypeError("Expected plain JSON data for translation sizing");
  }
  return bytes;
}
