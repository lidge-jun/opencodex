import type { ResponsesRequestContext } from "./core-options";
import type { PreparedResponsesRequest } from "./request-prepare";
import type { ResponsesTransport } from "./request-transport";
import type { ResponsesSidecarAuth } from "./request-sidecar-auth";
import type { ResponsesSendBudget } from "./request-send-budget";
import type { AdapterExchange } from "./adapter-dispatch";
import type { OcxParsedRequest, AdapterEvent } from "../../types";
import type { AttemptRecoveryKind } from "../../usage/log";
import type { AdapterRequest } from "../../adapters/base";
import {
  recordAdapterReasoning,
  recordAdapterTier,
  sealRequestAttemptIdentity,
  recordAttemptCredentialSource,
} from "../request-log";
import { noteAttemptRecoveryWithheld } from "../request-log";
import { waitForProviderRequestSlot } from "../../providers/request-pacing";
import { providerFetch, fetchWithHeaderTimeout, safeHostLabel } from "./fetch-helpers";
import {
  transientRetryPolicyFor,
  rateLimitRetryDelayMs,
  hasKeyPoolFailover,
  rotateProviderTransportOn429,
} from "../../providers/key-failover";
import {
  fetchWithTransientRetry,
  fetchWithResetRetry,
  applyUpstreamRecoveryInit,
  isNonReplayableResponse,
  prepareSameTarget429Wait,
} from "../../lib/upstream-retry";
import { redactSecretString } from "../../lib/redact";
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
  hasEligibleGenericOAuthFailoverTarget,
  isGenericOAuthFailoverEnabled,
  rotateGenericOAuthAccountOn429,
  failoverAccountSnapshot,
} from "../../oauth/generic-account-failover";
import { shouldAttemptImageTierRetry } from "../image-retry";
import { readDisplaySafeErrorText, normalizeUpstreamErrorText } from "./core-errors";
import { isCyberPolicyCode, CYBER_POLICY_FALLBACK_MESSAGE, CYBER_POLICY_ERROR_CODE } from "../../lib/errors";
import {
  readResponseBodyWithInactivity,
  readResponseStreamWithInactivity,
  ResponseBodyInactivityError,
} from "../../lib/response-body-inactivity";
import { resolveStallTimeoutSec } from "../../stall-timeout";
import { guardTerminalEventStream } from "./terminal-guard";

/** One responsibility of the Responses request pipeline; state owners are explicit. */
export function createAdapterContinuations(
  requestContext: Pick<ResponsesRequestContext, "options" | "logCtx" | "config">,
  requestState: Pick<
    PreparedResponsesRequest,
    | "route"
    | "selectedForwardHeaders"
    | "translatorBudget"
    | "inboundWire"
    | "parsed"
  >,
  transportState: Pick<
    ResponsesTransport,
    | "activeAdapter"
    | "sameTargetRequest"
    | "sameTargetParsed"
    | "sameTargetToken"
    | "transportToken"
    | "imageTierBias"
    | "oauthDispatch"
    | "invalidateSameTargetRequest"
    | "resolveSelectionAdapter"
    | "anthropicPoolAccountId"
    | "anthropicPoolFailovers"
    | "anthropicSessionKey"
    | "commitResolvedOAuthSelection"
    | "genericFailoverAccountId"
    | "genericFailovers"
    | "applyFailoverSnapshot"
    | "replayOAuthCredentialSnapshot"
    | "noteRoutedAttemptSend"
  >,
  sidecarState: Pick<ResponsesSidecarAuth, "routedCompaction">,
  sendBudgetState: Pick<
    ResponsesSendBudget,
    | "adapterDispatchBudget"
    | "noteAdapterPhysicalSend"
    | "noteAdapterRecoveryWithheld"
    | "remainingTransientSendBudget"
    | "noteTransientSends"
    | "reserveCredentialHop"
    | "pendingHopPermit"
    | "sendBudgetExhausted"
  >,
  adapterExchange: Pick<
    AdapterExchange,
    | "upstream"
    | "connectMs"
    | "rateLimitPolicy"
    | "rateLimitRetries"
    | "stallTimeoutMs"
  >,
) {
  const { options, logCtx, config } = requestContext;
  const {
    oauthDispatch,
    invalidateSameTargetRequest,
    resolveSelectionAdapter,
    anthropicSessionKey,
    commitResolvedOAuthSelection,
    applyFailoverSnapshot,
  } = transportState;
  const { route, translatorBudget, inboundWire, parsed } = requestState;
  const { routedCompaction } = sidecarState;
  const { upstream, connectMs, rateLimitPolicy, stallTimeoutMs } = adapterExchange;
  const bodyInactivityMs = resolveStallTimeoutSec(config.stallTimeoutSec) * 1000;
  const {
    adapterDispatchBudget,
    noteAdapterPhysicalSend,
    noteAdapterRecoveryWithheld,
    remainingTransientSendBudget,
    noteTransientSends,
    reserveCredentialHop,
    sendBudgetExhausted,
  } = sendBudgetState;


  // One bounded internal continuation re-ask for clean end_turn turns that announced an edit
  // without emitting a tool call. Anthropic gets this by default; openai-chat providers opt in
  // per-provider via `terminalContinuationGuard` (the heuristic was tuned on Anthropic turns,
  // so it stays off for the shared openai-chat adapter unless a provider enables it).
  const terminalGuardEnabled = (transportState.activeAdapter.name === "anthropic"
      || (transportState.activeAdapter.name === "openai-chat" && route.provider.terminalContinuationGuard === true))
    && !options.comboAttempt && !routedCompaction;
  /**
   * One bounded internal re-ask for Anthropic end_turn-without-tool-call turns. Replays the
   * continuation on a 429 with the same-key retry budget (hoisted per request), then falls
   * back to key/account failover; a failure becomes an in-stream adapter error so the client
   * never sees a second hidden HTTP response or an unbounded retry loop.
   */
  const fetchTerminalGuardContinuation = async function* (
    nextParsed: OcxParsedRequest,
    initialRecoveryKind?: AttemptRecoveryKind,
  ): AsyncGenerator<AdapterEvent> {
    let response: Response | undefined;
    // One-shot recovery label for the next top-of-loop continuation send after a failover rotation.
    let nextContinuationRecoveryKind: AttemptRecoveryKind | undefined = initialRecoveryKind;
    /**
     * Build and fetch one terminal-guard continuation. `recoveryKind` tags same-target and
     * failover sends (`empty-completion`, `rate-limit-429`, `key-429`,
     * `anthropic-oauth-429`, `image-413`); the
     * adapter rebuild is deterministic for the same parsed request (tests assert byte-identical
     * replays).
     */
    const fetchContinuation = async (recoveryKind?: AttemptRecoveryKind): Promise<Response> => {
      let continuationRequest: AdapterRequest | undefined;
      if (transportState.sameTargetRequest !== undefined && transportState.sameTargetParsed === nextParsed && transportState.sameTargetToken === transportState.transportToken) {
        // Same target (key/adapter/parsed/tier unchanged): replay the exact cached request.
        continuationRequest = transportState.sameTargetRequest;
      } else {
        try {
          continuationRequest = await transportState.activeAdapter.buildRequest(nextParsed, {
            headers: requestState.selectedForwardHeaders,
            translatorBudget,
            ...(transportState.imageTierBias > 0 ? { imageTierBias: transportState.imageTierBias } : {}),
          });
          recordAdapterReasoning(logCtx, continuationRequest);
          recordAdapterTier(logCtx, continuationRequest);
        } catch (err) {
          // The main body is already streaming, so there is no HTTP error surface: release
          // any partial body observation and surface the failure as an in-stream error via
          // the outer catch (no upstream.abort() — that would kill the live body stream).
          continuationRequest?.releaseBodyObservation?.();
          throw err;
        }
        transportState.sameTargetRequest = continuationRequest;
        transportState.sameTargetParsed = nextParsed;
        transportState.sameTargetToken = transportState.transportToken;
      }
      // Both branches assign the request (the build catch rethrows), so capture it in a
      // const for the fetch callback and finally below — a `let` read inside a nested
      // function keeps its undefined half, which would break the byte-identical replay.
      const builtContinuationRequest = continuationRequest;
      const continuationEstimate = typeof builtContinuationRequest.usageLog?.inputTokens === "number"
        ? builtContinuationRequest.usageLog.inputTokens
        : undefined;
      if (continuationEstimate !== undefined) logCtx.usageLogInputTokens = continuationEstimate;
      // Optional recovery label for same-target / failover continuation sends.
      const replayKind: AttemptRecoveryKind | undefined = recoveryKind;
      try {
        if (transportState.activeAdapter.fetchResponse) {
          transportState.noteRoutedAttemptSend(continuationEstimate, replayKind);
          await waitForProviderRequestSlot(route.providerName, route.provider, nextParsed.modelId, upstream.signal);
          return await transportState.activeAdapter.fetchResponse(builtContinuationRequest, {
            abortSignal: upstream.signal,
            timeoutMs: connectMs,
              sendBudget: adapterDispatchBudget,
            onPhysicalSend: send => noteAdapterPhysicalSend(continuationEstimate, send),
            onRecoveryWithheld: noteAdapterRecoveryWithheld,
            stream: nextParsed.stream,
            executor: providerFetch(route.provider, options.codexWsRuntimeIdentity, {
              pacingSlotAcquired: true,
              dispatchOverride: oauthDispatch(builtContinuationRequest, nextParsed),
              providerName: route.providerName,
              modelId: nextParsed.modelId,
            }),
          });
        }
        // Same #1851 scope guard as the initial send: transient-5xx retry only for direct
        // Google AI Studio; every other adapter keeps reset-only semantics here.
        const continuationTransientPolicy = transientRetryPolicyFor(route.provider);
        const fetchContinuationWithRetryPolicy = (route.provider.adapter === "google" || continuationTransientPolicy)
          ? fetchWithTransientRetry
          : fetchWithResetRetry;
        return await fetchContinuationWithRetryPolicy(
          recovery => {
            transportState.noteRoutedAttemptSend(continuationEstimate, recovery ?? replayKind);
            return fetchWithHeaderTimeout(
              builtContinuationRequest.url,
              applyUpstreamRecoveryInit({
                method: builtContinuationRequest.method,
                headers: builtContinuationRequest.headers,
                body: builtContinuationRequest.body,
              }, recovery),
              upstream.signal,
              connectMs,
              nextParsed.stream,
              providerFetch(route.provider, options.codexWsRuntimeIdentity, {
              dispatchOverride: oauthDispatch(builtContinuationRequest, nextParsed),
                providerName: route.providerName,
                modelId: nextParsed.modelId,
              }),
            );
          },
          {
            abortSignal: upstream.signal,
            label: safeHostLabel(builtContinuationRequest.url),
            // Same request-scoped budget as the initial send and the 429/rotation refetches:
            // a terminal-guard continuation is another leg of ONE request, so handing it a
            // fresh `attempts` would let one request exceed the configured total-send ceiling.
            ...(continuationTransientPolicy
              ? {
                attempts: remainingTransientSendBudget(continuationTransientPolicy.attempts),
                onSendsConsumed: noteTransientSends,
              }
              : {}),
          },
          );
      } finally {
        builtContinuationRequest.releaseBodyObservation?.();
      }
    };
    while (true) {
      try {
        const recoveryKind = nextContinuationRecoveryKind;
        nextContinuationRecoveryKind = undefined;
        response = await fetchContinuation(recoveryKind);
      } catch (error) {
        if (options.abortSignal?.aborted || upstream.signal.aborted) {
          yield { type: "error", message: "client closed request during terminal continuation", status: 499 };
        } else {
          yield { type: "error", message: `Provider continuation failed: ${redactSecretString(error instanceof Error ? error.message : String(error))}` };
        }
        return;
      }

      // Same-target 429 wait-and-retry (opt-in `retryOn429`) before key/account failover:
      // a primary-key rate-limit blip replays on the SAME key, matching the main recovery
      // loop; only after the attempts are exhausted does the continuation fail over.
     while (
       response.status === 429
        // A synthesized replay refusal is not a rate limit; replaying the continuation on
        // it would re-send a turn whose first send may already have been processed.
        && !isNonReplayableResponse(response)
       && rateLimitPolicy !== null
        && adapterExchange.rateLimitRetries < rateLimitPolicy.attempts
        // The main recovery loop and the passthrough ladder both consult the shared remainder
        // here; this loop did not, so a request whose budget was already spent could still
        // same-key replay on a live stream. Checked BEFORE the wait below cancels the body, so
        // a refusal keeps the real upstream 429 -- status, Retry-After, quota evidence -- intact.
        && !sendBudgetExhausted()
      ) {
        adapterExchange.rateLimitRetries += 1;
        // Release unread body + heartbeat-fed wait via the shared same-target helper.
        const retryAfterHeader = response.headers.get("retry-after");
        try {
          yield* prepareSameTarget429Wait({
            body: response.body,
            // Listen on the upstream signal: once the SSE body is being streamed, a client
            // cancel aborts `upstream` through the bridge, and upstream is also linked from
            // options.abortSignal — so this covers both cancellation paths.
            signal: upstream.signal,
            delayMs: rateLimitRetryDelayMs(rateLimitPolicy, retryAfterHeader, Date.now()),
            heartbeatIntervalMs: Math.min(10_000, Math.max(250, stallTimeoutMs / 2)),
          });
        } catch {
          if (options.abortSignal?.aborted || upstream.signal.aborted) {
            yield { type: "error", message: "client closed request during terminal continuation", status: 499 };
          } else {
            yield { type: "error", message: "Provider continuation failed: retry wait interrupted" };
          }
          return;
        }
        // Client cancellation wins over any stale timer edge: re-check before dispatching the
        // replay so the continuation never starts work for a request the client abandoned.
        if (options.abortSignal?.aborted || upstream.signal.aborted) {
          yield { type: "error", message: "client closed request during terminal continuation", status: 499 };
          return;
        }
        try {
          response = await fetchContinuation("rate-limit-429");
        } catch (error) {
          if (options.abortSignal?.aborted || upstream.signal.aborted) {
            yield { type: "error", message: "client closed request during terminal continuation", status: 499 };
          } else {
            yield { type: "error", message: `Provider continuation failed: ${redactSecretString(error instanceof Error ? error.message : String(error))}` };
          }
          return;
        }
      }

      if (response.status === 429 && !isNonReplayableResponse(response) && hasKeyPoolFailover(route.provider)) {
        const rotated = rotateProviderTransportOn429(config, route.providerName, route.provider, {
          retryAfter: response.headers.get("retry-after"),
          now: Date.now(),
          attemptedKey: route.provider.apiKey,
          promptCacheKey: nextParsed.options.promptCacheKey,
        });
        if (rotated) {
          try { void response.body?.cancel().catch(() => {}); } catch { /* already closed */ }
          route.provider = rotated;
          invalidateSameTargetRequest();
          transportState.activeAdapter = resolveSelectionAdapter(
            resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, inboundWire, route.staticPolicy),
            config.cacheRetention,
          );
          bindRouteReasoningReplayScope({
            parsed: nextParsed,
            providerName: route.providerName,
            provider: route.provider,
            adapterName: transportState.activeAdapter.name,
          });
          // Response persistence closes over the outer parsed request; keep its owner binding in
          // sync with the terminal-guard clone that builds the rotated continuation request.
          bindRouteReasoningReplayScope({
            parsed,
            providerName: route.providerName,
            provider: route.provider,
            adapterName: transportState.activeAdapter.name,
          });
          nextContinuationRecoveryKind = "key-429";
          continue;
        }
      }
     if (
       response.status === 429
       && transportState.anthropicPoolAccountId
        && !isNonReplayableResponse(response)
       && transportState.anthropicPoolFailovers < ANTHROPIC_POOL_MAX_FAILOVERS_PER_REQUEST
      ) {
        const nextAccountId = rotateAnthropicAccountOn429(
          config,
          transportState.anthropicPoolAccountId,
          response.headers.get("retry-after"),
          anthropicSessionKey,
          Date.now(),
          response.headers,
        );
        if (nextAccountId) {
          try { void response.body?.cancel().catch(() => {}); } catch { /* already closed */ }
          try {
            const admitted = await commitResolvedOAuthSelection(await getAnthropicPoolAccessSnapshot(nextAccountId));
            if (!admitted) throw new Error("OAuth selection changed during recovery");
            transportState.anthropicPoolAccountId = admitted.accountId;
            transportState.anthropicPoolFailovers += 1;
            route.provider = { ...route.provider, apiKey: admitted.accessToken };
            invalidateSameTargetRequest();
            logCtx.provider = formatAnthropicProviderForLog("anthropic", admitted.accountId, config);
            transportState.activeAdapter = resolveSelectionAdapter(
              resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, inboundWire, route.staticPolicy),
              config.cacheRetention,
            );
            sealRequestAttemptIdentity(logCtx.activeAttempt, logCtx.provider, transportState.activeAdapter.name, logCtx.accountLogLabel);
            recordAttemptCredentialSource(logCtx.activeAttempt, route.providerName, route.provider, transportState.activeAdapter.name);
            nextContinuationRecoveryKind = "anthropic-oauth-429";
            continue;
          } catch {
            // fall through to emit continuation error below
          }
        }
      }
      // Generic OAuth rotation for the continuation loop. The streaming loop grew this arm with
      // #2568 and this one did not, so an xAI/Cursor/Kimi/Copilot/Antigravity/Nous continuation
      // 429 stayed terminal even with failover fully active -- the same class of divergence the
      // two sidecars already produced once. Request-local state is shared with the other arms so
      // the per-request bound cannot be silently re-armed by reaching a different loop.
     if (
       response.status === 429
       && transportState.genericFailoverAccountId
        && !isNonReplayableResponse(response)
       && transportState.genericFailovers < GENERIC_OAUTH_MAX_FAILOVERS_PER_REQUEST
        && isGenericOAuthFailoverEnabled(config, route.providerName)
      ) {
        // Intersection with the shared request budget. The continuation loop re-sends the
        // turn, so without this the per-request bound could be re-armed simply by reaching a
        // different loop -- which is the divergence the comment above already warns about.
        //
        // Who settles the reservation depends on who sends the replay (#4709). An adapter that
        // owns its ladder reserves once per physical send and would charge this replay twice;
        // the helper path reports it back instead, which is what `countedExternally` names.
        const adapterOwnsDispatch = transportState.activeAdapter.fetchResponse !== undefined;
        const hop = reserveCredentialHop(
          "auth-recovery",
          `${route.providerName}|${route.modelId}|continuation-oauth-429`,
          !adapterOwnsDispatch && transientRetryPolicyFor(route.provider) !== null,
        );
        const nextAccountId = hop.allowed
          ? rotateGenericOAuthAccountOn429(
            config,
            route.providerName,
            transportState.genericFailoverAccountId,
            response.headers.get("retry-after"),
            Date.now(),
            route.modelId,
          )
          : null;
        // A roster quorum ignores cooldowns, so only attribute a budget refusal when the
        // non-mutating selector confirms that an alternate account could serve this model now.
        if (!hop.allowed && hasEligibleGenericOAuthFailoverTarget(
          route.providerName, transportState.genericFailoverAccountId, Date.now(), route.modelId,
        )) noteAttemptRecoveryWithheld(logCtx.activeAttempt, "rotation-send-budget");
        if (!nextAccountId) hop.permit?.release();
        if (nextAccountId) {
          try { void response.body?.cancel().catch(() => {}); } catch { /* already closed */ }
          try {
            // The FULL snapshot through the shared helper, never a bare bearer: Antigravity
            // pairs an account-matched projectId with its token and Kiro carries routing
            // metadata, so a token-only swap would mix one account's credential with another's
            // routing data.
            const snapshot = await failoverAccountSnapshot(route.providerName, nextAccountId);
                transportState.genericFailovers += 1;
            const applied = await applyFailoverSnapshot(snapshot, nextParsed);
            if (!applied) hop.permit?.release();
            if (applied) {
              invalidateSameTargetRequest();
              transportState.activeAdapter = resolveSelectionAdapter(
                resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, inboundWire, route.staticPolicy),
                config.cacheRetention,
              );
              bindRouteReasoningReplayScope({
                parsed: nextParsed,
                providerName: route.providerName,
                provider: route.provider,
                adapterName: transportState.activeAdapter.name,
                oauthCredentialSnapshot: transportState.replayOAuthCredentialSnapshot,
              });
              // Response persistence closes over the outer parsed request; keep its owner binding in
              // sync with the terminal-guard clone that builds the rotated continuation request.
              bindRouteReasoningReplayScope({
                parsed,
                providerName: route.providerName,
                provider: route.provider,
                adapterName: transportState.activeAdapter.name,
                oauthCredentialSnapshot: transportState.replayOAuthCredentialSnapshot,
              });
              sealRequestAttemptIdentity(logCtx.activeAttempt, logCtx.provider, transportState.activeAdapter.name, logCtx.accountLogLabel);
              recordAttemptCredentialSource(logCtx.activeAttempt, route.providerName, route.provider, transportState.activeAdapter.name);
              // The replay goes out on the next iteration. An adapter that owns its ladder
              // reserves for that send itself, so hand this reservation down rather than let it
              // take a second one for the same replay. A helper-routed replay needs no handoff:
              // its reporter settles the booking made above.
              if (adapterOwnsDispatch) sendBudgetState.pendingHopPermit = hop.permit;
              nextContinuationRecoveryKind = "oauth-account-429";
              continue;
            }
          } catch {
            // Everything in this try runs before the replay: the send happens on the next
            // iteration, after `continue`. A throw here therefore leaves a reservation that
            // never dispatched, and holding it would refuse a later recovery in this same
            // request for a send that never left the process.
            hop.permit?.release();
            // fall through to emit continuation error below
          }
        }
      }
      if (shouldAttemptImageTierRetry({
        status: response.status,
        adapterName: transportState.activeAdapter.name,
        parsed: nextParsed,
        alreadyAttempted: transportState.imageTierBias > 0,
      })) {
        transportState.imageTierBias = 1;
        invalidateSameTargetRequest();
        try { void response.body?.cancel().catch(() => {}); } catch { /* already closed */ }
        nextContinuationRecoveryKind = "image-413";
        continue;
      }
      break;
    }

    if (!response.ok) {
      const errorText = await readDisplaySafeErrorText(response, upstream.signal, "unknown error");
      const normalized = normalizeUpstreamErrorText(errorText, "unknown error");
      yield {
        type: "error",
        status: normalized.cyberPolicy ? 400 : response.status,
        message: normalized.cyberPolicy
          ? normalized.message
            ?? (isCyberPolicyCode(normalized.code) ? CYBER_POLICY_FALLBACK_MESSAGE : normalized.safeText)
          : `Provider continuation error ${response.status}: ${normalized.safeText}`,
        ...(normalized.cyberPolicy
          ? {
            errorType: normalized.type ?? CYBER_POLICY_ERROR_CODE,
            code: CYBER_POLICY_ERROR_CODE,
            retryable: false,
          }
          : {}),
      };
      return;
    }

    try {
      // Each successful continuation owns a fresh pending-read deadline and an abort
      // listener that can cancel its reader even while the parser holds the body lock.
      // The shared signal is not aborted on timeout: this generator must still emit
      // the error that the already-live Responses bridge turns into a terminal.
      if (nextParsed.stream) {
        yield* readResponseStreamWithInactivity(
          response,
          upstream.signal,
          bodyInactivityMs,
          guarded => transportState.activeAdapter.parseStream(guarded, translatorBudget, logCtx.activeTierMetadata),
        );
      } else if (transportState.activeAdapter.parseResponse) {
        yield* await readResponseBodyWithInactivity(
          response,
          upstream.signal,
          bodyInactivityMs,
          guarded => transportState.activeAdapter.parseResponse!(guarded, translatorBudget, logCtx.activeTierMetadata),
        );
      } else {
        try { void response.body?.cancel().catch(() => {}); } catch { /* already closed */ }
        yield { type: "error", message: "Provider continuation does not support response parsing" };
      }
    } catch (error) {
      // Classify the thrown error before reading signal state: cancelling the stalled
      // source can synchronously abort the shared signal, which would otherwise report
      // this timeout as a client cancellation.
      if (error instanceof ResponseBodyInactivityError) {
        yield { type: "error", message: "Provider continuation response body stalled before completing", status: 504 };
      } else if (options.abortSignal?.aborted || upstream.signal.aborted) {
        yield { type: "error", message: "client closed request during terminal continuation", status: 499 };
      } else {
        yield { type: "error", message: `Provider continuation parse failed: ${redactSecretString(error instanceof Error ? error.message : String(error))}` };
      }
    }
  };

  const fetchGuardedEmptyCompletionRetry = (): AsyncIterable<AdapterEvent> => {
    const retryEvents = fetchTerminalGuardContinuation(parsed, "empty-completion");
    return terminalGuardEnabled
      ? guardTerminalEventStream({
          parsed,
          firstEvents: retryEvents,
          adapterName: transportState.activeAdapter.name,
          maxAutoContinuations: 1,
          continuation: fetchTerminalGuardContinuation,
        })
      : retryEvents;
  };

  return {
    terminalGuardEnabled,
    fetchTerminalGuardContinuation,
    fetchGuardedEmptyCompletionRetry,
  };
}

export type AdapterContinuations = Exclude<ReturnType<typeof createAdapterContinuations>, Response>;
