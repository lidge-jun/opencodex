import type { OcxProviderConfig } from "../types";
import { FORWARD_HEADERS } from "../adapters/openai-responses";
import { parseSidecarSSE, type WebSearchResult } from "./parse";

export interface SidecarSettings {
  model: string;
  reasoning: string;
  timeoutMs: number;
}

/** A search result, or an `error` string when the search couldn't run (surfaced as a tool result). */
export type SidecarOutcome = WebSearchResult & { error?: string };

/**
 * Execute ONE web search via the gpt-mini sidecar through the ChatGPT forward backend — the only path
 * with a real server-side web_search. Reuses the caller's forwarded OAuth headers (the forward adapter
 * has no key of its own), replays the hosted web_search tool config verbatim, and runs the mini at
 * minimal reasoning. Never throws — returns `{error}` so the caller injects a graceful tool result.
 */
export async function runWebSearch(
  query: string,
  hostedTool: Record<string, unknown>,
  forwardProvider: OcxProviderConfig,
  incomingHeaders: Headers,
  settings: SidecarSettings,
): Promise<SidecarOutcome> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (forwardProvider.headers) Object.assign(headers, forwardProvider.headers);
  for (const h of FORWARD_HEADERS) {
    const v = incomingHeaders.get(h);
    if (v) headers[h] = v;
  }
  const body = {
    model: settings.model,
    instructions:
      "You are a web-search assistant. Use the web_search tool to find current information for the " +
      "user's query, then reply with a concise, factual answer and cite the sources you used.",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: query }] }],
    tools: [hostedTool],
    tool_choice: "auto",
    reasoning: { effort: settings.reasoning },
    store: false, // the ChatGPT (codex) backend rejects the request otherwise ("Store must be set to false")
    stream: true,
  };
  const url = `${forwardProvider.baseUrl}/responses`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(settings.timeoutMs),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { text: "", sources: [], error: `sidecar HTTP ${res.status}: ${t.slice(0, 200)}` };
    }
    return await parseSidecarSSE(res);
  } catch (e) {
    return { text: "", sources: [], error: e instanceof Error ? e.message : String(e) };
  }
}
