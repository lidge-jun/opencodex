import type { OcxProviderConfig } from "../types";
import { getValidAccessToken } from "../oauth";
import { ANTHROPIC_OAUTH_BETA, CLAUDE_CODE_SYSTEM_INSTRUCTION } from "../oauth/anthropic";
import { CLAUDE_CODE_HEADERS, claudeCodeSessionId } from "../adapters/client-fingerprint";
import { signalWithTimeout, cancelBodyOnAbort } from "../lib/abort";
import { redactSecretString } from "../lib/redact";
import { sidecarEnter } from "../lib/sidecar-tracker";
import { fetchWithResetRetry } from "../lib/upstream-retry";
import type { WebSearchSource } from "./parse";
import { BASE_INSTRUCTION, IMAGE_INSTRUCTION, type SidecarOutcome, type SidecarSettings } from "./executor";

/** Hardcoded per-turn search bound handed to the server tool (mirrors the loop's maxSearches intent). */
const ANTHROPIC_MAX_USES = 3;
/** Answer budget; the injected tool_result is clamped downstream, so this only bounds the sidecar turn. */
const ANTHROPIC_MAX_TOKENS = 8192;

function isRec(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Fold an Anthropic Messages SSE stream (a web_search_20250305 turn) into a WebSearchResult.
 *
 * Anthropic streams the FULL `web_search_tool_result.content` array on `content_block_start` (not via
 * deltas), so sources are collected there; the answer text arrives as `text_delta` events, and
 * `citations_delta` (web_search_result_location) contributes any additional cited URLs. A
 * `web_search_tool_result_error` content object yields no sources. Never throws.
 */
export async function parseAnthropicSidecarSSE(res: Response): Promise<SidecarOutcome> {
  const sources: WebSearchSource[] = [];
  const seen = new Set<string>();
  const pushSource = (url: unknown, title: unknown): void => {
    if (typeof url !== "string" || url.length === 0 || seen.has(url)) return;
    seen.add(url);
    sources.push(typeof title === "string" && title.length > 0 ? { url, title } : { url });
  };

  let text = "";
  let sawToolResultError = false;
  if (!res.body) return { text: "", sources, error: "anthropic sidecar returned no response body" };

  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buffer = "";

  const handleFrame = (data: Record<string, unknown>): void => {
    const type = typeof data.type === "string" ? data.type : "";
    if (type === "content_block_start") {
      const block = isRec(data.content_block) ? data.content_block : {};
      if (block.type === "web_search_tool_result") {
        if (Array.isArray(block.content)) {
          for (const hit of block.content) {
            if (isRec(hit) && hit.type === "web_search_result") pushSource(hit.url, hit.title);
          }
        } else if (isRec(block.content) && block.content.type === "web_search_tool_result_error") {
          sawToolResultError = true;
        }
      }
    } else if (type === "content_block_delta") {
      const delta = isRec(data.delta) ? data.delta : {};
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        text += delta.text;
      } else if (delta.type === "citations_delta") {
        const citation = isRec(delta.citation) ? delta.citation : {};
        if (citation.type === "web_search_result_location") pushSource(citation.url, citation.title);
      }
    }
  };

  // Parse one SSE frame's `data:` payload and fold it. Shared by the streaming loop and the EOF flush.
  const processFrame = (rawFrame: string): void => {
    let dataLine = "";
    for (const line of rawFrame.split("\n")) {
      if (line.startsWith("data:")) dataLine += line.slice(line.startsWith("data: ") ? 6 : 5);
    }
    if (!dataLine || dataLine === "[DONE]") return;
    let data: unknown;
    try { data = JSON.parse(dataLine); } catch { return; }
    if (isRec(data)) handleFrame(data);
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Normalize CRLF on the ACCUMULATED buffer so a `\r\n` pair split across two network chunks
      // (chunk ends in `\r`, next starts with `\n`) still collapses to `\n` (audit round-2 F2).
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const rawFrame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        processFrame(rawFrame);
      }
    }
    // Flush the decoder and process any final unterminated frame (a stream that ends without \n\n).
    buffer = (buffer + decoder.decode()).replace(/\r\n/g, "\n");
    if (buffer.trim().length > 0) processFrame(buffer);
  } catch {
    /* mid-stream abort/decode failure: fall through with whatever text/sources were gathered */
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { text: "", sources, error: sawToolResultError ? "anthropic web search returned an error result" : "anthropic sidecar produced no answer" };
  }
  return { text: trimmed, sources };
}

/**
 * Execute ONE web search via a Claude sidecar through the STORED anthropic OAuth credential — the
 * Anthropic-backed analog of runWebSearch. Authenticates with getValidAccessToken (refresh handled)
 * and reproduces the Claude Code OAuth fingerprint (identity system block first, oauth beta, client
 * headers, stable session id) so the request is first-party-shaped. Never throws — returns `{error}`
 * so the caller injects a graceful tool result.
 */
export async function runAnthropicWebSearch(
  query: string,
  providerName: string,
  provider: OcxProviderConfig,
  settings: SidecarSettings,
  abortSignal?: AbortSignal,
): Promise<SidecarOutcome> {
  const base = provider.baseUrl.replace(/\/v1\/?$/, "");
  const url = `${base}/v1/messages`;
  let token: string;
  try {
    token = await getValidAccessToken(providerName);
  } catch (e) {
    return { text: "", sources: [], error: `anthropic sidecar auth failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    "Accept": "text/event-stream",
    "User-Agent": "@anthropic-ai/sdk/0.74.0",
    "Authorization": `Bearer ${token}`,
    "anthropic-beta": ANTHROPIC_OAUTH_BETA,
    ...CLAUDE_CODE_HEADERS,
    "X-Claude-Code-Session-Id": claudeCodeSessionId(token),
    "x-client-request-id": crypto.randomUUID(),
  };
  if (provider.headers) Object.assign(headers, provider.headers);

  const instruction = settings.describeImages ? BASE_INSTRUCTION + IMAGE_INSTRUCTION : BASE_INSTRUCTION;
  const body = {
    model: settings.model,
    max_tokens: ANTHROPIC_MAX_TOKENS,
    // sonnet-5 defaults to adaptive thinking when omitted; keep the sidecar fast/cheap (audit F2).
    thinking: { type: "disabled" },
    // OAuth fingerprint requires the Claude Code identity as the FIRST system block (audit F6/anthropic.ts).
    system: [
      { type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION },
      { type: "text", text: instruction },
    ],
    messages: [{ role: "user", content: [{ type: "text", text: query }] }],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: ANTHROPIC_MAX_USES }],
    stream: true,
  };

  const linkedSignal = signalWithTimeout(settings.timeoutMs, abortSignal);
  const sidecarExit = sidecarEnter("web-search");
  const t0 = Date.now();
  try {
    const res = await fetchWithResetRetry(
      () => fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: linkedSignal.signal }),
      { abortSignal: linkedSignal.signal, label: "web-search-sidecar-anthropic" },
    );
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.warn(`[web-search] anthropic sidecar HTTP ${res.status} for query "${query.slice(0, 80)}" (${Date.now() - t0}ms)`);
      // Redact before surfacing: the body can echo auth headers/tokens (#398 review).
      return { text: "", sources: [], error: `sidecar HTTP ${res.status}: ${redactSecretString(t.slice(0, 200))}` };
    }
    const detachBodyGuard = cancelBodyOnAbort(res.body, linkedSignal.signal);
    try {
      return await parseAnthropicSidecarSSE(res);
    } finally {
      detachBodyGuard();
    }
  } catch (e) {
    const kind = e instanceof Error && e.name === "TimeoutError" ? "timeout" : "connect_error";
    console.warn(`[web-search] anthropic sidecar ${kind} for query "${query.slice(0, 80)}" (${Date.now() - t0}ms)`);
    return { text: "", sources: [], error: e instanceof Error ? e.message : String(e) };
  } finally {
    sidecarExit();
    linkedSignal.cleanup();
  }
}
