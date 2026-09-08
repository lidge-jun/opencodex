import { TRANSLATOR_MAX_TURN_BYTES, TranslatorBudgetExceededError } from "./translator-budget";

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
  const visit = (item: unknown): void => {
    if (item === null) { add(4); return; }
    if (typeof item === "string") { string(item); return; }
    if (typeof item === "boolean") { add(item ? 4 : 5); return; }
    if (typeof item === "number") { add(Number.isFinite(item) ? String(item).length : 4); return; }
    if (Array.isArray(item)) {
      add(2);
      for (let i = 0; i < item.length; i++) {
        if (i > 0) add(1);
        if (item[i] === undefined) add(4);
        else visit(item[i]);
      }
      return;
    }
    if (typeof item === "object" && item !== null) {
      add(2);
      let first = true;
      for (const key of Object.keys(item)) {
        const field = (item as Record<string, unknown>)[key];
        if (field === undefined) continue;
        if (!first) add(1);
        first = false;
        string(key);
        add(1);
        visit(field);
      }
      return;
    }
    throw new TypeError("Expected plain JSON data for translation sizing");
  };
  visit(value);
  return bytes;
}
