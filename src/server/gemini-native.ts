import type { OcxConfig } from "../types";
import { getValidAccessSnapshotForAccount, forceRefreshOAuthAccessSnapshot, OAuthLoginRequiredError, OAuthAccountPausedError, OAuthTokenRefreshBusyError, OAuthTokenRefreshStaleError, type OAuthAccessSnapshot } from "../oauth";
import { getAccountSet } from "../oauth/store";
import { getProviderRegistryEntry } from "../providers/registry";
import { sendTrackingRequestSlot, waitForProviderRequestSlot, RequestPacingQueueOverloadError, RequestPacingProviderRemovedError } from "../providers/request-pacing";
import { antigravityUserAgentForWireModel } from "../adapters/google-antigravity-wire";
import { fetchWithAttemptDeadline } from "../lib/upstream-retry";
import { reserveWorkflowSend } from "../lib/workflow-budget";
import { currentWorkflowBudgetPolicy } from "../lib/workflow-budget-config";
import { spendPolicyFromConfig } from "../lib/spend-reservation-ledger";
import { carryWorkflowRefusal, workflowRefusalResponse } from "./workflow-refusal";
import type { RequestLogContext } from "./request-log";
import { DEFAULT_STALL_TIMEOUT_SEC, resolveStallTimeoutMs } from "../stall-timeout";
import { isLocalUpstream } from "../lib/local-upstream";
import { assertProviderDestinationAllowed } from "../lib/destination-policy";
import { registerTurn, unregisterTurn, type ActiveTurnLease } from "./lifecycle";
import { geminiSseTransform, readGeminiText, validateGeminiObject, GEMINI_NATIVE_MAX_BYTES, GEMINI_NATIVE_ERROR_CODE, unwrapGeminiResponse, wrapGeminiRequest } from "./gemini-native-wire";

const PROVIDER = "google-antigravity";
class NativeWorkflowSendDenied extends Error {}
class NativeSpendLimitsUnsupported extends Error {}
class NativeRequestBodyTimeout extends Error {}
class NativeConfigurationInvalid extends Error {}
export const GEMINI_NATIVE_PATH = /^\/v1beta\/models\/(gemini-[A-Za-z0-9._-]{1,120}):(generateContent|streamGenerateContent)$/;
export function geminiNativeError(status: number, message: string, reason?: string): Response {
  return Response.json({ error: { code: status, message, ...(reason ? { details: [{ reason }] } : {}) } }, { status });
}

export interface GeminiNativeDeps {
  access: () => Promise<OAuthAccessSnapshot>;
  refresh: (snapshot: OAuthAccessSnapshot) => Promise<OAuthAccessSnapshot>;
  fetch: typeof globalThis.fetch;
}
const defaults: GeminiNativeDeps = {
  access: async () => {
    const set = getAccountSet(PROVIDER);
    if (!set) throw new OAuthLoginRequiredError(PROVIDER);
    return getValidAccessSnapshotForAccount(PROVIDER, set.activeAccountId, { requireUsableAccount: true });
  }, refresh: forceRefreshOAuthAccessSnapshot,
  fetch: globalThis.fetch,
};

/** Active-account native leg; no internal messages, tool-schema repair or model rewriting. */
export async function handleGeminiNative(
  req: Request, config: OcxConfig, model: string, streaming: boolean,
  lease: ActiveTurnLease, deps: GeminiNativeDeps = defaults, logCtx?: RequestLogContext,
): Promise<Response> {
  const rootId = req.headers.get("x-codex-parent-thread-id")?.trim() || undefined;
  // This source-preserving path does not yet book or settle token spend. Refuse applicable
  // ceilings rather than allowing an unmeasured request to escape the common ledger.
  const spendUnsupported = () => {
    const policy = spendPolicyFromConfig(config.spend);
    return policy.identity.maxTokens !== undefined || policy.pool.maxTokens !== undefined
      || rootId !== undefined && policy.root.maxTokens !== undefined;
  };
  const unsupportedSpend = () => geminiNativeError(503,
    "Gemini native requests do not support configured token spend limits; use a translated OC route",
    "gemini_native_spend_limits_unsupported");
  if (spendUnsupported()) return unsupportedSpend();
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
  const baseUrl = provider.baseUrl || getProviderRegistryEntry(PROVIDER)!.baseUrl;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let bodyReadTimer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  let onUpstreamAbort: (() => void) | undefined;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer); clearTimeout(bodyReadTimer);
    if (onUpstreamAbort) ac.signal.removeEventListener("abort", onUpstreamAbort);
    req.signal.removeEventListener("abort", onAbort);
    unregisterTurn(ac);
  };
  const armStall = () => {
    clearTimeout(timer);
    const stallMs = resolveStallTimeoutMs(config.stallTimeoutSec, { localUpstream: isLocalUpstream(baseUrl) });
    if (stallMs > 0) timer = setTimeout(() => ac.abort(new Error("Gemini upstream stalled")), stallMs);
  };
  let upstream: Response | undefined;
  try {
    const maxBytes = Math.min(GEMINI_NATIVE_MAX_BYTES, config.maxInboundBodyBytes ?? GEMINI_NATIVE_MAX_BYTES);
    // Upload protection is independent of upstream silence: disabling model stalls must not
    // let an authenticated client hold an admission lease with an unfinished JSON upload.
    const bodyIdleMs = resolveStallTimeoutMs(config.stallTimeoutSec) || DEFAULT_STALL_TIMEOUT_SEC * 1000;
    const armBodyRead = () => {
      clearTimeout(bodyReadTimer);
      bodyReadTimer = setTimeout(() => ac.abort(new NativeRequestBodyTimeout()), bodyIdleMs);
    };
    const input = req.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) { if (chunk.byteLength) armBodyRead(); controller.enqueue(chunk); },
    })) ?? null;
    let raw: string | null;
    armBodyRead();
    try { raw = await readGeminiText(input, maxBytes, ac.signal); }
    catch (error) {
      if (ac.signal.aborted) throw error;
      finish(); return geminiNativeError(400, "Gemini request body must be readable UTF-8 JSON");
    } finally { clearTimeout(bodyReadTimer); bodyReadTimer = undefined; }
    if (raw === null) { finish(); return geminiNativeError(413, "Gemini native request exceeds the body limit"); }
    try { validateGeminiObject(raw); }
    catch { finish(); return geminiNativeError(400, "Expected a Gemini JSON object"); }
    let access = await deps.access();
    for (let attempt = 0; attempt < 2; attempt++) {
      ac.signal.throwIfAborted();
      if (!access.projectId) { finish(); return geminiNativeError(503, "Antigravity project missing; sign in again"); }
      try {
        assertProviderDestinationAllowed(PROVIDER, { ...provider, baseUrl });
        const base = new URL(baseUrl);
        if (base.username || base.password || base.search || base.hash) throw new NativeConfigurationInvalid();
      } catch { throw new NativeConfigurationInvalid(); }
      const method = streaming ? "streamGenerateContent?alt=sse" : "generateContent";
      const slot = await waitForProviderRequestSlot(PROVIDER, provider, model, ac.signal);
      upstream = await sendTrackingRequestSlot(slot, () => {
        ac.signal.throwIfAborted();
        if (spendUnsupported()) throw new NativeSpendLimitsUnsupported();
        if (!reserveWorkflowSend(rootId, currentWorkflowBudgetPolicy())) throw new NativeWorkflowSendDenied();
        return fetchWithAttemptDeadline(`${baseUrl.replace(/\/$/, "")}/v1internal:${method}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${access.accessToken}`, "User-Agent": antigravityUserAgentForWireModel(model) },
          body: wrapGeminiRequest(raw, model, access.projectId!),
        }, config.connectTimeoutMs ?? 200_000, ac.signal, true, deps.fetch);
      });
      if (upstream.status !== 401 || attempt === 1) break;
      await upstream.body?.cancel();
      access = await deps.refresh(access);
    }
    if (!upstream) throw new Error("missing upstream response");
    if (!upstream.ok) {
      void upstream.body?.cancel().catch(() => {});
      finish();
      const response = geminiNativeError(upstream.status >= 400 ? upstream.status : 502, "Antigravity upstream rejected the request");
      const retryAfter = upstream.headers.get("retry-after");
      if (retryAfter && /^\d{1,6}$/.test(retryAfter)) response.headers.set("Retry-After", retryAfter);
      return response;
    }
    if (!upstream.body) throw new Error("missing upstream response body");
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
      return new Response(body.pipeThrough(geminiSseTransform(GEMINI_NATIVE_MAX_BYTES, () => {
        if (logCtx) { logCtx.errorCode = GEMINI_NATIVE_ERROR_CODE; logCtx.terminalSource = "upstream"; }
      })), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
    }
    const text = await readGeminiText(body, GEMINI_NATIVE_MAX_BYTES, ac.signal);
    if (text === null) return geminiNativeError(502, "Gemini upstream response exceeds the body limit");
    return new Response(unwrapGeminiResponse(text), { headers: { "Content-Type": "application/json" } });
  } catch (error) {
    ac.abort(); finish();
    void upstream?.body?.cancel().catch(() => {});
    if (req.signal.aborted) return geminiNativeError(499, "Request cancelled");
    if (error instanceof NativeRequestBodyTimeout) return geminiNativeError(408, "Gemini request body upload stalled; send a complete JSON body and retry");
    if (error instanceof OAuthLoginRequiredError) return geminiNativeError(503, "Antigravity sign-in required; run ocx login google-antigravity");
    if (error instanceof OAuthAccountPausedError) return geminiNativeError(503, "Antigravity account is paused; resume it in OC account settings and retry");
    if (error instanceof OAuthTokenRefreshBusyError || error instanceof OAuthTokenRefreshStaleError) {
      const response = geminiNativeError(503, "Antigravity credential refresh is temporarily busy; retry shortly");
      response.headers.set("Retry-After", "1"); return response;
    }
    if (error instanceof RequestPacingQueueOverloadError) {
      const response = geminiNativeError(429, "Antigravity request queue is temporarily full; retry after the indicated delay");
      const seconds = Number.isFinite(error.retryAfterSeconds) ? Math.max(1, Math.ceil(error.retryAfterSeconds)) : 5;
      response.headers.set("Retry-After", String(seconds)); return response;
    }
    if (error instanceof RequestPacingProviderRemovedError || error instanceof NativeConfigurationInvalid) {
      return geminiNativeError(503, "Antigravity provider configuration is unavailable or invalid; check its baseUrl and destination policy in OC settings");
    }
    if (error instanceof NativeSpendLimitsUnsupported) return unsupportedSpend();
    if (error instanceof NativeWorkflowSendDenied) {
      const refusal = workflowRefusalResponse("workflow-sends-exhausted", logCtx, undefined, rootId);
      return carryWorkflowRefusal(refusal, geminiNativeError(429, "OpenCodex workflow physical-send budget exhausted"));
    }
    return geminiNativeError(req.signal.aborted ? 499 : 502, req.signal.aborted ? "Request cancelled" : "Gemini native upstream request failed");
  }
}
