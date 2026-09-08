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
  // Walk START-delimited segments exactly like the streaming filter below: a START whose
  // own segment (up to the next START) contains an END within the span bound is a span and
  // is removed; a START that is superseded by another START before any END, or whose span
  // exceeds MAX_CITATION_SPAN_LENGTH, is malformed text and stays verbatim. Pairing an
  // earlier malformed START with a later span's END would delete real answer text and,
  // worse, disagree with what the streaming deltas already emitted (#3843). The bound is
  // shared with the streaming filter for the same reason: a span it has already released
  // as over-bound must not be swallowed here when the END finally arrives.
  let start = text.indexOf(CITATION_MARKER_START);
  let out = text.slice(0, start);
  while (start !== -1) {
    const nextStart = text.indexOf(CITATION_MARKER_START, start + 1);
    const segment = text.slice(start, nextStart === -1 ? text.length : nextStart);
    const end = segment.indexOf(CITATION_MARKER_END, 1);
    out += end === -1 || end + 1 > MAX_CITATION_SPAN_LENGTH ? segment : segment.slice(end + 1);
    start = nextStart;
  }
  return out;
}

export interface CitationMarkerFilter {
  /** Feed one streaming delta; returns the portion safe to emit now. */
  push(delta: string): string;
  /** Release anything still held when the message closes. */
  flush(): string;
}

/**
 * Upper bound on the length of a citation span (START through END inclusive), and therefore
 * on the text the streaming filter withholds for one unterminated START.
 *
 * A real span is `cite` plus a few turn-scoped ids, so it is far under this. Without a
 * bound, a backend that emits a START and never terminates it makes `held` grow for the
 * whole response, and every later delta re-scans that accumulated prefix. The whole-string
 * strip applies the same bound so both paths classify a span identically regardless of how
 * the text was chunked.
 */
const MAX_CITATION_SPAN_LENGTH = 4_096;

/**
 * Streaming filter.
 *
 * A marker can straddle a delta boundary — `\uE200cite` in one chunk and the rest in the
 * next — so a stateless per-delta strip would emit the tail of a span it never recognized.
 * This holds back the text from an unterminated START and releases it once the END arrives
 * (removed) or the stream ends (verbatim, so nothing the model actually said is lost).
 *
 * A span that grows past `MAX_CITATION_SPAN_LENGTH` is malformed ordinary text, so
 * it is released verbatim instead of withheld; a later START can still open a valid span.
 */
export function createCitationMarkerFilter(): CitationMarkerFilter {
  // Text from an open START that has not been terminated yet.
  let held = "";
  return {
    push(delta: string): string {
      const combined = held + delta;
      held = "";
      let start = combined.indexOf(CITATION_MARKER_START);
      if (start === -1) return combined;
      let out = combined.slice(0, start);
      // Walk START-delimited segments independently so an earlier malformed START is never
      // paired with a later span's END (the whole-string strip would do exactly that).
      while (start !== -1) {
        const nextStart = combined.indexOf(CITATION_MARKER_START, start + 1);
        const segment = combined.slice(start, nextStart === -1 ? combined.length : nextStart);
        const end = segment.indexOf(CITATION_MARKER_END, 1);
        if (end !== -1 && end + 1 <= MAX_CITATION_SPAN_LENGTH) {
          // A complete span: drop it, keep whatever trails it inside this segment.
          out += segment.slice(end + 1);
        } else if (end === -1 && nextStart === -1 && segment.length <= MAX_CITATION_SPAN_LENGTH) {
          // Only a bounded trailing span can still be completed by a later delta.
          held = segment;
        } else {
          // Superseded by a later START, or over the bound (with or without a late END):
          // ordinary text, emitted verbatim so neither the retained text nor the per-delta
          // rescan grows without limit.
          out += segment;
        }
        start = nextStart;
      }
      return out;
    },
    flush(): string {
      const rest = held;
      held = "";
      return rest;
    },
  };
}
