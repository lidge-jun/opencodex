import type { OcxConfig } from "../types";
import { getValidAccessSnapshotForAccount, forceRefreshOAuthAccessSnapshot, type OAuthAccessSnapshot } from "../oauth";
import { getAccountSet } from "../oauth/store";
import { getProviderRegistryEntry } from "../providers/registry";
import { sendTrackingRequestSlot, waitForProviderRequestSlot } from "../providers/request-pacing";
import { antigravityUserAgentForWireModel } from "../adapters/google-antigravity-wire";
import { fetchWithAttemptDeadline } from "../lib/upstream-retry";
import { assertProviderDestinationAllowed } from "../lib/destination-policy";
import { registerTurn, unregisterTurn, type ActiveTurnLease } from "./lifecycle";
import { geminiSseTransform, readGeminiText, validateGeminiObject, GEMINI_NATIVE_MAX_BYTES, unwrapGeminiResponse, wrapGeminiRequest } from "./gemini-native-wire";

const PROVIDER = "google-antigravity";
export const GEMINI_NATIVE_PATH = /^\/v1beta\/models\/(gemini-[A-Za-z0-9._-]{1,120}):(generateContent|streamGenerateContent)$/;
export function geminiNativeError(status: number, message: string): Response {
  return Response.json({ error: { code: status, message } }, { status });
}

export interface GeminiNativeDeps {
  access: () => Promise<OAuthAccessSnapshot>;
  refresh: (snapshot: OAuthAccessSnapshot) => Promise<OAuthAccessSnapshot>;
  fetch: typeof globalThis.fetch;
}
const defaults: GeminiNativeDeps = {
  access: async () => {
    const set = getAccountSet(PROVIDER);
    if (!set) throw new Error("Antigravity sign-in required");
    return getValidAccessSnapshotForAccount(PROVIDER, set.activeAccountId, { requireUsableAccount: true });
  }, refresh: forceRefreshOAuthAccessSnapshot,
  fetch: globalThis.fetch,
};

/** Active-account native leg; no internal messages, tool-schema repair or model rewriting. */
export async function handleGeminiNative(
  req: Request, config: OcxConfig, model: string, streaming: boolean,
  lease: ActiveTurnLease, deps: GeminiNativeDeps = defaults,
): Promise<Response> {
  const provider = config.providers[PROVIDER];
  if (!provider || provider.disabled === true) return geminiNativeError(503, "Enable google-antigravity and sign in before using Gemini native requests");
  if (provider.adapter !== "google" || (provider.authMode && provider.authMode !== "oauth") || (provider.googleMode && provider.googleMode !== "cloud-code-assist")) {
    return geminiNativeError(503, "Gemini native requests require a Google Antigravity OAuth provider");
  }
  if (req.headers.get("content-encoding") && req.headers.get("content-encoding") !== "identity") return geminiNativeError(415, "Gemini native requests require identity content encoding");
  const ac = new AbortController();
  const onAbort = () => ac.abort(req.signal.reason);
  req.signal.addEventListener("abort", onAbort, { once: true });
  if (req.signal.aborted) onAbort();
  registerTurn(ac, lease);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  let onUpstreamAbort: (() => void) | undefined;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (onUpstreamAbort) ac.signal.removeEventListener("abort", onUpstreamAbort);
    req.signal.removeEventListener("abort", onAbort);
    unregisterTurn(ac);
  };
  const armStall = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ac.abort(new Error("Gemini upstream stalled")), Math.max(1, config.stallTimeoutSec ?? 300) * 1000);
  };
  let upstream: Response | undefined;
  try {
    const maxBytes = Math.min(GEMINI_NATIVE_MAX_BYTES, config.maxInboundBodyBytes ?? GEMINI_NATIVE_MAX_BYTES);
    const raw = await readGeminiText(req.body, maxBytes, ac.signal);
    if (raw === null) { finish(); return geminiNativeError(413, "Gemini native request exceeds the body limit"); }
    try { validateGeminiObject(raw); }
    catch { finish(); return geminiNativeError(400, "Expected a Gemini JSON object"); }
    let access = await deps.access();
    for (let attempt = 0; attempt < 2; attempt++) {
      ac.signal.throwIfAborted();
      if (!access.projectId) { finish(); return geminiNativeError(503, "Antigravity project missing; sign in again"); }
      const baseUrl = provider.baseUrl || getProviderRegistryEntry(PROVIDER)!.baseUrl;
      assertProviderDestinationAllowed(PROVIDER, { ...provider, baseUrl });
      const base = new URL(baseUrl);
      if (base.username || base.password || base.search || base.hash) throw new Error("invalid Antigravity base URL");
      const method = streaming ? "streamGenerateContent?alt=sse" : "generateContent";
      const slot = await waitForProviderRequestSlot(PROVIDER, provider, model, ac.signal);
      upstream = await sendTrackingRequestSlot(slot, () => fetchWithAttemptDeadline(`${baseUrl.replace(/\/$/, "")}/v1internal:${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${access.accessToken}`, "User-Agent": antigravityUserAgentForWireModel(model) },
        body: wrapGeminiRequest(raw, model, access.projectId!),
      }, config.connectTimeoutMs ?? 200_000, ac.signal, true, deps.fetch));
      if (upstream.status !== 401 || attempt === 1) break;
      await upstream.body?.cancel();
      access = await deps.refresh(access);
    }
    if (!upstream?.body) throw new Error("missing upstream response body");
    const reader = upstream.body.getReader();
    const cancel = onUpstreamAbort = () => { void reader.cancel(ac.signal.reason).catch(() => {}); };
    ac.signal.addEventListener("abort", cancel, { once: true });
    armStall();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          ac.signal.throwIfAborted(); armStall();
          const next = await reader.read();
          ac.signal.throwIfAborted(); armStall();
          if (next.done) { controller.close(); finish(); ac.signal.removeEventListener("abort", cancel); }
          else controller.enqueue(next.value);
        } catch (error) { controller.error(error); ac.abort(error); finish(); }
      },
      cancel(reason) { ac.abort(reason); finish(); return reader.cancel(reason); },
    });
    if (upstream.ok && streaming) {
      return new Response(body.pipeThrough(geminiSseTransform()), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
    }
    const text = await readGeminiText(body, GEMINI_NATIVE_MAX_BYTES, ac.signal);
    if (text === null) return geminiNativeError(502, "Gemini upstream response exceeds the body limit");
    if (!upstream.ok) {
      const response = geminiNativeError(upstream.status >= 400 ? upstream.status : 502, "Antigravity upstream rejected the request");
      const retryAfter = upstream.headers.get("retry-after");
      if (retryAfter && /^\d{1,6}$/.test(retryAfter)) response.headers.set("Retry-After", retryAfter);
      return response;
    }
    return new Response(unwrapGeminiResponse(text), { headers: { "Content-Type": "application/json" } });
  } catch {
    ac.abort(); finish();
    void upstream?.body?.cancel().catch(() => {});
    return geminiNativeError(req.signal.aborted ? 499 : 502, req.signal.aborted ? "Request cancelled" : "Gemini native upstream request failed");
  }
}
