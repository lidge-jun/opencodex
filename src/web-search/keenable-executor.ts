/**
 * Execute ONE web search via the Keenable Search API — the keyless non-LLM lane.
 *
 * Keenable returns ranked result JSON `{results: [{title, url, snippet}]}`, not a
 * prose answer. Keyless calls hit POST https://api.keenable.ai/v1/search/public
 * with `X-Keenable-Title: opencodex`; when an optional `keenableApiKey` is set,
 * calls hit POST https://api.keenable.ai/v1/search with `X-API-Key`.
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

export const KEENABLE_PUBLIC_SEARCH_URL = "https://api.keenable.ai/v1/search/public";
export const KEENABLE_KEYED_SEARCH_URL = "https://api.keenable.ai/v1/search";
const KEENABLE_MAX_RESULTS = 5;
const KEENABLE_SNIPPET_CHARS = 1000;

function isRec(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export async function runKeenableWebSearch(
  query: string,
  apiKey: string | undefined,
  settings: SidecarSettings,
  abortSignal?: AbortSignal,
): Promise<SidecarOutcome> {
  const keyed = typeof apiKey === "string" && apiKey.length > 0;
  const scrub = (s: string) =>
    redactSecretString(keyed ? s.split(apiKey).join("[redacted-keenable-key]") : s);
  const url = keyed ? KEENABLE_KEYED_SEARCH_URL : KEENABLE_PUBLIC_SEARCH_URL;
  const headers: Record<string, string> = keyed
    ? { "Content-Type": "application/json", "X-API-Key": apiKey }
    : { "Content-Type": "application/json", "X-Keenable-Title": "opencodex" };

  const linkedSignal = signalWithTimeout(settings.timeoutMs, abortSignal);
  const sidecarExit = sidecarEnter("web-search");
  const t0 = Date.now();
  try {
    const res = await fetchWithResetRetry(
      recovery =>
        fetch(
          url,
          applyUpstreamRecoveryInit(
            {
              method: "POST",
              headers,
              body: JSON.stringify({ query, max_results: KEENABLE_MAX_RESULTS }),
              signal: linkedSignal.signal,
              redirect: "manual",
            },
            recovery,
          ),
        ),
      { replaySafe: true, abortSignal: linkedSignal.signal, label: "keenable-web-search-sidecar" },
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
      }
      if (bounded?.oversized) {
        const prefix = res.ok ? "keenable sidecar response" : `keenable sidecar HTTP ${res.status} response`;
        return { text: "", sources: [], error: `${prefix} exceeded byte bound` };
      }
      const text = bounded ? new TextDecoder().decode(bounded.bytes) : "";
      if (!res.ok) {
        return { text: "", sources: [], error: `keenable sidecar HTTP ${res.status}: ${scrub(text).slice(0, 200)}` };
      }
      let payload: unknown = null;
      try {
        payload = JSON.parse(text);
      } catch {
        // The mapper owns the stable malformed/empty JSON outcome.
      }
      return mapKeenableSearchResponse(payload);
    } finally {
      detachBodyGuard();
    }
  } catch (e) {
    const kind = e instanceof Error && e.name === "TimeoutError" ? "timeout" : "connect_error";
    console.warn(`[web-search] keenable sidecar ${kind} (${Date.now() - t0}ms)`);
    return { text: "", sources: [], error: scrub(e instanceof Error ? e.message : String(e)) };
  } finally {
    sidecarExit();
    linkedSignal.cleanup();
  }
}

/** Map a Keenable /v1/search payload to a digest the routed model can synthesize from. */
export function mapKeenableSearchResponse(payload: unknown): SidecarOutcome {
  if (!isRec(payload) || !Array.isArray(payload.results)) {
    return { text: "", sources: [], error: "keenable sidecar returned a non-JSON or shapeless body" };
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
    const rawSnippet = typeof result.snippet === "string"
      ? result.snippet
      : typeof result.text === "string"
        ? result.text
        : "";
    const snippet = rawSnippet.trim().slice(0, KEENABLE_SNIPPET_CHARS);
    lines.push(`- ${title}: ${snippet || "(no excerpt)"} [${result.url}]`);
  }
  if (lines.length === 0) return { text: "", sources: [], error: "keenable sidecar returned no results" };
  return { text: `Search results:\n${lines.join("\n")}`, sources };
}
