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
 * The memory-citation tags the Codex client renders specially: it keeps the LAST
 * `<oai-mem-citation>` block and drops everything else, so a literal mention of the tag in prose
 * swallows the rest of the answer between the first opening tag and the last closing one. A
 * model that quotes the tag ("output the `...` block at the end") therefore appears to truncate
 * at the quote. Matches the open tag, the close tag, and a backticked open tag, since a fenced or
 * inline-code copy is what shows up inside an otherwise ordinary sentence.
 */
const MEMORY_CITATION_OPEN = "<oai-mem-citation>";
const MEMORY_CITATION_CLOSE = "</oai-mem-citation>";
const MEMORY_CITATION_TAG = /<\/?(oai-mem-citation)>/g;

/**
 * Body shape of a REAL memory-citation block: `<citation_entries>` plus `<rollout_ids>`.
 *
 * This is what separates a block the client should render from a mention of the tag name inside
 * ordinary prose. Escaping both would break the real feature: the client would print the tags
 * instead of the citation list, and the turn's memory references would silently disappear.
 */
const MEMORY_CITATION_BODY = /<citation_entries>[\s\S]*<\/citation_entries>[\s\S]*<rollout_ids>/;

/** First element of a real block's body, used to decide from a short lookahead. */
const MEMORY_CITATION_BODY_OPEN = "<citation_entries>";

/**
 * Whether the text right after an opening tag still could begin a real block.
 *
 * A real block puts `<citation_entries>` (usually on the next line) immediately after the open
 * tag. Ordinary prose that quotes the tag puts a backtick, punctuation, or words there instead,
 * so one short lookahead separates the two without buffering the whole block.
 */
function bodyCouldBeReal(afterOpen: string): boolean {
  const trimmed = afterOpen.replace(/^\s+/, "");
  return MEMORY_CITATION_BODY_OPEN.startsWith(trimmed) || trimmed.startsWith(MEMORY_CITATION_BODY_OPEN);
}

function isMemoryCitationBlock(body: string): boolean {
  return MEMORY_CITATION_BODY.test(body);
}

/**
 * Whether an opening tag begins a real block: the entries list has to follow it directly.
 *
 * `isMemoryCitationBlock` over a whole body cannot answer this, because prose before a real block
 * also spans a `<citation_entries>…</citation_entries>…<rollout_ids>` stretch when the search is
 * anchored at the mention rather than at the block. The adjacency check is what makes the mention
 * provably a mention.
 */
function opensRealBlock(text: string, openAt: number): number | undefined {
  const afterOpen = openAt + MEMORY_CITATION_OPEN.length;
  const bodyStart = afterOpen + (text.slice(afterOpen).match(/^\s*/)?.[0].length ?? 0);
  if (!text.startsWith(MEMORY_CITATION_BODY_OPEN, bodyStart)) return undefined;
  const close = text.indexOf(MEMORY_CITATION_CLOSE, bodyStart);
  if (close === -1) return undefined;
  return isMemoryCitationBlock(text.slice(afterOpen, close)) ? close + MEMORY_CITATION_CLOSE.length : undefined;
}

/**
 * Neutralize a literal memory-citation tag so the client renders it as text.
 *
 * The client parses the tag as markup, not as markdown, so wrapping it in backticks does not
 * protect it. Escaping the leading `<` as `&lt;` keeps the same visible characters in every
 * renderer while leaving the payload itself recognizable.
 */
export function escapeMemoryCitationMentions(text: string): string {
  if (!text.includes("oai-mem-citation")) return text;
  // Claim real blocks FIRST, so a mention earlier in the prose cannot pair with a real block's
  // closing tag and leave the block half-escaped. Everything outside a claimed block is a
  // mention and gets escaped, tags included. Matching runs over the ORIGINAL string as one pass
  // (appendReplacement), because `String.replace` would re-scan the text we just escaped.
  const blocks: Array<{ start: number; end: number }> = [];
  let searchFrom = 0;
  for (;;) {
    const open = text.indexOf(MEMORY_CITATION_OPEN, searchFrom);
    if (open === -1) break;
    const end = opensRealBlock(text, open);
    if (end !== undefined) {
      blocks.push({ start: open, end });
      searchFrom = end;
    } else {
      searchFrom = open + MEMORY_CITATION_OPEN.length;
    }
  }
  const escapedMentions = (segment: string): string => {
    let out = "";
    let i = 0;
    for (;;) {
      const open = segment.indexOf(MEMORY_CITATION_OPEN, i);
      const close = segment.indexOf(MEMORY_CITATION_CLOSE, i);
      const next = open === -1 ? close : close === -1 ? open : Math.min(open, close);
      if (next === -1) {
        out += segment.slice(i);
        return out;
      }
      out += segment.slice(i, next);
      const tag = open !== -1 && open === next ? MEMORY_CITATION_OPEN : MEMORY_CITATION_CLOSE;
      out += `&lt;${tag.slice(1)}`;
      i = next + tag.length;
    }
  };
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
  /** Unresolved tail: either a partial tag, or a tag whose follower has not arrived yet. */
  let held = "";
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
        const tail = input.slice(next);
        const isOpen = MEMORY_CITATION_OPEN.startsWith(tail) || tail.startsWith(MEMORY_CITATION_OPEN);
        const isClose = MEMORY_CITATION_CLOSE.startsWith(tail) || tail.startsWith(MEMORY_CITATION_CLOSE);
        if (!isOpen && !isClose) {
          out += "<";
          i = next + 1;
          continue;
        }
        // A complete close tag is never part of a block we would keep here: real blocks are
        // emitted whole from their opening tag, so this one belongs to prose.
        if (tail.startsWith(MEMORY_CITATION_CLOSE)) {
          out += "&lt;/oai-mem-citation>";
          i = next + MEMORY_CITATION_CLOSE.length;
          continue;
        }
        if (!tail.startsWith(MEMORY_CITATION_OPEN)) {
          // The open tag itself is still arriving.
          held = tail;
          return out;
        }
        const afterOpen = tail.slice(MEMORY_CITATION_OPEN.length);
        const trimmed = afterOpen.replace(/^\s+/, "");
        if (trimmed.length === 0) {
          // Whitespace-only follow-up could still be the start of a real block.
          held = tail;
          return out;
        }
        if (MEMORY_CITATION_BODY_OPEN.startsWith(trimmed) || trimmed.startsWith(MEMORY_CITATION_BODY_OPEN)) {
          // A real block: emit its opening tag and stream the body through untouched.
          out += MEMORY_CITATION_OPEN;
          i = next + MEMORY_CITATION_OPEN.length;
          continue;
        }
        out += "&lt;oai-mem-citation>";
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
  if (!text.includes(CITATION_MARKER_START)) return escapeMemoryCitationMentions(text);
  const filter = createCitationMarkerFilter();
  return escapeMemoryCitationMentions(filter.push(text) + filter.flush());
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
