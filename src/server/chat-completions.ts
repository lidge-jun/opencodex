/**
 * OpenAI Chat Completions inbound (/v1/chat/completions) for GitHub Copilot App
 * and other OpenAI-compatible clients.
 *
 * Ordinary openai-chat routes send directly on the Chat Completions wire. Routes
 * that need Responses-only behavior keep the Chat -> Responses -> Chat bridge.
 */
import { FORWARD_HEADERS } from "../adapters/openai-responses";
import {
  assertChatCompletionsRoutingBody,
  ChatCompletionsRequestError,
  chatCompletionsToResponsesBody,
} from "../chat/inbound";
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
import type { OcxConfig } from "../types";
import { readJsonRequestBody } from "./request-decompress";
import {
  addFinalRequestLog,
  httpStatusForRequestLogTerminal,
  recordFirstOutput,
  type RequestLogContext,
  type RequestLogEntry,
} from "./request-log";
import { responseWithDeferredRequestLog } from "./relay";
import { handleResponses } from "./responses";
import type { AdmissionLease } from "../lib/admission";
import type { DataPlaneAdmission } from "./auth-cors";
import { tryClaimNativeMainProfileForTurn } from "../codex/native-main-admission";
import {
  createTranslatorBudget,
  finalizeTranslatorBudgetResponse,
  isTranslatorBudgetExceededError,
  type TranslatorBudget,
} from "../lib/translator-budget";
import { handleNativeChatCompletions, isNativeChatRouteEligible } from "./chat-native";

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
  logIds?: { requestId: string; start: number; turnAdmissionLease?: AdmissionLease; admission?: DataPlaneAdmission },
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

async function handleChatCompletionsWithBudget(
  req: Request,
  config: OcxConfig,
  logCtx: RequestLogContext,
  translatorBudget: TranslatorBudget,
  logIds?: { requestId: string; start: number; turnAdmissionLease?: AdmissionLease; admission?: DataPlaneAdmission },
): Promise<Response> {
  let chatBody: Rec;
  try {
    const rawBody = await readChatBody(req, translatorBudget);
    assertChatCompletionsRoutingBody(rawBody);
    chatBody = rawBody;
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

  const requestedModel = chatBody.model as string;
  const stream = chatBody.stream === true;
  // Best-effort Grok attribution: the managed fence stamps this header on every model
  // it registers (extra_headers, sent verbatim by upstream Grok). Dashboard usage
  // bucketing only — never an auth or billing signal.
  if (req.headers.get("x-opencodex-grok") === "1") logCtx.surface = "grok";
  let directRoute = false;
  let settledRoute: ReturnType<typeof routeModel> | null = null;
  let chatNativeRoute: ReturnType<typeof routeModel> | null = null;
  try {
    const route = routeModel(config, requestedModel, evidenceFromBody(chatBody));
    // Settle the wire once so every branch below reads the adapter this model will
    // actually use, not the provider-wide default (#404).
    route.provider = resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, "chat");
    logCtx.model = route.modelId;
    logCtx.providerAdapter = route.provider.adapter;
    logCtx.requestedModel = requestedModel;
    logCtx.provider = route.providerName;
    logCtx.routeDecision = route.routeDecision;
    settledRoute = route;
    if (route.provider.adapter === "openai-responses") {
      directRoute = route.codexAccountMode === "direct";
    }
    if (route.provider.adapter === "cursor" || route.provider.adapter === "kiro") {
      const parts: string[] = [];
      if (chatBody.messages !== undefined) parts.push(JSON.stringify(chatBody.messages));
      if (chatBody.tools !== undefined) parts.push(JSON.stringify(chatBody.tools));
      logCtx.usageLogInputTokens = Math.max(1, estimateTokens(parts.join("\n"), requestedModel));
    }
    if (isNativeChatRouteEligible(route, chatBody)) chatNativeRoute = route;
  } catch (err) {
    if (err instanceof NoEligiblePolicyCandidateError) {
      logCtx.routeDecision = err.trace;
      if (logIds) addFinalRequestLog(logIds.requestId, logIds.start, logCtx, 404, { closeReason: "non_stream" });
      return chatCompletionsErrorResponse(404, err.message, "invalid_request_error");
    }
    /* unknown model: let handleResponses shape the 404 */
  }

  if (chatNativeRoute) {
    return handleNativeChatCompletions({
      req,
      config,
      logCtx,
      ...(logIds ? { logIds } : {}),
      route: chatNativeRoute,
      chatBody,
      requestedModel,
      requestedStream: stream,
      translatorBudget,
    });
  }

  let internalBody: Rec;
  try {
    // Validate the full Chat boundary after routing. Native Chat keeps `chatBody` as
    // its wire source; this Responses projection is used only by the fallback path.
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

  // Routed adapters only support streamed turns; always stream internally and fold
  // for non-streaming clients. Native Chat uses the caller's original stream bit.
  internalBody.stream = true;
  if (settledRoute?.provider.adapter === "openai-responses") {
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
  if (settledRoute && internalBody.reasoning !== undefined) {
    const { stripEmptyLadderEffort, supportedLadderFor } = await import("./effort-policy");
    const ladder = supportedLadderFor({ provider: settledRoute.provider, modelId: settledRoute.modelId });
    const next = stripEmptyLadderEffort(internalBody.reasoning, ladder);
    if (next === undefined) delete internalBody.reasoning;
    else internalBody.reasoning = next;
  }

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
    // #1686: the Chat surface translates its body and replays here, so the admission fact has
    // to ride along or a bearer-admitted Chat caller would still be refused by Direct.
    ...(logIds?.admission ? { admission: logIds.admission } : {}),
    abortSignal: req.signal,
    // Body is Responses-shaped by now, but the client spoke Chat Completions.
    inboundWire: "chat",
    // Terminal vision-describe marker (roadmap 180): the bridge rebuilds
    // headers from the FORWARD_HEADERS allowlist, which would drop the raw
    // header — so the fact is detected here and carried as an option flag.
    ...(req.headers.get("x-opencodex-vision-describe") === "1" ? { visionDescribeTerminal: true } : {}),
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
    if (stream) {
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
  if (!stream) {
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
