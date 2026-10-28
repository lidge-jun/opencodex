import { sseFieldValue } from "../lib/sse-decoder";
import {
  appendSafeWebSearchSource,
  safeWebSearchSources,
  type SafeWebSearchSource,
} from "./sources";

/** A single web source backing the sidecar's answer. */
export type WebSearchSource = SafeWebSearchSource;

/** The sidecar's synthesized answer plus its sources (empty `sources` is fine). */
export interface WebSearchResult {
  text: string;
  sources: WebSearchSource[];
  /** Set when the stream failed, including when partial text was decoded before failure. */
  error?: string;
}

interface AnnotationLike {
  type?: string;
  url?: string;
  title?: string;
}
interface OutputTextBlock {
  type?: string;
  text?: string;
  annotations?: AnnotationLike[];
}
interface OutputItem {
  type?: string;
  content?: OutputTextBlock[];
}
/**
 * Completed output text and citations. `parts` holds each output_text block's text keyed by
 * `output_index:content_index`, and `incomplete` marks skipped malformed entries.
 */
type CompletedOutput = WebSearchResult & { incomplete: boolean; parts: Map<string, string> };
/** Streamed text for one `output_text` content part. */
interface StreamedPart {
  delta: string;
  done: string | null;
}

/** The streamed part for events that carry no valid `output_index`/`content_index`. */
const UNINDEXED_PART = "unindexed";

/**
 * Key a streamed text event by its content part. An event without valid indexes joins the only
 * indexed part when exactly one exists. The first indexed event identifies any preceding
 * unindexed accumulator; once multiple indexed parts exist, unindexed text stays separate.
 */
function streamedPartKey(data: Record<string, unknown>, parts: Map<string, StreamedPart>): string {
  const output = data.output_index;
  const content = data.content_index;
  if (Number.isInteger(output) && Number.isInteger(content)) {
    const key = `${output}:${content}`;
    if (parts.size === 1 && parts.has(UNINDEXED_PART)) {
      parts.set(key, parts.get(UNINDEXED_PART)!);
      parts.delete(UNINDEXED_PART);
    }
    return key;
  }
  const indexed = [...parts.keys()].filter(key => key !== UNINDEXED_PART);
  return indexed.length === 1 ? indexed[0]! : UNINDEXED_PART;
}

/** Order `output_index:content_index` keys numerically. */
function comparePartKeys(left: string, right: string): number {
  const [leftOutput = 0, leftContent = 0] = left.split(":").map(Number);
  const [rightOutput = 0, rightContent = 0] = right.split(":").map(Number);
  return leftOutput - rightOutput || leftContent - rightContent;
}

/** One part's streamed text: its done text when present, otherwise its deltas. */
function streamedPartText(part: StreamedPart): string {
  return part.done?.trim() ? part.done : part.delta;
}

/** Join indexed parts in index order, followed by any unindexed text. */
function assembleStreamedText(parts: Map<string, StreamedPart>): string {
  const keys = [...parts.keys()].filter(key => key !== UNINDEXED_PART).sort(comparePartKeys);
  if (parts.has(UNINDEXED_PART)) keys.push(UNINDEXED_PART);
  return keys.map(key => streamedPartText(parts.get(key)!)).join("");
}

/**
 * Rebuild an incomplete completed output part by part: a part keeps its completed text when the
 * completed output has it, and otherwise takes that part's streamed text.
 */
function mergeIncompleteOutput(completed: Map<string, string>, streamed: Map<string, StreamedPart>): string {
  const keys = [...new Set([...completed.keys(), ...streamed.keys()])].sort(comparePartKeys);
  return keys.map(key => {
    const text = completed.get(key);
    if (text?.trim()) return text;
    const part = streamed.get(key);
    return part ? streamedPartText(part) : text ?? "";
  }).join("");
}

// Keep this compatibility export for non-Responses sidecar executors and bounded error bodies.
export const MAX_SIDECAR_RESPONSE_BYTES = 64 * 1024;
// Responses SSE can spend far more wire bytes on JSON framing than on useful model output. Keep a
// larger finite wire ceiling while separately bounding the decoded text copies accumulated below.
export const MAX_SIDECAR_STREAM_BYTES = MAX_SIDECAR_RESPONSE_BYTES * 16;
export const MAX_SIDECAR_DECODED_CHARS = 64 * 1024;

/** Push a `url_citation` annotation as a source, de-duplicated by URL. */
function collectAnnotation(ann: AnnotationLike | undefined, sources: WebSearchSource[], seen: Set<string>): void {
  if (!ann || ann.type !== "url_citation" || typeof ann.url !== "string" || seen.has(ann.url)) return;
  if (appendSafeWebSearchSource(sources, {
    url: ann.url,
    ...(ann.title !== undefined ? { title: ann.title } : {}),
  })) seen.add(ann.url);
}

/**
 * Hosted web_search (gpt-mini) rarely emits structured `url_citation` annotations; instead it ends
 * its answer with a markdown `Sources:` section. Extract sources from that TRAILING section only
 * (a whole-body URL scan would false-positive on URLs the model merely mentions), and return the
 * answer text with that section stripped so the tool_result renderer doesn't double-print sources.
 *
 * Handles the per-line forms seen from the backend: `- title: url`, `- title (url)`,
 * `- [title](url)`, `- <url>`, `- url`, numbered `1. ...` variants, a markdown-prefixed header
 * (`### Sources:`, `**Sources**`), a title line whose URL sits on the FOLLOWING line, and trailing
 * URL punctuation (`;`, `,`, `)`, `]`, `.`). Prose that follows the source list is preserved.
 */
const URL_RE = /https?:\/\/[^\s<>()\[\]]+/i;
// Recognize URI-like candidates separately from the HTTP(S)-only acceptance boundary. A rejected
// citation (for example `javascript:`) still belongs to the trailing Sources block and must not be
// left behind as ordinary assistant text.
// The scheme length is bounded so a long word without a colon is scanned in linear time.
const URI_LIKE_RE = /[a-z][a-z0-9+.-]{0,31}:[^\s<>()\[\]]+/i;
// A "Sources:" / "Source:" header, allowing markdown prefixes (#, *, -, >) and bold/italic wrappers.
const SOURCES_WORD_RE = /^sources?/i;

/** Match the legacy Sources-header grammar without overlapping regex quantifiers. */
function isSourcesHeader(line: string): boolean {
  let cursor = 0;
  /** Match one code unit using JavaScript's existing `\s` semantics. */
  const isWhitespace = (char: string | undefined): boolean => char !== undefined && /\s/u.test(char);
  /** Advance over the current contiguous whitespace run. */
  const skipWhitespace = (): void => {
    while (isWhitespace(line[cursor])) cursor += 1;
  };
  /** Advance over the current contiguous Markdown-star run. */
  const skipStars = (): void => {
    while (line[cursor] === "*") cursor += 1;
  };

  skipWhitespace();
  if (line[cursor] === "#") {
    const start = cursor;
    while (line[cursor] === "#") cursor += 1;
    if (cursor - start > 6) return false;
    skipWhitespace();
  }

  while (isWhitespace(line[cursor]) || line[cursor] === "-" || line[cursor] === "*" || line[cursor] === ">") {
    cursor += 1;
  }

  const word = SOURCES_WORD_RE.exec(line.slice(cursor, cursor + 7));
  if (!word) return false;
  cursor += word[0].length;

  // Preserve `\s*\**\s*:?\s*\**\s*$`: at most two star runs, with the optional
  // colon between them. Either run may be empty, so `Sources:*` is one trailing run; three
  // separated runs and a colon after the second run remain invalid.
  skipWhitespace();
  skipStars();
  skipWhitespace();
  if (line[cursor] === ":") {
    cursor += 1;
    skipWhitespace();
  }
  skipStars();
  skipWhitespace();
  return cursor === line.length;
}

/** Trim wrapping/trailing noise from a captured URL: angle brackets, then trailing punctuation and code backticks. */
function cleanUrl(url: string): string {
  return url.replace(/^<+/, "").replace(/[)>\].,;:`]+$/, "");
}

/** Derive a human title from the list-item text preceding the URL (strip markers, md link, seps). */
function cleanTitle(prefix: string): string {
  let title = prefix.replace(/^[-*+>\d.)\s]+/, "").trim();
  // `[title](` from a markdown link, or a leading `[`.
  title = title.replace(/^\[/, "").replace(/\]\(?$/, "");
  // Trailing separators and an opening code backtick, trimmed by a linear scan.
  let end = title.length;
  while (end > 0 && TITLE_TRAILING_SEPARATORS.has(title[end - 1]!)) end -= 1;
  return title.slice(0, end).trim();
}

const TITLE_TRAILING_SEPARATORS = new Set([":", "-", "—", "(", "<", "`", " ", "\t"]);

/** A line that looks like a list item (bullet, quote or ordinal marker). */
const LIST_ITEM_RE = /^[-*+>\d.)]/;

/**
 * Replace inline code spans with spaces of equal length. A span opens and closes with backtick runs
 * of equal length; runs are paired in one pass, so an unmatched run cannot cause backtracking.
 */
function maskInlineCode(line: string): string {
  const runs: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < line.length;) {
    if (line[index] !== "`") { index += 1; continue; }
    const start = index;
    while (line[index] === "`") index += 1;
    runs.push({ start, end: index });
  }
  if (runs.length < 2) return line;
  // For each run, the index of the next run with the same length, or -1.
  const next = new Array<number>(runs.length).fill(-1);
  const lastByLength = new Map<number, number>();
  for (let run = runs.length - 1; run >= 0; run -= 1) {
    const length = runs[run]!.end - runs[run]!.start;
    next[run] = lastByLength.get(length) ?? -1;
    lastByLength.set(length, run);
  }
  let masked = "";
  let cursor = 0;
  for (let run = 0; run < runs.length;) {
    const close = next[run]!;
    if (close === -1) { run += 1; continue; }
    masked += line.slice(cursor, runs[run]!.start) + " ".repeat(runs[close]!.end - runs[run]!.start);
    cursor = runs[close]!.end;
    run = close + 1;
  }
  return masked + line.slice(cursor);
}

/**
 * Move citation lines from the last `Sources:` block into `sources` and strip them from the text.
 * List items that cannot be paired with a URL stay in the answer, and every consumed citation line,
 * including one whose URL is rejected as unsafe, leaves the text.
 */
function extractTrailingSources(text: string): { text: string; sources: WebSearchSource[]; stripped: boolean } {
  const lines = text.split("\n");
  // Find the LAST line that is a "Sources:" header (markdown prefixes allowed).
  let headerIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isSourcesHeader(lines[i])) { headerIdx = i; break; }
  }
  if (headerIdx === -1) return { text, sources: [], stripped: false };
  const sources: WebSearchSource[] = [];
  const seen = new Set<string>();
  // Track the last line index actually consumed as part of the source list so trailing prose after
  // the list survives (we strip the header through the last consumed source line, not to EOF).
  let lastConsumed = headerIdx;
  // A title line whose URL is expected on a following line (multiline entry).
  let pendingTitle: string | null = null;
  let pendingIndex = -1;
  // Line indexes of list items that turned out not to title a URL; they remain answer text.
  const keptNotes: number[] = [];
  let consumedSourceLine = false;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (raw === "") {
      // Blank line between header and first entry is fine; a blank AFTER entries ends the list.
      if (consumedSourceLine || pendingTitle !== null) break;
      continue;
    }
    const httpMatch = raw.match(URL_RE);
    // URI-like text inside an inline code span of any backtick run, such as `mode:fast`, is prose
    // rather than a citation. HTTP(S) URLs keep their citation meaning even when code-formatted.
    const m = httpMatch ?? maskInlineCode(raw).match(URI_LIKE_RE);
    if (!m) {
      // A list-ish line with no URL may be a title whose URL is on the next line. Only treat it as a
      // pending title when it looks like a list item; otherwise it's prose → stop. A second list item
      // means the previous one was a note, so it is kept instead of discarded.
      if (!LIST_ITEM_RE.test(raw)) break;
      if (pendingTitle !== null) keptNotes.push(pendingIndex);
      pendingTitle = raw;
      pendingIndex = i;
      continue;
    }
    // A non-HTTP URI embedded in prose is not sufficient to classify the line as a citation.
    // Accept it as a consumed source line only when it is a list item or the whole line starts with
    // the URI candidate, matching the existing bare-URL grammar.
    if (!httpMatch && !LIST_ITEM_RE.test(raw) && m.index !== 0) break;
    const url = cleanUrl(m[0]);
    if (!url) { break; }
    const inlinePrefix = raw.slice(0, m.index);
    const inlineTitle = cleanTitle(inlinePrefix);
    // A self-titled citation, or a URL that starts its own list item, does not prove that the
    // preceding bullet was its title. Only an unmarked continuation line pairs with it.
    const startsListItem = /^(?:[-*+>]|\d+[.)])\s/.test(raw);
    const pairsWithPending = pendingTitle !== null && !inlineTitle && !startsListItem;
    if (pendingTitle !== null && !pairsWithPending) keptNotes.push(pendingIndex);
    consumedSourceLine = true;
    lastConsumed = i;
    // Title: text before the URL on this line, else a buffered title from a preceding line.
    const title = inlineTitle || (pairsWithPending ? cleanTitle(pendingTitle!) : "");
    pendingTitle = null;
    if (seen.has(url)) continue;
    if (appendSafeWebSearchSource(sources, title ? { url, title } : { url })) seen.add(url);
  }
  if (!consumedSourceLine) return { text, sources: [], stripped: false };
  // Keep text before the header, notes found between citations, and anything after the last citation.
  const before = lines.slice(0, headerIdx).join("\n").replace(/\s+$/, "");
  const notes = keptNotes.filter(index => index < lastConsumed).map(index => lines[index]);
  const after = [...notes, lines.slice(lastConsumed + 1).join("\n").replace(/^\s+/, "")].filter(Boolean).join("\n");
  const body = after ? (before ? `${before}\n\n${after}` : after) : before;
  return { text: body, sources, stripped: true };
}

/**
 * Pull final text + url_citation sources from a completed Responses `output[]` array.
 * Malformed entries are skipped, and `incomplete` records that the text may be partial.
 */
function fromOutputArray(output: OutputItem[], seen: Set<string>): CompletedOutput {
  let text = "";
  let incomplete = false;
  const parts = new Map<string, string>();
  const sources: WebSearchSource[] = [];
  for (const [outputIndex, item] of output.entries()) {
    if (!item || typeof item !== "object") { incomplete = true; continue; }
    if (item.type !== "message") continue;
    if (!Array.isArray(item.content)) { incomplete = true; continue; }
    for (const [contentIndex, block] of item.content.entries()) {
      if (!block || typeof block !== "object") { incomplete = true; continue; }
      if (block.type === "output_text") {
        if (typeof block.text !== "string") { incomplete = true; continue; }
        text += block.text;
        parts.set(`${outputIndex}:${contentIndex}`, block.text);
        for (const ann of Array.isArray(block.annotations) ? block.annotations : []) collectAnnotation(ann, sources, seen);
      }
    }
  }
  return { text, sources, incomplete, parts };
}

export function cancelReaderWithoutWaiting(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: string,
): void {
  try {
    void reader.cancel(reason).catch(() => undefined);
  } catch { /* best-effort body teardown */ }
}

/**
 * Parse the sidecar's streamed Responses SSE into a final answer + sources. Tolerant of the full set of
 * Responses streaming events: prefers the authoritative `response.completed` output[], then the
 * `response.output_text.done` text; falls back to accumulated `response.output_text.delta`. Sources are
 * collected from EVERY shape they arrive in — `response.output_text.annotation.added` events (the
 * streaming path, which earlier testing missed → empty citations), `done`-block `annotations[]`, and
 * the final output[]. A terminal failure, a safety bound, or EOF before a terminal event surfaces as
 * `error` even when partial answer text was decoded.
 */
export async function parseSidecarSSE(response: Response): Promise<WebSearchResult> {
  if (!response.body) return { text: "", sources: [], error: "sidecar stream returned no response body" };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let responseBytes = 0;
  const seen = new Set<string>();
  // Holder object — fields are mutated inside the closure, so they can't live as narrowed locals.
  const acc: {
    parts: Map<string, StreamedPart>;
    final: CompletedOutput | null;
    streamSources: WebSearchSource[];
    error: string | null;
    decodedChars: number;
    terminalEvent: boolean;
    limitReached: boolean;
  } = {
    parts: new Map(),
    final: null,
    streamSources: [],
    error: null,
    decodedChars: 0,
    terminalEvent: false,
    limitReached: false,
  };

  /** The accumulator for the content part that `data` belongs to. */
  const streamedPart = (data: Record<string, unknown>): StreamedPart => {
    const key = streamedPartKey(data, acc.parts);
    let part = acc.parts.get(key);
    if (!part) { part = { delta: "", done: null }; acc.parts.set(key, part); }
    return part;
  };

  const acceptDecodedChars = (count: number): boolean => {
    if (count > MAX_SIDECAR_DECODED_CHARS - acc.decodedChars) {
      acc.error = "sidecar response decoded text limit reached";
      acc.limitReached = true;
      return false;
    }
    acc.decodedChars += count;
    return true;
  };

  const handle = (payload: string): void => {
    if (!payload) return;
    if (payload === "[DONE]") {
      acc.terminalEvent = true;
      return;
    }
    if (acc.limitReached) return;
    // Neither warning below copies the frame's content. An upstream SSE payload can carry model
    // output or credential material, and a malformed frame is exactly the case where the content
    // is least trustworthy. Length plus a classification separates the two failure modes in a log
    // without reproducing anything from the wire.
    let parsed: unknown;
    try { parsed = JSON.parse(payload); } catch {
      console.warn(`[web-search-parse] malformed SSE JSON (${payload.length} chars)`);
      return;
    }
    // `JSON.parse("null")` returns null rather than throwing, so the catch above cannot cover it
    // and the `data.type` read below threw out of parseSidecarSSE.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      const shape = Array.isArray(parsed) ? "array" : parsed === null ? "null" : typeof parsed;
      console.warn(`[web-search-parse] non-record SSE JSON frame (${payload.length} chars, ${shape})`);
      return;
    }
    const data = parsed as Record<string, unknown>;
    const type = typeof data.type === "string" ? data.type : undefined;
    if (type === "response.output_text.delta" && typeof data.delta === "string") {
      if (acceptDecodedChars(data.delta.length)) streamedPart(data).delta += data.delta;
    } else if (type === "response.output_text.done" && typeof data.text === "string") {
      // The `done` event carries the full, authoritative text for one content part.
      if (acceptDecodedChars(data.text.length)) {
        const part = streamedPart(data);
        part.done = (part.done ?? "") + data.text;
      }
    } else if (type === "response.completed" || type === "response.done") {
      acc.terminalEvent = true;
      const resp = data.response as { output?: OutputItem[] } | undefined;
      if (Array.isArray(resp?.output)) {
        const final = fromOutputArray(resp.output, seen);
        if (acceptDecodedChars(final.text.length)) acc.final = final;
      }
    } else if (type === "response.failed" || type === "response.incomplete" || type === "error") {
      acc.terminalEvent = true;
      const resp = data.response as { error?: { message?: string } } | undefined;
      const msg = resp?.error?.message
        ?? (data.error as { message?: string } | undefined)?.message
        ?? (typeof data.message === "string" ? data.message : undefined);
      acc.error = typeof msg === "string" && msg.trim() ? msg : `sidecar stream ended with ${type}`;
    } else if (type?.includes("reasoning") && typeof data.delta === "string") {
      // Reasoning is not returned, but it is still decoded payload retained transiently by JSON.parse.
      acceptDecodedChars(data.delta.length);
    }
    // Citations stream as a dedicated `response.output_text.annotation.added` event (singular
    // `annotation`); capture it regardless of the exact event name so they aren't lost.
    if (data.annotation) collectAnnotation(data.annotation as AnnotationLike, acc.streamSources, seen);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_SIDECAR_STREAM_BYTES - responseBytes;
      const accepted = value.byteLength <= remaining ? value : value.subarray(0, remaining);
      responseBytes += accepted.byteLength;
      buffer += decoder.decode(accepted, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const data = sseFieldValue(line, "data");
        if (data !== null) handle(data.trim());
      }
      if (acc.limitReached) {
        cancelReaderWithoutWaiting(reader, "sidecar response decoded text limit reached");
        buffer = "";
        break;
      }
      if (acc.terminalEvent) {
        cancelReaderWithoutWaiting(reader, "sidecar terminal event received");
        buffer = "";
        break;
      }
      if (responseBytes >= MAX_SIDECAR_STREAM_BYTES) {
        // Preserve complete events accepted up to the cap, but discard any unterminated line and
        // TextDecoder carry. Do not let a rejecting/hung cancel turn bounded partial output into
        // an error or keep this parser waiting on upstream teardown.
        cancelReaderWithoutWaiting(reader, "sidecar response byte limit reached");
        acc.error = "sidecar response byte limit reached before terminal event";
        acc.limitReached = true;
        buffer = "";
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Prefer the authoritative completed output[], then the done text, then accumulated deltas.
  // Each streamed content part contributes its done text, or its deltas when the done event never
  // arrived. A completed output that skipped malformed entries may be partial: indexed streams fill
  // only the parts it lacks, while an unindexed stream replaces it as a whole.
  const streamedText = assembleStreamedText(acc.parts);
  const completedText = acc.final?.text.trim() ? acc.final.text : "";
  let text = completedText || streamedText;
  if (acc.final?.incomplete) {
    const repaired = acc.parts.has(UNINDEXED_PART) ? streamedText : mergeIncompleteOutput(acc.final.parts, acc.parts);
    if (repaired.trim()) text = repaired;
  }
  // Merge sources from the final output[] and the streaming annotation events.
  const sources = safeWebSearchSources(acc.final?.sources ?? []);
  for (const s of acc.streamSources) {
    appendSafeWebSearchSource(sources, s);
  }
  // Hosted web_search usually omits url_citation annotations and lists sources in a trailing
  // `Sources:` markdown block instead. Pull those out (and strip the block from the answer so the
  // tool_result renderer doesn't print sources twice). Annotation titles win; text-block titles
  // only fill a gap. URL-deduped against annotation sources.
  const { text: body, sources: textSources, stripped } = extractTrailingSources(typeof text === "string" ? text : "");
  for (const s of textSources) {
    appendSafeWebSearchSource(sources, s);
  }
  const finalText = stripped ? body : (typeof text === "string" ? text : "");
  const error = acc.error ?? (!acc.terminalEvent ? "sidecar stream ended before terminal event" : null);
  if (error) return { text: finalText, sources, error };
  return { text: finalText, sources };
}
