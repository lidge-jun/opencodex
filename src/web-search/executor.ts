import type { OcxProviderConfig } from "../types";
import { FORWARD_HEADERS } from "../adapters/openai-responses";
import { signalWithTimeout, cancelBodyOnAbort } from "../lib/abort";
import { sidecarEnter } from "../lib/sidecar-tracker";
import { fetchWithResetRetry } from "../lib/upstream-retry";
import { parseSidecarSSE, type WebSearchResult } from "./parse";
import type { CodexUpstreamOutcome } from "../codex/routing";

export interface SidecarSettings {
  model: string;
  reasoning: string;
  timeoutMs: number;
  /**
   * True when the routed (downstream) model is text-only. The search model CAN see images, so it's
   * told to verbalize any relevant image results and include their URLs — otherwise a non-vision model
   * would receive bare image links it cannot interpret (the image-web-search gap).
   */
  describeImages?: boolean;
}

const BASE_INSTRUCTION =
  "You are a web-search assistant. Use the web_search tool to find current information for the " +
  "user's query, then reply with a concise, factual answer. End your reply with a `Sources:` " +
  "section listing each source you used on its own line as `- Title: URL` (one per line).";
const IMAGE_INSTRUCTION =
  " The model that will read your answer is TEXT-ONLY and cannot see images: if the results include " +
  "relevant images, describe what they show in words and include their source URLs in your answer.";

/** A search result, or an `error` string when the search couldn't run (surfaced as a tool result). */
export type SidecarOutcome = WebSearchResult & { error?: string };
export type SidecarOutcomeRecorder = (outcome: CodexUpstreamOutcome) => void;

/**
 * Execute ONE web search via the gpt-mini sidecar through the ChatGPT forward backend — the only path
 * with a real server-side web_search. Reuses selected forwarded OAuth headers (the forward adapter
 * has no key of its own), replays the hosted web_search tool config verbatim, and runs the mini at
 * minimal reasoning. Never throws — returns `{error}` so the caller injects a graceful tool result.
 */
export async function runWebSearch(
  query: string,
  hostedTool: Record<string, unknown>,
  forwardProvider: OcxProviderConfig,
  selectedForwardHeaders: Headers,
  settings: SidecarSettings,
  abortSignal?: AbortSignal,
  recordOutcome?: SidecarOutcomeRecorder,
): Promise<SidecarOutcome> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (forwardProvider.headers) Object.assign(headers, forwardProvider.headers);
  for (const h of FORWARD_HEADERS) {
    const v = selectedForwardHeaders.get(h);
    if (v) headers[h] = v;
  }
  const body = {
    model: settings.model,
    instructions: settings.describeImages ? BASE_INSTRUCTION + IMAGE_INSTRUCTION : BASE_INSTRUCTION,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: query }] }],
    tools: [hostedTool],
    tool_choice: "auto",
    reasoning: { effort: settings.reasoning },
    // NOTE: the ChatGPT (codex) backend rejects `max_output_tokens` ("Unsupported parameter") and
    // requires `store: false` — keep this body minimal. Answer length is capped downstream
    // (format-result clamps the injected tool_result), so no upstream cap is needed.
    store: false,
    stream: true,
  };
  const url = `${forwardProvider.baseUrl}/responses`;
  const linkedSignal = signalWithTimeout(settings.timeoutMs, abortSignal);
  const sidecarExit = sidecarEnter("web-search");
  try {
    const res = await fetchWithResetRetry(
      () => fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: linkedSignal.signal,
      }),
      { abortSignal: linkedSignal.signal, label: "web-search-sidecar" },
    );
    recordOutcome?.(res.status);
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { text: "", sources: [], error: `sidecar HTTP ${res.status}: ${t.slice(0, 200)}` };
    }
    const detachBodyGuard = cancelBodyOnAbort(res.body, linkedSignal.signal);
    try {
      return await parseSidecarSSE(res);
    } finally {
      detachBodyGuard();
    }
  } catch (e) {
    recordOutcome?.(e instanceof Error && e.name === "TimeoutError" ? "timeout" : "connect_error");
    return { text: "", sources: [], error: e instanceof Error ? e.message : String(e) };
  } finally {
    sidecarExit();
    linkedSignal.cleanup();
  }
}
