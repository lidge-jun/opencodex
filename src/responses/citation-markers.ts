/**
 * ChatGPT-backend citation markers.
 *
 * The ChatGPT backend delimits inline citations with Unicode private-use characters:
 *
 *     \uE200 cite \uE202 turn1view0 \uE202 turn1view1 \uE201
 *
 * The desktop client renders that as source chips. The Codex TUI does not: it prints the
 * codepoints literally, so the user sees "citeturn1view0turn1view1" in the answer and in
 * the saved transcript (#3150).
 *
 * OpenCodex neither produces nor understands this grammar — it arrives as ordinary
 * assistant text from a ChatGPT-derived backend (GitHub Copilot in the report). The proxy
 * is the last place that can remove it before a client that cannot render it.
 *
 * Strip, do not translate. The `turnNviewN` ids are turn-scoped and opaque, and the
 * response carries no mapping from them to a URL, so there is nothing to convert them
 * into. Structured `url_citation` annotations are a separate path and are untouched.
 */

/** Opens a citation span. */
export const CITATION_MARKER_START = "\uE200";
/** Separates the `cite` keyword and each source reference inside a span. */
export const CITATION_MARKER_SEPARATOR = "\uE202";
/** Closes a citation span. */
export const CITATION_MARKER_END = "\uE201";

/** True when the text contains any of the three delimiters. Cheap pre-check. */
export function hasCitationMarker(text: string): boolean {
  return text.includes(CITATION_MARKER_START)
    || text.includes(CITATION_MARKER_SEPARATOR)
    || text.includes(CITATION_MARKER_END);
}

/**
 * Remove every complete `START … END` span from a whole string.
 *
 * A START with no END is left alone rather than truncating the remainder: an unterminated
 * marker is malformed input, and dropping everything after it would delete real answer
 * text. A stray SEPARATOR or END outside a span is also left alone for the same reason —
 * this function only removes what it can prove is a citation span.
 */
export function stripCitationMarkers(text: string): string {
  if (!text.includes(CITATION_MARKER_START)) return text;
  let out = "";
  let index = 0;
  for (;;) {
    const start = text.indexOf(CITATION_MARKER_START, index);
    if (start === -1) {
      out += text.slice(index);
      return out;
    }
    const end = text.indexOf(CITATION_MARKER_END, start + 1);
    if (end === -1) {
      // Unterminated: keep the rest verbatim.
      out += text.slice(index);
      return out;
    }
    out += text.slice(index, start);
    index = end + 1;
  }
}

export interface CitationMarkerFilter {
  /** Feed one streaming delta; returns the portion safe to emit now. */
  push(delta: string): string;
  /** Release anything still held when the message closes. */
  flush(): string;
}

/**
 * Streaming filter.
 *
 * A marker can straddle a delta boundary — `\uE200cite` in one chunk and the rest in the
 * next — so a stateless per-delta strip would emit the tail of a span it never recognized.
 * This holds back the text from an unterminated START and releases it once the END arrives
 * (removed) or the stream ends (verbatim, so nothing the model actually said is lost).
 */
export function createCitationMarkerFilter(): CitationMarkerFilter {
  // Text from an open START that has not been terminated yet.
  let held = "";
  return {
    push(delta: string): string {
      const combined = held + delta;
      held = "";
      const start = combined.lastIndexOf(CITATION_MARKER_START);
      if (start === -1) return stripCitationMarkers(combined);
      const endAfterStart = combined.indexOf(CITATION_MARKER_END, start + 1);
      if (endAfterStart !== -1) return stripCitationMarkers(combined);
      // The trailing span is still open: emit everything before it, hold the rest.
      held = combined.slice(start);
      return stripCitationMarkers(combined.slice(0, start));
    },
    flush(): string {
      const rest = held;
      held = "";
      return rest;
    },
  };
}

