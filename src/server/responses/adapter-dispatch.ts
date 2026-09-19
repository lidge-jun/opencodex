import { isNonReplayableResponse } from "../../lib/upstream-retry";
import type { ResponsesRequestContext, ResponsesAdmissionState } from "./core-options";
import type { PreparedResponsesRequest } from "./request-prepare";
import type { ResponsesTransport } from "./request-transport";
import type { ResponsesEffects } from "./response-effects";
import type { ResponsesSendBudget } from "./request-send-budget";
import { linkAbortSignal } from "./core-lifetime";
import type { AdapterRequest } from "../../adapters/base";
import type { AdapterEvent } from "../../types";
import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse } from "../../bridge";
import { trackStreamLifetime } from "../lifecycle";
import {
  recordAdapterReasoning,
  recordAdapterTier,
  sealRequestAttemptIdentity,
  recordAttemptCredentialSource,
} from "../request-log";
import { clientCancelledResponse, readDisplaySafeErrorText, normalizeUpstreamErrorText } from "./core-errors";
import { redactSecretString } from "../../lib/redact";
import { waitForProviderRequestSlot } from "../../providers/request-pacing";
import { providerFetch, fetchWithHeaderTimeout, safeHostLabel } from "./fetch-helpers";
import {
  transientRetryPolicyFor,
  rateLimitRetryPolicyFor,
  hasKeyPoolFailover,
  rotateProviderTransportOn401,
  rateLimitRetryDelayMs,
  readQuotaResetAt,
  rotateProviderTransportOn429,
} from "../../providers/key-failover";
import {
  fetchWithTransientRetry,
  fetchWithResetRetry,
  applyUpstreamRecoveryInit,
  SendBudgetExhaustedError,
  prepareSameTarget429Wait,
  sleepWithAbort,
} from "../../lib/upstream-retry";
import { describeUpstreamConnectFailure } from "./upstream-error";
import type { OpaqueBlobRecoveryGuard } from "./core-opaque-recovery";
import type { AttemptRecoveryKind } from "../../usage/log";
import type { OAuthAccessSnapshot } from "../../oauth";
import { publicOAuthAuthenticationErrorMessage } from "../../oauth";
import { resolveProviderTransport } from "../../providers/xai-transport";
import { resolveCopilotApiBaseUrl } from "../../oauth/github-copilot";
import { resolveWireProtocolOverride } from "../adapter-resolve";
import { bindRouteReasoningReplayScope } from "./core-replay";
import {
  ANTHROPIC_POOL_MAX_FAILOVERS_PER_REQUEST,
  rotateAnthropicAccountOn429,
  getAnthropicPoolAccessSnapshot,
  formatAnthropicProviderForLog,
} from "../../oauth/anthropic-routing";
import {
  GENERIC_OAUTH_MAX_FAILOVERS_PER_REQUEST,
  isGenericOAuthFailoverEnabled,
  rotateGenericOAuthAccountOn429,
  failoverAccountSnapshot,
} from "../../oauth/generic-account-failover";
import {
  attemptOpaqueBlobRecovery,
  consoleGoUploadRejectionBody,
  CONSOLE_GO_UPLOAD_RETRY_DELAY_MS,
  reasoningEffortRejectionText,
} from "./core-opaque-recovery";
import { shouldAttemptImageTierRetry } from "../image-retry";
import {
  isTransientConsoleGoUploadRejection,
  enrichOpenCodeZenUpstreamMessage,
} from "../../providers/opencode-zen-rate-limit";
import { planReasoningEffortDowngrade } from "../../providers/reasoning-metadata";
import { consumeComboFailure } from "./core-combo-failure";
import { streamingContextOverflowResponse, jsonContextOverflowResponse } from "./context-overflow";
import { isFixedCodexAccount } from "./core-codex-account";
import { recordSubagentQuotaFailureForThreadSpawn } from "../../codex/subagent-model-fallback";
import {
  isCyberPolicyCode,
  CYBER_POLICY_FALLBACK_MESSAGE,
  CYBER_POLICY_ERROR_CODE,
  SEND_BUDGET_EXHAUSTED_CODE,
} from "../../lib/errors";
import { resolveClientRetryAfter } from "../../lib/retry-after";
import { cancelBodyOnAbort } from "../../lib/abort";

/** One responsibility of the Responses request pipeline; state owners are explicit. */
export async function prepareAdapterExchange(
  requestContext: Pick<ResponsesRequestContext, "options" | "config" | "logCtx" | "req">,
  admissionState: ResponsesAdmissionState,
  requestState: Pick<
    PreparedResponsesRequest,
    | "parsed"
    | "toolBridgeMaps"
    | "translatorBudget"
    | "selectedForwardHeaders"
    | "route"
    | "inboundWire"
    | "clientRequestedStream"
    | "subagentQuotaFailureModel"
    | "subagentFallbackAccountId"
  >,
  transportState: Pick<
    ResponsesTransport,
    | "activeAdapter"
    | "adapter"
    | "sameTargetRequest"
    | "sameTargetParsed"
    | "sameTargetToken"
    | "transportToken"
    | "oauthDispatch"
    | "imageTierBias"
    | "isOAuth401ReplayProvider"
    | "sentOAuthSnapshot"
    | "refreshResolvedOAuthSelection"
    | "replayOAuthCredentialSnapshot"
    | "invalidateSameTargetRequest"
    | "resolveSelectionAdapter"
    | "anthropicPoolAccountId"
    | "anthropicPoolFailovers"
    | "anthropicSessionKey"
    | "commitResolvedOAuthSelection"
    | "genericFailoverAccountId"
    | "genericFailovers"
    | "applyFailoverSnapshot"
    | "noteRoutedAttemptSend"
  >,
  responseEffects: Pick<ResponsesEffects, "cancelResponseCompletion" | "notifyResponseComplete" | "refreshRequestToolAliases">,
  sendBudgetState: Pick<
    ResponsesSendBudget,
    | "adapterDispatchBudget"
    | "noteAdapterPhysicalSend"
    | "noteAdapterRecoveryWithheld"
    | "remainingTransientSendBudget"
    | "noteTransientSends"
    | "recoverySendAllowance"
    | "recoveryClassFor"
    | "sendBudgetExhausted"
    | "reserveCredentialHop"
    | "pendingHopPermit"
  >,
) {
  const { options, config, logCtx, req } = requestContext;
  const {
    oauthDispatch,
    isOAuth401ReplayProvider,
    refreshResolvedOAuthSelection,
    invalidateSameTargetRequest,
    resolveSelectionAdapter,
    anthropicSessionKey,
    commitResolvedOAuthSelection,
    applyFailoverSnapshot,
  } = transportState;
  const {
    parsed,
    toolBridgeMaps,
    translatorBudget,
    route,
    inboundWire,
    clientRequestedStream,
    subagentQuotaFailureModel,
  } = requestState;
  const { cancelResponseCompletion, notifyResponseComplete, refreshRequestToolAliases } = responseEffects;
  const {
    adapterDispatchBudget,
    noteAdapterPhysicalSend,
    noteAdapterRecoveryWithheld,
    remainingTransientSendBudget,
    noteTransientSends,
    recoverySendAllowance,
    recoveryClassFor,
    sendBudgetExhausted,
    reserveCredentialHop,
  } = sendBudgetState;


  const upstream = new AbortController();
  const cleanupUpstreamAbort = linkAbortSignal(upstream, options.abortSignal);
  const connectMs = config.connectTimeoutMs ?? 200_000;
  // Bridge stall budget (seconds of silence before upstream_stall_timeout); the retry backoff
  // heartbeat interval is derived from it so the watchdog is always fed during deliberate waits.
  const stallTimeoutMs = typeof config.stallTimeoutSec === "number" && Number.isFinite(config.stallTimeoutSec) && config.stallTimeoutSec > 0
    ? Math.floor(config.stallTimeoutSec * 1000)
    : 300_000;
  transportState.activeAdapter = transportState.adapter;

  // One immutable, body-safe outbound request per same-target sequence (URL, serialized body,
  // auth headers, generated compat headers). Same-target 429 replays reuse it verbatim; the
  // builder runs again only after a key/account/adapter rotation, an oauth refresh, or an
  // image-tier bias change (transportToken bump). `body` is always a serialized string, so
  // reuse is safe, and releaseBodyObservation is idempotent per build.
  let initialRequest: AdapterRequest | undefined;
  let inputTokenEstimate: number | undefined;
  // An adapter may know the turn needs no inference at all — Kiro's replayed history ending in a
  // delivered final answer. Answer it locally: no build (so no token estimate), no send (so
  // sendCount stays 0), and crucially no empty-completion guard, which treats an outputless
  // terminal as a failed turn and re-invokes the identical request. Routing this through the
  // ordinary event path would therefore reinstate the loop it exists to end.
  const localTerminal = transportState.activeAdapter.localTerminal?.(parsed);
  if (localTerminal) {
    logCtx.localTerminalReason = localTerminal.reason;
    // Mark the physical attempt too, not just the parent row. `finishRequestAttempt` finalizes the
    // attempt through the same estimated-provider path, so without this the row reads exact while
    // its own attempt still claims an estimate — the detailed accounting a maintainer actually
    // reads for a zero-send turn.
    if (logCtx.activeAttempt) logCtx.activeAttempt.locallyAnswered = true;
    cleanupUpstreamAbort();
    upstream.abort();
    const terminalEvents: AdapterEvent[] = [{
      type: "done",
      endTurn: true,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    }];
    if (parsed.stream) {
      const localSse = bridgeToResponsesSSE(
        (async function* () { yield* terminalEvents; })(),
        parsed._responseModelId ?? parsed.modelId,
        toolBridgeMaps.toolNsMap,
        toolBridgeMaps.freeformToolNames,
        toolBridgeMaps.toolSearchToolNames,
        cancelResponseCompletion,
        2_000,
        {
          translatorBudget,
          onCompletedResponse: notifyResponseComplete,
          ...(options.forceEmptyResponseId ? { responseId: "" } : {}),
          ...(options.onFirstOutput ? { onFirstOutput: options.onFirstOutput } : {}),
        },
      );
      // Same lifetime tracking as every other streaming return in this function: the turn
      // admission lease is released when the body finishes or the client disconnects. Returning
      // the raw stream would hold a lease for a turn that already has all of its output.
      const localTurnAc = new AbortController();
      return new Response(
        trackStreamLifetime(localSse, localTurnAc, undefined, options.turnAdmissionLease),
        {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
          },
        },
      );
    }
    const json = buildResponseJSON(terminalEvents, parsed._responseModelId ?? parsed.modelId, { translatorBudget });
    notifyResponseComplete(json);
    return new Response(JSON.stringify(json), { headers: { "Content-Type": "application/json" } });
  }
  try {
    initialRequest = await transportState.activeAdapter.buildRequest(parsed, {
      headers: requestState.selectedForwardHeaders,
      translatorBudget,
      abortSignal: upstream.signal,
    });
    refreshRequestToolAliases(initialRequest);
    recordAdapterReasoning(logCtx, initialRequest);
    recordAdapterTier(logCtx, initialRequest);
    inputTokenEstimate = typeof initialRequest.usageLog?.inputTokens === "number"
      ? initialRequest.usageLog.inputTokens
      : undefined;
    if (inputTokenEstimate !== undefined) logCtx.usageLogInputTokens = inputTokenEstimate;
  } catch (err) {
    // A throwing buildRequest never returned a request; if a post-build step threw, release
    // the serialized-body observation (idempotent) so the translator budget is not leaked.
    // The build runs after linkAbortSignal, so a failure must also tear the link down and
    // abort the upstream controller instead of escaping handleResponses unmapped.
    initialRequest?.releaseBodyObservation?.();
    cleanupUpstreamAbort();
    upstream.abort();
    if (options.abortSignal?.aborted) return clientCancelledResponse();
    const msg = err instanceof Error ? err.message : String(err);
    return formatErrorResponse(400, "invalid_request_error", redactSecretString(msg));
  }
  // The catch path above always returns, so the request is definitely assigned here.
  // Capture it in a const so the fetch callbacks read a narrowed, immutable value
  // (TypeScript drops narrowing for a `let` captured by a nested function).
  const builtInitialRequest = initialRequest;
  transportState.sameTargetRequest = builtInitialRequest;
  transportState.sameTargetParsed = parsed;
  transportState.sameTargetToken = transportState.transportToken;
  /**
   * Invalidate the same-target request cache. Every credential/adapter/parsed mutation MUST
   * go through here: the cache keys on `parsed` REFERENCE identity, so an in-place mutation
   * is invisible to it and a missed bump would replay a request built with a stale key.
   */

  let upstreamResponse: Response;
  try {
    if (transportState.activeAdapter.fetchResponse) {
      transportState.noteRoutedAttemptSend(inputTokenEstimate);
      await waitForProviderRequestSlot(route.providerName, route.provider, route.modelId, upstream.signal);
      upstreamResponse = await transportState.activeAdapter.fetchResponse(builtInitialRequest, {
        abortSignal: upstream.signal,
        timeoutMs: connectMs,
        sendBudget: adapterDispatchBudget,
        onPhysicalSend: send => noteAdapterPhysicalSend(inputTokenEstimate, send),
        onRecoveryWithheld: noteAdapterRecoveryWithheld,
        stream: parsed.stream,
        executor: providerFetch(route.provider, options.codexWsRuntimeIdentity, {
              pacingSlotAcquired: true,
              dispatchOverride: oauthDispatch(builtInitialRequest),
          providerName: route.providerName,
          modelId: route.modelId,
        }),
      });
    } else {
      // #1851 scope guard: transient-5xx retry on this generic adapter path is opt-in for
      // direct Google AI Studio only (Vertex/Antigravity use fetchResponse above). Other
      // adapters keep reset-only retry so combo failover still hops on the first 5xx
      // instead of burning ~1.2s of same-target retries per hop.
      // #2643: an opted-in key-auth openai-chat provider also gets transient-5xx retry. The
      // legacy direct-Google exception is preserved exactly; every other adapter still keeps
      // reset-only semantics so combo failover hops on the first 5xx.
      const transientPolicy = transientRetryPolicyFor(route.provider);
      const fetchWithRetryPolicy = (route.provider.adapter === "google" || transientPolicy)
        ? fetchWithTransientRetry
        : fetchWithResetRetry;
      upstreamResponse = await fetchWithRetryPolicy(
        recovery => {
          transportState.noteRoutedAttemptSend(inputTokenEstimate, recovery);
          return fetchWithHeaderTimeout(builtInitialRequest.url, applyUpstreamRecoveryInit({
            method: builtInitialRequest.method,
            headers: builtInitialRequest.headers,
            body: builtInitialRequest.body,
          }, recovery), upstream.signal, connectMs, parsed.stream,
            providerFetch(route.provider, options.codexWsRuntimeIdentity, {
              dispatchOverride: oauthDispatch(builtInitialRequest),
              providerName: route.providerName,
              modelId: route.modelId,
            }));
        },
        {
          abortSignal: upstream.signal,
          label: safeHostLabel(builtInitialRequest.url),
          ...(transientPolicy
            // Draws the remainder, not the raw policy. A combo child inherits the parent's
            // holder but used to take a fresh full allowance on its own first send, so the
            // shared counter was inherited without ever being read as a limit.
            ? {
              attempts: remainingTransientSendBudget(transientPolicy.attempts),
              onSendsConsumed: noteTransientSends,
            }
            : {}),
        },
      );
    }
  } catch (err) {
    cleanupUpstreamAbort();
    upstream.abort();
    if (options.abortSignal?.aborted) return clientCancelledResponse();
    // A budget refusal is a decision this process made, not an upstream fault. Reporting it as
    // 502 does more than mislabel it: the Codex client retries 5xx and does not retry a 429, so
    // blaming the provider makes the caller send the whole turn again -- the amplification this
    // budget exists to stop. The passthrough path has answered 429 here since #4546.
    if (err instanceof SendBudgetExhaustedError) {
      return formatErrorResponse(429, SEND_BUDGET_EXHAUSTED_CODE, err.message);
    }
    const msg = describeUpstreamConnectFailure(err, connectMs);
    return formatErrorResponse(502, "upstream_error", msg);
  } finally {
    builtInitialRequest.releaseBodyObservation?.();
  }

  // Same-target 429 retry budget is per REQUEST: it lives OUTSIDE the recovery loop (so a 413/401
  // replay that comes back 429 cannot silently re-arm a fresh budget) and is SHARED with the
  // terminal-guard continuation below, so the main loop + one continuation can never exceed
  // `attempts` same-key replays in total (bounded per request).
  const rateLimitPolicy = rateLimitRetryPolicyFor(route.provider);
  let rateLimitRetries = 0;
  // Shared with the terminal-guard continuation below: an image-tier reduction that let the
  // main request clear a 413 must not be forgotten on the very next continuation build.
  if (!upstreamResponse.ok) {
    // Recovery loop: multi-key 429 failover + at most ONE opaque-state rebuild and ONE
    // anthropic 413 tightened retry
    // (devlog/260714_image_normalization_pipeline/030). One mutable activeAdapter serves
    // both paths so a 429→413 sequence never rebuilds against a stale pre-rotation
    // adapter, and imageTierBias — once armed — rides EVERY subsequent rebuild so a
    // 413→429 rotation cannot silently undo the tightening.
    let imageRetryAttempted = false;
    const opaqueBlobRecoveryGuard: OpaqueBlobRecoveryGuard = { attempted: false };
    // Console Go answers a transient 400 "Invalid upload request." for bodies it accepts
    // moments later; at most one byte-identical replay is allowed per request.
    const consoleGoUploadRetryGuard: { attempted: boolean } = { attempted: false };
    let oauth401ReplayAttempted = false;
    // At most one reasoning-effort downgrade per request. This sits outside the recovery loop
    // below for the same reason the two guards above do: a guard declared inside it is reset by
    // every `continue recovery`, which would let one turn walk the whole ladder down.
    const reasoningEffortDowngradeGuard: { attempted: boolean } = { attempted: false };
    /**
     * Rebuild the request from the current parsed input (and any image-tier bias) and refetch
     * it once, tagging the attempt with the given recovery kind. Rebuilds are deterministic
     * for the same parsed request, so same-target replays stay byte-identical.
     */
    const rebuildAndRefetch = async (
      recovery: AttemptRecoveryKind,
      /**
       * Called at the dispatch boundary — after the request is rebuilt and shaped, immediately
       * before the send. A caller holding a reserved hop confirms it here rather than before the
       * rebuild, because a build failure returns `{ failed }` without ever reaching the wire and
       * a permit confirmed earlier would keep the charge for a send that never happened.
       */
      onDispatch?: () => void,
    ): Promise<Response | { failed: Response }> => {
      let retryRequest: AdapterRequest;
      if (transportState.sameTargetRequest !== undefined && transportState.sameTargetParsed === parsed && transportState.sameTargetToken === transportState.transportToken) {
        // Same target (key/adapter/parsed/tier unchanged): replay the exact cached request.
        retryRequest = transportState.sameTargetRequest;
      } else {
        try {
          retryRequest = await transportState.activeAdapter.buildRequest(parsed, {
            headers: requestState.selectedForwardHeaders,
            translatorBudget,
            abortSignal: upstream.signal,
            ...(transportState.imageTierBias > 0 ? { imageTierBias: transportState.imageTierBias } : {}),
          });
          recordAdapterReasoning(logCtx, retryRequest);
          recordAdapterTier(logCtx, retryRequest);
        } catch (err) {
          // A rotated/rebuilt adapter build failure is a request-shaping error, not an
          // upstream connect failure: tear the abort link down and map it as 400 (no 413
          // translator-budget mapping here — that stays with parseRequest/buildToolBridgeMaps).
          cleanupUpstreamAbort();
          upstream.abort();
          if (options.abortSignal?.aborted) return { failed: clientCancelledResponse() };
          const msg = err instanceof Error ? err.message : String(err);
          return { failed: formatErrorResponse(400, "invalid_request_error", redactSecretString(msg)) };
        }
        transportState.sameTargetRequest = retryRequest;
        transportState.sameTargetParsed = parsed;
        transportState.sameTargetToken = transportState.transportToken;
      }
      refreshRequestToolAliases(retryRequest);
      const retryEstimate = typeof retryRequest.usageLog?.inputTokens === "number"
        ? retryRequest.usageLog.inputTokens
        : undefined;
      if (retryEstimate !== undefined) logCtx.usageLogInputTokens = retryEstimate;
      logCtx.providerAdapter = transportState.activeAdapter.name;
      sealRequestAttemptIdentity(logCtx.activeAttempt, logCtx.provider, transportState.activeAdapter.name, logCtx.accountLogLabel);
      recordAttemptCredentialSource(logCtx.activeAttempt, route.providerName, route.provider, transportState.activeAdapter.name);
      try {
        try {
          if (transportState.activeAdapter.fetchResponse) {
            transportState.noteRoutedAttemptSend(retryEstimate, recovery);
            await waitForProviderRequestSlot(route.providerName, route.provider, route.modelId, upstream.signal);
            // The dispatch boundary is HERE, not before the pacing wait: that wait can reject for
            // an abort, a saturated queue, an expired slot or a removed provider, and none of
            // those reach the wire. Confirming earlier would hold the charge for a send that the
            // pacer refused.
            onDispatch?.();
            return await transportState.activeAdapter.fetchResponse(retryRequest, {
              abortSignal: upstream.signal,
              timeoutMs: connectMs,
            sendBudget: adapterDispatchBudget,
              onPhysicalSend: send => noteAdapterPhysicalSend(retryEstimate, send),
              onRecoveryWithheld: noteAdapterRecoveryWithheld,
              stream: parsed.stream,
              executor: providerFetch(route.provider, options.codexWsRuntimeIdentity, {
                pacingSlotAcquired: true,
              dispatchOverride: oauthDispatch(retryRequest),
                providerName: route.providerName,
                modelId: route.modelId,
              }),
            });
          }
          // #2643 review: this leg used to call fetchWithHeaderTimeout directly, so an
          // opted-in provider's transient-5xx policy applied to the initial send and to
          // native chat but was silently bypassed here — a 429 that recovered into a
          // retryable 503 got no retry on the Responses path. Route it through the same
          // selection, and pass what is LEFT of the request-scoped budget rather than a
          // fresh one, so a recovery loop cannot multiply total upstream sends.
          const refetchTransientPolicy = transientRetryPolicyFor(route.provider);
          const refetchWithPolicy = (route.provider.adapter === "google" || refetchTransientPolicy)
            ? fetchWithTransientRetry
            : fetchWithResetRetry;
          // Same rule as the passthrough rebuild: spend the base allowance first, then the one
          // shared final-recovery reserve, so a recovery that follows a spent streak still gets
          // its single send instead of dying at three.
          const refetchAllowance = refetchTransientPolicy
            ? recoverySendAllowance(
              refetchTransientPolicy.attempts,
              recoveryClassFor(recovery),
              `${route.providerName}|${route.modelId}|${recovery}`,
            )
            : undefined;
          try {
            return await refetchWithPolicy(
              recoveryKind => {
                if (refetchAllowance?.permit && !refetchAllowance.permit.use()) {
                  throw new SendBudgetExhaustedError(safeHostLabel(retryRequest.url));
                }
                transportState.noteRoutedAttemptSend(retryEstimate, recoveryKind ?? recovery);
                // Same boundary on the helper path: the thunk is what reaches the wire, and it
                // can be refused above before it does. use() past the first attempt is a no-op.
                onDispatch?.();
                return fetchWithHeaderTimeout(retryRequest.url,
                  applyUpstreamRecoveryInit({
                    method: retryRequest.method, headers: retryRequest.headers, body: retryRequest.body,
                  }, recoveryKind), upstream.signal, connectMs, parsed.stream,
                  providerFetch(route.provider, options.codexWsRuntimeIdentity, {
                    dispatchOverride: oauthDispatch(retryRequest),
                    providerName: route.providerName,
                    modelId: route.modelId,
                  }));
              },
              {
                abortSignal: upstream.signal,
                label: safeHostLabel(retryRequest.url),
                ...(refetchAllowance
                  ? {
                    attempts: refetchAllowance.attempts,
                    onSendsConsumed: noteTransientSends,
                  }
                  : {}),
              },
            );
          } finally {
            // Refunds only a reservation whose send never happened -- an abort settled before
            // the thunk ran. A used or externally settled permit ignores this.
            refetchAllowance?.permit?.release();
          }
        } finally {
          retryRequest.releaseBodyObservation?.();
        }
      } catch (err) {
        cleanupUpstreamAbort();
        upstream.abort();
        if (options.abortSignal?.aborted) {
          return { failed: clientCancelledResponse() };
        }
        // Same rule on the recovery leg: the ladder refused to send again, so the answer names
        // this proxy rather than the provider it never reached.
        if (err instanceof SendBudgetExhaustedError) {
          return { failed: formatErrorResponse(429, SEND_BUDGET_EXHAUSTED_CODE, err.message) };
        }
        const msg = describeUpstreamConnectFailure(err, connectMs);
        return { failed: formatErrorResponse(502, "upstream_error", msg) };
      }
    };
   // Keep recovery kinds in sync with the native Responses `passthroughRecovery:` loop above.
   recovery: for (;;) {
      // Preserve the terminal verdict through adapter and combo error formatting.
      // This also covers a reset reached by a 401/429/413 recovery refetch.
      if (isNonReplayableResponse(upstreamResponse)) {
        cleanupUpstreamAbort();
        return upstreamResponse;
      }
     if (
       upstreamResponse.status === 401
       && isOAuth401ReplayProvider
        && transportState.sentOAuthSnapshot
        && !oauth401ReplayAttempted
        && !sendBudgetExhausted()
      ) {
        oauth401ReplayAttempted = true;
        try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
        let refreshed: OAuthAccessSnapshot;
        try {
          refreshed = await refreshResolvedOAuthSelection(transportState.sentOAuthSnapshot);
        } catch (err) {
          cleanupUpstreamAbort();
          return formatErrorResponse(401, "authentication_error", publicOAuthAuthenticationErrorMessage(err));
        }
        if (route.provider.googleMode === "cloud-code-assist" && !refreshed.projectId) {
          cleanupUpstreamAbort();
          return formatErrorResponse(401, "authentication_error", publicOAuthAuthenticationErrorMessage(new Error("Cloud Code Assist project is required")));
        }
        transportState.sentOAuthSnapshot = refreshed;
        transportState.replayOAuthCredentialSnapshot = {
          accountId: refreshed.accountId,
          generation: refreshed.generation,
        };
        if (route.providerName === "kiro") {
          parsed._kiroAuthContext = { ...(refreshed.kiro ?? {}) };
        }
        const refreshedProvider = resolveProviderTransport(
          route.providerName,
          {
            ...route.provider,
            apiKey: refreshed.accessToken,
            ...(refreshed.projectId ? { project: refreshed.projectId } : {}),
          },
          parsed.options.promptCacheKey,
          route.providerName === "github-copilot"
            ? resolveCopilotApiBaseUrl(refreshed.apiBaseUrl)
            : undefined,
        );
        route.provider = refreshedProvider;
        invalidateSameTargetRequest();
        transportState.activeAdapter = resolveSelectionAdapter(
          resolveWireProtocolOverride(route.providerName, route.modelId, refreshedProvider, inboundWire),
          config.cacheRetention,
        );
        bindRouteReasoningReplayScope({
          parsed,
          providerName: route.providerName,
          provider: refreshedProvider,
          adapterName: transportState.activeAdapter.name,
          oauthCredentialSnapshot: transportState.replayOAuthCredentialSnapshot,
        });
        const result = await rebuildAndRefetch("oauth-401");
        if ("failed" in result) return result.failed;
        upstreamResponse = result;
        continue recovery;
      }

      // Static API-key pools can recover a credential-scoped 401 without abandoning the
      // provider: one revoked or mistyped key says nothing about its siblings. OAuth providers
      // refresh above and never enter here — `hasKeyPoolFailover` rejects oauth/forward modes.
      // Runs after the OAuth replay so a refreshable token is never treated as a dead key.
      while (upstreamResponse.status === 401 && hasKeyPoolFailover(route.provider)) {
        const rotated = rotateProviderTransportOn401(config, route.providerName, route.provider, {
          now: Date.now(),
          attemptedKey: route.provider.apiKey,
          promptCacheKey: parsed.options.promptCacheKey,
        });
        if (!rotated) break;
        // Release the failed response's socket before retrying; unread bodies otherwise linger
        // until runtime cleanup (one per rotated key).
        try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
        route.provider = rotated;
        invalidateSameTargetRequest();
        transportState.activeAdapter = resolveSelectionAdapter(
          resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, inboundWire),
          config.cacheRetention,
        );
        bindRouteReasoningReplayScope({
          parsed,
          providerName: route.providerName,
          provider: route.provider,
          adapterName: transportState.activeAdapter.name,
        });
       const result = await rebuildAndRefetch("key-401");
       if ("failed" in result) return result.failed;
       upstreamResponse = result;
        // A recovery refetch can itself die on an ambiguous pre-header reset, and the refusal
        // that answers it is a 429. Every arm below keys on 429, so letting it fall through
        // hands the marked refusal to the next waiting arm and replays the send it exists to
        // stop. Re-enter the loop guard instead, which returns it unchanged.
        if (isNonReplayableResponse(upstreamResponse)) continue recovery;
     }

      // Same-target 429 wait-and-retry (opt-in `retryOn429`, issue #487). Codex never retries
      // 429 itself (it retries 5xx only), and single-key pools cannot use the failover below,
      // so wait (Retry-After or the fixed interval) and replay the IDENTICAL request on the
      // same key first. Pre-stream only: a 429 arrives before any bytes are relayed, so the
      // replay is lossless. Runs before key failover so "primary-first" setups keep the same
      // key on rate-limit blips; only after the attempts are exhausted does failover run.
      while (
        upstreamResponse.status === 429
        && rateLimitPolicy !== null
        && rateLimitRetries < rateLimitPolicy.attempts
        && !sendBudgetExhausted()
      ) {
        rateLimitRetries += 1;
        // Release unread body + deliberate wait via the shared same-target helper.
        const retryAfterHeader = upstreamResponse.headers.get("retry-after");
        try {
          for await (const _ of prepareSameTarget429Wait({
            body: upstreamResponse.body,
            signal: options.abortSignal,
            delayMs: rateLimitRetryDelayMs(rateLimitPolicy, retryAfterHeader, Date.now()),
          })) {
            // pre-stream: no stall watchdog to feed
          }
        } catch {
          cleanupUpstreamAbort();
          upstream.abort();
          return clientCancelledResponse();
        }
        // Client cancellation wins over any stale timer edge: re-check before dispatching the
        // replay so an adapter never starts work for a request the client already abandoned.
        if (options.abortSignal?.aborted || upstream.signal.aborted) {
          cleanupUpstreamAbort();
          upstream.abort();
          return clientCancelledResponse();
        }
       const result = await rebuildAndRefetch("rate-limit-429");
       if ("failed" in result) return result.failed;
       upstreamResponse = result;
        // The refusal is a 429 too: without this the while condition is still true and the
        // next configured attempt replays it on the same target.
        if (isNonReplayableResponse(upstreamResponse)) continue recovery;
     }

      // Multi-key 429 failover: rotate to the next pool key (cooldown-aware) and retry the
      // SAME request once per remaining key. OAuth/forward providers and single-key pools
      // return null immediately, so this stays a no-op for them (src/providers/key-failover.ts).
      while (upstreamResponse.status === 429 && hasKeyPoolFailover(route.provider)) {
        // A quota exhaustion is dated in the BODY, not in `Retry-After` — OpenRouter
        // sends no header for it (#4024). Read a bounded prefix before the socket is
        // released below; a failed or slow read just leaves the header path in charge.
        // Peeks a bounded prefix and hands back a Response still carrying the whole
        // body, so the cancel below still releases the socket.
        let peeked: Awaited<ReturnType<typeof readQuotaResetAt>>;
        try {
          peeked = await readQuotaResetAt(upstreamResponse, { signal: options.abortSignal });
        } catch {
          cleanupUpstreamAbort();
          upstream.abort();
          return clientCancelledResponse();
        }
        if (options.abortSignal?.aborted) {
          cleanupUpstreamAbort();
          upstream.abort();
          return clientCancelledResponse();
        }
        upstreamResponse = peeked.response;
        const quotaResetAt = peeked.at;
        const rotated = rotateProviderTransportOn429(config, route.providerName, route.provider, {
          retryAfter: upstreamResponse.headers.get("retry-after"),
          now: Date.now(),
          attemptedKey: route.provider.apiKey,
          promptCacheKey: parsed.options.promptCacheKey,
          quotaResetAt,
        });
        if (!rotated) break;
        // Release the failed response's socket before retrying; unread bodies otherwise linger
        // until runtime cleanup (one per rotated key under a rate-limit storm).
        try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
        route.provider = rotated;
        invalidateSameTargetRequest();
        transportState.activeAdapter = resolveSelectionAdapter(
          resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, inboundWire),
          config.cacheRetention,
        );
        bindRouteReasoningReplayScope({
          parsed,
          providerName: route.providerName,
          provider: route.provider,
          adapterName: transportState.activeAdapter.name,
        });
       const result = await rebuildAndRefetch("key-429");
       if ("failed" in result) return result.failed;
       upstreamResponse = result;
        // Rotating on the refusal would also write a cooldown against a key that rate-limited
        // nothing, which outlives the request.
        if (isNonReplayableResponse(upstreamResponse)) continue recovery;
     }

      // Opt-in Anthropic OAuth account pool (#294): cool the failed account and retry
      // with another eligible OAuth account (bounded per request). Disabled by default.
      while (
        upstreamResponse.status === 429
        && transportState.anthropicPoolAccountId
        && transportState.anthropicPoolFailovers < ANTHROPIC_POOL_MAX_FAILOVERS_PER_REQUEST
      ) {
        const nextAccountId = rotateAnthropicAccountOn429(
          config,
          transportState.anthropicPoolAccountId,
          upstreamResponse.headers.get("retry-after"),
          anthropicSessionKey,
          Date.now(),
          upstreamResponse.headers,
        );
        if (!nextAccountId) break;
        try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
        try {
          const admitted = await commitResolvedOAuthSelection(await getAnthropicPoolAccessSnapshot(nextAccountId));
          if (!admitted) throw new Error("OAuth selection changed during recovery");
          transportState.anthropicPoolAccountId = admitted.accountId;
          transportState.anthropicPoolFailovers += 1;
          route.provider = { ...route.provider, apiKey: admitted.accessToken };
          invalidateSameTargetRequest();
          logCtx.provider = formatAnthropicProviderForLog("anthropic", admitted.accountId, config);
          transportState.activeAdapter = resolveSelectionAdapter(
            resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, inboundWire),
            config.cacheRetention,
          );
          sealRequestAttemptIdentity(logCtx.activeAttempt, logCtx.provider, transportState.activeAdapter.name, logCtx.accountLogLabel);
          recordAttemptCredentialSource(logCtx.activeAttempt, route.providerName, route.provider, transportState.activeAdapter.name);
         const result = await rebuildAndRefetch("anthropic-oauth-429");
         if ("failed" in result) return result.failed;
         upstreamResponse = result;
          if (isNonReplayableResponse(upstreamResponse)) continue recovery;
       } catch {
          break;
        }
      }
      // Generic OAuth account failover (#2568) for providers with no pool of their own.
      // Presence is consent since #2568d: rotation is ON by default once two or more eligible
      // accounts are stored for the provider, because a second deliberate login is read as the
      // operator asking for it. A single-account install is still a strict no-op, and an
      // explicit `oauthAccountFailover.enabled: false` (global or per provider) still wins --
      // see isGenericOAuthFailoverEnabled in src/oauth/generic-account-failover.ts. Codex and
      // Anthropic are excluded by isGenericFailoverProvider: their pools own quota scopes,
      // probe leases and affinity that this must not reimplement.
      while (
        upstreamResponse.status === 429
        && transportState.genericFailoverAccountId
        && transportState.genericFailovers < GENERIC_OAUTH_MAX_FAILOVERS_PER_REQUEST
        && isGenericOAuthFailoverEnabled(config, route.providerName)
      ) {
        // Intersection with the shared request budget. This arm re-sends through
        // rebuildAndRefetch, so the roster cap alone would let one request walk the roster on
        // an allowance the rest of the request cannot see. A refusal ends the ladder with the
        // real 429 already in hand, which is the decided exhaustion contract.
        //
        // Who settles this reservation depends on who dispatches the replay (#4709). An
        // adapter that owns its ladder -- Kiro's reset loop, Cursor's transport loop --
        // reserves once per physical send and would charge the same replay again; the helper
        // path reports it again through `onSendsConsumed`. Both turned one physical send into
        // two charges, and once the allowance was spent, into a synthetic error in place of
        // the 429 this hop was recovering from. The wire protocol is resolved from the
        // provider and model, not from the account, so an account rotation cannot move the
        // replay between these two shapes.
        const adapterOwnsDispatch = transportState.activeAdapter.fetchResponse !== undefined;
        const hop = reserveCredentialHop(
          "auth-recovery",
          `${route.providerName}|${route.modelId}|adapter-recovery-oauth-429`,
          // Only a helper-routed replay reports this send back. A reset-only refetch reports
          // nothing and an adapter ladder settles the booking itself, so promising an external
          // report on either would leave a booking pending until it swallowed a later charge.
          !adapterOwnsDispatch && transientRetryPolicyFor(route.provider) !== null,
        );
        if (!hop.allowed) break;
        const nextAccountId = rotateGenericOAuthAccountOn429(
          config,
          route.providerName,
          transportState.genericFailoverAccountId,
          upstreamResponse.headers.get("retry-after"),
          Date.now(),
          route.modelId,
        );
        if (!nextAccountId) {
          hop.permit?.release();
          break;
        }
        try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
        try {
          // The FULL snapshot, not just the bearer: Antigravity pairs an account-matched
          // projectId with its token and Kiro carries routing metadata, so a token-only swap
          // would mix one account's credential with another's routing data.
          const snapshot = await failoverAccountSnapshot(route.providerName, nextAccountId);
            transportState.genericFailovers += 1;
          if (!await applyFailoverSnapshot(snapshot)) {
            hop.permit?.release();
            break;
          }
          invalidateSameTargetRequest();
          transportState.activeAdapter = resolveSelectionAdapter(
            resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, inboundWire),
            config.cacheRetention,
          );
          sealRequestAttemptIdentity(logCtx.activeAttempt, logCtx.provider, transportState.activeAdapter.name, logCtx.accountLogLabel);
          recordAttemptCredentialSource(logCtx.activeAttempt, route.providerName, route.provider, transportState.activeAdapter.name);
          // The replay IS this hop's send, so hand the reservation down and let the layer that
          // dispatches settle it: `adapterDispatchBudget` spends it on the adapter's first
          // reservation, and the retry helper's reporter settles the external booking.
          sendBudgetState.pendingHopPermit = hop.permit;
          let result: Response | { failed: Response };
          try {
            // Confirm at the dispatch boundary, not here: a rebuild can fail while shaping the
            // request and return `{ failed }` without reaching the wire, and a permit confirmed
            // before that would hold the charge for a send that never happened. An
            // adapter-owned ladder is the exception -- its own reservation is the confirmation,
            // and settling here first would hand it a dead permit, which it reads as an
            // exhausted request and stops sending on.
            result = await rebuildAndRefetch("oauth-account-429", () => {
              if (!adapterOwnsDispatch) hop.permit?.use();
            });
          } finally {
            sendBudgetState.pendingHopPermit = undefined;
          }
          if ("failed" in result) {
            // A no-op if the boundary was reached; a refund if the rebuild died before it.
            hop.permit?.release();
            return result.failed;
          }
         upstreamResponse = result;
          // The hop's permit is already settled by the dispatch boundary above; continuing
          // only skips the remaining arms, it does not abandon a reservation.
          if (isNonReplayableResponse(upstreamResponse)) continue recovery;
       } catch {
         // A throw before the send — snapshot fetch, credential application, adapter
          // resolution — must hand the reservation back. Without this the ladder charges the
          // request for a send it never made, and a later recovery in the same request is
          // refused on an allowance nothing spent. release() is idempotent and a no-op once
          // used, so a throw from the rebuild keeps its charge.
          hop.permit?.release();
          break;
        }
      }
      // Unknown provenance is deliberately fail-soft in pre-flight: after a restart, TTL expiry,
      // or LRU eviction, a valid same-backend blob must survive. A decoder's own 4xx identity is
      // the missing authoritative signal. Rebuild once through the same sanitation path used by a
      // known route switch; invalidating is mandatory because `parsed` mutates in place and the
      // same-target cache would otherwise replay the rejected bytes verbatim.
      const opaqueBlobRecovery = await attemptOpaqueBlobRecovery({
        response: upstreamResponse,
        outboundBody: transportState.sameTargetRequest?.body,
        adapterName: transportState.activeAdapter.name,
        parsed,
        guard: opaqueBlobRecoveryGuard,
        signal: upstream.signal,
      }, recovery => {
        invalidateSameTargetRequest();
        return rebuildAndRefetch(recovery);
      });
      if (opaqueBlobRecovery.kind === "failed") return opaqueBlobRecovery.response;
      if (opaqueBlobRecovery.kind === "recovered") {
        upstreamResponse = opaqueBlobRecovery.response;
        continue recovery;
      }
      // Anthropic 413 request_too_large: rebuild once with every image one tier lower
      // (spiral guard: single attempt). The biased response re-enters the 429 check above.
      if (shouldAttemptImageTierRetry({
        status: upstreamResponse.status,
        adapterName: transportState.activeAdapter.name,
        parsed,
        alreadyAttempted: imageRetryAttempted,
      })) {
        imageRetryAttempted = true;
        transportState.imageTierBias = 1;
        invalidateSameTargetRequest();
        try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
        const result = await rebuildAndRefetch("image-413");
        if ("failed" in result) return result.failed;
        upstreamResponse = result;
        continue recovery;
      }
      // Console Go (opencode-zen / opencode-go) intermittently rejects a body it accepts seconds
      // later with 400 invalid_request_error / "Invalid upload request." Replay the
      // byte-identical request once after the exact gateway rejection.
      if (!consoleGoUploadRetryGuard.attempted) {
        const uploadRejectionBody = await consoleGoUploadRejectionBody(
          upstreamResponse,
          consoleGoUploadRetryGuard.attempted,
          upstream.signal,
        );
        if (uploadRejectionBody !== undefined
          && isTransientConsoleGoUploadRejection({
            status: upstreamResponse.status,
            errorBody: uploadRejectionBody,
            outboundUrl: transportState.sameTargetRequest?.url,
          })) {
          consoleGoUploadRetryGuard.attempted = true;
          try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
          if (!upstream.signal.aborted) {
            try {
              await sleepWithAbort(CONSOLE_GO_UPLOAD_RETRY_DELAY_MS, upstream.signal);
            } catch { cleanupUpstreamAbort(); return clientCancelledResponse(); }
          }
          if (upstream.signal.aborted) { cleanupUpstreamAbort(); return clientCancelledResponse(); }
          const result = await rebuildAndRefetch("console-go-upload-retry");
          if ("failed" in result) return result.failed;
          upstreamResponse = result;
          continue recovery;
        }
      }
      // Reasoning-effort downgrade, mirroring the passthroughRecovery loop above: learn the
      // refused rung, then replay once at the next published one.
      if (!reasoningEffortDowngradeGuard.attempted) {
        const rejectionText = await reasoningEffortRejectionText(
          upstreamResponse,
          reasoningEffortDowngradeGuard.attempted,
          upstream.signal,
        );
        const downgrade = rejectionText === undefined
          ? undefined
          : planReasoningEffortDowngrade({
              provider: route.provider,
              modelId: parsed.modelId,
              requested: parsed.options.reasoning,
              rejectionText,
            });
        if (downgrade) {
          reasoningEffortDowngradeGuard.attempted = true;
          parsed.options.reasoning = downgrade.effort;
          // The same-target cache keys on parsed identity, so a mutated effort needs a token bump.
          invalidateSameTargetRequest();
          try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
          const result = await rebuildAndRefetch("reasoning-effort-downgrade");
          if ("failed" in result) return result.failed;
          upstreamResponse = result;
          continue recovery;
        }
      }
      break;
    }
    if (!upstreamResponse.ok) {
      if (options.comboAttempt) {
        // No pre-read guard: `consumeComboFailure` -> `readBoundedResponseBody` reads
        // `response.body` itself with the abort signal threaded through, and the combo
        // contract is that this body's getter is touched exactly once. A guard here would be
        // a second `.body` access for no gain, since the bounded reader owns settlement.
        const failure = await consumeComboFailure(upstreamResponse, options.abortSignal)
          .finally(cleanupUpstreamAbort);
        options.onConsumedComboFailure?.(failure);
        return failure.response;
      }
      let errorText: string;
      try {
        errorText = await readDisplaySafeErrorText(
          upstreamResponse,
          upstream.signal,
          "unknown error",
        );
      } finally {
        cleanupUpstreamAbort();
      }
      if (upstreamResponse.status === 413) {
        return clientRequestedStream
          ? streamingContextOverflowResponse(parsed._responseModelId ?? parsed.modelId, translatorBudget)
          : jsonContextOverflowResponse();
      }
      if (!isFixedCodexAccount(admissionState.authCtx)) {
        recordSubagentQuotaFailureForThreadSpawn(
          req.headers,
          subagentQuotaFailureModel,
          upstreamResponse.status === 429 || upstreamResponse.status === 402
            ? upstreamResponse.status
            : `Provider error ${upstreamResponse.status}: ${redactSecretString(errorText.slice(0, 500))}`,
          config,
          requestState.subagentFallbackAccountId,
        );
      }
      // Upstreams occasionally echo request details in error bodies — scrub token-shaped
      // material before it reaches the client-facing error surface.
      const upstreamRetryAfter = upstreamResponse.headers.get("retry-after");
      const normalized = normalizeUpstreamErrorText(errorText, "unknown error");
      const message = normalized.cyberPolicy
        ? normalized.message
          ?? (isCyberPolicyCode(normalized.code) ? CYBER_POLICY_FALLBACK_MESSAGE : normalized.safeText)
        : enrichOpenCodeZenUpstreamMessage(
          `Provider error ${upstreamResponse.status}: ${normalized.safeText}`,
          {
            status: upstreamResponse.status,
            providerName: route.providerName,
            baseUrl: route.provider.baseUrl,
            adapter: route.provider.adapter,
            authMode: route.provider.authMode,
            hasApiKey: Boolean(route.provider.apiKey?.trim()),
            upstreamRetryAfter,
            // This recovery path is the HTTP Responses wire; custom runTurn transports
            // never reach enrichOpenCodeZenUpstreamMessage here.
            supportsHttpSameKeyRetry: true,
          },
        );
      const retryAfter = normalized.cyberPolicy
        ? undefined
        : resolveClientRetryAfter({
          status: upstreamResponse.status,
          message,
          upstreamRetryAfter,
        });
      return formatErrorResponse(
        upstreamResponse.status,
        normalized.cyberPolicy ? (normalized.type ?? CYBER_POLICY_ERROR_CODE) : "upstream_error",
        message,
        {
          ...(normalized.cyberPolicy ? { code: CYBER_POLICY_ERROR_CODE } : {}),
          ...(retryAfter !== undefined ? { retryAfter } : {}),
        },
      );
    }
  }

  cancelBodyOnAbort(upstreamResponse.body, upstream.signal);

  return {
    upstream,
    cleanupUpstreamAbort,
    connectMs,
    stallTimeoutMs,
    upstreamResponse,
    rateLimitPolicy,
    get rateLimitRetries(): typeof rateLimitRetries {
      return rateLimitRetries;
    },
    set rateLimitRetries(value: typeof rateLimitRetries) {
      rateLimitRetries = value;
    },
  };
}

export type AdapterExchange = Exclude<Awaited<ReturnType<typeof prepareAdapterExchange>>, Response>;
