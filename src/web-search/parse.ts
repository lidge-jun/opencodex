/** A single web source backing the sidecar's answer. */
export interface WebSearchSource {
  url: string;
  title?: string;
}

/** The sidecar's synthesized answer plus its sources (empty `sources` is fine). */
export interface WebSearchResult {
  text: string;
  sources: WebSearchSource[];
  /** Set only when the stream surfaced an error AND produced no usable answer text. */
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

/** Push a `url_citation` annotation as a source, de-duplicated by URL. */
function collectAnnotation(ann: AnnotationLike | undefined, sources: WebSearchSource[], seen: Set<string>): void {
  if (!ann || ann.type !== "url_citation" || typeof ann.url !== "string" || seen.has(ann.url)) return;
  seen.add(ann.url);
  sources.push({ url: ann.url, ...(ann.title ? { title: ann.title } : {}) });
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
const URL_RE = /https?:\/\/[^\s<>()\[\]]+/;
// A "Sources:" / "Source:" header, allowing markdown prefixes (#, *, -, >) and bold/italic wrappers.
const SOURCES_HEADER_RE = /^\s*(?:#{1,6}\s*)?[-*>\s]*\**\s*sources?\s*\**\s*:?\s*\**\s*$/i;

/** Trim wrapping/trailing noise from a captured URL: angle brackets, then trailing punctuation. */
function cleanUrl(url: string): string {
  return url.replace(/^<+/, "").replace(/[)>\].,;:]+$/, "");
}

/** Derive a human title from the list-item text preceding the URL (strip markers, md link, seps). */
function cleanTitle(prefix: string): string {
  let title = prefix.replace(/^[-*>\d.)\s]+/, "").trim();
  // `[title](` from a markdown link, or a leading `[`.
  title = title.replace(/^\[/, "").replace(/\]\(?$/, "").replace(/[:\-—(<]\s*$/, "").trim();
  return title;
}

function extractTrailingSources(text: string): { text: string; sources: WebSearchSource[] } {
  const lines = text.split("\n");
  // Find the LAST line that is a "Sources:" header (markdown prefixes allowed).
  let headerIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (SOURCES_HEADER_RE.test(lines[i])) { headerIdx = i; break; }
  }
  if (headerIdx === -1) return { text, sources: [] };
  const sources: WebSearchSource[] = [];
  const seen = new Set<string>();
  // Track the last line index actually consumed as part of the source list so trailing prose after
  // the list survives (we strip the header through the last consumed source line, not to EOF).
  let lastConsumed = headerIdx;
  // A title line whose URL is expected on a following line (multiline entry).
  let pendingTitle: string | null = null;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (raw === "") {
      // Blank line between header and first entry is fine; a blank AFTER entries ends the list.
      if (sources.length > 0 || pendingTitle !== null) break;
      continue;
    }
    const m = raw.match(URL_RE);
    if (!m) {
      // A list-ish line with no URL may be a title whose URL is on the next line. Only treat it as a
      // pending title when it looks like a list item; otherwise it's prose → stop.
      if (/^[-*>\d.)]/.test(raw) || pendingTitle === null) {
        if (/^[-*>\d.)]/.test(raw)) { pendingTitle = raw; lastConsumed = i; continue; }
      }
      break;
    }
    const url = cleanUrl(m[0]);
    if (!url) { break; }
    lastConsumed = i;
    // Title: text before the URL on this line, else a buffered title from a preceding line.
    const inlinePrefix = raw.slice(0, m.index);
    const title = cleanTitle(inlinePrefix) || (pendingTitle ? cleanTitle(pendingTitle) : "");
    pendingTitle = null;
    if (seen.has(url)) continue;
    seen.add(url);
    sources.push(title ? { url, title } : { url });
  }
  if (sources.length === 0) return { text, sources: [] };
  // Keep text before the header AND any prose after the consumed source lines.
  const before = lines.slice(0, headerIdx).join("\n").replace(/\s+$/, "");
  const after = lines.slice(lastConsumed + 1).join("\n").replace(/^\s+/, "");
  const body = after ? (before ? `${before}\n\n${after}` : after) : before;
  return { text: body, sources };
}

/** Pull final text + url_citation sources from a completed Responses `output[]` array. */
function fromOutputArray(output: OutputItem[], seen: Set<string>): WebSearchResult {
  let text = "";
  const sources: WebSearchSource[] = [];
  for (const item of output) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const block of item.content) {
      if (block.type === "output_text" && typeof block.text === "string") {
        text += block.text;
        for (const ann of block.annotations ?? []) collectAnnotation(ann, sources, seen);
      }
    }
  }
  return { text, sources };
}

/**
 * Parse the sidecar's streamed Responses SSE into a final answer + sources. Tolerant of the full set of
 * Responses streaming events: prefers the authoritative `response.completed` output[], then the
 * `response.output_text.done` text; falls back to accumulated `response.output_text.delta`. Sources are
 * collected from EVERY shape they arrive in — `response.output_text.annotation.added` events (the
 * streaming path, which earlier testing missed → empty citations), `done`-block `annotations[]`, and
 * the final output[]. `response.failed`/`error` events surface as `error` when no answer text was produced.
 */
export async function parseSidecarSSE(response: Response): Promise<WebSearchResult> {
  if (!response.body) return { text: "", sources: [] };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const seen = new Set<string>();
  // Holder object — fields are mutated inside the closure, so they can't live as narrowed locals.
  const acc: {
    deltaText: string;
    doneText: string;
    final: WebSearchResult | null;
    streamSources: WebSearchSource[];
    error: string | null;
  } = { deltaText: "", doneText: "", final: null, streamSources: [], error: null };

  const handle = (payload: string): void => {
    if (!payload || payload === "[DONE]") return;
    let data: Record<string, unknown>;
    try { data = JSON.parse(payload) as Record<string, unknown>; } catch { return; }
    const type = data.type as string | undefined;
    if (type === "response.output_text.delta" && typeof data.delta === "string") {
      acc.deltaText += data.delta;
    } else if (type === "response.output_text.done" && typeof data.text === "string") {
      // The `done` event carries the full, authoritative text for one content part.
      acc.doneText += data.text;
    } else if (type === "response.completed" || type === "response.done") {
      const resp = data.response as { output?: OutputItem[] } | undefined;
      if (resp?.output) acc.final = fromOutputArray(resp.output, seen);
    } else if (type === "response.failed" || type === "response.incomplete" || type === "error") {
      const resp = data.response as { error?: { message?: string } } | undefined;
      const msg = resp?.error?.message
        ?? (data.error as { message?: string } | undefined)?.message
        ?? (typeof data.message === "string" ? data.message : undefined);
      if (msg) acc.error = msg;
    }
    // Citations stream as a dedicated `response.output_text.annotation.added` event (singular
    // `annotation`); capture it regardless of the exact event name so they aren't lost.
    if (data.annotation) collectAnnotation(data.annotation as AnnotationLike, acc.streamSources, seen);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data: ")) handle(line.slice(6).trim());
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Prefer the authoritative completed output[], then the done text, then accumulated deltas.
  const text = (acc.final?.text.trim() ? acc.final.text : "")
    || acc.doneText.trim() && acc.doneText
    || acc.deltaText;
  // Merge sources from the final output[] and the streaming annotation events.
  const sources = [...(acc.final?.sources ?? [])];
  const seenMerge = new Set(sources.map(s => s.url));
  for (const s of acc.streamSources) {
    if (!seenMerge.has(s.url)) { seenMerge.add(s.url); sources.push(s); }
  }
  // Hosted web_search usually omits url_citation annotations and lists sources in a trailing
  // `Sources:` markdown block instead. Pull those out (and strip the block from the answer so the
  // tool_result renderer doesn't print sources twice). Annotation titles win; text-block titles
  // only fill a gap. URL-deduped against annotation sources.
  const { text: body, sources: textSources } = extractTrailingSources(typeof text === "string" ? text : "");
  for (const s of textSources) {
    if (seenMerge.has(s.url)) continue;
    seenMerge.add(s.url);
    sources.push(s);
  }
  const finalText = textSources.length > 0 ? body : (typeof text === "string" ? text : "");
  if (!finalText.trim() && acc.error) return { text: "", sources, error: acc.error };
  return { text: finalText, sources };
}
