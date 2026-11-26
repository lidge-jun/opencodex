/**
 * Extract one SSE field value from a single line, or null when the line is a different field.
 *
 * The space after the colon is OPTIONAL in text/event-stream: `data:{"a":1}` is as valid as
 * `data: {"a":1}`. Parsers that hardcoded `startsWith("data: ")` silently dropped every frame
 * from a producer that omits it, which surfaced as a completed turn with no content (#1170).
 *
 * Strips at most ONE leading space — the same rule `decodeServerSentEvents` applies — so a
 * payload that legitimately begins with whitespace keeps the rest of it. Does not trim the value:
 * callers own that choice, and some of them intentionally keep trailing bytes.
 */
export function sseFieldValue(line: string, field: string): string | null {
  if (!line.startsWith(field)) return null;
  const rest = line.slice(field.length);
  // A colonless field line is the field with an empty value per the SSE rules, and
  // `decodeServerSentEvents` treats it that way (`colon < 0` -> valueStart = line.length).
  // These helpers must not disagree with the decoder they mirror.
  if (rest.length === 0) return "";
  if (!rest.startsWith(":")) return null;
  return rest.startsWith(": ") ? rest.slice(2) : rest.slice(1);
}

/**
 * Offset-only variant of {@link sseFieldValue} for parsers that index into a larger buffer.
 *
 * Returns the index where the field's value begins within `text`, or -1 when the line at
 * `[lineStart, lineEnd)` is a different field. Slicing nothing matters for the live Claude relay,
 * whose translator-budget accounting reserves bytes by offset — materializing the line first would
 * allocate the very string the budget exists to bound.
 */
export function sseFieldOffset(text: string, lineStart: number, lineEnd: number, field: string): number {
  if (!text.startsWith(field, lineStart)) return -1;
  let valueStart = lineStart + field.length;
  // Colonless field line: empty value, positioned at end-of-line (matches the decoder).
  if (valueStart >= lineEnd) return lineEnd;
  if (text[valueStart] !== ":") return -1;
  valueStart += 1;
  if (valueStart < lineEnd && text[valueStart] === " ") valueStart += 1;
  return valueStart;
}
