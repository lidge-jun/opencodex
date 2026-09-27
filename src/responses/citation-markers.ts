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
 *
 * Only citation spans are stripped. The same delimiters carry other inline directives
 * that the Codex App renders, such as `\uE200visualize\uE202{"path":…}\uE201` from the
 * bundled visualize plugin (#6039). A span is a citation only when the keyword between
 * START and its first SEPARATOR or END is one of `CITATION_KEYWORDS`; any other span
 * passes through byte for byte.
 */

/** Opens a citation span. */
export const CITATION_MARKER_START = "\uE200";
/** Separates the `cite` keyword and each source reference inside a span. */
export const CITATION_MARKER_SEPARATOR = "\uE202";
/** Closes a citation span. */
export const CITATION_MARKER_END = "\uE201";

/**
 * Keywords that mark a span as a ChatGPT citation. `filecite` is the uploaded-file variant
 * of `cite` and uses the same `turnN…` reference grammar.
 */
const CITATION_KEYWORDS: readonly string[] = ["cite", "filecite"];

/** True when the text contains any of the three delimiters. Cheap pre-check. */
export function hasCitationMarker(text: string): boolean {
  return text.includes(CITATION_MARKER_START)
    || text.includes(CITATION_MARKER_SEPARATOR)
    || text.includes(CITATION_MARKER_END);
}

/**
 * Upper bound on the length of a span (START through END inclusive).
 *
 * A real citation is `cite` plus a few turn-scoped ids, so it is far under this. Without a
 * bound, a backend that emits a START and never terminates it makes the streaming filter
 * withhold the rest of the response. A non-citation directive keeps later STARTs literal
 * only within the same bound, so one unterminated directive cannot hide a real citation for
 * the rest of the message.
 */
const MAX_CITATION_SPAN_LENGTH = 4_096;

export interface CitationMarkerFilter {
  /** Feed one streaming delta; returns the portion safe to emit now. */
  push(delta: string): string;
  /** Release anything still held when the message closes. */
  flush(): string;
}

/**
 * Remove every complete citation span from a whole string.
 *
 * This runs the streaming filter over the whole text, so the bridge's re-stripped
 * `output_text.done` always equals the concatenated deltas it already emitted (#3843).
 * Anything that is not a complete citation span stays verbatim: an unterminated START, a
 * stray SEPARATOR or END, and every non-citation directive.
 */
export function stripCitationMarkers(text: string): string {
  if (!text.includes(CITATION_MARKER_START)) return text;
  const filter = createCitationMarkerFilter();
  return filter.push(text) + filter.flush();
}

/**
 * Streaming filter, as a per-character state machine so the result never depends on how the
 * text was split into deltas.
 *
 * - `text`: ordinary text, emitted at once. A START opens `keyword`.
 * - `keyword`: the START and keyword so far are withheld while the keyword can still become
 *   a citation keyword. A SEPARATOR after a citation keyword enters `citation`; an END right
 *   after one removes the span. Any other keyword releases the text and enters `other`.
 * - `citation`: withheld until its END, then removed. A new START means this one was
 *   malformed, so it is released verbatim; so is a span that reaches the length bound.
 * - `other`: the keyword of a non-citation span, emitted at once. A START here means the
 *   earlier one was malformed and opens a new span; a SEPARATOR enters `opaque`.
 * - `opaque`: the body of a non-citation directive such as `visualize` (#6039), emitted at
 *   once. STARTs inside it are payload, not new spans, until its END or the length bound.
 *
 * A stream that ends while text is withheld releases it verbatim, so nothing the model
 * actually said is lost.
 */
export function createCitationMarkerFilter(): CitationMarkerFilter {
  let mode: "text" | "keyword" | "citation" | "other" | "opaque" = "text";
  // The withheld START, keyword, and body in `keyword` and `citation` modes.
  let held = "";
  // Characters from START so far in `other` and `opaque` modes.
  let spanLength = 0;
  const isKeywordPrefix = (keyword: string): boolean => CITATION_KEYWORDS.some(k => k.startsWith(keyword));

  return {
    push(delta: string): string {
      let out = "";
      let i = 0;
      while (i < delta.length) {
        if (mode === "text") {
          const next = delta.indexOf(CITATION_MARKER_START, i);
          if (next === -1) {
            out += delta.slice(i);
            break;
          }
          out += delta.slice(i, next);
          held = CITATION_MARKER_START;
          mode = "keyword";
          i = next + 1;
          continue;
        }
        const ch = delta[i]!;
        if (mode === "other" || mode === "opaque") {
          if (spanLength + 1 > MAX_CITATION_SPAN_LENGTH) {
            // Past the bound this is ordinary text again; handle the character in `text`.
            mode = "text";
            continue;
          }
          if (ch === CITATION_MARKER_START && mode === "other") {
            held = CITATION_MARKER_START;
            mode = "keyword";
          } else {
            out += ch;
            spanLength += 1;
            if (ch === CITATION_MARKER_END) mode = "text";
            else if (ch === CITATION_MARKER_SEPARATOR) mode = "opaque";
          }
          i += 1;
          continue;
        }
        i += 1;
        if (ch === CITATION_MARKER_START) {
          // The withheld START was malformed: release it and open a new span here.
          out += held;
          held = CITATION_MARKER_START;
          mode = "keyword";
          continue;
        }
        if (mode === "citation") {
          if (ch === CITATION_MARKER_END) {
            held = "";
            mode = "text";
            continue;
          }
          held += ch;
          // One more character plus an END would exceed the bound, so this is not a span.
          if (held.length >= MAX_CITATION_SPAN_LENGTH) {
            out += held;
            held = "";
            mode = "text";
          }
          continue;
        }
        // mode === "keyword"
        if (ch === CITATION_MARKER_SEPARATOR || ch === CITATION_MARKER_END) {
          if (CITATION_KEYWORDS.includes(held.slice(1))) {
            if (ch === CITATION_MARKER_END) {
              held = "";
              mode = "text";
            } else {
              held += ch;
              mode = "citation";
            }
          } else {
            out += held + ch;
            spanLength = held.length + 1;
            held = "";
            mode = ch === CITATION_MARKER_END ? "text" : "opaque";
          }
          continue;
        }
        held += ch;
        if (!isKeywordPrefix(held.slice(1))) {
          out += held;
          spanLength = held.length;
          held = "";
          mode = "other";
        }
      }
      return out;
    },
    flush(): string {
      const rest = held;
      held = "";
      spanLength = 0;
      mode = "text";
      return rest;
    },
  };
}
