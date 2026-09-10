/**
 * Execute ONE web search via the Ollama web-search API — the executor behind
 * `providers.<name>.webSearchBridge.backend: "ollama"` (#3761).
 *
 * Documented contract: POST <origin>/api/web_search with a bearer key returns
 * {results: [{title, url, content}]}; `max_results` defaults to 5 and caps at 10
 * (https://docs.ollama.com/web-search). Like Exa, this lane returns ranked results
 * rather than a prose answer, so the outcome text is a digest the routed model
 * synthesizes from.
 *
 * The key is the PROVIDER's own API key: an operator who enables the bridge is reusing
 * their Ollama Cloud route key on a second Ollama endpoint. That is why the planner
 * refuses to derive a non-canonical origin on its own.
 *
 * Never throws; every error string passes redactSecretString and scrubs the literal key.
 */
import { applyUpstreamRecoveryInit, fetchWithResetRetry } from "../lib/upstream-retry";
import { cancelBodyOnAbort, signalWithTimeout } from "../lib/abort";
import { readBoundedResponseBytes } from "../lib/bounded-body";
import { sidecarEnter } from "../lib/sidecar-tracker";
import { redactSecretString } from "../lib/redact";
import { MAX_SIDECAR_RESPONSE_BYTES, type WebSearchSource } from "./parse";
import type { SidecarOutcome } from "./executor";

/** Documented ceiling for the API's own `max_results`; a larger value is rejected upstream. */
export const OLLAMA_WEB_SEARCH_MAX_RESULTS = 5;
const OLLAMA_SNIPPET_CHARS = 1000;

function isRec(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export async function runOllamaWebSearch(
  query: string,
  apiKey: string,
  endpoint: string,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<SidecarOutcome> {
  if (!apiKey) {
    return { text: "", sources: [], error: "ollama web-search backend selected without a provider apiKey" };
  }
  // The executor KNOWS the secret, so pattern-based redaction is not enough: scrub the
  // literal value before anything derived from an upstream body is returned.
  const scrub = (value: string) =>
    redactSecretString(value.split(apiKey).join("[redacted-provider-key]"));
  const linkedSignal = signalWithTimeout(timeoutMs, abortSignal);
  const sidecarExit = sidecarEnter("web-search");
  const startedAt = Date.now();
  try {
    const res = await fetchWithResetRetry(
      recovery => fetch(endpoint, applyUpstreamRecoveryInit({
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ query, max_results: OLLAMA_WEB_SEARCH_MAX_RESULTS }),
        signal: linkedSignal.signal,
        // Bun forwards custom headers across redirects, so a redirect would leak the key.
        redirect: "manual",
      }, recovery)),
      { abortSignal: linkedSignal.signal, label: "ollama-web-search-bridge" },
    );
    const detachBodyGuard = cancelBodyOnAbort(res.body, linkedSignal.signal);
    try {
      let bounded: Awaited<ReturnType<typeof readBoundedResponseBytes>> | null = null;
      try {
        bounded = await readBoundedResponseBytes(res, {
          maxBytes: MAX_SIDECAR_RESPONSE_BYTES,
          signal: linkedSignal.signal,
        });
      } catch {
        const reason = linkedSignal.signal.reason;
        if (linkedSignal.signal.aborted && reason instanceof Error && reason.name === "TimeoutError") {
          throw reason;
        }
        // A body-read failure degrades to the status-only outcome below.
      }
      if (bounded?.oversized) {
        const prefix = res.ok ? "ollama web-search response" : `ollama web-search HTTP ${res.status} response`;
        return { text: "", sources: [], error: `${prefix} exceeded byte bound` };
      }
      const text = bounded ? new TextDecoder().decode(bounded.bytes) : "";
      if (!res.ok) {
        // Scrub BEFORE truncating: slicing first can cut the literal key at the boundary
        // and leave an unscrubbable prefix in the surviving text.
        return { text: "", sources: [], error: `ollama web-search HTTP ${res.status}: ${scrub(text).slice(0, 200)}` };
      }
      let payload: unknown = null;
      try {
        payload = JSON.parse(text);
      } catch {
        // The mapper owns the stable malformed/empty JSON outcome.
      }
      return mapOllamaSearchResponse(payload);
    } finally {
      detachBodyGuard();
    }
  } catch (error) {
    const kind = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "connect_error";
    console.warn(`[web-search] ollama bridge ${kind} (${Date.now() - startedAt}ms)`);
    return { text: "", sources: [], error: scrub(error instanceof Error ? error.message : String(error)) };
  } finally {
    sidecarExit();
    linkedSignal.cleanup();
  }
}

/** Map an Ollama /api/web_search payload to a digest the routed model can synthesize from. */
export function mapOllamaSearchResponse(payload: unknown): SidecarOutcome {
  if (!isRec(payload) || !Array.isArray(payload.results)) {
    return { text: "", sources: [], error: "ollama web-search returned a non-JSON or shapeless body" };
  }
  const sources: WebSearchSource[] = [];
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const result of payload.results) {
    if (!isRec(result) || typeof result.url !== "string" || result.url.length === 0) continue;
    if (seen.has(result.url)) continue;
    seen.add(result.url);
    const title = typeof result.title === "string" && result.title.length > 0 ? result.title : result.url;
    sources.push({ url: result.url, ...(title !== result.url ? { title } : {}) });
    const snippet = typeof result.content === "string" ? result.content.trim().slice(0, OLLAMA_SNIPPET_CHARS) : "";
    lines.push(`- ${title}: ${snippet || "(no excerpt)"} [${result.url}]`);
  }
  if (lines.length === 0) return { text: "", sources: [], error: "ollama web-search returned no results" };
  return { text: `Search results:\n${lines.join("\n")}`, sources };
}

