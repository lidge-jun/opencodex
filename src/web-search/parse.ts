/** A single web source backing the sidecar's answer. */
export interface WebSearchSource {
  url: string;
  title?: string;
}

/** The sidecar's synthesized answer plus its sources (empty `sources` is fine). */
export interface WebSearchResult {
  text: string;
  sources: WebSearchSource[];
}

interface OutputTextBlock {
  type?: string;
  text?: string;
  annotations?: { type?: string; url?: string; title?: string }[];
}
interface OutputItem {
  type?: string;
  content?: OutputTextBlock[];
}

/** Pull final text + url_citation sources from a completed Responses `output[]` array. */
function fromOutputArray(output: OutputItem[]): WebSearchResult {
  let text = "";
  const sources: WebSearchSource[] = [];
  const seen = new Set<string>();
  for (const item of output) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const block of item.content) {
      if (block.type === "output_text" && typeof block.text === "string") {
        text += block.text;
        for (const ann of block.annotations ?? []) {
          if (ann.type === "url_citation" && ann.url && !seen.has(ann.url)) {
            seen.add(ann.url);
            sources.push({ url: ann.url, ...(ann.title ? { title: ann.title } : {}) });
          }
        }
      }
    }
  }
  return { text, sources };
}

/**
 * Parse the sidecar's streamed Responses SSE into a final answer + sources. Prefers the authoritative
 * `response.completed` output[] (full text + url_citation annotations); falls back to accumulated
 * `response.output_text.delta` text when no completed event arrives.
 */
export async function parseSidecarSSE(response: Response): Promise<WebSearchResult> {
  if (!response.body) return { text: "", sources: [] };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // Holder object — `final` is mutated inside the closure, so it can't live as a narrowed local.
  const acc: { deltaText: string; final: WebSearchResult | null } = { deltaText: "", final: null };

  const handle = (payload: string): void => {
    if (!payload || payload === "[DONE]") return;
    let data: Record<string, unknown>;
    try { data = JSON.parse(payload) as Record<string, unknown>; } catch { return; }
    const type = data.type as string | undefined;
    if (type === "response.output_text.delta" && typeof data.delta === "string") {
      acc.deltaText += data.delta;
    } else if (type === "response.completed" || type === "response.done") {
      const resp = data.response as { output?: OutputItem[] } | undefined;
      if (resp?.output) acc.final = fromOutputArray(resp.output);
    }
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

  if (acc.final && acc.final.text.trim()) return acc.final;
  return { text: acc.deltaText, sources: acc.final?.sources ?? [] };
}
