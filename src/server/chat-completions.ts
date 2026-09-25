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
} from "../chat/inbound";
import { chatToResponsesBody } from "../protocols/codecs/chat";
import { normalizeChatImageParts } from "../chat/image-parts";
import {
  chatCompletionsErrorResponse,
  collectChatCompletion,
  isChatCompletionsStreamError,
  responsesJsonToChatCompletion,
  responsesSseToChatCompletionsSse,
} from "../chat/outbound";
import { classifyError, cyberPolicyErrorType, CYBER_POLICY_ERROR_CODE, isCyberPolicyCode } from "../lib/errors";
import { redactSecretString } from "../lib/redact";
import { resolveClientRetryAfter } from "../lib/retry-after";
import {
  applyReplayRefusalClientHeaders,
  isReplayRefusalCode,
  isReplayRefusalResponse,
  REPLAY_REFUSAL_CLIENT_HEADERS,
  REPLAY_REFUSED_STATUS,
  retainReplayRefusal,
  UPSTREAM_RESET_REPLAY_REFUSED_CODE,
} from "../lib/upstream-retry";
import { estimateTokens } from "../lib/token-estimate";
import { captureRouteStaticPolicy, NoEligiblePolicyCandidateError, UnknownRoutingPolicyError, routeModel } from "../router";
import { evidenceFromBody } from "../routing/request-evidence";
import { resolveWireProtocolOverride } from "./adapter-resolve";
import { resolveOpenCodeGoTransport } from "../providers/opencode-go-transport";
import {
  getOrAllocateRequestSessionLane,
  linkRequestSessionLane,
} from "./request-log-conversation";
import type { OcxConfig } from "../types";
import { readJsonRequestBody, resolveInboundBodyLimitBytes } from "./request-decompress";
import {
  addFinalRequestLog,
  httpStatusForRequestLogTerminal,
  recordFirstOutput,
  type RequestLogContext,
} from "./request-log";
import { createFinalRequestLog } from "./inference/final-log";
import { clientWireLogOf, clientWireOf } from "./inference/client-wire";
import { directEncodersApply } from "./inference/client-encoder-delivery";
import { responseWithDeferredRequestLog } from "./relay";
import { handleResponses } from "./responses";
import { providerConsumesCallerAuthorization } from "../providers/caller-authorization";
import { captureExplicitOpenAiCallerAuth } from "../providers/openai-sidecar";
import { captureCallerDirectAuth } from "../providers/caller-authorization";
import type { AdmissionLease } from "../lib/admission";
import {
  admissionModelDeniedResponse,
  AdmissionModelDeniedError,
  assertRouteAllowedByScope,
  resolveAdmissionModelScope,
} from "./admission-model-scope";
import type { DataPlaneAdmission } from "./auth-cors";
import { tryClaimNativeMainProfileForTurn } from "../codex/native-main-admission";
import {
  createTranslatorBudget,
  finalizeTranslatorBudgetResponse,
  isTranslatorBudgetExceededError,
  type TranslatorBudget,
} from "../lib/translator-budget";
import { createNativeChatComboSource, handleNativeChatCompletions, nativeChatDeclineReason } from "./chat-native";
import { upstreamWireForAdapter, type ProtocolReasonCode } from "../protocols/contract";
import { createProtocolEnvelope } from "../protocols/envelope";
import { featuresFromChatBody } from "../protocols/features";
import { checkRepresentable, unrepresentableMessage } from "../protocols/guard";
import { requestPathForLane } from "../protocols/path";
import { resolveProtocolSettings } from "../protocols/settings";
import { markProtocolBlocked, markProtocolEntry } from "../protocols/trace";
import { recordProtocolShadowPlan } from "../protocols/shadow-plan";
import { jsonCompletionSse } from "./chat-native-sse";
import { parseRequestEffortRowId } from "./effort-row";
import { parseSyntheticRowId } from "./fast-row";
import { isCanonicalOpenAiForwardProvider } from "../providers/openai-tiers";
import { CODEX_RESERVE_HELPER_UNSUPPORTED_MESSAGE, isCodexReserveHelperUnsupported } from "../codex/loopback-target";

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
async function readChatBody(req: Request, budget: TranslatorBudget, maxBytes: number): Promise<unknown> {
  try {
    return await readJsonRequestBody(req, budget, maxBytes);
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
    if (isTranslatorBudgetExceededError(error)) {
      if (logIds) addFinalRequestLog(logIds.requestId, logIds.start, logCtx, 502, { closeReason: "non_stream" });
      return chatCompletionsErrorResponse(502, "upstream translation buffer exceeded the safe limit", "upstream_error", "translation_buffer_limit");
    }
    if (isChatCompletionsStreamError(error)) {
      if (logIds) addFinalRequestLog(logIds.requestId, logIds.start, logCtx, error.status, { closeReason: "non_stream" });
      return chatCompletionsErrorResponse(error.status, error.message, error.type, error.code);
    }
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
    const rawBody = await readChatBody(req, translatorBudget, resolveInboundBodyLimitBytes(config.maxInboundBodyBytes));
    assertChatCompletionsRoutingBody(rawBody);
    // Normalize foreign image shapes BEFORE routing. isNativeChatRouteEligible below
    // decides the pipeline from the image parts it can see, and the native path then
    // forwards this body as-is, so both must observe the same parts. A body with no
    // foreign image part is returned by reference and stays byte-identical.
    chatBody = normalizeChatImageParts(rawBody);
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
  const { fastRow, effortRow } = parseSyntheticRowId(requestedModel, config);
  if (effortRow) chatBody.model = effortRow.baseId;
  if (fastRow) {
    chatBody.model = fastRow.baseId;
    // A caller intent; decideTier rules on it downstream. Unlike an effort row this does NOT
    // block the native-chat shortcut below: native chat carries service_tier itself and runs
    // the same policy, so blocking it would degrade the request for no reason.
    chatBody.service_tier = "priority";
  }
  const stream = chatBody.stream === true;
  // Best-effort Grok attribution: the managed fence stamps this header on every model
  // it registers (extra_headers, sent verbatim by upstream Grok). Dashboard usage
  // bucketing only — never an auth or billing signal.
  if (req.headers.get("x-opencodex-grok") === "1") logCtx.surface = "grok";
  let callerAuthorizationRoute = false;
  let routeMayChangeCredentialDomain = false;
  let settledRoute: ReturnType<typeof routeModel> | null = null;
  let chatNativeRoute: ReturnType<typeof routeModel> | null = null;
  // Why the native Chat lane was not taken; stays `unknown-model` when routing threw.
  let nativeDecline: ProtocolReasonCode | undefined = "unknown-model";
  try {
    const route = routeModel(config, chatBody.model as string, evidenceFromBody(chatBody));
    // The native Chat lane sends without re-entering the Responses path, so it
    // has to apply the key's scope itself. Translated traffic is checked where
    // every rewrite converges instead.
    assertRouteAllowedByScope(resolveAdmissionModelScope(config, logIds?.admission), requestedModel, route);
    // Preserve the routed destination for Go recognition, then settle the wire before
    // deriving protocol-scoped affinity. Recognition must not inspect the flipped adapter.
    const routedProvider = route.provider;
    route.staticPolicy = captureRouteStaticPolicy(
      route.providerName, route.modelId, routedProvider, route.staticPolicy.effectiveAlias, "chat",
    );
    const wireProvider = resolveWireProtocolOverride(route.providerName, route.modelId, routedProvider, "chat", route.staticPolicy);
    route.provider = resolveOpenCodeGoTransport(
      wireProvider,
      getOrAllocateRequestSessionLane(req),
      routedProvider,
    );
    logCtx.model = route.modelId;
    logCtx.providerAdapter = route.provider.adapter;
    logCtx.requestedModel = requestedModel;
    if (route.routeReason === "model-alias" || route.modelId !== requestedModel && requestedModel.includes("/")) logCtx.requestedAlias = requestedModel;
    logCtx.provider = route.providerName;
    logCtx.routeDecision = route.routeDecision;
    settledRoute = route;
    routeMayChangeCredentialDomain = route.combo !== undefined || route.routeKind === "policy";
    callerAuthorizationRoute = !routeMayChangeCredentialDomain
      && providerConsumesCallerAuthorization(route.provider);
    if (route.provider.adapter === "cursor" || route.provider.adapter === "kiro") {
      const parts: string[] = [];
      if (chatBody.messages !== undefined) parts.push(JSON.stringify(chatBody.messages));
      if (chatBody.tools !== undefined) parts.push(JSON.stringify(chatBody.tools));
      logCtx.usageLogInputTokens = Math.max(1, estimateTokens(parts.join("\n"), requestedModel));
    }
    // Combos must enter the Responses routing path so child selection, forced default
    // effort, failover, and per-attempt telemetry run before any native Chat send.
    nativeDecline = route.combo ? "combo-or-policy-route"
      : effortRow ? "effort-row"
      : nativeChatDeclineReason(route, chatBody, config);
    if (nativeDecline === undefined) {
      chatNativeRoute = route;
      // Reserve an input estimate for spend without recording it as usage: native Chat attempts
      // keep the provider-reported counts, as they did before the reservation existed.
      if (logCtx.usageLogInputTokens === undefined) {
        const parts = [JSON.stringify(chatBody.messages ?? [])];
        if (chatBody.tools !== undefined) parts.push(JSON.stringify(chatBody.tools));
        logCtx.spendInputEstimateTokens = Math.max(1, estimateTokens(parts.join("\n"), requestedModel));
      }
      const outputCeiling = chatBody.max_completion_tokens ?? chatBody.max_tokens;
      if (typeof outputCeiling === "number" && outputCeiling > 0) {
        logCtx.spendOutputCeilingTokens = Math.trunc(outputCeiling);
      }
    }
  } catch (err) {
    if (err instanceof AdmissionModelDeniedError) {
      logCtx.requestedModel = requestedModel;
      if (logIds) addFinalRequestLog(logIds.requestId, logIds.start, logCtx, 403, { closeReason: "non_stream" });
      return admissionModelDeniedResponse(err);
    }
    if (err instanceof UnknownRoutingPolicyError) {
      logCtx.requestedModel = requestedModel;
      if (logIds) addFinalRequestLog(logIds.requestId, logIds.start, logCtx, 404, { closeReason: "non_stream" });
      return chatCompletionsErrorResponse(404, err.message, "invalid_request_error");
    }
    if (err instanceof NoEligiblePolicyCandidateError) {
      logCtx.routeDecision = err.trace;
      if (logIds) addFinalRequestLog(logIds.requestId, logIds.start, logCtx, 404, { closeReason: "non_stream" });
      return chatCompletionsErrorResponse(404, err.message, "invalid_request_error");
    }
    /* unknown model: let handleResponses shape the 404 */
  }

  // Off by default: under the legacy policy with `nativeChatCombos` off nothing below is built
  // and the request is unchanged. An effort row keeps its effort on the Responses body only, so
  // its combo stays on the bridge.
  const protocolSettings = resolveProtocolSettings(config);
  const nativeChatCombos = protocolSettings.rollout.nativeChatCombos
    && settledRoute?.combo !== undefined && !effortRow;
  const envelope = protocolSettings.unrepresentable === "reject" || nativeChatCombos
    ? createProtocolEnvelope({ inbound: "chat", body: chatBody, translatorBudget })
    : undefined;
  // Combo and policy children are judged per candidate (PF-07); an unknown model has no route.
  if (envelope && settledRoute && !settledRoute.combo && settledRoute.routeKind !== "policy") {
    const verdict = checkRepresentable({
      inbound: "chat",
      requestPath: chatNativeRoute
        ? requestPathForLane("chat", "native", "chat")
        : requestPathForLane("chat", "bridge", upstreamWireForAdapter(settledRoute.provider.adapter)),
      features: envelope.features(),
      policy: "reject",
    });
    if (!verdict.ok) {
      markProtocolBlocked(logCtx, { inbound: "chat", reasonCodes: verdict.reasonCodes, features: verdict.features });
      logCtx.errorCode = "unsupported_feature";
      if (logIds) addFinalRequestLog(logIds.requestId, logIds.start, logCtx, 400, { closeReason: "non_stream" });
      return chatCompletionsErrorResponse(400, unrepresentableMessage(verdict.features), "invalid_request_error", "unsupported_feature");
    }
  }
  markProtocolEntry(logCtx, {
    inbound: "chat",
    lane: chatNativeRoute ? "native" : "bridge",
    reasonCodes: !chatNativeRoute && nativeDecline ? [nativeDecline] : [],
    features: envelope ? () => envelope.features() : () => featuresFromChatBody(chatBody),
  });
  recordProtocolShadowPlan(logCtx, config, { inbound: "chat", model: requestedModel });
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
    internalBody = chatToResponsesBody(chatBody);
    if (effortRow) {
      internalBody.reasoning = {
        ...(isRec(internalBody.reasoning) ? internalBody.reasoning : {}),
        effort: effortRow.effort,
      };
    }
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
    // The proxy never wants upstream-side retention for a translated Chat turn, so
    // store stays pinned for every Responses route.
    //
    // The sampling and output-cap restrictions used to be applied here too, keyed on
    // the adapter string. That was wrong twice over. Seven providers share this
    // adapter (openai, openai-apikey, meta-model, meta-muse, zai,
    // zhipu-bigmodel-responses, volcengine-agent-plan), so a generic key gateway lost
    // controls it accepts. And settledRoute is the route settled at INGRESS: a combo
    // or policy route resolves its concrete child later in the Responses pipeline, so
    // deciding here mutates shared intent before the real target is known — a
    // canonical-first combo that falls back to a key gateway had already lost the
    // caller's controls, while a non-canonical-first combo that falls back to
    // canonical still shipped them.
    //
    // Canonical-backend sanitization now happens at the final outgoing body in
    // src/adapters/openai-responses.ts, where the concrete provider is known.
    internalBody.store = false;
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

  const visionDescribeTerminal = req.headers.get("x-opencodex-vision-describe") === "1";
  // Concrete helper targets must fail before optional stored-main credential enrichment.
  // Unresolved combos are checked after their concrete child route is selected in Responses.
  if (settledRoute && !settledRoute.combo && isCanonicalOpenAiForwardProvider(settledRoute.provider)
    && isCodexReserveHelperUnsupported(config, settledRoute.modelId, logIds?.admission, visionDescribeTerminal)) {
    return chatCompletionsErrorResponse(400, CODEX_RESERVE_HELPER_UNSUPPORTED_MESSAGE, "invalid_request_error");
  }
  const nativeCallerAuth = captureExplicitOpenAiCallerAuth(req.headers, config);
  // Caller-owned only: stored-main enrichment below is sidecar authority, never Direct authority.
  const callerDirectAuth = captureCallerDirectAuth(req.headers, config);
  let openAiSidecarAuth = nativeCallerAuth;
  const headers = new Headers({ "content-type": "application/json" });
  // Internal bridge metadata; the Go resolver scopes and hashes it before upstream use.
  const openCodeSession = req.headers.get("x-opencode-session");
  if (openCodeSession) headers.set("x-opencode-session", openCodeSession);
  for (const name of FORWARD_HEADERS) {
    if (routeMayChangeCredentialDomain && (name === "authorization" || name === "chatgpt-account-id")) continue;
    if (name === "authorization" && !callerAuthorizationRoute) continue;
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  // Existing primary enrichment stays on non-caller-auth routes. Caller-auth routes defer
  // optional stored sidecar auth until the final helper plan actually needs it.
  if (!callerAuthorizationRoute) {
    // This enrichment is optional for routed/non-main providers. If native main
    // is fenced, omit it and let auth-context reject only a final physical-main
    // selection while healthy pool/provider routes continue.
    const isCanonicalPool = settledRoute && isCanonicalOpenAiForwardProvider(settledRoute.provider)
      && settledRoute.codexAccountMode === "pool";
    if (!isCanonicalPool && tryClaimNativeMainProfileForTurn(logIds?.turnAdmissionLease)) {
      try {
        const { getMainAccountToken } = await import("../codex/main-account");
        const token = getMainAccountToken();
        if (token) {
          const mainHeaders = new Headers({ authorization: `Bearer ${token.accessToken}`, "chatgpt-account-id": token.chatgptAccountId });
          openAiSidecarAuth ??= captureExplicitOpenAiCallerAuth(mainHeaders, config);
          if (!callerAuthorizationRoute && !routeMayChangeCredentialDomain) {
            headers.set("authorization", `Bearer ${token.accessToken}`);
            headers.set("chatgpt-account-id", token.chatgptAccountId);
          }
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
      Buffer.byteLength(internalBodyJson, "utf8"),
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
  linkRequestSessionLane(req, internalReq);

  const finalizeNativeLog = createFinalRequestLog(logIds, logCtx).finish;
  const upstream = await handleResponses(internalReq, config, logCtx, {
    openAiSidecarAuth,
    allowStoredOpenAiSidecarAuth: !!(callerAuthorizationRoute && settledRoute
      && !isCanonicalOpenAiForwardProvider(settledRoute.provider)),
    nativeCallerAuth,
    callerDirectAuth,
    ...(logIds?.turnAdmissionLease ? { turnAdmissionLease: logIds.turnAdmissionLease } : {}),
    // #1686: the Chat surface translates its body and replays here, so the admission fact has
    // to ride along or a bearer-admitted Chat caller would still be refused by Direct.
    ...(logIds?.admission ? { admission: logIds.admission } : {}),
    abortSignal: req.signal,
    // Body is Responses-shaped by now, but the client spoke Chat Completions.
    inboundWire: "chat",
    // PF-07: the combo sends eligible candidates natively from this envelope.
    ...(envelope && nativeChatCombos ? {
      protocolSource: createNativeChatComboSource({
        req, config, envelope, requestedModel, requestedStream: stream, translatorBudget,
      }),
    } : {}),
    // Terminal vision-describe marker (roadmap 180): the bridge rebuilds
    // headers from the FORWARD_HEADERS allowlist, which would drop the raw
    // header — so the fact is detected here and carried as an option flag.
    ...(visionDescribeTerminal ? { visionDescribeTerminal: true } : {}),
    translatorBudget,
    ...(logIds ? { onFirstOutput: () => recordFirstOutput(logCtx, logIds.start) } : {}),
    onNativePassthroughTerminal: status => finalizeNativeLog(httpStatusForRequestLogTerminal(status, logCtx), { terminalStatus: status, closeReason: "terminal" }),
    onNativePassthroughCancel: () => finalizeNativeLog(499, { closeReason: "client_cancel" }),
    ...(directEncodersApply(config, settledRoute)
      ? { clientEncoder: { protocol: "chat" as const, stream, model: requestedModel } }
      : {}),
  });
  // Already in the Chat wire: no conversion. A direct-encoder body (PF-09) reports its own log
  // facts to the deferred request log. A native combo child (PF-07) carries none: its row is
  // written by the terminal callbacks above, and the deferred log's Responses-shaped inspector
  // would misread a Chat stream, so of those only a refusal is wrapped.
  if (clientWireOf(upstream) === "chat") {
    if (!logIds || (upstream.ok && !clientWireLogOf(upstream))) return upstream;
    return responseWithDeferredRequestLog(upstream, logIds.requestId, logIds.start, logCtx);
  }

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
          type?: string;
          code?: string | null;
        };
        const nested = typeof parsed?.error === "object" && parsed.error ? parsed.error : undefined;
        const flat = typeof parsed?.error === "string" ? parsed.error : parsed?.message;
        const rawFallback = text
          ? `upstream error (${upstream.status}): ${redactSecretString(text).slice(0, 400)}`
          : message;
        const upstreamMessage = nested?.message || flat;
        message = upstreamMessage
          ? redactSecretString(upstreamMessage).slice(0, 500)
          : rawFallback;
        const structuredType = nested?.type ?? parsed.type;
        const structuredCode = nested?.code ?? parsed.code;
        if (typeof structuredType === "string") upstreamType = structuredType;
        if (structuredCode === null || typeof structuredCode === "string") upstreamCode = structuredCode;
      } catch {
        if (text) message = `upstream error (${upstream.status}): ${redactSecretString(text).slice(0, 400)}`;
      }
    } catch { /* keep fallback */ }
    const classified = classifyError(
      upstream.status,
      upstreamType
        ?? (upstream.status === 401 ? "authentication_error"
          : upstream.status === 429 ? "rate_limit_error"
          : upstream.status >= 500 ? "server_error"
          : "invalid_request_error"),
      message,
    );
    // The same verdict the native Chat surface reads, from the same two places: the response
    // this wrapper still holds, and the code a body kept through an intermediate formatter.
    // Not the status -- a refusal and a real rate limit are both 429, which is the whole
    // reason this surface used to report one as the other.
    const replayRefusal = isReplayRefusalResponse(upstream) || isReplayRefusalCode(upstreamCode);
    if (isCyberPolicyCode(upstreamCode) || classified.code === CYBER_POLICY_ERROR_CODE) {
      classified.code = CYBER_POLICY_ERROR_CODE;
      classified.type = cyberPolicyErrorType(upstreamType);
    } else if (replayRefusal) {
      // 429 classifies as a rate limit, which already carries a code, so the empty-code branch
      // below could never restore this one -- the translated client was told the provider
      // throttled the turn, and handed a two-second wait to send it again.
      classified.code = UPSTREAM_RESET_REPLAY_REFUSED_CODE;
    } else if (upstreamCode === "model_not_found") {
      // Structured model_not_found must win over classifyError's generic remaps.
      classified.code = "model_not_found";
      classified.type = "invalid_request_error";
    } else if (upstreamCode !== undefined && upstreamCode !== null && classified.code == null) {
      classified.code = upstreamCode;
    }
    const status = isCyberPolicyCode(classified.code) ? 400
      : replayRefusal ? REPLAY_REFUSED_STATUS
      : upstream.status;
    const retryAfter = isCyberPolicyCode(classified.code) || replayRefusal
      ? undefined
      : resolveClientRetryAfter({
        status: upstream.status,
        message,
        upstreamRetryAfter: upstream.headers.get("retry-after"),
      });
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
        ...(replayRefusal ? REPLAY_REFUSAL_CLIENT_HEADERS : {}),
      },
    });
    if (replayRefusal) retainReplayRefusal(rewritten);
    return logIds
      // Deferred logging re-wraps this response and carries the verdict with it.
      ? responseWithDeferredRequestLog(rewritten, logIds.requestId, logIds.start, logCtx)
      : rewritten;
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  // JSON is not complete for the client until its Chat projection succeeds.
  // Logging the upstream JSON body here would persist 200 before a later
  // conversion/serialization error, double-counting both the request and usage.
  const response = logIds && contentType.includes("text/event-stream")
    ? responseWithDeferredRequestLog(upstream, logIds.requestId, logIds.start, logCtx)
    : upstream;

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
  const finishJson = (result: Response): Response => {
    finalizeNativeLog(result.status, { closeReason: "non_stream" });
    return result;
  };
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return finishJson(chatCompletionsErrorResponse(502, "internal replay returned a non-JSON response", "server_error"));
  }
  const status = (json as Rec)?.status;
  if (status === "failed") {
    const error = (json as { error?: { message?: string; type?: string; code?: string | null } }).error;
    const message = redactSecretString(error?.message ?? "upstream request failed");
    const classified = classifyError(502, error?.type ?? "server_error", message);
    if (error?.code === "translation_buffer_limit") {
      classified.code = "translation_buffer_limit";
      classified.type = "upstream_error";
    } else if (isCyberPolicyCode(error?.code) || classified.code === CYBER_POLICY_ERROR_CODE) {
      classified.code = CYBER_POLICY_ERROR_CODE;
      classified.type = cyberPolicyErrorType(error?.type);
    } else if (isReplayRefusalCode(error?.code)) {
      // The refusal can also arrive as a failed Responses envelope rather than a non-2xx.
      // Reporting that as the 502 below would invite the four resends the refusal prevents.
      classified.code = UPSTREAM_RESET_REPLAY_REFUSED_CODE;
    } else if (error?.code === "model_not_found") {
      // Same deliberate preserve as the non-OK path: structured code beats generic classify.
      classified.code = "model_not_found";
      classified.type = "invalid_request_error";
    }
    if (isReplayRefusalCode(classified.code)) {
      const refusal = chatCompletionsErrorResponse(
        REPLAY_REFUSED_STATUS, message, classified.type, classified.code,
      );
      const headers = new Headers(refusal.headers);
      applyReplayRefusalClientHeaders(headers);
      return finishJson(retainReplayRefusal(
        new Response(refusal.body, { status: refusal.status, headers }),
      ));
    }
    return finishJson(chatCompletionsErrorResponse(
      classified.code === "translation_buffer_limit"
        ? 502
        : isCyberPolicyCode(classified.code) ? 400 : 502,
      message,
      classified.type,
      classified.code,
    ));
  }
  const completion = responsesJsonToChatCompletion(json, requestedModel, translatorBudget);
  const body = stream
    ? jsonCompletionSse(completion, requestedModel, translatorBudget)
    : JSON.stringify(completion);
  if (!stream) translatorBudget.chargeRetained(Buffer.byteLength(body) * 2, { kind: "live_transient" });
  return finishJson(new Response(body, {
    status: 200,
    headers: stream
      ? { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" }
      : { "Content-Type": "application/json" },
  }));
}
