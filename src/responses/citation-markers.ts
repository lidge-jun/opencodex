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
 * The memory-citation tags the Codex client parses as hidden markup (openai/codex
 * `codex-rs/utils/stream-parser/src/citation.rs`): matching is literal and non-nested, the text
 * from an opening tag to the FIRST closing tag is hidden, and an opening tag that never closes is
 * auto-closed at the end of the stream, hiding everything after it. A model that quotes the tag
 * ("output the `...` block at the end") therefore appears to truncate at the quote. Backticks do
 * not protect it, because the client parses before any markdown rendering.
 */
const MEMORY_CITATION_OPEN = "<oai-mem-citation>";
const MEMORY_CITATION_CLOSE = "</oai-mem-citation>";
const MEMORY_CITATION_MENTION = /<(\/?oai-mem-citation>)/g;

/**
 * Body shape of a REAL memory-citation block: it opens with a complete `<citation_entries>` list, or
 * with a complete ids list (`<rollout_ids>` or `<thread_ids>`) when the entries are absent. That matches
 * the client's `parse_memory_citation` (`codex-rs/memories/read/src/citations.rs`), which accepts a block
 * carrying either list and rejects one carrying neither.
 *
 * This is what separates a block the client should render from a mention of the tag name inside
 * ordinary prose. Escaping both would break the real feature: the client would print the tags
 * instead of the citation list, and the turn's memory references would silently disappear.
 */
const MEMORY_CITATION_BODY_ELEMENTS: ReadonlyArray<readonly [open: string, close: string]> = [
  ["<citation_entries>", "</citation_entries>"],
  ["<rollout_ids>", "</rollout_ids>"],
  ["<thread_ids>", "</thread_ids>"],
];

/** First index at or after `from` (below `limit`) that is not whitespace. */
function skipWhitespace(text: string, from: number, limit: number): number {
  let at = from;
  while (at < limit && /\s/.test(text[at]!)) at++;
  return at;
}

/**
 * Longest candidate block, in UTF-16 code units (JavaScript string length), that the streaming
 * escaper holds while waiting for its closing tag; the whole-string form applies the same limit.
 * Callers charge the held bytes to their translator budget (`live_transient`) as the hold grows.
 */
const MAX_MEMORY_CITATION_HOLD = 16_384;

/**
 * Whether the text right after an opening tag still could begin a real block.
 *
 * A real block puts `<citation_entries>` (usually on the next line) immediately after the open
 * tag. Ordinary prose that quotes the tag puts a backtick, punctuation, or words there instead,
 * so one short lookahead separates the two without buffering the whole block.
 */
function bodyCouldBeReal(afterOpen: string): boolean {
  const trimmed = afterOpen.replace(/^\s+/, "");
  return MEMORY_CITATION_BODY_ELEMENTS.some(([open]) => open.startsWith(trimmed) || trimmed.startsWith(open));
}

function isMemoryCitationBlock(body: string): boolean {
  const trimmed = body.replace(/^\s+/, "");
  return MEMORY_CITATION_BODY_ELEMENTS.some(([open, close]) => trimmed.startsWith(open) && trimmed.includes(close, open.length));
}

/**
 * Whether an opening tag begins a real block: the entries list has to follow it directly.
 *
 * `isMemoryCitationBlock` over a whole body cannot answer this, because prose before a real block
 * also spans a `<citation_entries>…</citation_entries>…<rollout_ids>` stretch when the search is
 * anchored at the mention rather than at the block. The adjacency check is what makes the mention
 * provably a mention.
 */
function opensRealBlock(text: string, openAt: number, closeCache?: { at: number }): number | undefined {
  const afterOpen = openAt + MEMORY_CITATION_OPEN.length;
  const bodyStart = skipWhitespace(text, afterOpen, Math.min(text.length, openAt + MAX_MEMORY_CITATION_HOLD));
  if (!MEMORY_CITATION_BODY_ELEMENTS.some(([open]) => text.startsWith(open, bodyStart))) return undefined;
  // Callers scanning one string for several opening tags share the next closing tag, so prose with
  // many unclosed candidates costs one forward search instead of one per tag (-2: not searched yet).
  let close: number;
  if (closeCache) {
    if (closeCache.at === -2 || (closeCache.at !== -1 && closeCache.at < bodyStart)) {
      closeCache.at = text.indexOf(MEMORY_CITATION_CLOSE, bodyStart);
    }
    close = closeCache.at;
  } else {
    close = text.indexOf(MEMORY_CITATION_CLOSE, bodyStart);
  }
  if (close === -1) return undefined;
  // The streaming escaper holds at most MAX_MEMORY_CITATION_HOLD of a candidate, so a block larger
  // than that is a mention in BOTH forms; one size rule keeps deltas and `output_text.done` equal.
  if (close + MEMORY_CITATION_CLOSE.length - openAt > MAX_MEMORY_CITATION_HOLD) return undefined;
  return isMemoryCitationBlock(text.slice(afterOpen, close)) ? close + MEMORY_CITATION_CLOSE.length : undefined;
}

/**
 * Neutralize a literal memory-citation tag so the client renders it as text.
 *
 * The client parses the tag as markup before markdown, so wrapping it in backticks does not
 * protect it. The leading `<` becomes `&lt;`. In ordinary markdown text that renders as `<` again;
 * inside an inline code span or a fenced block CommonMark does not decode entities, so the reader
 * sees `&lt;oai-mem-citation>` literally. That visible difference is the trade-off for keeping the
 * rest of the answer: the alternative is the client hiding everything after the quote.
 *
 * Only the Responses wire needs this: Chat Completions and Messages clients never parse the tag,
 * so the bridges apply it behind `escapeMemoryCitationTags`.
 */
export function escapeMemoryCitationMentions(text: string): string {
  if (!text.includes("oai-mem-citation")) return text;
  // Claim real blocks FIRST, so a mention earlier in the prose cannot pair with a real block's
  // closing tag and leave the block half-escaped. Everything outside a claimed block is a
  // mention and gets escaped, tags included. Matching runs over the ORIGINAL string as one pass
  // (appendReplacement), because `String.replace` would re-scan the text we just escaped.
  const blocks: Array<{ start: number; end: number }> = [];
  const closeCache = { at: -2 };
  let searchFrom = 0;
  for (;;) {
    const open = text.indexOf(MEMORY_CITATION_OPEN, searchFrom);
    if (open === -1) break;
    const end = opensRealBlock(text, open, closeCache);
    if (end !== undefined) {
      blocks.push({ start: open, end });
      searchFrom = end;
    } else {
      searchFrom = open + MEMORY_CITATION_OPEN.length;
    }
  }
  // Outside claimed blocks every tag is a mention; one linear regex pass escapes them all.
  const escapedMentions = (segment: string): string => segment.replace(MEMORY_CITATION_MENTION, "&lt;$1");
  if (blocks.length === 0) return escapedMentions(text);
  let out = "";
  let cursor = 0;
  for (const block of blocks) {
    out += escapedMentions(text.slice(cursor, block.start));
    out += text.slice(block.start, block.end);
    cursor = block.end;
  }
  out += escapedMentions(text.slice(cursor));
  return out;
}

export interface MemoryCitationEscaper {
  /** Feed one streaming delta; returns the portion safe to emit now. */
  push(delta: string): string;
  /** Text still withheld at the end of the stream; resolve it with `escapeMemoryCitationMentions`. */
  pending(): string;
}

/** Escaper for deliveries that must not rewrite text (Chat Completions, Messages). */
export const passthroughMemoryCitationEscaper: MemoryCitationEscaper = {
  push: (delta: string) => delta,
  pending: () => "",
};

/**
 * Streaming form of `escapeMemoryCitationMentions`.
 *
 * A tag can straddle delta boundaries, so a per-delta regex would miss the mention that matters
 * most: the model writing the tag name one token at a time. The escaper buffers until it can tell
 * a mention from a real block. A real block is emitted verbatim, tags included, as soon as its
 * `<citation_entries>` body starts — the client keeps it, which is the whole point of the block.
 * Everything else is a mention and gets `&lt;`.
 */
export function createMemoryCitationEscaper(): MemoryCitationEscaper {
  /**
   * Unresolved tail. It starts at a `<` and is either a partial tag, or an opening tag whose block
   * has not closed yet. A candidate block is held WHOLE until its closing tag arrives, because only
   * the complete body (entries, then rollout ids) proves it is a real block rather than a mention.
   */
  let held = "";
  const escapeOpen = "&lt;" + MEMORY_CITATION_OPEN.slice(1);
  const escapeClose = "&lt;" + MEMORY_CITATION_CLOSE.slice(1);
  return {
    push(delta: string): string {
      if (!held && !delta.includes("<")) return delta;
      const input = held + delta;
      held = "";
      let out = "";
      let i = 0;
      while (i < input.length) {
        const next = input.indexOf("<", i);
        if (next === -1) {
          out += input.slice(i);
          break;
        }
        out += input.slice(i, next);
        // Look no further than one hold limit ahead: a real block never exceeds it, and slicing the
        // whole remainder for every tag would make one large delta of many tags quadratic.
        const tail = input.slice(next, next + MAX_MEMORY_CITATION_HOLD + 1);
        const remaining = input.length - next;
        if (tail.startsWith(MEMORY_CITATION_CLOSE)) {
          // A close tag outside a claimed block is prose.
          out += escapeClose;
          i = next + MEMORY_CITATION_CLOSE.length;
          continue;
        }
        if (!tail.startsWith(MEMORY_CITATION_OPEN)) {
          if (MEMORY_CITATION_OPEN.startsWith(tail) || MEMORY_CITATION_CLOSE.startsWith(tail)) {
            // A tag is still arriving.
            held = tail;
            return out;
          }
          out += "<";
          i = next + 1;
          continue;
        }
        const afterOpen = tail.slice(MEMORY_CITATION_OPEN.length);
        if (!bodyCouldBeReal(afterOpen)) {
          out += escapeOpen;
          i = next + MEMORY_CITATION_OPEN.length;
          continue;
        }
        const end = opensRealBlock(tail, 0);
        if (end !== undefined) {
          // A complete real block is released verbatim, both tags included, so the delta stream
          // equals what `escapeMemoryCitationMentions` keeps in the final text.
          out += tail.slice(0, end);
          i = next + end;
          continue;
        }
        if (!tail.includes(MEMORY_CITATION_CLOSE, MEMORY_CITATION_OPEN.length) && remaining <= MAX_MEMORY_CITATION_HOLD) {
          // The block may still close; hold it whole.
          held = tail;
          return out;
        }
        // Closed without a valid body, or too large to keep holding: a mention.
        out += escapeOpen;
        i = next + MEMORY_CITATION_OPEN.length;
      }
      return out;
    },
    pending(): string {
      return held;
    },
  };
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
