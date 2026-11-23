import type { OcxConfig, OcxUsage } from "../types";
import { markNativeGeminiProtocol } from "../protocols/trace";
import { getValidAccessSnapshotForAccount, forceRefreshOAuthAccessSnapshot, OAuthLoginRequiredError, OAuthAccountPausedError, OAuthTokenRefreshBusyError, OAuthTokenRefreshStaleError, type OAuthAccessSnapshot } from "../oauth";
import { getAccountSet, getAccountCredentialWithStatus } from "../oauth/store";
import {
  antigravityModelRefusal, isProactivePreferenceEnabled, noteGenericPoolSelection, preferredInitialAccount, routeAntigravityModel,
} from "../oauth/generic-account-failover";
import { stampOAuthAccountLabel } from "../providers/label";
import { getProviderRegistryEntry } from "../providers/registry";
import { sendTrackingRequestSlot, waitForProviderRequestSlot, RequestPacingQueueOverloadError, RequestPacingProviderRemovedError } from "../providers/request-pacing";
import { usageFromGemini } from "../adapters/google-usage";
import { antigravityUserAgentForWireModel } from "../adapters/google-antigravity-wire";
import { fetchWithAttemptDeadline, releaseResponseBodyBestEffort } from "../lib/upstream-retry";
import { reserveWorkflowSend } from "../lib/workflow-budget";
import { currentWorkflowBudgetPolicy } from "../lib/workflow-budget-config";
import { spendPolicyFromConfig } from "../lib/spend-reservation-ledger";
import { carryWorkflowRefusal, workflowRefusalResponse } from "./workflow-refusal";
import { geminiErrorBody, toGeminiRefusal } from "./gemini-inbound";
import { estimateTokens } from "../lib/token-estimate";
import { createPhysicalSendReporter } from "../lib/request-execution-budget";
import { createInferenceSendBudget } from "./inference/context";
import { attachRequestSpendTracker } from "./responses/request-spend";
import { markLocalRequestLogRefusal, type RequestLogContext } from "./request-log";
import { recordGenerationOutput } from "./request-log-generation-window";
import { noteCredentialAttemptSend, sealCredentialRefusal } from "./credential-recovery-attempt";
import { DEFAULT_STALL_TIMEOUT_SEC, resolveStallTimeoutMs } from "../stall-timeout";
import { isLocalUpstream } from "../lib/local-upstream";
import { assertProviderDestinationAllowed } from "../lib/destination-policy";
import { InvalidProviderEgressError, markEgressTransparentExecutor, providerEgressSendInit } from "../lib/provider-egress";
import { configuredOutboundFetch } from "../lib/proxy-env";
import { clientFacingModelLabel, type ClientFacingModelLabel } from "../lib/error-destination";
import { registerTurn, unregisterTurn, type ActiveTurnLease } from "./lifecycle";
import { containsGeminiCredential, geminiNativeReasoningFields, geminiSseTransform, readGeminiText, validateGeminiObject, GEMINI_NATIVE_MAX_BYTES, GEMINI_NATIVE_ERROR_CODE, unwrapGeminiResponse, wrapGeminiRequest } from "./gemini-native-wire";

export const GEMINI_NATIVE_PROVIDER = "google-antigravity";
class NativeWorkflowSendDenied extends Error {}
class NativeRequestBodyTimeout extends Error {}
class NativeConfigurationInvalid extends Error {}
class NativeModelUnavailable extends Error {}
export function geminiNativeError(status: number, message: string, reason?: string): Response {
  const { error } = geminiErrorBody(status, message);
  return Response.json({ error: { ...error, ...(reason ? { details: [{ reason }] } : {}) } }, { status });
}

export interface GeminiNativeDeps {
  access: (config: OcxConfig, model: string, clientModel: ClientFacingModelLabel) => Promise<OAuthAccessSnapshot>;
  refresh: (snapshot: OAuthAccessSnapshot) => Promise<OAuthAccessSnapshot>;
  fetch?: typeof globalThis.fetch;
}
const nativeOutboundFetch = markEgressTransparentExecutor(((input, init) => configuredOutboundFetch(input, init)) as typeof fetch);
const defaults: GeminiNativeDeps = {
  access: async (config, model, clientModel) => {
    const set = getAccountSet(GEMINI_NATIVE_PROVIDER);
    if (!set) throw new OAuthLoginRequiredError(GEMINI_NATIVE_PROVIDER);
    const now = Date.now();
    const planned = preferredInitialAccount(config, GEMINI_NATIVE_PROVIDER, now, model) ?? set.activeAccountId;
    const route = routeAntigravityModel(config, GEMINI_NATIVE_PROVIDER, planned, model, now, clientModel);
    if (route.kind === "refuse") throw new NativeModelUnavailable(route.message);
    const accountId = route.kind === "reroute" ? route.accountId : planned;
    return getValidAccessSnapshotForAccount(GEMINI_NATIVE_PROVIDER, accountId, { requireUsableAccount: true });
  }, refresh: forceRefreshOAuthAccessSnapshot,
};

/** Native leg using an account-scoped Antigravity token and project. */
export async function handleGeminiNative(
  req: Request, config: OcxConfig, model: string, streamFormat: "sse" | "array" | undefined,
  lease: ActiveTurnLease, deps: GeminiNativeDeps = defaults, logCtx?: RequestLogContext, start?: number,
): Promise<Response> {
  const rootId = req.headers.get("x-codex-parent-thread-id")?.trim() || undefined;
  if (!logCtx) {
    const policy = spendPolicyFromConfig(config.spend);
    if (policy.identity.maxTokens !== undefined || policy.pool.maxTokens !== undefined
      || (rootId !== undefined && policy.root.maxTokens !== undefined)) {
      return geminiNativeError(503, "Token budget accounting is unavailable for this request");
    }
  }
  const provider = config.providers[GEMINI_NATIVE_PROVIDER];
  if (!provider || provider.disabled === true) return geminiNativeError(503, "Enable google-antigravity and sign in before using Gemini native requests");
  if (provider.adapter !== "google" || (provider.authMode && provider.authMode !== "oauth") || (provider.googleMode && provider.googleMode !== "cloud-code-assist")) {
    return geminiNativeError(503, "Gemini native requests require a Google Antigravity OAuth provider");
  }
  if (req.headers.get("content-encoding") && req.headers.get("content-encoding") !== "identity") return geminiNativeError(415, "Gemini native requests require identity content encoding");
  // Native admission accepts the canonical provider's implicit OAuth mode. Account helpers
  // require an explicit mode, so give them the same default without changing saved settings.
  const accountConfig: OcxConfig = provider.authMode === undefined ? {
    ...config, providers: { ...config.providers, [GEMINI_NATIVE_PROVIDER]: { ...provider, authMode: "oauth" } },
  } : config;
  const ac = new AbortController();
  const onAbort = () => ac.abort(req.signal.reason);
  req.signal.addEventListener("abort", onAbort, { once: true });
  if (req.signal.aborted) onAbort();
  registerTurn(ac, lease);
  const baseUrl = provider.baseUrl || getProviderRegistryEntry(GEMINI_NATIVE_PROVIDER)!.baseUrl;
  const executor = deps.fetch ?? nativeOutboundFetch;
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
  const noteNativeError = () => {
    if (logCtx) { logCtx.errorCode = GEMINI_NATIVE_ERROR_CODE; logCtx.terminalSource = "upstream"; }
  };
  let sawThoughtOutput = false;
  const noteUsage = logCtx ? (usage: OcxUsage) => {
    logCtx.usage = usage;
    // Reported thought tokens count in the numerator. Their generation must also be observed.
    if (usage.reasoningOutputTokens && !sawThoughtOutput) {
      delete logCtx.generationStartedAt;
      delete logCtx.lastOutputAt;
    }
  } : undefined;
  const noteOutput = logCtx && start !== undefined ? (visible: boolean, thought: boolean) => {
    const now = Date.now();
    sawThoughtOutput ||= thought;
    recordGenerationOutput(logCtx, now);
    if (visible) logCtx.firstOutputMs ??= Math.max(0, now - start);
  } : undefined;
  const spendTracker = logCtx ? attachRequestSpendTracker(req, logCtx) : undefined;
  const physicalBudget = logCtx ? createInferenceSendBudget(req, logCtx) : undefined;
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
    let reasoning: ReturnType<typeof geminiNativeReasoningFields> | undefined;
    try {
      const payload = validateGeminiObject(raw);
      if (logCtx) {
        reasoning = geminiNativeReasoningFields(payload, model);
        const generation = (payload.generationConfig ?? payload.generation_config) as Record<string, unknown> | undefined;
        const maxOutput = generation?.maxOutputTokens ?? generation?.max_output_tokens;
        const candidates = generation?.candidateCount ?? generation?.candidate_count;
        const candidateCount = typeof candidates === "number" && Number.isSafeInteger(candidates) && candidates > 0 ? candidates : 1;
        // Measure the native JSON for reservation only. Usage comes from the upstream response.
        logCtx.spendInputEstimateTokens = estimateTokens(raw, model);
        if (typeof maxOutput === "number" && Number.isSafeInteger(maxOutput) && maxOutput > 0) {
          logCtx.spendOutputCeilingTokens = Math.min(Number.MAX_SAFE_INTEGER, maxOutput * candidateCount);
        }
      }
    } catch { finish(); return geminiNativeError(400, "Expected a Gemini JSON object"); }
    ac.signal.throwIfAborted();
    const clientModel = clientFacingModelLabel(logCtx?.requestedModel ?? model);
    let access = await deps.access(accountConfig, model, clientModel);
    const boundCredentials = new Set<string>();
    for (let attempt = 0; attempt < 2; attempt++) {
      ac.signal.throwIfAborted();
      if (!access.projectId) { finish(); return geminiNativeError(503, "Antigravity project missing; sign in again"); }
      try {
        assertProviderDestinationAllowed(GEMINI_NATIVE_PROVIDER, { ...provider, baseUrl });
        const base = new URL(baseUrl);
        if (base.username || base.password || base.search || base.hash) throw new NativeConfigurationInvalid();
      } catch { throw new NativeConfigurationInvalid(); }
      const method = streamFormat ? "streamGenerateContent?alt=sse" : "generateContent";
      const url = `${baseUrl.replace(/\/$/, "")}/v1internal:${method}`;
      const slot = await waitForProviderRequestSlot(GEMINI_NATIVE_PROVIDER, provider, model, ac.signal);
      upstream = await sendTrackingRequestSlot(slot, async () => {
        ac.signal.throwIfAborted();
        // A pacing wait must not outlive an operator pause, reauth mark or account removal.
        const account = getAccountCredentialWithStatus(GEMINI_NATIVE_PROVIDER, access.accountId);
        if (!account) throw new OAuthLoginRequiredError(GEMINI_NATIVE_PROVIDER);
        if (account.paused) throw new OAuthAccountPausedError();
        if (account.needsReauth) throw new OAuthLoginRequiredError(GEMINI_NATIVE_PROVIDER);
        const refusal = antigravityModelRefusal(accountConfig, GEMINI_NATIVE_PROVIDER, access.accountId, model, undefined, clientModel);
        if (refusal) throw new NativeModelUnavailable(refusal);
        const { credential } = account;
        // Keep both generations across a 401 recovery. The store can also rotate during pacing.
        for (const value of [access.accessToken, access.projectId, access.accountId, credential.access,
          credential.refresh, credential.projectId, credential.accountId, credential.email]) {
          if (value) boundCredentials.add(value);
        }
        const egress = providerEgressSendInit({ providerName: GEMINI_NATIVE_PROVIDER, provider }, executor, url);
        const body = wrapGeminiRequest(raw, model, access.projectId!);
        if (logCtx) stampOAuthAccountLabel(logCtx, GEMINI_NATIVE_PROVIDER, { authMode: "oauth" }, access.accountId);
        const report = physicalBudget && createPhysicalSendReporter(physicalBudget, () => ({
          poolId: GEMINI_NATIVE_PROVIDER, identityId: logCtx?.accountLogLabel,
        }));
        let dispatched = false;
        try {
          if (report ? !report.beforeSend?.(attempt > 0) : !reserveWorkflowSend(rootId, currentWorkflowBudgetPolicy())) {
            throw new NativeWorkflowSendDenied();
          }
          if (attempt === 0 && isProactivePreferenceEnabled(accountConfig, GEMINI_NATIVE_PROVIDER, Date.now())) {
            noteGenericPoolSelection(accountConfig, GEMINI_NATIVE_PROVIDER, access.accountId, model);
          }
          if (logCtx) {
            Object.assign(logCtx, reasoning);
            markNativeGeminiProtocol(logCtx);
            noteCredentialAttemptSend(logCtx, { providerName: GEMINI_NATIVE_PROVIDER, modelId: model }, provider,
              attempt === 0 ? undefined : "oauth-401");
            Object.assign(logCtx.activeAttempt!, reasoning);
          }
          dispatched = true;
          return await fetchWithAttemptDeadline(url, {
            ...egress,
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${access.accessToken}`, "User-Agent": antigravityUserAgentForWireModel(model) },
            body,
          }, config.connectTimeoutMs ?? 200_000, ac.signal, true, executor);
        } finally {
          try { if (dispatched) report?.(1); }
          finally { report?.close?.(); }
        }
      });
      if (upstream.status !== 401 || attempt === 1) break;
      if (logCtx) sealCredentialRefusal(logCtx, 401, "oauth-401");
      await releaseResponseBodyBestEffort(upstream.body, ac.signal);
      ac.signal.throwIfAborted();
      access = await deps.refresh(access);
    }
    if (!upstream) throw new Error("missing upstream response");
    if (!upstream.ok) {
      if (logCtx) logCtx.terminalSource = "upstream";
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
    const credentials = [...boundCredentials];
    if (streamFormat) {
      const headers = { "Content-Type": streamFormat === "sse" ? "text/event-stream" : "application/json", "Cache-Control": "no-cache" };
      return new Response(body.pipeThrough(geminiSseTransform(
        GEMINI_NATIVE_MAX_BYTES, { onNativeError: noteNativeError, onUsage: noteUsage, onOutput: noteOutput }, streamFormat, credentials,
      )), { headers });
    }
    const text = await readGeminiText(body, GEMINI_NATIVE_MAX_BYTES, ac.signal);
    if (text === null) return geminiNativeError(502, "Gemini upstream response exceeds the body limit");
    const response = unwrapGeminiResponse(text);
    const payload = JSON.parse(response) as { usageMetadata?: unknown };
    if (Object.hasOwn(payload, "error") || containsGeminiCredential(response, credentials)) {
      noteNativeError();
      return geminiNativeError(502, "Antigravity upstream rejected the request");
    }
    const usage = usageFromGemini(payload.usageMetadata);
    if (usage) noteUsage?.(usage);
    return new Response(response, { headers: { "Content-Type": "application/json" } });
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
    if (error instanceof InvalidProviderEgressError) {
      return geminiNativeError(503, "Antigravity provider egress configuration is unavailable or invalid; check proxy and noProxy in OC settings");
    }
    if (error instanceof RequestPacingProviderRemovedError || error instanceof NativeConfigurationInvalid) {
      return geminiNativeError(503, "Antigravity provider configuration is unavailable or invalid; check its baseUrl and destination policy in OC settings");
    }
    if (error instanceof NativeModelUnavailable) {
      if (logCtx) {
        logCtx.errorCode = "gemini_native_model_unlisted";
        markLocalRequestLogRefusal(logCtx, "gemini_native_model_unlisted");
      }
      return geminiNativeError(403, error.message, "gemini_native_model_unlisted");
    }
    if (error instanceof NativeWorkflowSendDenied) {
      const denial = spendTracker?.lastRefusal;
      if (denial) {
        const refusal = workflowRefusalResponse(denial.reason, logCtx, undefined, undefined, denial.spend);
        return carryWorkflowRefusal(refusal, toGeminiRefusal(refusal));
      }
      const refusal = workflowRefusalResponse("workflow-sends-exhausted", logCtx, undefined, rootId);
      return carryWorkflowRefusal(refusal, geminiNativeError(429, "OpenCodex workflow physical-send budget exhausted"));
    }
    return geminiNativeError(req.signal.aborted ? 499 : 502, req.signal.aborted ? "Request cancelled" : "Gemini native upstream request failed");
  }
}
