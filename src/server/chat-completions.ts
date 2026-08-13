/**
 * OpenAI Chat Completions inbound (/v1/chat/completions) for GitHub Copilot App
 * and other OpenAI-compatible clients.
 *
 * Dual-path: `chat -> chat` for the majority chat-form providers is a
 * direct Chat wire (no Responses round-trip). Every other target keeps
 * the existing translate-and-replay bridge so the proxy's admission,
 * routing, key-pool, retry, usage, and logging stay on one shared path.
 */
import { FORWARD_HEADERS } from "../adapters/openai-responses";
import { stripBracketedModelSuffix } from "../adapters/openai-chat";
import { ChatCompletionsRequestError, chatCompletionsToResponsesBody } from "../chat/inbound";
import {
  chatCompletionsErrorResponse,
  collectChatCompletion,
  isChatCompletionsStreamError,
  responsesJsonToChatCompletion,
  responsesSseToChatCompletionsSse,
} from "../chat/outbound";
import { classifyError, CYBER_POLICY_ERROR_CODE, isCyberPolicyCode } from "../lib/errors";
import { redactSecretString } from "../lib/redact";
import { resolveClientRetryAfter } from "../lib/retry-after";
import { estimateTokens } from "../lib/token-estimate";
import { NoEligiblePolicyCandidateError, routeModel } from "../router";
import { evidenceFromBody } from "../routing/request-evidence";
import { resolveWireProtocolOverride } from "./adapter-resolve";
import type { OcxConfig, OcxProviderConfig } from "../types";
import type { UpstreamSendRecovery } from "../lib/upstream-retry";
import { readJsonRequestBody } from "./request-decompress";
import {
  addFinalRequestLog,
  beginRequestAttempt,
  finishRequestAttempt,
  noteAttemptSend,
  sealRequestAttemptIdentity,
  httpStatusForRequestLogTerminal,
  recordFirstOutput,
  type RequestLogContext,
  type RequestLogEntry,
} from "./request-log";
import { responseWithDeferredRequestLog } from "./relay";
import { handleResponses, linkAbortSignal } from "./responses";
import { fetchWithHeaderTimeout, providerFetch, safeHostLabel } from "./responses/fetch-helpers";
import { fetchWithTransientRetry } from "../lib/upstream-retry";
import { cancelBodyOnAbort } from "../lib/abort";
import { trackStreamLifetime } from "./lifecycle";
import {
  hasKeyPoolFailover,
  rateLimitRetryDelayMs,
  rateLimitRetryPolicyFor,
  rotateProviderTransportOn429,
} from "../providers/key-failover";
import type { AdmissionLease } from "../lib/admission";
import { tryClaimNativeMainProfileForTurn } from "../codex/native-main-admission";
import {
  createTranslatorBudget,
  finalizeTranslatorBudgetResponse,
  isTranslatorBudgetExceededError,
  type TranslatorBudget,
} from "../lib/translator-budget";

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
async function readChatBody(req: Request, budget: TranslatorBudget): Promise<unknown> {
  try {
    return await readJsonRequestBody(req, budget);
  } catch (err) {
    if (isTranslatorBudgetExceededError(err)) throw err;
    throw new ChatCompletionsRequestError(err instanceof Error && err.message ? err.message : "Invalid JSON body");
  }
}

export async function handleChatCompletions(
  req: Request,
  config: OcxConfig,
  logCtx: RequestLogContext,
  logIds?: { requestId: string; start: number; turnAdmissionLease?: AdmissionLease },
): Promise<Response> {
  const translatorBudget = createTranslatorBudget();
  try {
    return finalizeTranslatorBudgetResponse(
      await handleChatCompletionsWithBudget(req, config, logCtx, translatorBudget, logIds),
      translatorBudget,
    );
  } catch (error) {
    translatorBudget.dispose();
    throw error;
  }
}

function isChatNativeEligibleProvider(provider: OcxProviderConfig): boolean {
  return provider.adapter === "openai-chat" && provider.authMode !== "forward";
}

function shouldBridgeChatNative(raw: Rec): boolean {
  if (raw.store === true) return true;
  if (raw.background === true) return true;
  if (typeof raw.previous_response_id === "string" && raw.previous_response_id.length > 0) return true;
  if (raw.compaction_trigger !== undefined) return true;
  if (Array.isArray(raw.tools)) {
    for (const t of raw.tools as unknown[]) {
      if (!t || typeof t !== "object") continue;
      const tt = (t as Rec).type;
      if (tt === "web_search" || tt === "web_search_preview" || tt === "image_generation") return true;
    }
  }
  return false;
}


async function handleChatCompletionsWithBudget(
  req: Request,
  config: OcxConfig,
  logCtx: RequestLogContext,
  translatorBudget: TranslatorBudget,
  logIds?: { requestId: string; start: number; turnAdmissionLease?: AdmissionLease },
): Promise<Response> {
  let chatBody: unknown;
  let internalBody: Rec;
  try {
    chatBody = await readChatBody(req, translatorBudget);
    internalBody = chatCompletionsToResponsesBody(chatBody);
  } catch (err) {
    const overflow = isTranslatorBudgetExceededError(err);
    const status = overflow ? 413 : err instanceof ChatCompletionsRequestError ? 400 : 500;
    if (logIds) addFinalRequestLog(logIds.requestId, logIds.start, logCtx, status, { closeReason: "non_stream" });
    return chatCompletionsErrorResponse(
      status,
      overflow ? "request translation buffer exceeded the safe limit" : err instanceof Error ? err.message : String(err),
      overflow ? "request_too_large" : undefined,
      overflow ? "translation_buffer_limit" : undefined,
    );
  }

  const requestedModel = (chatBody as Rec).model as string;
  const requestedStream = internalBody.stream === true;
  const chatStreamForUpstream = (chatBody as Rec).stream === true;
  // Chat-native path must also respect the translator turn budget on the raw
  // Chat body size (Responses does this via JSON stringify charge). Without it,
  // the 33 MiB overflow test escapes as a 502 after routing.
  try {
    const rawJson = JSON.stringify(chatBody);
    translatorBudget.chargeRetained(new TextEncoder().encode(rawJson).byteLength, { kind: "request_copies" });
  } catch (err) {
    const overflow = isTranslatorBudgetExceededError(err);
    const status = overflow ? 413 : 500;
    if (logIds) addFinalRequestLog(logIds.requestId, logIds.start, logCtx, status, { closeReason: "non_stream" });
    return chatCompletionsErrorResponse(
      status,
      overflow ? "request translation buffer exceeded the safe limit" : err instanceof Error ? err.message : String(err),
      overflow ? "request_too_large" : undefined,
      overflow ? "translation_buffer_limit" : undefined,
    );
  }
  // Best-effort Grok attribution: the managed fence stamps this header on every model
  // it registers (extra_headers, sent verbatim by upstream Grok). Dashboard usage
  // bucketing only — never an auth or billing signal.
  if (req.headers.get("x-opencodex-grok") === "1") logCtx.surface = "grok";
  // Routed adapters only support streamed turns; always stream internally and fold
  // for non-streaming clients.
  internalBody.stream = true;

  let nativeRoute = false;
  let directRoute = false;
  type ChatNativeRoute = { providerName: string; provider: OcxProviderConfig; modelId: string };
  let chatNativeRoute: ChatNativeRoute | null = null;
  try {
    const route = routeModel(config, internalBody.model as string, evidenceFromBody(internalBody));
    // Settle the wire once so every branch below reads the adapter this model will
    // actually use, not the provider-wide default (#404).
    route.provider = resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, "chat");
    logCtx.model = route.modelId;
    logCtx.providerAdapter = route.provider.adapter;
    logCtx.requestedModel = requestedModel;
    logCtx.provider = route.providerName;
    logCtx.routeDecision = route.routeDecision;
    if (route.provider.adapter === "openai-responses") {
      nativeRoute = true;
      directRoute = route.codexAccountMode === "direct";
      // ChatGPT backend rejects store:true and unsupported sampling knobs.
      internalBody.store = false;
      delete internalBody.max_output_tokens;
      delete internalBody.temperature;
      delete internalBody.top_p;
      delete internalBody.stop;
      delete internalBody.user;
    } else if (internalBody.store === undefined) {
      internalBody.store = false;
    }
    if (route.provider.adapter === "cursor" || route.provider.adapter === "kiro") {
      const raw = chatBody as Rec;
      const parts: string[] = [];
      if (raw.messages !== undefined) parts.push(JSON.stringify(raw.messages));
      if (raw.tools !== undefined) parts.push(JSON.stringify(raw.tools));
      logCtx.usageLogInputTokens = Math.max(1, estimateTokens(parts.join("\n"), requestedModel));
    }
    if (internalBody.reasoning !== undefined) {
      const { supportedLadderFor } = await import("./effort-policy");
      const ladder = supportedLadderFor({ provider: route.provider, modelId: route.modelId });
      if (ladder !== undefined && ladder.length === 0) delete internalBody.reasoning;
    }
    if (
      isChatNativeEligibleProvider(route.provider)
      && !shouldBridgeChatNative(chatBody as Rec)
    ) {
      chatNativeRoute = route as unknown as ChatNativeRoute;
    }
  } catch (err) {
    if (err instanceof NoEligiblePolicyCandidateError) {
      logCtx.routeDecision = err.trace;
      if (logIds) addFinalRequestLog(logIds.requestId, logIds.start, logCtx, 404, { closeReason: "non_stream" });
      return chatCompletionsErrorResponse(404, err.message, "invalid_request_error");
    }
    /* unknown model: let handleResponses shape the 404 */
  }
  void nativeRoute;

  const headers = new Headers({ "content-type": "application/json" });
  for (const name of FORWARD_HEADERS) {
    if (name === "authorization" && !directRoute) continue;
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  // Prefer main ChatGPT auth so OpenAI-backed sidecars remain reachable on routed turns.
  if (!directRoute) {
    // This enrichment is optional for routed/non-main providers. If native main
    // is fenced, omit it and let auth-context reject only a final physical-main
    // selection while healthy pool/provider routes continue.
    if (tryClaimNativeMainProfileForTurn(logIds?.turnAdmissionLease)) {
      try {
        const { getMainAccountToken } = await import("../codex/main-account");
        const token = getMainAccountToken();
        if (token) {
          headers.set("authorization", `Bearer ${token.accessToken}`);
          headers.set("chatgpt-account-id", token.chatgptAccountId);
        }
      } catch {
        /* optional */
      }
    }
  }

  // ---- Chat-native path (chat -> chat) : minimal direct wire, no Responses round-trip ----
  if (chatNativeRoute) {
    const rawChat = chatBody as Rec;
    const routeInfo: ChatNativeRoute = chatNativeRoute;
    // Preserve request logging shape for chat-native turns.
    logCtx.inboundProtocol = "chat";
    const attempt = beginRequestAttempt(
      (logCtx.attempts?.length ?? 0) + 1,
      logCtx.provider,
      routeInfo.modelId,
      "openai-chat",
    );
    logCtx.activeAttempt = attempt;
    logCtx.activeAttemptStartedAt = Date.now();
    (logCtx.attempts ??= []).push(attempt);
    sealRequestAttemptIdentity(logCtx.activeAttempt, logCtx.provider, "openai-chat", logCtx.accountLogLabel);

    const upstreamHeaders = new Headers(headers);
    // Chat-native always sends the provider's own credential; forward-mode is excluded above.
    // Keep any caller Authorization only when it was explicitly forwarded (directRoute).
    const providerConfig: OcxProviderConfig = routeInfo.provider;
    const providerApiKey: string | undefined = providerConfig.apiKey;
    const hasProviderKey = typeof providerApiKey === "string" && providerApiKey.trim().length > 0;
    if (hasProviderKey) {
      upstreamHeaders.set("authorization", `Bearer ${providerApiKey!.trim()}`);
    }
    if (providerConfig.headers) {
      for (const [k, v] of Object.entries(providerConfig.headers)) upstreamHeaders.set(k, v);
    }

    const wireModelId = providerConfig.modelSuffixBracketStrip
      ? stripBracketedModelSuffix(routeInfo.modelId)
      : routeInfo.modelId;
    const chatBodyForWire: Rec = { ...rawChat, model: wireModelId, stream: chatStreamForUpstream };
    if (chatBodyForWire.store === true) chatBodyForWire.store = false;
    if (
      chatBodyForWire.response_format !== undefined
      && providerConfig.noStructuredOutputModels?.includes(routeInfo.modelId)
    ) {
      delete chatBodyForWire.response_format;
    }
    const bodyJson = JSON.stringify(chatBodyForWire);
    const base = providerConfig.baseUrl ?? "";
    const url = `${base.replace(/\/$/, "")}/chat/completions`;

    const ac = new AbortController();
    const cleanup = linkAbortSignal(ac, req.signal);
    const connectMs = config.connectTimeoutMs ?? 200_000;
    const stream = chatStreamForUpstream;
    let response: Response;
    try {
      const doFetch = (recovery?: UpstreamSendRecovery) =>
        fetchWithHeaderTimeout(
          url,
          {
            method: "POST",
            headers: Object.fromEntries(upstreamHeaders.entries()),
            body: bodyJson,
            ...(recovery ? { keepalive: false } as unknown as RequestInit : {}),
          },
          ac.signal,
          connectMs,
          stream,
          providerFetch(providerConfig),
        );
      noteAttemptSend(logCtx.activeAttempt, logCtx.usageLogInputTokens);
      response = await fetchWithTransientRetry(doFetch, { abortSignal: ac.signal, label: safeHostLabel(url) });
    } catch (err) {
      cleanup();
      ac.abort();
      if (req.signal.aborted) {
        if (logIds) addFinalRequestLog(logIds.requestId, logIds.start, logCtx, 499, { closeReason: "client_cancel" });
        return chatCompletionsErrorResponse(499, "Client cancelled request", "client_cancelled");
      }
      const msg = err instanceof Error ? err.message : String(err);
      finishRequestAttempt(attempt, 502, Date.now() - (logCtx.activeAttemptStartedAt ?? Date.now()));
      if (logIds) addFinalRequestLog(logIds.requestId, logIds.start, logCtx, 502, { closeReason: "non_stream" });
      return chatCompletionsErrorResponse(502, redactSecretString(msg).slice(0, 500), "server_error");
    }

    // Pre-stream 429 handling: same-target wait then key-pool failover, matching
    // the Responses core policy but scoped to this chat-native request.
    const rateLimitPolicy = rateLimitRetryPolicyFor(providerConfig);
    let sameTargetRetries = 0;
    while (
      response.status === 429
      && rateLimitPolicy
      && sameTargetRetries < rateLimitPolicy.attempts
      && !ac.signal.aborted
      && !req.signal.aborted
    ) {
      const retryAfter = response.headers.get("retry-after");
      const delayMs = rateLimitRetryDelayMs(rateLimitPolicy, retryAfter, Date.now());
      try { void response.body?.cancel().catch(() => {}); } catch { /* noop */ }
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, delayMs);
        const onAbort = () => { clearTimeout(t); reject(new DOMException("aborted", "AbortError")); };
        if (ac.signal.aborted || req.signal.aborted) { clearTimeout(t); reject(new DOMException("aborted", "AbortError")); return; }
        ac.signal.addEventListener("abort", onAbort, { once: true });
        req.signal.addEventListener("abort", onAbort, { once: true });
      }).catch(() => {});
      if (ac.signal.aborted || req.signal.aborted) break;
      sameTargetRetries += 1;
      noteAttemptSend(logCtx.activeAttempt, logCtx.usageLogInputTokens, "rate-limit-429");
      try {
        response = await fetchWithHeaderTimeout(
          url,
          { method: "POST", headers: Object.fromEntries(upstreamHeaders.entries()), body: bodyJson },
          ac.signal,
          connectMs,
          stream,
          providerFetch(providerConfig),
        );
      } catch {
        break;
      }
    }
    while (
      response.status === 429
      && hasKeyPoolFailover(providerConfig)
      && !ac.signal.aborted
      && !req.signal.aborted
    ) {
      const rotated = rotateProviderTransportOn429(config, routeInfo.providerName, providerConfig as OcxProviderConfig, {
        retryAfter: response.headers.get("retry-after"),
        now: Date.now(),
        attemptedKey: providerApiKey,
      });
      if (!rotated) break;
      // Adopt rotated provider for the retry.
      const nextProvider: OcxProviderConfig = rotated as unknown as OcxProviderConfig;
      if (nextProvider.apiKey) upstreamHeaders.set("authorization", `Bearer ${nextProvider.apiKey.trim()}`);
      if (nextProvider.headers) for (const [k, v] of Object.entries(nextProvider.headers)) upstreamHeaders.set(k, v);
      try { void response.body?.cancel().catch(() => {}); } catch { /* noop */ }
      noteAttemptSend(logCtx.activeAttempt, logCtx.usageLogInputTokens, "key-429");
      try {
        response = await fetchWithHeaderTimeout(
          url,
          { method: "POST", headers: Object.fromEntries(upstreamHeaders.entries()), body: bodyJson },
          ac.signal,
          connectMs,
          stream,
          providerFetch(nextProvider),
        );
      } catch {
        break;
      }
      // Keep provider reference coherent for logging on this turn.
      (routeInfo as { provider: OcxProviderConfig }).provider = nextProvider;
    }

    if (req.signal.aborted || ac.signal.aborted) {
      cleanup();
      ac.abort();
      try { void response.body?.cancel().catch(() => {}); } catch { /* noop */ }
      if (logIds) addFinalRequestLog(logIds.requestId, logIds.start, logCtx, 499, { closeReason: "client_cancel" });
      return chatCompletionsErrorResponse(499, "Client cancelled request", "client_cancelled");
    }

    if (!response.ok) {
      cleanup();
      const rawRetryAfter = response.headers.get("retry-after");
      const retryAfter = resolveClientRetryAfter({
        status: response.status,
        message: `Provider error ${response.status}`,
        upstreamRetryAfter: rawRetryAfter,
      });
      let message = `Provider error ${response.status}`;
      let upstreamCode: string | null | undefined;
      let upstreamType: string | undefined;
      try {
        const text = await response.text();
        try {
          const parsed = JSON.parse(text) as { error?: { message?: string; type?: string; code?: string | null } | string; message?: string };
          const nested = typeof parsed?.error === "object" && parsed.error ? parsed.error : undefined;
          const flat = typeof parsed?.error === "string" ? parsed.error : parsed?.message;
          const fallback = text ? `Provider error ${response.status}: ${redactSecretString(text).slice(0, 400)}` : message;
          message = nested?.message || flat || fallback;
          if (nested) {
            if (typeof nested.type === "string") upstreamType = nested.type;
            if (nested.code === null || typeof nested.code === "string") upstreamCode = nested.code;
          }
        } catch {
          if (text) message = `Provider error ${response.status}: ${redactSecretString(text).slice(0, 400)}`;
        }
      } catch { /* keep fallback */ }
      const classified = classifyError(
        response.status,
        upstreamType
          ?? (response.status === 401 ? "authentication_error"
            : response.status === 429 ? "rate_limit_error"
            : response.status >= 500 ? "server_error"
            : "invalid_request_error"),
        message,
      );
      if (isCyberPolicyCode(upstreamCode)) {
        classified.code = CYBER_POLICY_ERROR_CODE;
        classified.type = "invalid_request_error";
      } else if (upstreamCode === "model_not_found") {
        classified.code = "model_not_found";
        classified.type = "invalid_request_error";
      } else if (upstreamCode !== undefined && upstreamCode !== null && classified.code == null) {
        classified.code = upstreamCode;
      }
      const status = isCyberPolicyCode(classified.code) ? 400 : response.status;
      finishRequestAttempt(attempt, status, Date.now() - (logCtx.activeAttemptStartedAt ?? Date.now()));
      const headersOut: Record<string, string> = { "Content-Type": "application/json", ...(retryAfter ? { "Retry-After": retryAfter } : {}) };
      const bodyOut = JSON.stringify({ error: { message: classified.message, type: classified.type, param: null, code: classified.code } });
      const errResp = new Response(bodyOut, { status, headers: headersOut });
      if (logIds) {
        return responseWithDeferredRequestLog(errResp, logIds.requestId, logIds.start, logCtx);
      }
      return errResp;
    }

    // Success: stream passthrough or JSON — preserve Chat wire verbatim.
    const ct = response.headers.get("content-type") ?? "";
    // Requested streaming wins even when the mock omits content-type on some paths;
    // non-streaming JSON must be returned even if upstream sent SSE frames.
    const wantsStream = stream;
    const isSseContentType = ct.includes("text/event-stream");
    const shouldStream = (wantsStream && !!response.body) || (isSseContentType && !!response.body && wantsStream);
    const sseHeaders: Record<string, string> = {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    };
    if (shouldStream && response.body) {
      // If this is a requested SSE turn, rewrite upstream Chat SSE into the
      // canonical chat.completion.chunk envelope so existing clients/tests that
      // expect `chat.completion.chunk` continue to pass on the chat-native path.
      const upstreamBody = response.body;
      let outStream: ReadableStream<Uint8Array>;
      if (isSseContentType) {
        // Upstream is Chat SSE but may omit the object envelope (mock does).
        // Wrap it into a proper chunk envelope without re-parsing.
        const reader = upstreamBody.getReader();
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        const created = Math.floor(Date.now() / 1000);
        const id = `chatcmpl-${Date.now().toString(36)}`;
        const modelForChunk = requestedModel;
        let buffer = "";
        let forwardedDone = false;
        outStream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const { done, value } = await reader.read();
            if (done) {
              if (!forwardedDone) {
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                forwardedDone = true;
              }
              controller.close();
              return;
            }
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split("\n\n");
            buffer = parts.pop() ?? "";
            for (const part of parts) {
              const line = part.trim();
              if (!line) continue;
              if (line === "data: [DONE]") {
                forwardedDone = true;
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                continue;
              }
              if (!line.startsWith("data: ")) continue;
              const payload = line.slice(6).trim();
              if (payload === "[DONE]") {
                forwardedDone = true;
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                continue;
              }
              let parsed: unknown;
              try { parsed = JSON.parse(payload); } catch { continue; }
              if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
              const rec = parsed as Rec;
              // Already a proper chunk — forward as-is.
              if (rec.object === "chat.completion.chunk") {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(rec)}\n\n`));
                continue;
              }
              const choices = Array.isArray(rec.choices) ? rec.choices as Rec[] : [];
              const choice0 = choices[0] as Rec | undefined;
              // Normalize minimal mock delta -> proper chunk
              const chunk: Rec = {
                id,
                object: "chat.completion.chunk",
                created,
                model: modelForChunk,
                choices: [{
                  index: 0,
                  delta: (choice0?.delta as Rec) ?? {},
                  finish_reason: (choice0?.finish_reason as string | null) ?? null,
                }],
                ...(rec.usage ? { usage: rec.usage } : {}),
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            }
          },
          cancel(reason) { try { void reader.cancel(reason); } catch { /* noop */ } },
        });
      } else {
        outStream = upstreamBody;
      }
      if (logIds) recordFirstOutput(logCtx, logIds.start);
      const tracked = trackStreamLifetime(outStream, ac, () => {
        cleanup();
        if (logIds) addFinalRequestLog(logIds.requestId, logIds.start, logCtx, 200, { closeReason: "terminal" });
        finishRequestAttempt(attempt, 200, Date.now() - (logCtx.activeAttemptStartedAt ?? Date.now()));
      }, logIds?.turnAdmissionLease);
      const withAbort = new Response(tracked, { status: 200, headers: sseHeaders });
      cancelBodyOnAbort(tracked, ac.signal);
      if (logIds) {
        return responseWithDeferredRequestLog(withAbort, logIds.requestId, logIds.start, logCtx);
      }
      return withAbort;
    }

    // Non-streaming: upstream may have returned SSE (mock always does) or JSON.
    // Normalize both into chat.completion JSON so callers/tests stay green.
    let parsedJson: unknown | null = null;
    let jsonText: string | null = null;
    if (isSseContentType && response.body) {
      // Fold SSE into a completion JSON (same as the legacy bridge does for
      // non-streaming clients via collectChatCompletion, but lighter: the
      // mock already emits stop+usage, so just collect text deltas).
      const text = await response.text();
      cleanup();
      let content = "";
      let usage: Rec | undefined;
      for (const block of text.split("\n\n")) {
        const line = block.trim();
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const parsed = JSON.parse(payload) as Rec;
          const choices = Array.isArray(parsed.choices) ? parsed.choices as Rec[] : [];
          const delta = (choices[0] as Rec | undefined)?.delta as Rec | undefined;
          if (delta && typeof delta.content === "string") content += delta.content;
          if (parsed.usage && isRec(parsed.usage)) usage = parsed.usage as Rec;
        } catch { /* skip malformed delta */ }
      }
      parsedJson = {
        id: `chatcmpl-${Date.now().toString(36)}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: requestedModel,
        choices: [{ index: 0, message: { role: "assistant", content: content || null }, finish_reason: "stop", logprobs: null }],
        usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
      if (isRec(usage)) {
        const prompt = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined;
        const completion = typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined;
        if (prompt !== undefined || completion !== undefined) {
          logCtx.usage = { inputTokens: prompt ?? 0, outputTokens: completion ?? 0 };
          if (logCtx.activeAttempt) logCtx.activeAttempt.usage = logCtx.usage;
        }
      }
      finishRequestAttempt(attempt, 200, Date.now() - (logCtx.activeAttemptStartedAt ?? Date.now()));
      const okResp = new Response(JSON.stringify(parsedJson), { status: 200, headers: { "Content-Type": "application/json" } });
      if (logIds) {
        addFinalRequestLog(logIds.requestId, logIds.start, logCtx, 200, { closeReason: "non_stream" });
        return responseWithDeferredRequestLog(okResp, logIds.requestId, logIds.start, logCtx);
      }
      return okResp;
    }
    try {
      jsonText = await response.text();
    } catch {
      cleanup();
      finishRequestAttempt(attempt, 502, Date.now() - (logCtx.activeAttemptStartedAt ?? Date.now()));
      if (logIds) addFinalRequestLog(logIds.requestId, logIds.start, logCtx, 502, { closeReason: "non_stream" });
      return chatCompletionsErrorResponse(502, "upstream returned a non-JSON response", "server_error");
    }
    cleanup();
    try { parsedJson = JSON.parse(jsonText!); } catch { parsedJson = null; }
    if (isRec(parsedJson) && isRec((parsedJson as Rec).usage)) {
      const usage = (parsedJson as Rec).usage as Rec;
      const prompt = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined;
      const completion = typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined;
      if (prompt !== undefined || completion !== undefined) {
        logCtx.usage = { inputTokens: prompt ?? 0, outputTokens: completion ?? 0 };
        if (logCtx.activeAttempt) logCtx.activeAttempt.usage = logCtx.usage;
      }
    }
    finishRequestAttempt(attempt, 200, Date.now() - (logCtx.activeAttemptStartedAt ?? Date.now()));
    const outHeaders: Record<string, string> = { "Content-Type": "application/json" };
    const outBody = parsedJson !== null ? JSON.stringify(parsedJson) : jsonText!;
    const okResp = new Response(outBody, { status: 200, headers: outHeaders });
    if (logIds) {
      addFinalRequestLog(logIds.requestId, logIds.start, logCtx, 200, { closeReason: "non_stream" });
      return responseWithDeferredRequestLog(okResp, logIds.requestId, logIds.start, logCtx);
    }
    return okResp;
  }

  let internalBodyJson: string;
  try {
    internalBodyJson = JSON.stringify(internalBody);
    translatorBudget.chargeRetained(
      new TextEncoder().encode(internalBodyJson).byteLength,
      { kind: "request_copies" },
    );
  } catch (err) {
    const overflow = isTranslatorBudgetExceededError(err);
    const status = overflow ? 413 : 500;
    if (logIds) addFinalRequestLog(logIds.requestId, logIds.start, logCtx, status, { closeReason: "non_stream" });
    return chatCompletionsErrorResponse(
      status,
      overflow ? "request translation buffer exceeded the safe limit" : err instanceof Error ? err.message : String(err),
      overflow ? "request_too_large" : undefined,
      overflow ? "translation_buffer_limit" : undefined,
    );
  }
  const internalReq = new Request("http://localhost/v1/responses", {
    method: "POST",
    headers,
    body: internalBodyJson,
  });

  let nativeLogged = false;
  const finalizeNativeLog = (status: number, meta: { terminalStatus?: RequestLogEntry["terminalStatus"]; closeReason: "terminal" | "client_cancel" }) => {
    if (!logIds || nativeLogged) return;
    nativeLogged = true;
    addFinalRequestLog(logIds.requestId, logIds.start, logCtx, status, meta);
  };
  const upstream = await handleResponses(internalReq, config, logCtx, {
    ...(logIds?.turnAdmissionLease ? { turnAdmissionLease: logIds.turnAdmissionLease } : {}),
    abortSignal: req.signal,
    // Body is Responses-shaped by now, but the client spoke Chat Completions.
    inboundWire: "chat",
    translatorBudget,
    ...(logIds ? { onFirstOutput: () => recordFirstOutput(logCtx, logIds.start) } : {}),
    onNativePassthroughTerminal: status => finalizeNativeLog(httpStatusForRequestLogTerminal(status, logCtx), { terminalStatus: status, closeReason: "terminal" }),
    onNativePassthroughCancel: () => finalizeNativeLog(499, { closeReason: "client_cancel" }),
  });

  // Rewrite non-2xx before deferred logging so /api/logs records the client-facing status
  // (e.g. cyber_policy remapped from a passthrough 5xx to HTTP 400).
  if (!upstream.ok) {
    let message = `upstream error (${upstream.status})`;
    let upstreamCode: string | null | undefined;
    let upstreamType: string | undefined;
    try {
      const text = await upstream.text();
      try {
        const parsed = JSON.parse(text) as {
          error?: { message?: string; type?: string; code?: string | null } | string;
          message?: string;
        };
        const nested = typeof parsed?.error === "object" && parsed.error ? parsed.error : undefined;
        const flat = typeof parsed?.error === "string" ? parsed.error : parsed?.message;
        const rawFallback = text
          ? `upstream error (${upstream.status}): ${redactSecretString(text).slice(0, 400)}`
          : message;
        message = nested?.message || flat || rawFallback;
        if (nested) {
          if (typeof nested.type === "string") upstreamType = nested.type;
          if (nested.code === null || typeof nested.code === "string") upstreamCode = nested.code;
        }
      } catch {
        if (text) message = `upstream error (${upstream.status}): ${redactSecretString(text).slice(0, 400)}`;
      }
    } catch { /* keep fallback */ }
    const retryAfter = resolveClientRetryAfter({
      status: upstream.status,
      message,
      upstreamRetryAfter: upstream.headers.get("retry-after"),
    });
    const classified = classifyError(
      upstream.status,
      upstreamType
        ?? (upstream.status === 401 ? "authentication_error"
          : upstream.status === 429 ? "rate_limit_error"
          : upstream.status >= 500 ? "server_error"
          : "invalid_request_error"),
      message,
    );
    if (isCyberPolicyCode(upstreamCode)) {
      classified.code = CYBER_POLICY_ERROR_CODE;
      classified.type = "invalid_request_error";
    } else if (upstreamCode === "model_not_found") {
      // Structured model_not_found must win over classifyError's generic remaps.
      classified.code = "model_not_found";
      classified.type = "invalid_request_error";
    } else if (upstreamCode !== undefined && upstreamCode !== null && classified.code == null) {
      classified.code = upstreamCode;
    }
    const status = isCyberPolicyCode(classified.code) ? 400 : upstream.status;
    const rewritten = new Response(JSON.stringify({
      error: {
        message: classified.message,
        type: classified.type,
        param: null,
        code: classified.code,
      },
    }), {
      status,
      headers: {
        "Content-Type": "application/json",
        ...(retryAfter ? { "Retry-After": retryAfter } : {}),
      },
    });
    return logIds
      ? responseWithDeferredRequestLog(rewritten, logIds.requestId, logIds.start, logCtx)
      : rewritten;
  }

  const response = logIds
    ? responseWithDeferredRequestLog(upstream, logIds.requestId, logIds.start, logCtx)
    : upstream;

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream") && response.body) {
    const chatSse = responsesSseToChatCompletionsSse(response.body, requestedModel, { translatorBudget });
    if (requestedStream) {
      // Stream failures surface as an error SSE frame then abort the body — never a
      // success completion that embeds `[error] ...` + clean [DONE].
      return new Response(chatSse, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }
    try {
      const completion = await collectChatCompletion(chatSse, requestedModel, translatorBudget);
      return new Response(JSON.stringify(completion), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      if (isChatCompletionsStreamError(err)) {
        return chatCompletionsErrorResponse(err.status, err.message, err.type, err.code);
      }
      return chatCompletionsErrorResponse(
        502,
        err instanceof Error ? err.message : String(err),
        "server_error",
      );
    }
  }

  // Defensive: JSON despite stream:true.
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return chatCompletionsErrorResponse(502, "internal replay returned a non-JSON response", "server_error");
  }
  const status = (json as Rec)?.status;
  if (status === "failed") {
    const error = (json as { error?: { message?: string; type?: string; code?: string | null } }).error;
    const message = error?.message ?? "upstream request failed";
    const classified = classifyError(502, error?.type ?? "server_error", message);
    if (error?.code === "translation_buffer_limit") {
      classified.code = "translation_buffer_limit";
      classified.type = "upstream_error";
    } else if (isCyberPolicyCode(error?.code)) {
      classified.code = CYBER_POLICY_ERROR_CODE;
      classified.type = "invalid_request_error";
    } else if (error?.code === "model_not_found") {
      // Same deliberate preserve as the non-OK path: structured code beats generic classify.
      classified.code = "model_not_found";
      classified.type = "invalid_request_error";
    }
    return chatCompletionsErrorResponse(
      classified.code === "translation_buffer_limit"
        ? 502
        : isCyberPolicyCode(classified.code) ? 400 : 502,
      message,
      classified.type,
      classified.code,
    );
  }
  const completion = responsesJsonToChatCompletion(json, requestedModel);
  if (!requestedStream) {
    return new Response(JSON.stringify(completion), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Streaming client + JSON upstream: synthesize a minimal Chat Completions stream.
  const encoder = new TextEncoder();
  const id = typeof completion.id === "string" ? completion.id : `chatcmpl-${Date.now()}`;
  const created = typeof completion.created === "number" ? completion.created : Math.floor(Date.now() / 1000);
  const message = isRec((completion.choices as Rec[] | undefined)?.[0])
    ? ((completion.choices as Rec[])[0] as Rec).message as Rec | undefined
    : undefined;
  const content = message && typeof message.content === "string" ? message.content : "";
  const frames = [
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: requestedModel, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })}\n\n`,
    ...(content
      ? [`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: requestedModel, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`]
      : []),
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: requestedModel, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: completion.usage })}\n\n`,
    "data: [DONE]\n\n",
  ];
  return new Response(encoder.encode(frames.join("")), {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}
