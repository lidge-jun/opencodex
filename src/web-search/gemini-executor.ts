/**
 * Execute ONE web search via Gemini google_search grounding on the Antigravity
 * Cloud Code Assist transport (#2188 L8). Live-probed 2026-08-20/21 (devlog 002):
 * the CCA envelope with tools [{google_search:{}}] returns a grounded answer
 * plus groundingMetadata; a non-IDE User-Agent gets 404, so the request reuses
 * the adapter's fingerprint constants. The OAuth bearer only ever travels to
 * the REGISTRY-pinned endpoint — a config-level baseUrl override is never
 * trusted for token transmission (same rule as src/server/images.ts).
 * Never throws — returns {error} so the caller injects a graceful tool result.
 */
import type { OcxProviderConfig } from "../types";
import { getValidAccessTokenSnapshot, publicOAuthAuthenticationErrorMessage } from "../oauth";
import { applyUpstreamRecoveryInit, fetchWithResetRetry } from "../lib/upstream-retry";
import { cancelBodyOnAbort, signalWithTimeout } from "../lib/abort";
import { readBoundedResponseBytes } from "../lib/bounded-body";
import { sidecarEnter } from "../lib/sidecar-tracker";
import { redactSecretString } from "../lib/redact";
import { ANTIGRAVITY_REQUEST_UA } from "../adapters/google-antigravity-wire";
import { resolveAntigravityEffortWireModel } from "../providers/antigravity-models";
import { getProviderRegistryEntry } from "../providers/registry";
import { MAX_SIDECAR_RESPONSE_BYTES, type WebSearchSource } from "./parse";
import { BASE_INSTRUCTION, IMAGE_INSTRUCTION, type SidecarOutcome, type SidecarSettings } from "./executor";

const CCA_FALLBACK_BASE = "https://daily-cloudcode-pa.googleapis.com";

function isRec(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export async function runGeminiWebSearch(
  query: string,
  providerName: string,
  _provider: OcxProviderConfig,
  settings: SidecarSettings,
  abortSignal?: AbortSignal,
): Promise<SidecarOutcome> {
  let token: string;
  let project: string | undefined;
  try {
    const snapshot = await getValidAccessTokenSnapshot(providerName);
    token = snapshot.accessToken;
    project = snapshot.projectId;
  } catch (e) {
    return { text: "", sources: [], error: `gemini sidecar auth failed: ${publicOAuthAuthenticationErrorMessage(e)}` };
  }
  if (!project) {
    return { text: "", sources: [], error: "gemini sidecar missing Cloud Code Assist project id — re-run ocx login google-antigravity" };
  }
  // Destination pinned to the registry endpoint (see module doc).
  const base = getProviderRegistryEntry("google-antigravity")?.baseUrl ?? CCA_FALLBACK_BASE;
  const { wireModelId, thinkingLevel } = resolveAntigravityEffortWireModel(settings.model, settings.reasoning, base);
  const instruction = settings.describeImages ? BASE_INSTRUCTION + IMAGE_INSTRUCTION : BASE_INSTRUCTION;
  const envelope = {
    model: wireModelId,
    userAgent: "antigravity",
    requestType: "agent",
    project,
    requestId: `agent-${crypto.randomUUID()}`,
    request: {
      systemInstruction: { role: "user", parts: [{ text: instruction }] },
      contents: [{ role: "user", parts: [{ text: query }] }],
      tools: [{ google_search: {} }],
      sessionId: crypto.randomUUID(),
      ...(thinkingLevel ? { generationConfig: { thinkingConfig: { thinkingLevel } } } : {}),
    },
  };
  const linkedSignal = signalWithTimeout(settings.timeoutMs, abortSignal);
  const sidecarExit = sidecarEnter("web-search");
  const t0 = Date.now();
  try {
    const res = await fetchWithResetRetry(
      recovery => fetch(`${base}/v1internal:generateContent`, applyUpstreamRecoveryInit({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
          "User-Agent": ANTIGRAVITY_REQUEST_UA,
        },
        body: JSON.stringify(envelope),
        signal: linkedSignal.signal,
        redirect: "manual",
      }, recovery)),
      { abortSignal: linkedSignal.signal, label: "gemini-web-search-sidecar" },
    );
    const detachBodyGuard = cancelBodyOnAbort(res.body, linkedSignal.signal);
    try {
      const bounded = await readBoundedResponseBytes(res, {
        maxBytes: MAX_SIDECAR_RESPONSE_BYTES,
        signal: linkedSignal.signal,
      });
      if (bounded.oversized) {
        const prefix = res.ok ? "gemini sidecar response" : `gemini sidecar HTTP ${res.status} response`;
        return { text: "", sources: [], error: `${prefix} exceeded byte bound` };
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bounded.bytes);
      if (!res.ok) {
        return { text: "", sources: [], error: `gemini sidecar HTTP ${res.status}: ${redactSecretString(text.slice(0, 200))}` };
      }
      let payload: unknown = null;
      try {
        payload = JSON.parse(text);
      } catch {
        // The mapper owns the stable malformed/empty JSON outcome.
      }
      return mapCcaGroundedResponse(payload);
    } finally {
      detachBodyGuard();
    }
  } catch (e) {
    const kind = e instanceof Error && e.name === "TimeoutError" ? "timeout" : "connect_error";
    console.warn(`[web-search] gemini sidecar ${kind} (${Date.now() - t0}ms)`);
    return { text: "", sources: [], error: redactSecretString(e instanceof Error ? e.message : String(e)) };
  } finally {
    sidecarExit();
    linkedSignal.cleanup();
  }
}

/** Map a CCA generateContent payload (possibly wrapped in {response}) to text + grounding sources. */
export function mapCcaGroundedResponse(payload: unknown): SidecarOutcome {
  const root = isRec(payload) && isRec(payload.response) ? payload.response : payload;
  if (!isRec(root)) return { text: "", sources: [], error: "gemini sidecar returned a non-JSON or empty body" };
  const candidate = Array.isArray(root.candidates) && isRec(root.candidates[0]) ? root.candidates[0] : undefined;
  if (!candidate) return { text: "", sources: [], error: "gemini sidecar returned no candidates" };
  const parts = isRec(candidate.content) && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
  const text = parts.map(p => (isRec(p) && typeof p.text === "string" ? p.text : "")).join("");
  const sources: WebSearchSource[] = [];
  const seen = new Set<string>();
  const gm = isRec(candidate.groundingMetadata) ? candidate.groundingMetadata : undefined;
  if (gm && Array.isArray(gm.groundingChunks)) {
    for (const chunk of gm.groundingChunks) {
      const web = isRec(chunk) && isRec(chunk.web) ? chunk.web : undefined;
      const uri = web && typeof web.uri === "string" ? web.uri : undefined;
      if (!uri || seen.has(uri)) continue;
      seen.add(uri);
      sources.push({ url: uri, ...(typeof web?.title === "string" && web.title.length > 0 ? { title: web.title } : {}) });
    }
  }
  if (text.length === 0) return { text: "", sources, error: "gemini sidecar returned no text" };
  return { text, sources };
}
