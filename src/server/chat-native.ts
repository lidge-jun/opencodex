import { buildOpenAIChatPassthroughRequest, createOpenAIChatAdapter } from "../adapters/openai-chat";
import type { AdapterRequest, ProviderAdapter } from "../adapters/base";
import {
  chatCompletionsErrorBody,
  chatCompletionsErrorResponse,
  collectChatCompletion,
  isChatCompletionsStreamError,
} from "../chat/outbound";
import { classifyError, CYBER_POLICY_ERROR_CODE, isCyberPolicyCode } from "../lib/errors";
import type { AdmissionLease } from "../lib/admission";
import { readBoundedResponseBody } from "../lib/bounded-body";
import { redactSecretString } from "../lib/redact";
import { resolveClientRetryAfter } from "../lib/retry-after";
import { isModelTextOnly } from "../vision";
import {
  applyUpstreamRecoveryInit,
  fetchWithResetRetry,
  prepareSameTarget429Wait,
  type UpstreamSendRecovery,
} from "../lib/upstream-retry";
import {
  isTranslatorBudgetExceededError,
  type TranslatorBudget,
} from "../lib/translator-budget";
import {
  hasKeyPoolFailover,
  rateLimitRetryDelayMs,
  rateLimitRetryPolicyFor,
  rotateProviderTransportOn429,
} from "../providers/key-failover";
import { fastPolicyForModel } from "../providers/service-tier";
import type { RouteResult } from "../router";
import type { OcxConfig, OcxProviderConfig } from "../types";
import { fetchWithHeaderTimeout, providerFetch, safeHostLabel } from "./responses/fetch-helpers";
import { linkAbortSignal } from "./responses";
import {
  addFinalRequestLog,
  beginRequestAttempt,
  noteAttemptSend,
  recordFirstOutput,
  sealRequestAttemptIdentity,
  type RequestLogContext,
} from "./request-log";
import { jsonCompletionSse, nativeChatSse, structuredError, usageFromChat } from "./chat-native-sse";
import { registerTurn, unregisterTurn } from "./lifecycle";

type Rec = Record<string, unknown>;

const MAX_NATIVE_CHAT_JSON_BYTES = 32 * 1024 * 1024;
const MAX_NATIVE_CHAT_ERROR_BYTES = 64 * 1024;

function isRec(value: unknown): value is Rec {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isNativeChatRouteEligible(route: RouteResult, rawBody: Rec): boolean {
  const provider = route.provider;
  if (provider.adapter !== "openai-chat") return false;
  if (provider.authMode !== undefined && provider.authMode !== "key" && provider.authMode !== "local") return false;
  // Combo and policy execution own multi-candidate retries in the Responses pipeline.
  if (route.combo || route.routeKind === "combo" || route.routeKind === "policy") return false;
  if (rawBody.store === true || rawBody.background === true) return false;
  if (typeof rawBody.previous_response_id === "string" && rawBody.previous_response_id.length > 0) return false;
  if (rawBody.compaction_trigger !== undefined) return false;
  // Vision sidecar coverage (roadmap 180): a text-only routed model with an
  // image-bearing body must go through the Responses pipeline, whose plan
  // site describes or strips the image. The native fast path has no vision
  // handling, so letting it keep such a request forwards raw pixels to a
  // model the operator declared blind.
  if (isModelTextOnly(provider, route.modelId) && chatBodyCarriesImage(rawBody)) return false;
  if (Array.isArray(rawBody.tools)) {
    for (const tool of rawBody.tools) {
      if (!isRec(tool)) continue;
      if (tool.type === "web_search" || tool.type === "web_search_preview" || tool.type === "image_generation") {
        return false;
      }
    }
  }
  return true;
}

/** Any messages[].content[] part of type image_url. */
function chatBodyCarriesImage(rawBody: Rec): boolean {
  const messages = rawBody.messages;
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    if (!isRec(message) || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (isRec(part) && part.type === "image_url") return true;
    }
  }
  return false;
}

function chatCompletionJson(value: unknown): Rec | null {
  if (!isRec(value) || !Array.isArray(value.choices) || value.choices.length === 0) return null;
  return value;
}

interface HandleNativeChatOptions {
  req: Request;
  config: OcxConfig;
  logCtx: RequestLogContext;
  logIds?: { requestId: string; start: number; turnAdmissionLease?: AdmissionLease };
  route: RouteResult;
  chatBody: Rec;
  requestedModel: string;
  requestedStream: boolean;
  translatorBudget: TranslatorBudget;
}

export async function handleNativeChatCompletions(options: HandleNativeChatOptions): Promise<Response> {
  const { req, config, logCtx, logIds, route, requestedModel, requestedStream, translatorBudget } = options;
  logCtx.inboundProtocol = "chat";
  const attempt = beginRequestAttempt(
    (logCtx.attempts?.length ?? 0) + 1,
    route.providerName,
    route.modelId,
    "openai-chat",
  );
  logCtx.activeAttempt = attempt;
  logCtx.activeAttemptStartedAt = Date.now();
  (logCtx.attempts ??= []).push(attempt);
  sealRequestAttemptIdentity(attempt, route.providerName, "openai-chat", logCtx.accountLogLabel);

  let logged = false;
  const finishLog = (status: number, message?: string, closeReason: "non_stream" | "terminal" | "client_cancel" = "non_stream") => {
    if (logged) return;
    logged = true;
    if (message) logCtx.upstreamError = redactSecretString(message).slice(0, 500);
    if (logIds) addFinalRequestLog(logIds.requestId, logIds.start, logCtx, status, { closeReason });
  };
  const fail = (status: number, message: string, type?: string, code?: string | null): Response => {
    const safeMessage = redactSecretString(message);
    finishLog(status, safeMessage);
    return chatCompletionsErrorResponse(status, safeMessage, type, code);
  };

  logCtx.requestedEffort = typeof options.chatBody.reasoning_effort === "string"
    ? options.chatBody.reasoning_effort
    : undefined;
  logCtx.requestedServiceTier = typeof options.chatBody.service_tier === "string"
    ? options.chatBody.service_tier
    : undefined;

  const upstream = new AbortController();
  const cleanupAbort = linkAbortSignal(upstream, req.signal);
  // nativeChatSse already owns the translated stream's async pull/cancel path.
  // Bind the lease to that same controller and its terminal callbacks instead
  // of adding another trackStreamLifetime wrapper (unsafe on bundled Bun#32111).
  let streamTurnRegistered = false;
  const transferTurnToStream = () => {
    const lease = logIds?.turnAdmissionLease;
    if (!lease || typeof (lease as { bindAbortController?: unknown }).bindAbortController !== "function") return;
    registerTurn(upstream, lease);
    streamTurnRegistered = true;
  };
  const releaseStreamTurn = () => {
    if (!streamTurnRegistered) return;
    streamTurnRegistered = false;
    unregisterTurn(upstream);
  };
  const connectMs = config.connectTimeoutMs ?? 200_000;
  let activeProvider: OcxProviderConfig = route.provider;
  let activeAdapter: ProviderAdapter = createOpenAIChatAdapter(activeProvider);
  let activeRequest: AdapterRequest;
  let retainedRequestBytes = 0;
  const releaseRetainedRequest = () => {
    if (retainedRequestBytes === 0) return;
    translatorBudget.releaseRetained(retainedRequestBytes, { kind: "request_copies" });
    retainedRequestBytes = 0;
  };
  const retainRequest = (request: AdapterRequest) => {
    const bytes = new TextEncoder().encode(request.body).byteLength;
    translatorBudget.chargeRetained(bytes, { kind: "request_copies" });
    retainedRequestBytes = bytes;
  };
  const buildActiveRequest = () => buildOpenAIChatPassthroughRequest(
    activeProvider,
    options.chatBody,
    route.modelId,
    requestedStream,
    fastPolicyForModel(activeProvider, route.modelId, route.providerName, "chat"),
    config.fastMode,
  );
  try {
    activeRequest = buildActiveRequest();
    retainRequest(activeRequest);
  } catch (error) {
    releaseRetainedRequest();
    cleanupAbort();
    upstream.abort();
    if (isTranslatorBudgetExceededError(error)) {
      return fail(413, "request translation buffer exceeded the safe limit", "request_too_large", "translation_buffer_limit");
    }
    return fail(400, error instanceof Error ? error.message : String(error), "invalid_request_error");
  }

  const send = async (request: AdapterRequest, recovery?: "rate-limit-429" | "key-429"): Promise<Response> => {
    try {
      return await fetchWithResetRetry(
        (transportRecovery?: UpstreamSendRecovery) => {
          noteAttemptSend(attempt, logCtx.usageLogInputTokens, transportRecovery ?? recovery);
          return fetchWithHeaderTimeout(
            request.url,
            applyUpstreamRecoveryInit({
              method: request.method,
              headers: request.headers,
              body: request.body,
            }, transportRecovery),
            upstream.signal,
            connectMs,
            requestedStream,
            providerFetch(activeProvider, undefined, {
              providerName: route.providerName,
              modelId: route.modelId,
            }),
          );
        },
        { abortSignal: upstream.signal, label: safeHostLabel(request.url) },
      );
    } finally {
      request.releaseBodyObservation?.();
    }
  };

  let response: Response;
  try {
    response = await send(activeRequest);
    const retryPolicy = rateLimitRetryPolicyFor(activeProvider);
    let retries = 0;
    while (response.status === 429 && retryPolicy && retries < retryPolicy.attempts) {
      retries += 1;
      for await (const _ of prepareSameTarget429Wait({
        body: response.body,
        signal: upstream.signal,
        delayMs: rateLimitRetryDelayMs(retryPolicy, response.headers.get("retry-after"), Date.now()),
      })) { /* pre-stream wait */ }
      if (upstream.signal.aborted) throw upstream.signal.reason;
      response = await send(activeRequest, "rate-limit-429");
    }
    while (response.status === 429 && hasKeyPoolFailover(activeProvider)) {
      const rotated = rotateProviderTransportOn429(config, route.providerName, activeProvider, {
        retryAfter: response.headers.get("retry-after"),
        now: Date.now(),
        attemptedKey: activeProvider.apiKey,
        promptCacheKey: typeof options.chatBody.prompt_cache_key === "string" ? options.chatBody.prompt_cache_key : undefined,
      });
      if (!rotated) break;
      try { void response.body?.cancel().catch(() => {}); } catch { /* already closed */ }
      activeProvider = rotated;
      activeAdapter = createOpenAIChatAdapter(activeProvider);
      releaseRetainedRequest();
      activeRequest = buildActiveRequest();
      retainRequest(activeRequest);
      response = await send(activeRequest, "key-429");
    }
  } catch (error) {
    releaseRetainedRequest();
    cleanupAbort();
    upstream.abort();
    if (req.signal.aborted) return fail(499, "Client cancelled request", "client_cancelled");
    return fail(502, error instanceof Error ? error.message : String(error), "server_error");
  }
  releaseRetainedRequest();

  if (!response.ok) {
    let bodyText = "";
    try {
      const body = await readBoundedResponseBody(response, {
        signal: upstream.signal,
        maxBytes: MAX_NATIVE_CHAT_ERROR_BYTES,
      });
      if (body.displaySafe) bodyText = body.text;
    } catch { /* status-only fallback */ }
    cleanupAbort();
    if (req.signal.aborted) {
      upstream.abort();
      return fail(499, "Client cancelled request", "client_cancelled");
    }
    const detail = activeAdapter.formatErrorBody?.(response.status, response.headers, bodyText) ?? "";
    let upstreamType: string | undefined;
    let upstreamCode: string | null | undefined;
    try {
      const parsedError = JSON.parse(bodyText) as Rec;
      const nested = isRec(parsedError.error) ? parsedError.error : undefined;
      if (typeof nested?.type === "string") upstreamType = nested.type;
      if (nested?.code === null || typeof nested?.code === "string") upstreamCode = nested.code;
    } catch { /* keep generic classification */ }
    const message = detail ? `Provider error ${response.status}: ${detail}` : `Provider error ${response.status}`;
    const classified = classifyError(
      response.status,
      upstreamType ?? (response.status === 401 ? "authentication_error"
        : response.status === 429 ? "rate_limit_error"
          : response.status >= 500 ? "server_error" : "invalid_request_error"),
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
    const retryAfter = resolveClientRetryAfter({
      status: response.status,
      message: classified.message,
      upstreamRetryAfter: response.headers.get("retry-after"),
    });
    finishLog(status, classified.message);
    return new Response(JSON.stringify(chatCompletionsErrorBody(status, classified.message, classified.type, classified.code)), {
      status,
      headers: {
        "Content-Type": "application/json",
        ...(retryAfter ? { "Retry-After": retryAfter } : {}),
      },
    });
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/event-stream") && response.body) {
    if (requestedStream) transferTurnToStream();
    const stream = nativeChatSse(response.body, {
      requestedModel,
      translatorBudget,
      signal: upstream.signal,
      onFirstOutput: logIds ? () => recordFirstOutput(logCtx, logIds.start) : undefined,
      onUsage: usage => {
        logCtx.usage = usage;
        attempt.usage = usage;
      },
      ...(requestedStream ? {
        onTerminal: (status: number, message?: string) => {
          try {
            cleanupAbort();
            finishLog(status, message, "terminal");
          } finally {
            releaseStreamTurn();
          }
        },
        onCancel: () => {
          try {
            cleanupAbort();
            upstream.abort();
            finishLog(499, undefined, "client_cancel");
          } finally {
            releaseStreamTurn();
          }
        },
      } : {}),
    });
    if (requestedStream) {
      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }
    try {
      const completion = await collectChatCompletion(stream, requestedModel, translatorBudget);
      cleanupAbort();
      finishLog(200);
      return Response.json(completion);
    } catch (error) {
      cleanupAbort();
      upstream.abort();
      if (isChatCompletionsStreamError(error)) {
        return fail(error.status, error.message, error.type, error.code);
      }
      return fail(502, error instanceof Error ? error.message : String(error), "upstream_error");
    }
  }

  let body;
  try {
    body = await readBoundedResponseBody(response, {
      signal: upstream.signal,
      maxBytes: MAX_NATIVE_CHAT_JSON_BYTES,
      totalTimeoutMs: Math.max(connectMs, 5_000),
      inactivityTimeoutMs: Math.max(connectMs, 5_000),
    });
  } catch (error) {
    cleanupAbort();
    upstream.abort();
    if (req.signal.aborted) return fail(499, "Client cancelled request", "client_cancelled");
    return fail(502, error instanceof Error ? error.message : String(error), "upstream_error");
  }
  cleanupAbort();
  if (body.oversized) {
    upstream.abort();
    return fail(502, "upstream response exceeded the safe limit", "upstream_error", "translation_buffer_limit");
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(body.text);
  } catch {
    return fail(502, "upstream returned malformed Chat Completions JSON", "upstream_error");
  }
  const error = structuredError(parsedJson);
  if (error) return fail(error.status ?? 502, error.message, error.type, error.code);
  const completion = chatCompletionJson(parsedJson);
  if (!completion) return fail(502, "upstream response contained no choices", "upstream_error");
  const usage = usageFromChat(completion.usage);
  if (usage) {
    logCtx.usage = usage;
    attempt.usage = usage;
  }
  if (logIds) recordFirstOutput(logCtx, logIds.start);
  finishLog(200);
  if (requestedStream) {
    return new Response(jsonCompletionSse(completion, requestedModel), {
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
    });
  }
  return new Response(JSON.stringify(completion), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
