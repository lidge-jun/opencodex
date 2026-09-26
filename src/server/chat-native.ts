import { buildOpenAIChatPassthroughRequest, createOpenAIChatAdapter } from "../adapters/openai-chat";
import { transformProviderRequest } from "../adapters/provider-compatibility";
import type { AdapterRequest, ProviderAdapter } from "../adapters/base";
import { isNativeChatRouteEligible } from "./chat-native-eligibility";
import {
  chatCompletionsErrorBody,
  chatCompletionsErrorResponse,
  collectChatCompletion,
  isChatCompletionsStreamError,
} from "../chat/outbound";
import { applyChatEffortCap, chatCollabSurface, effortCapAppliesTo, resolvePinnedEffort, supportedLadderFor } from "./effort-policy";
import { mapReasoningEffort } from "../reasoning-effort";
import {
  classifyError,
  cyberPolicyErrorType,
  CYBER_POLICY_ERROR_CODE,
  isCyberPolicyCode,
  isCyberPolicyMessage,
  SEND_BUDGET_EXHAUSTED_CODE,
} from "../lib/errors";
import type { RequestExecutionBudget } from "../lib/request-execution-budget";
import type { AdmissionLease } from "../lib/admission";
import { readBoundedResponseBody } from "../lib/bounded-body";
import { redactSecretString } from "../lib/redact";
import { resolveClientRetryAfter } from "../lib/retry-after";
import {
  applyUpstreamRecoveryInit,
  fetchWithResetRetry,
  fetchWithTransientRetry,
  isNonReplayableResponse,
  isReplayRefusalCode,
  isReplayRefusalResponse,
  prepareSameTarget429Wait,
  REPLAY_REFUSAL_CLIENT_HEADERS,
  REPLAY_REFUSED_STATUS,
  retainReplayRefusal,
  SendBudgetExhaustedError,
  TRANSIENT_RETRY_MAX_ATTEMPTS,
  UpstreamRetryEvidenceError,
  type UpstreamSendRecovery,
  UPSTREAM_RESET_REPLAY_REFUSED_CODE,
  wrapWithZeroOutputRefetch,
} from "../lib/upstream-retry";
import {
  isTranslatorBudgetExceededError,
  type TranslatorBudget,
} from "../lib/translator-budget";
import { authorizeResendForRecovery } from "../lib/request-resend-gate";
import { ambiguousResendAllowanceFor, selfContainedChatBody } from "./responses/reset-replay";
import {
  hasKeyPoolFailover,
  selectProactiveApiKeyTransport,
  rateLimitRetryDelayMs,
  rateLimitRetryPolicyFor,
  rotateProviderTransportOn429,
  transientRetryPolicyFor,
} from "../providers/key-failover";
import { fastPolicyForModel } from "../providers/service-tier";
import { stampApiKeyAccountLabel } from "../providers/label";
import { providerApiKeySelectionIsCurrent, resolveCurrentProviderApiKeyTransport } from "../providers/api-key-selection";
import { enrichOpenCodeZenFreeTierMessage } from "../providers/opencode-zen-rate-limit";
import type { OcxProviderTransport } from "../providers/xai-transport";
import type { RouteResult } from "../router";
import type { OcxConfig, OcxProviderConfig } from "../types";
import { fetchWithHeaderTimeout, providerFetch, safeHostLabel, sendWithConnectionPolicy } from "./responses/fetch-helpers";
import { isLocalUpstream } from "../lib/local-upstream";
import { linkAbortSignal } from "./responses";
import {
  noteProviderAttemptSend,
  recordKeyAttemptFailure,
  recordKeyWireAttemptUsage,
  recordFirstOutput,
  recordAttemptCredentialSource,
  type RequestLogContext,
} from "./request-log";
import { jsonCompletionSse, nativeChatSse, structuredError, usageFromChat } from "./chat-native-sse";
import { beginInferenceAttempt, type InferenceAttempt } from "./inference/attempt";
import { createFinalRequestLog } from "./inference/final-log";
import { getOrAllocateRequestSessionLane } from "./request-log-conversation";
import { registerTurn, unregisterTurn } from "./lifecycle";
import { attachRequestSpendTracker } from "./responses/request-spend";
import { workflowRefusalResponse } from "./workflow-refusal";
import type { ComboProtocolSource } from "./responses/core-combo-native";
import type { ProtocolEnvelope } from "../protocols/envelope";

export { isNativeChatRouteEligible, nativeChatDeclineReason } from "./chat-native-eligibility";

type Rec = Record<string, unknown>;

const MAX_NATIVE_CHAT_JSON_BYTES = 32 * 1024 * 1024;
const MAX_NATIVE_CHAT_ERROR_BYTES = 64 * 1024;

class NativeChatSpendRefusal extends Error {}

const chatEffortSnapshots = new WeakMap<Rec, {
  inputModel: string;
  providerName: string;
  modelId: string;
  present: boolean;
  value: unknown;
  annotation: string | undefined;
}>();

function normalizePinnedChatEffort(options: HandleNativeChatOptions): void {
  const { chatBody, route, config, req, logCtx, requestedModel } = options;
  let snapshot = chatEffortSnapshots.get(chatBody);
  const inputModel = typeof chatBody.model === "string" ? chatBody.model : requestedModel;
  let selector = inputModel;
  if (snapshot) {
    if (snapshot.providerName === route.providerName && snapshot.modelId === route.modelId) {
      logCtx.requestedEffort = snapshot.annotation;
      return;
    }
    if (snapshot.present) chatBody.reasoning_effort = snapshot.value;
    else delete chatBody.reasoning_effort;
    if (selector === snapshot.inputModel || selector === snapshot.modelId) {
      selector = `${route.providerName}/${route.modelId}`;
    }
  } else {
    snapshot = {
      inputModel,
      providerName: route.providerName,
      modelId: route.modelId,
      present: Object.hasOwn(chatBody, "reasoning_effort"),
      value: chatBody.reasoning_effort,
      annotation: undefined,
    };
    chatEffortSnapshots.set(chatBody, snapshot);
  }
  snapshot.inputModel = inputModel;
  snapshot.providerName = route.providerName;
  snapshot.modelId = route.modelId;
  const from = typeof chatBody.reasoning_effort === "string" ? chatBody.reasoning_effort : undefined;
  logCtx.requestedEffort = from;
  // Compaction is normally excluded by native-route eligibility; preserve that boundary here too.
  const compaction = chatBody.compaction_trigger !== undefined;
  const pinned = !compaction
    ? resolvePinnedEffort(route, selector, config)
    : undefined;
  let normalizeForWire = false;
  if (pinned !== undefined) {
    logCtx.requestedEffort = from ? `${from}->${pinned}` : pinned;
    if (pinned === "none") delete chatBody.reasoning_effort;
    else chatBody.reasoning_effort = pinned;
    normalizeForWire = true;
  }
  // A qualifying turn's ceiling is independent of whether an operator pin resolved.
  if (effortCapAppliesTo(chatCollabSurface(chatBody), req.headers, config, compaction)) {
    const capped = applyChatEffortCap(chatBody, req.headers, config, supportedLadderFor(route));
    if (capped) {
      logCtx.requestedEffort = `${logCtx.requestedEffort ?? capped.from}->${capped.to}`;
      normalizeForWire = true;
    }
  }
  // Normalize operator-pinned values and cap rewrites; otherwise preserve caller spelling.
  if (normalizeForWire) {
    const effort = typeof chatBody.reasoning_effort === "string" ? chatBody.reasoning_effort : undefined;
    const wireEffort = mapReasoningEffort(route.provider, route.modelId, effort);
    if (wireEffort === undefined) delete chatBody.reasoning_effort;
    else chatBody.reasoning_effort = wireEffort;
  }
  snapshot.annotation = logCtx.requestedEffort;
}

function isRec(value: unknown): value is Rec {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function chatCompletionJson(value: unknown): Rec | null {
  if (!isRec(value) || !Array.isArray(value.choices) || value.choices.length === 0) return null;
  return value;
}

export interface HandleNativeChatOptions {
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

/** Records the outcome on whichever final row owns this attempt; the first call wins. */
export type NativeChatFinishLog = (
  status: number,
  message?: string,
  closeReason?: "non_stream" | "terminal" | "client_cancel",
) => void;

export interface NativeChatExecution extends HandleNativeChatOptions {
  finishLog: NativeChatFinishLog;
  /**
   * A combo child's per-target budget (PF-07). With it the attempt opens no spend tracker of its
   * own: the combo's hop reservation already booked the first send on the request's shared
   * counter, and every later physical send is reported to that counter, whose observer is the
   * request's one spend tracker. A second tracker would book each send twice and, merged into
   * the parent row, replace the one the final log settles.
   */
  sendBudget?: RequestExecutionBudget;
  /** Replaces the request-relative first-output mark; a combo child records its own. */
  onFirstOutput?: () => void;
  /** The lease a streamed body holds; defaults to `logIds.turnAdmissionLease`. */
  turnAdmissionLease?: AdmissionLease;
}

/**
 * The native Chat ingress: opens the attempt on the request's log context and owns the
 * request's final log row, then runs the attempt.
 */
export async function handleNativeChatCompletions(options: HandleNativeChatOptions): Promise<Response> {
  const { logCtx, logIds, route } = options;
  logCtx.inboundProtocol = "chat";
  const attemptHandle = beginInferenceAttempt(logCtx, {
    provider: route.providerName,
    model: route.modelId,
    adapter: "openai-chat",
  });
  attemptHandle.seal(logCtx.accountLogLabel);

  const finalLog = createFinalRequestLog(logIds, logCtx);
  const finishLog: NativeChatFinishLog = (status, message, closeReason = "non_stream") => {
    if (finalLog.finished()) return;
    // The failure text lands on the context before the row is written, and only once.
    if (message) logCtx.upstreamError = redactSecretString(message).slice(0, 500);
    finalLog.finish(status, { closeReason });
  };
  return runNativeChatAttempt({ ...options, finishLog }, attemptHandle);
}

/**
 * The Chat source a combo hands its native children (PF-07). A child runs on the attempt the
 * combo opened and reports through the combo's callbacks, so the final row stays the parent's.
 */
export function createNativeChatComboSource(input: {
  req: Request;
  config: OcxConfig;
  envelope: ProtocolEnvelope;
  requestedModel: string;
  requestedStream: boolean;
  translatorBudget: TranslatorBudget;
}): ComboProtocolSource {
  return {
    inbound: "chat",
    envelope: input.envelope,
    dispatchNativeChild: child => runNativeChatAttempt({
      req: input.req,
      config: input.config,
      logCtx: child.childLog,
      route: child.route,
      chatBody: child.body,
      requestedModel: input.requestedModel,
      requestedStream: input.requestedStream,
      translatorBudget: input.translatorBudget,
      finishLog: child.finishLog,
      sendBudget: child.sendBudget,
      onFirstOutput: child.onFirstOutput,
      ...(child.turnAdmissionLease ? { turnAdmissionLease: child.turnAdmissionLease } : {}),
    }, child.attemptHandle),
  };
}

/**
 * One native Chat attempt on an already-open attempt row: effort normalization, the send
 * loop with key failover and 429 replay, relay and usage. Every outcome is reported through
 * `execution.finishLog`, so the caller decides which final row it lands on.
 */
export async function runNativeChatAttempt(
  execution: NativeChatExecution,
  attemptHandle: InferenceAttempt,
): Promise<Response> {
  const { req, config, logCtx, logIds, route, requestedModel, requestedStream, translatorBudget, finishLog } = execution;
  const { sendBudget } = execution;
  const { attempt } = attemptHandle;
  const onFirstOutput = execution.onFirstOutput
    ?? (logIds ? () => recordFirstOutput(logCtx, logIds.start) : undefined);
  const fail = (status: number, message: string, type?: string, code?: string | null): Response => {
    const safeMessage = redactSecretString(message);
    finishLog(status, safeMessage);
    return chatCompletionsErrorResponse(status, safeMessage, type, code);
  };

  normalizePinnedChatEffort(execution);
  logCtx.requestedServiceTier = typeof execution.chatBody.service_tier === "string"
    ? execution.chatBody.service_tier
    : undefined;

  const upstream = new AbortController();
  const cleanupAbort = linkAbortSignal(upstream, req.signal);
  // nativeChatSse already owns the translated stream's async pull/cancel path.
  // Bind the lease to that same controller and its terminal callbacks instead
  // of adding another trackStreamLifetime wrapper (unsafe on bundled Bun#32111).
  let streamTurnRegistered = false;
  const transferTurnToStream = () => {
    const lease = execution.turnAdmissionLease ?? logIds?.turnAdmissionLease;
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
  // Native chat is its own entry path -- chat-completions.ts routes here directly and never
  // through the Responses core -- so the pre-dispatch key preference is applied again here
  // rather than inherited. Assigned before the adapter binds below, for the same reason it is
  // assigned before the transport pin in core.ts.
  // Transport variant: the bare picker answers with the persisted row, which for a built-in
  // provider carries no adapter id or base URL until routedProviderConfig backfills it.
  const proactiveKeyProvider = selectProactiveApiKeyTransport(config, route.providerName, route.provider);
  if (proactiveKeyProvider) route.provider = proactiveKeyProvider;
  let activeProvider: OcxProviderConfig = route.provider;
  stampApiKeyAccountLabel(logCtx, route.providerName, activeProvider);
  const spendTracker = sendBudget ? undefined : attachRequestSpendTracker(req, logCtx);
  let activeAdapter: ProviderAdapter = createOpenAIChatAdapter(activeProvider);
  let activeRequest: AdapterRequest;
  let retainedRequestBytes = 0;
  const releaseRetainedRequest = () => {
    if (retainedRequestBytes === 0) return;
    translatorBudget.releaseRetained(retainedRequestBytes, { kind: "request_copies" });
    retainedRequestBytes = 0;
  };
  const retainRequest = (request: AdapterRequest) => {
    const bytes = Buffer.byteLength(request.body);
    translatorBudget.chargeRetained(bytes, { kind: "request_copies" });
    retainedRequestBytes = bytes;
  };
  const buildActiveRequest = () => {
    recordAttemptCredentialSource(attempt, route.providerName, activeProvider, activeAdapter.name);
    const request = buildOpenAIChatPassthroughRequest(
      activeProvider,
      execution.chatBody,
      route.modelId,
      requestedStream,
      fastPolicyForModel(activeProvider, route.modelId, route.providerName, "chat"),
      config.fastMode,
    );
    return transformProviderRequest(
      activeProvider,
      request,
      {
        incomingHeaders: req.headers,
        requestSessionLane: getOrAllocateRequestSessionLane(req),
      },
    );
  };
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

  // One inbound request owns one transient send allowance. Capture the policy before any
  // key rotation so recovery cannot replace the ceiling along with the active credential.
  const requestTransientPolicy = transientRetryPolicyFor(activeProvider);
  let transientSendsUsed = 0;
  // A combo child also answers to the request's shared base allowance, at the cap its own ladder
  // uses. Its first send is exempt: the combo reserved it before dispatching this target.
  const sharedSendCap = requestTransientPolicy?.attempts ?? TRANSIENT_RETRY_MAX_ATTEMPTS;
  let physicalSends = 0;
  const remainingSharedSends = (): number => {
    if (!sendBudget) return Number.POSITIVE_INFINITY;
    const remaining = sendBudget.remainingBaseSends(sharedSendCap);
    return physicalSends === 0 ? Math.max(1, remaining) : remaining;
  };
  const remainingTransientSends = (): number => Math.min(
    requestTransientPolicy
      ? Math.max(0, requestTransientPolicy.attempts - transientSendsUsed)
      : Number.POSITIVE_INFINITY,
    remainingSharedSends(),
  );
  const transientSendAvailable = (): boolean => remainingTransientSends() > 0;

  /**
   * The operator's replacement grant for THIS logical request, read per leg because
   * `activeProvider` is reassigned by credential rotation inside the send loop.
   *
   * A combo child already holds the request's send ledger, so the grant comes from it and every
   * ambiguous stage of the request draws on the same counter. A direct Chat request opens no such
   * ledger -- it accounts through a spend tracker instead -- so it keeps the single grant locally,
   * which is the same ceiling for the same one attempt.
   */
  const requestIsSelfContained = (() => {
    let memo: boolean | undefined;
    return (): boolean => memo ??= selfContainedChatBody(execution.chatBody);
  })();
  let localAmbiguousResendSpent = false;
  const claimAmbiguousResend = (limit: number): boolean => {
    if (sendBudget?.claimAmbiguousResend) return sendBudget.claimAmbiguousResend(limit);
    if (localAmbiguousResendSpent || limit <= 0) return false;
    localAmbiguousResendSpent = true;
    return true;
  };
  const ambiguousResend = () => ambiguousResendAllowanceFor(
    activeProvider,
    requestIsSelfContained,
    claimAmbiguousResend,
  );

  const send = async (
    request: AdapterRequest,
    recovery?: "rate-limit-429" | "key-429" | UpstreamSendRecovery,
    singleShot = false,
  ): Promise<Response> => {
    try {
      // #2643: opted-in key-auth openai-chat providers retry pre-stream transient statuses on
      // the native chat lane too; everyone else keeps reset-only semantics.
      const remaining = remainingTransientSends();
      if (sendBudget && remaining <= 0) throw new SendBudgetExhaustedError(safeHostLabel(request.url));
      if (requestTransientPolicy && remaining <= 0) {
        throw new Error("native Chat transient send budget exhausted before recovery dispatch");
      }
      const dispatch = (transportRecovery?: UpstreamSendRecovery) => {
        const effectiveRecovery = transportRecovery
          ?? (recovery === "connection-reset" ? "connection-reset" : undefined);
        return fetchWithHeaderTimeout(
          request.url,
          applyUpstreamRecoveryInit({
            method: request.method,
            headers: request.headers,
            body: request.body,
          }, effectiveRecovery),
          upstream.signal,
          connectMs,
          requestedStream,
          providerFetch(activeProvider, undefined, {
            providerName: route.providerName,
            modelId: route.modelId,
            dispatchOverride: async (_input, init, execute) => {
              if (!providerApiKeySelectionIsCurrent(config, route.providerName, activeProvider)) {
                const current = resolveCurrentProviderApiKeyTransport(config, route.providerName, activeProvider);
                if (!current || !isNativeChatRouteEligible({ ...route, provider: current }, execution.chatBody, config)) {
                  throw new Error("Provider key selection is no longer available for native Chat");
                }
                activeProvider = current;
                stampApiKeyAccountLabel(logCtx, route.providerName, activeProvider);
                activeAdapter = createOpenAIChatAdapter(current);
                activeRequest.releaseBodyObservation?.();
                releaseRetainedRequest();
                activeRequest = buildActiveRequest();
                try { retainRequest(activeRequest); }
                catch (error) { activeRequest.releaseBodyObservation?.(); throw error; }
              }
              // The retry closure may still hold a pre-pacing request. Replace its entire
              // wire shape, not just Authorization, and retain transport recovery flags.
              request = activeRequest;
              const headers = new Headers(request.headers);
              const encoding = new Headers(init.headers).get("accept-encoding");
              if (!headers.has("accept-encoding") && encoding) headers.set("accept-encoding", encoding);
              if (init.signal?.aborted) throw init.signal.reason;
              if (sendBudget) {
                // Backstop for sends the helper cannot see coming (a reset replay). The first
                // report settles the combo's booking; each later one is charged and booked.
                if (physicalSends > 0 && sendBudget.remainingBaseSends(sharedSendCap) <= 0) {
                  throw new SendBudgetExhaustedError(safeHostLabel(request.url));
                }
                physicalSends += 1;
                sendBudget.used += 1;
              } else if (!spendTracker?.charge()) throw new NativeChatSpendRefusal();
              noteProviderAttemptSend(logCtx, route.providerName, activeProvider, logCtx.usageLogInputTokens, transportRecovery ?? recovery);
              // A reselected provider transport is still a physical send: the connection policy
              // and manual-redirect ownership wrap the selected implementation (#4992).
              const dispatched = await sendWithConnectionPolicy(
                (activeProvider as OcxProviderTransport).fetch ?? execute,
                request.url,
                applyUpstreamRecoveryInit({
                  ...init, method: request.method, headers, body: request.body,
                }, transportRecovery),
                // Reselection can replace the provider transport and the wire shape, so the
                // egress route is bound to the provider this send actually uses. Omitting it
                // here would let a provider transport bypass its configured route entirely,
                // because that transport wins over the executor that carries the binding.
                { providerName: route.providerName, provider: activeProvider },
              );
              if (!dispatched.ok) await recordKeyAttemptFailure(logCtx, dispatched, init.signal ?? upstream.signal);
              return dispatched;
            },
          }),
        );
      };
      // A replacement bought by an ambiguous reset is ONE send. Routing it back through a retry
      // helper would let that helper spend sends the operator allowance never granted, which is
      // the duplicated inference the allowance exists to bound.
      if (singleShot) return await dispatch("connection-reset");
      const fetchWithPolicy = requestTransientPolicy ? fetchWithTransientRetry : fetchWithResetRetry;
      return await fetchWithPolicy(
        dispatch,
        {
          abortSignal: upstream.signal,
          label: safeHostLabel(request.url),
          ...(requestTransientPolicy
            ? {
              attempts: remaining,
              onSendsConsumed: (sends: number) => { transientSendsUsed += Math.max(0, sends); },
            }
            : {}),
        },
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
    while (
      response.status === 429
      // A 429 this proxy synthesized for a refused reset replay is not a provider rate
      // limit: waiting and re-sending here is exactly the duplicate inference the refusal
      // exists to stop. It kept the same shape under the old 502 only because 502 never
      // matched this branch.
      && !isNonReplayableResponse(response)
      && retryPolicy
      && retries < retryPolicy.attempts
      && transientSendAvailable()
    ) {
      retries += 1;
      for await (const _ of prepareSameTarget429Wait({
        body: response.body,
        signal: upstream.signal,
        delayMs: rateLimitRetryDelayMs(retryPolicy, response.headers.get("retry-after"), Date.now()),
      })) { /* pre-stream wait */ }
      if (upstream.signal.aborted) throw upstream.signal.reason;
      response = await send(activeRequest, "rate-limit-429");
    }
    // Same reason as above, plus a second one: rotating here would write a cooldown against
    // a key that rate-limited nothing, and that false signal outlives the request.
    while (response.status === 429 && !isNonReplayableResponse(response) && hasKeyPoolFailover(activeProvider)) {
      const rotated = rotateProviderTransportOn429(config, route.providerName, activeProvider, {
        retryAfter: response.headers.get("retry-after"),
        now: Date.now(),
        attemptedKey: activeProvider.apiKey,
        attemptedSelection: activeProvider._apiKeyAttempt,
        promptCacheKey: typeof execution.chatBody.prompt_cache_key === "string" ? execution.chatBody.prompt_cache_key : undefined,
      });
      if (!rotated) break;
      // Rotation also records the failed key's cooldown and persists the next healthy key.
      // Keep that bookkeeping when this request has spent its final send, but preserve the
      // terminal 429 body and do not dispatch with the replacement credential.
      if (!transientSendAvailable()) break;
      try { void response.body?.cancel().catch(() => {}); } catch { /* already closed */ }
      activeProvider = rotated;
      stampApiKeyAccountLabel(logCtx, route.providerName, activeProvider);
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
    const sendError = error instanceof UpstreamRetryEvidenceError ? error.cause : error;
    if (sendBudget && sendError instanceof SendBudgetExhaustedError) {
      // A decision this process made, answered as the Responses path answers it: 429, not 502.
      return fail(429, sendError.message, SEND_BUDGET_EXHAUSTED_CODE, SEND_BUDGET_EXHAUSTED_CODE);
    }
    if (sendError instanceof NativeChatSpendRefusal) {
      const refusal = workflowRefusalResponse("workflow-spend-exhausted", logCtx);
      finishLog(429);
      return refusal;
    }
    if (isTranslatorBudgetExceededError(error)) {
      return fail(413, "request translation buffer exceeded the safe limit", "request_too_large", "translation_buffer_limit");
    }
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
    let upstreamMessage: string | undefined;
    try {
      const parsedError = JSON.parse(bodyText) as Rec;
      const nested = isRec(parsedError.error) ? parsedError.error : undefined;
      const details = nested ?? parsedError;
      if (typeof details.type === "string") upstreamType = details.type;
      if (details.code === null || typeof details.code === "string") upstreamCode = details.code;
      const rawMessage = typeof details.message === "string"
        ? details.message
        : typeof parsedError.error === "string" ? parsedError.error : undefined;
      if (rawMessage?.trim()) {
        upstreamMessage = redactSecretString(rawMessage.trim());
      }
    } catch { /* keep generic classification */ }
    const message = upstreamMessage
      && (isCyberPolicyCode(upstreamCode) || isCyberPolicyMessage(upstreamMessage))
      ? upstreamMessage
      : detail ? `Provider error ${response.status}: ${detail}` : `Provider error ${response.status}`;
    // Zen's keyless free tier refuses the request outright rather than rate-limiting it, and
    // the raw `MissingSessionID` tells a user nothing about why or what to do (#4121).
    const clientMessage = enrichOpenCodeZenFreeTierMessage(message, {
      providerName: route.providerName,
      baseUrl: route.provider.baseUrl,
      adapter: route.provider.adapter,
      upstreamErrorType: upstreamType,
    });
    const classified = classifyError(
      response.status,
      upstreamType ?? (response.status === 401 ? "authentication_error"
        : response.status === 429 ? "rate_limit_error"
          : response.status >= 500 ? "server_error" : "invalid_request_error"),
      clientMessage,
    );
    // The verdict is read once, from the response that carries it and from the code a
    // re-wrapped body kept -- never from the status, which a real rate limit shares.
    const replayRefusal = isReplayRefusalResponse(response) || isReplayRefusalCode(upstreamCode);
    if (isCyberPolicyCode(upstreamCode) || classified.code === CYBER_POLICY_ERROR_CODE) {
      classified.code = CYBER_POLICY_ERROR_CODE;
      classified.type = cyberPolicyErrorType(upstreamType);
    } else if (replayRefusal) {
      // 429 classifies as a rate limit and a rate limit already carries a code, so the branch
      // below -- which only fills an EMPTY code -- could never restore this one. Without it the
      // client is told the provider throttled the turn, when what happened is that this proxy
      // declined to send it a second time.
      classified.code = UPSTREAM_RESET_REPLAY_REFUSED_CODE;
    } else if (upstreamCode === "model_not_found") {
      classified.code = "model_not_found";
      classified.type = "invalid_request_error";
    } else if (upstreamCode !== undefined && upstreamCode !== null && classified.code == null) {
      classified.code = upstreamCode;
    }
    const status = isCyberPolicyCode(classified.code) ? 400
      : replayRefusal ? REPLAY_REFUSED_STATUS
      : response.status;
    // A refusal this proxy made has no wait to report. Synthesizing one here would hand the
    // client the default two-second retry for a rate limit that never happened, which is the
    // duplicate send the refusal exists to prevent.
    const retryAfter = isCyberPolicyCode(classified.code) || replayRefusal
      ? undefined
      : resolveClientRetryAfter({
        status: response.status,
        message: classified.message,
        upstreamRetryAfter: response.headers.get("retry-after"),
      });
    finishLog(status, classified.message);
    const rewritten = new Response(JSON.stringify(chatCompletionsErrorBody(status, classified.message, classified.type, classified.code)), {
      status,
      headers: {
        "Content-Type": "application/json",
        ...(retryAfter ? { "Retry-After": retryAfter } : {}),
        ...(replayRefusal ? REPLAY_REFUSAL_CLIENT_HEADERS : {}),
      },
    });
    return replayRefusal ? retainReplayRefusal(rewritten) : rewritten;
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/event-stream") && response.body) {
    if (requestedStream) transferTurnToStream();
    let terminalStatus: number | undefined;
    const resilientBody = wrapWithZeroOutputRefetch(
      response.body,
      // One physical send, not one more trip through a retry helper: the allowance below buys a
      // single replacement, so the send must not be able to spend more than it granted.
      async () => {
        try {
          return await send(activeRequest, "connection-reset", true);
        } finally {
          // Reselection can charge the rebuilt request after the initial send settled.
          releaseRetainedRequest();
        }
      },
      {
        abortSignal: upstream.signal,
        label: safeHostLabel(activeRequest.url),
        attempts: remainingTransientSends(),
        // The origin returned a head and may already be running the turn, so this is the
        // ambiguous row of the stage table. Only the operator allowance the Responses stream
        // also draws on can authorise it; without one the original failure stands.
        authorize: () => authorizeResendForRecovery("headers-only", "connection-reset", ambiguousResend()).allowed,
        // A replacement must satisfy the contract already promised to the client. A 200 that is
        // not an event stream would reach the SSE translator as a non-SSE body and surface as a
        // malformed-stream error instead of the reset that actually happened.
        acceptResponse: replacement =>
          (replacement.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream"),
      },
    );
    const stream = nativeChatSse(resilientBody, {
      requestedModel,
      translatorBudget,
      signal: upstream.signal,
      stallTimeoutSec: config.stallTimeoutSec,
      localUpstream: isLocalUpstream(activeProvider.baseUrl),
      onFirstOutput,
      onUsage: usage => {
        if (!recordKeyWireAttemptUsage(logCtx, usage)) {
          logCtx.usage = usage;
          attempt.usage = usage;
        }
      },
      onTerminal: (status: number, message?: string) => {
        terminalStatus = status;
        if (!requestedStream) return;
        try {
          cleanupAbort();
          finishLog(status, message, "terminal");
          if (status >= 400) upstream.abort();
        } finally {
          releaseStreamTurn();
        }
      },
      ...(requestedStream ? {
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
      // A cancelled native relay closes its downstream body. EOF alone must not
      // promote the buffered prefix to a successful Chat completion. A terminal
      // already accepted by the relay retains precedence over a later abort.
      if (req.signal.aborted && terminalStatus === undefined) {
        return fail(499, "Client cancelled request", "client_cancelled");
      }
      finishLog(200);
      return Response.json(completion);
    } catch (error) {
      cleanupAbort();
      upstream.abort();
      if (req.signal.aborted && terminalStatus === undefined) {
        return fail(499, "Client cancelled request", "client_cancelled");
      }
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
    if (!recordKeyWireAttemptUsage(logCtx, usage)) {
      logCtx.usage = usage;
      attempt.usage = usage;
    }
  }
  onFirstOutput?.();
  try {
    const serialized = requestedStream
      ? jsonCompletionSse(completion, requestedModel, translatorBudget)
      : JSON.stringify(completion);
    if (!requestedStream) translatorBudget.chargeRetained(Buffer.byteLength(serialized) * 2, { kind: "live_transient" });
    finishLog(200);
    return new Response(serialized, {
      status: 200,
      headers: requestedStream
        ? { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" }
        : { "Content-Type": "application/json" },
    });
  } catch (error) {
    if (isTranslatorBudgetExceededError(error)) {
      return fail(502, "upstream translation buffer exceeded the safe limit", "upstream_error", "translation_buffer_limit");
    }
    throw error;
  }
}
