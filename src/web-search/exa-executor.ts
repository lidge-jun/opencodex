/**
 * Execute ONE web search via the Exa Search API (#2188 L9) — the non-LLM lane.
 *
 * Exa returns ranked result JSON, not a prose answer: the outcome's text is a
 * per-result digest the routed model synthesizes from. Probe-verified 2026-08-21
 * (devlog 002): POST https://api.exa.ai/search with x-api-key returns
 * {requestId, results[{title,url,publishedDate,text}], costDollars}.
 * redirect: "manual" because Bun forwards custom headers across redirects.
 * Never throws; every error string passes redactSecretString.
 */
import { applyUpstreamRecoveryInit, fetchWithResetRetry } from "../lib/upstream-retry";
import { cancelBodyOnAbort, signalWithTimeout } from "../lib/abort";
import { readBoundedResponseBytes } from "../lib/bounded-body";
import { sidecarEnter } from "../lib/sidecar-tracker";
import { redactSecretString } from "../lib/redact";
import { MAX_SIDECAR_RESPONSE_BYTES, type WebSearchSource } from "./parse";
import type { SidecarOutcome, SidecarSettings } from "./executor";

const EXA_SEARCH_URL = "https://api.exa.ai/search";
const EXA_NUM_RESULTS = 5;
const EXA_SNIPPET_CHARS = 1000;

function isRec(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export async function runExaWebSearch(
  query: string,
  apiKey: string,
  settings: SidecarSettings,
  abortSignal?: AbortSignal,
): Promise<SidecarOutcome> {
  if (!apiKey) return { text: "", sources: [], error: "exa backend selected without an exaApiKey" };
  // The executor KNOWS the secret — pattern-based redaction cannot be trusted to
  // recognize an arbitrary operator key, so scrub the literal value explicitly.
  const scrub = (s: string) => redactSecretString(s.split(apiKey).join("[redacted-exa-key]"));
  const linkedSignal = signalWithTimeout(settings.timeoutMs, abortSignal);
  const sidecarExit = sidecarEnter("web-search");
  const t0 = Date.now();
  try {
    const res = await fetchWithResetRetry(
      recovery => fetch(EXA_SEARCH_URL, applyUpstreamRecoveryInit({
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({ query, numResults: EXA_NUM_RESULTS, contents: { text: { maxCharacters: EXA_SNIPPET_CHARS } } }),
        signal: linkedSignal.signal,
        redirect: "manual",
      }, recovery)),
      { abortSignal: linkedSignal.signal, label: "exa-web-search-sidecar" },
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
        // Preserve the previous status-only/shapeless fallback for body read
        // failures; fetch/header failures are still classified by the outer catch.
      }
      if (bounded?.oversized) {
        const prefix = res.ok ? "exa sidecar response" : `exa sidecar HTTP ${res.status} response`;
        return { text: "", sources: [], error: `${prefix} exceeded byte bound` };
      }
      // Response.text()/json() replace malformed UTF-8, so preserve that
      // behavior while moving the byte bound ahead of decoding and parsing.
      const text = bounded ? new TextDecoder().decode(bounded.bytes) : "";
      if (!res.ok) {
        // Scrub BEFORE truncating: slicing first can cut the literal key at the
        // boundary, leaving an unscrubbable key prefix in the surviving text.
        return { text: "", sources: [], error: `exa sidecar HTTP ${res.status}: ${scrub(text).slice(0, 200)}` };
      }
      let payload: unknown = null;
      try {
        payload = JSON.parse(text);
      } catch {
        // The mapper owns the stable malformed/empty JSON outcome.
      }
      return mapExaSearchResponse(payload);
    } finally {
      detachBodyGuard();
    }
  } catch (e) {
    const kind = e instanceof Error && e.name === "TimeoutError" ? "timeout" : "connect_error";
    console.warn(`[web-search] exa sidecar ${kind} (${Date.now() - t0}ms)`);
    return { text: "", sources: [], error: scrub(e instanceof Error ? e.message : String(e)) };
  } finally {
    sidecarExit();
    linkedSignal.cleanup();
  }
}

/** Map an Exa /search payload to a digest the routed model can synthesize from. */
export function mapExaSearchResponse(payload: unknown): SidecarOutcome {
  if (!isRec(payload) || !Array.isArray(payload.results)) {
    return { text: "", sources: [], error: "exa sidecar returned a non-JSON or shapeless body" };
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
    const snippet = typeof result.text === "string" ? result.text.trim().slice(0, EXA_SNIPPET_CHARS) : "";
    const dated = typeof result.publishedDate === "string" ? ` (${result.publishedDate.slice(0, 10)})` : "";
    lines.push(`- ${title}${dated}: ${snippet || "(no excerpt)"} [${result.url}]`);
  }
  if (lines.length === 0) return { text: "", sources: [], error: "exa sidecar returned no results" };
  return { text: `Search results:\n${lines.join("\n")}`, sources };
}
