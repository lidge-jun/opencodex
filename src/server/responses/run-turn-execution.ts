import type { ResponsesRequestContext, ResponsesAdmissionState } from "./core-options";
import type { PreparedResponsesRequest } from "./request-prepare";
import type { ResponsesTransport } from "./request-transport";
import type { ResponsesSidecarAuth } from "./request-sidecar-auth";
import type { ResponsesEffects } from "./response-effects";
import type { ResponsesSendBudget } from "./request-send-budget";
import type { ResponsesCompletionPolicy } from "./completion-policy";
import { linkAbortSignal, runTurnAdapterSseResponses } from "./core-lifetime";
import { createAdapterEventQueue, preflightAdapterEvents } from "../../adapters/run-turn-queue";
import {
  bindRouteReasoningReplayScope,
  adapterNeedsForcedContinuation,
  adapterResponseReachedServingTerminal,
} from "./core-replay";
import { noteAttemptRecoveryWithheld, sealRequestAttemptIdentity, recordAttemptCredentialSource } from "../request-log";
import { waitForProviderRequestSlot, RequestPacingQueueOverloadError } from "../../providers/request-pacing";
import type { AdapterEventQueue } from "../../adapters/run-turn-queue";
import type { AttemptRecoveryKind } from "../../usage/log";
import { providerFetch } from "./fetch-helpers";
import { normalizeLogConversationId } from "../request-log-conversation";
import type { AdapterEvent, OcxProviderContinuationState } from "../../types";
import { adapterFailureFromMessage, SEND_BUDGET_EXHAUSTED_CODE } from "../../lib/errors";
import { SendBudgetExhaustedError } from "../../lib/upstream-retry";
import {
  GENERIC_OAUTH_MAX_FAILOVERS_PER_REQUEST,
  isGenericOAuthFailoverEnabled,
  rotateGenericOAuthAccountOn429,
  failoverAccountSnapshot,
} from "../../oauth/generic-account-failover";
import { resolveWireProtocolOverride } from "../adapter-resolve";
import { formatErrorResponse, bridgeToResponsesSSE, buildResponseJSON } from "../../bridge";
import { redactSecretString } from "../../lib/redact";
import {
  guardEmptyCompletionEventStream,
  observeEmptyCompletion,
  emptyCompletionNotice,
} from "./empty-completion-guard";
import { rememberResponseState } from "../../responses/state";
import { trackStreamLifetime } from "../lifecycle";
import { awaitThoughtSignatureDurability } from "../../responses/thought-signature-replay";

/** One responsibility of the Responses request pipeline; state owners are explicit. */
export async function executeResponsesRunTurn(
  requestContext: Pick<ResponsesRequestContext, "options" | "logCtx" | "config">,
  admissionState: ResponsesAdmissionState,
  requestState: Pick<
    PreparedResponsesRequest,
    | "parsed"
    | "route"
    | "selectedForwardHeaders"
    | "translatorBudget"
    | "inboundWire"
    | "toolBridgeMaps"
    | "rememberKiroDeliveredFinalAnswer"
    | "responseStateOptions"
  >,
  transportState: Pick<
    ResponsesTransport,
    | "selectionIsCurrent"
    | "adapterBindings"
    | "runTurnAdapter"
    | "refreshRunTurnAdapter"
    | "replayOAuthCredentialSnapshot"
    | "genericFailoverAccountId"
    | "genericFailovers"
    | "applyFailoverSnapshot"
    | "resolveSelectionAdapter"
    | "adapter"
    | "noteRoutedAttemptSend"
    | "bindKeyUsageFromBridge"
  >,
  sidecarState: Pick<ResponsesSidecarAuth, "routedCompaction">,
  responseEffects: Pick<
    ResponsesEffects,
    | "cancelResponseCompletion"
    | "commitReasoningReplayServingRoute"
    | "continuationStateForResponse"
    | "notifyResponseComplete"
  >,
  sendBudgetState: Pick<
    ResponsesSendBudget,
    | "adapterDispatchBudget"
    | "noteAdapterPhysicalSend"
    | "noteAdapterRecoveryWithheld"
    | "reserveCredentialHop"
    | "pendingHopPermit"
  >,
  completionPolicy: Pick<ResponsesCompletionPolicy, "emptyCompletionGuardEnabled">,
): Promise<Response> {
  const { options, logCtx, config } = requestContext;
  const {
    selectionIsCurrent,
    adapterBindings,
    refreshRunTurnAdapter,
    applyFailoverSnapshot,
    resolveSelectionAdapter,
  } = transportState;
  const {
    parsed,
    route,
    translatorBudget,
    inboundWire,
    toolBridgeMaps,
    rememberKiroDeliveredFinalAnswer,
    responseStateOptions,
  } = requestState;
  const {
    adapterDispatchBudget,
    noteAdapterPhysicalSend,
    noteAdapterRecoveryWithheld,
    reserveCredentialHop,
  } = sendBudgetState;
  const { emptyCompletionGuardEnabled } = completionPolicy;
  const {
    cancelResponseCompletion,
    commitReasoningReplayServingRoute,
    continuationStateForResponse,
    notifyResponseComplete,
  } = responseEffects;
  const { routedCompaction } = sidecarState;

    const runTurnAbort = new AbortController();
    const cleanupRunTurnAbort = linkAbortSignal(runTurnAbort, options.abortSignal);
    const queue = createAdapterEventQueue({
      onBacklogExceeded: () => runTurnAbort.abort(),
    });
    const refreshRunTurnSelection = async (): Promise<void> => {
      if (selectionIsCurrent(adapterBindings.get(transportState.runTurnAdapter))) return;
      await refreshRunTurnAdapter(parsed);
      bindRouteReasoningReplayScope({ parsed, providerName: route.providerName, provider: route.provider,
        adapterName: transportState.runTurnAdapter.name, oauthCredentialSnapshot: transportState.replayOAuthCredentialSnapshot });
      sealRequestAttemptIdentity(logCtx.activeAttempt, logCtx.provider, transportState.runTurnAdapter.name, logCtx.accountLogLabel);
    };
    // Initial admission must settle before the streaming Response commits HTTP 200.
    // Let the outer Responses facade preserve the local retryable-429 contract.
    try {
      await waitForProviderRequestSlot(route.providerName, route.provider, route.modelId, runTurnAbort.signal);
    } catch (error) {
      cleanupRunTurnAbort();
      queue.close();
      throw error;
    }
    // One attempt of the runTurn transport, against an explicit queue. The
    // empty-completion guard re-invokes the IDENTICAL turn (same parsed request,
    // same forwarded headers, same abort signal) through a fresh queue, so the
    // attempt body must not capture the first queue. Each attempt consumes its
    // own provider pacing slot (#1584): retries are paced like first attempts.
    const runTurnAttempt = async (
      targetQueue: AdapterEventQueue,
      recovery?: AttemptRecoveryKind,
      pacingSlotAcquired = false,
    ): Promise<void> => {
      try {
        if (!pacingSlotAcquired) {
          await waitForProviderRequestSlot(route.providerName, route.provider, route.modelId, runTurnAbort.signal);
        }
        await refreshRunTurnSelection();
        // An adapter that reports its own sends accounts for the first one at the boundary that
        // dispatches it. Logging here would claim a send that the adapter's own budget can still
        // refuse, which is exactly what happens once earlier recovery has spent the allowance.
        const reportsOwnSends = transportState.runTurnAdapter.reportsPhysicalSends === true;
        if (!reportsOwnSends) transportState.noteRoutedAttemptSend(logCtx.usageLogInputTokens, recovery);
        const runTurnProviderFetch = providerFetch(
          route.provider,
          options.codexWsRuntimeIdentity,
          {
            providerName: route.providerName,
            modelId: route.modelId,
            // runTurnAttempt acquired this logical turn's first physical-request slot above.
            // Cursor HTTP/1.1 consumes it for RunSSE; every BidiAppend and redial then waits on
            // the same provider queue through this stateful wrapper.
            pacingSlotAcquired: true,
          },
        );
        await transportState.runTurnAdapter.runTurn?.(
          parsed,
          {
            headers: requestState.selectedForwardHeaders,
            abortSignal: runTurnAbort.signal,
            translatorBudget,
            providerFetch: runTurnProviderFetch,
            // The only way the request budget reaches a transport the adapter owns. Without it
            // a Cursor turn's inner ladder was three physical sends the cap read as one.
            ...(adapterDispatchBudget ? { sendBudget: adapterDispatchBudget } : {}),
            onPhysicalSend: send => noteAdapterPhysicalSend(
              logCtx.usageLogInputTokens,
              // The attempt's own recovery kind still labels its first send when the adapter
              // does not supply one of its own.
              { ...send, ...(send.recovery ?? recovery ? { recovery: send.recovery ?? recovery } : {}) },
              { includeFirst: reportsOwnSends },
            ),
            onRecoveryWithheld: noteAdapterRecoveryWithheld,
          },
          targetQueue.push,
        );
      } catch (err) {
        targetQueue.push(err instanceof RequestPacingQueueOverloadError
          ? {
              type: "error",
              status: 429,
              errorType: "rate_limit_error",
              retryable: true,
              message: err.message,
            }
          : err instanceof SendBudgetExhaustedError
            // A structured terminal, not a bare message. The turn is already committed to an
            // SSE response by the time most of these arrive, so the only way to carry "this
            // proxy refused" to the client is on the event itself -- an unstructured message
            // is inferred back to 502, which the Codex client retries.
            ? {
                type: "error",
                status: 429,
                errorType: "rate_limit_error",
                code: SEND_BUDGET_EXHAUSTED_CODE,
                message: err.message,
              }
            : {
                type: "error",
                message: err instanceof Error ? err.message : String(err),
              });
      } finally {
        // Cursor assigns a stable conversation id inside runTurn on the first headerless
        // turn; backfill so Logs can filter/total that opening request (#330 / #522).
        if (!logCtx.conversationId && parsed._cursorConversationId) {
          logCtx.conversationId = normalizeLogConversationId(parsed._cursorConversationId);
        }
        targetQueue.close();
      }
    };
    const runTurn = async (): Promise<void> => runTurnAttempt(queue, undefined, true);
    const rotateRunTurnAdapterOnPreflight429 = async (
      error: Extract<AdapterEvent, { type: "error" }>,
    ): Promise<boolean> => {
      // Our own refusal wears a 429 now, and rotating on it would record a cooldown against an
      // account that never rate-limited anything -- a fake quota signal that outlives the
      // request and misroutes later ones. The passthrough path has never had this problem
      // because it answers before any rotation arm is reached.
      if (error.code === SEND_BUDGET_EXHAUSTED_CODE) return false;
      const status = error.status ?? adapterFailureFromMessage(error.message).httpStatus;
      if (
        status !== 429
        || !transportState.genericFailoverAccountId
        || transportState.genericFailovers >= GENERIC_OAUTH_MAX_FAILOVERS_PER_REQUEST
        || !isGenericOAuthFailoverEnabled(config, route.providerName)
      ) return false;
      // Intersection with the request's shared budget: the roster bound above answers "may this
      // credential set rotate again", this answers "may this request send again at all". The
      // replayed turn is dispatched by runTurnAttempt and never reaches `onSendsConsumed`, so
      // this reservation is the charge. Refusing returns false, which leaves the preflight 429
      // to reach the client exactly as the adapter produced it.
      const hop = reserveCredentialHop(
        "auth-recovery",
        `${route.providerName}|${route.modelId}|runturn-oauth-429`,
      );
      if (!hop.allowed) {
        // The roster bound above already said this credential set may rotate again; the shared
        // request budget is what refused. Returning false lets the preflight 429 reach the
        // client unchanged, which is right, but it used to leave a log indistinguishable from
        // a request where no rotation was ever available (#5044).
        noteAttemptRecoveryWithheld(logCtx.activeAttempt, "rotation-send-budget");
        return false;
      }
      const nextAccountId = rotateGenericOAuthAccountOn429(
        config,
        route.providerName,
        transportState.genericFailoverAccountId,
        null,
        Date.now(),
        route.modelId,
      );
      if (!nextAccountId) {
        hop.permit?.release();
        return false;
      }
      try {
        const snapshot = await failoverAccountSnapshot(route.providerName, nextAccountId);
        transportState.genericFailovers += 1;
        const admittedSnapshot = await applyFailoverSnapshot(snapshot);
        if (!admittedSnapshot) {
          hop.permit?.release();
          return false;
        }
        // A Cursor conversation/checkpoint is credential-scoped. The failed attempt emitted no
        // client-visible bytes, so replay is safe, but carrying its account identity into the next
        // account would not be. Let the rotated adapter derive a fresh identity and conversation.
        parsed._cursorIdentityScope = undefined;
        parsed._cursorConversationId = undefined;
        if (parsed._providerContinuation?.cursor) {
          const { cursor: _discardedCursor, ...otherProviderState } = parsed._providerContinuation;
          parsed._providerContinuation = otherProviderState;
        }
        const rotatedProvider = resolveWireProtocolOverride(
          route.providerName,
          route.modelId,
          route.provider,
          inboundWire,
          route.staticPolicy,
        );
        const rotatedAdapter = resolveSelectionAdapter(rotatedProvider, config.cacheRetention);
        if (!rotatedAdapter.runTurn) {
          hop.permit?.release();
          return false;
        }
        transportState.runTurnAdapter = rotatedAdapter;
        bindRouteReasoningReplayScope({
          parsed,
          providerName: route.providerName,
          provider: rotatedProvider,
          adapterName: rotatedAdapter.name,
          oauthCredentialSnapshot: {
            accountId: admittedSnapshot.accountId,
            generation: admittedSnapshot.generation,
          },
          codexAuthContext: admissionState.authCtx,
          forwardHeaders: requestState.selectedForwardHeaders,
        });
        sealRequestAttemptIdentity(logCtx.activeAttempt, logCtx.provider, rotatedAdapter.name, logCtx.accountLogLabel);
        recordAttemptCredentialSource(logCtx.activeAttempt, route.providerName, route.provider, rotatedAdapter.name);
        // The caller replays the turn on this rotation, and a runTurn adapter dispatches through
        // its own reservation ladder -- Cursor reserves once per physical send. Confirming here
        // would leave that ladder to charge the same replay a second time (#4709), so hand the
        // reservation down and let the send that actually happens spend it.
        sendBudgetState.pendingHopPermit = hop.permit;
        return true;
      } catch {
        hop.permit?.release();
        return false;
      }
    };
    const preflightRunTurnFailover = async (
      firstSource: AsyncIterable<AdapterEvent>,
    ): Promise<AsyncIterable<AdapterEvent>> => {
      let source = firstSource;
      try {
        while (true) {
          const preflight = await preflightAdapterEvents(source);
          if (preflight.replayUnsafe
            || !preflight.error
            || !(await rotateRunTurnAdapterOnPreflight429(preflight.error))) {
            return preflight.stream;
          }
          const retryQueue = createAdapterEventQueue({
            onBacklogExceeded: () => runTurnAbort.abort(),
          });
          void runTurnAttempt(retryQueue, "oauth-account-429");
          source = retryQueue.stream();
        }
      } finally {
        // A handed-down hop reservation belongs to the replay this loop dispatched, and the
        // loop only leaves after that replay's first event has arrived -- so the adapter has
        // already reserved if it was ever going to. Dropping the reference here keeps an
        // adapter that reserves nothing from leaving a free send for an unrelated later leg.
        sendBudgetState.pendingHopPermit = undefined;
      }
    };
    // The empty-completion retry re-runs the turn against a fresh queue: the
    // first queue is closed once its attempt settles, and pushing into it after
    // close is a silent no-op.
    const runTurnRetrySource = (): AsyncIterable<AdapterEvent> => {
      const retryQueue = createAdapterEventQueue({
        onBacklogExceeded: () => runTurnAbort.abort(),
      });
      void runTurnAttempt(retryQueue, "empty-completion");
      return retryQueue.stream();
    };

    const { toolNsMap, declaredToolNames, toolParameterSchemas, freeformToolNames, toolSearchToolNames } = toolBridgeMaps;
    if (parsed.stream) {
      void runTurn();
      let eventSource: AsyncIterable<AdapterEvent> = queue.stream();
      if (route.provider.authMode === "oauth" || (transportState.genericFailoverAccountId && isGenericOAuthFailoverEnabled(config, route.providerName))) {
        // Preflight holds only heartbeats and the first meaningful event. A first-event 429 can be
        // replayed transparently; after any output reaches the bridge, a later error stays terminal.
        eventSource = await preflightRunTurnFailover(eventSource);
      }
      if (options.comboAttempt) {
        const preflight = await preflightAdapterEvents(eventSource);
        if (preflight.error || preflight.empty) {
          runTurnAbort.abort();
          queue.close();
          const message = preflight.error?.message ?? "Adapter ended before producing a response";
          return formatErrorResponse(502, "upstream_error", redactSecretString(message));
        }
        eventSource = preflight.stream;
      }
      const guardedSource = emptyCompletionGuardEnabled
        ? guardEmptyCompletionEventStream({
            firstEvents: eventSource,
            // Identical-turn retry: same parsed request, same headers, same
            // signal — run the adapter transport again against a fresh queue.
            continuation: runTurnRetrySource,
          })
        // Guard off (the default): leave the stream alone, but record that the turn ended
        // empty so the user has something to correlate instead of an unexplained blank
        // result (#2472). Retrying by default would re-send a turn that may already have had
        // billable side effects, so the honest default is observability, not recovery.
        : observeEmptyCompletion(eventSource, () => {
          console.warn(emptyCompletionNotice(route.providerName, route.modelId));
        });
      const sseStream = bridgeToResponsesSSE(
        guardedSource, parsed._responseModelId ?? parsed.modelId, toolNsMap, freeformToolNames, toolSearchToolNames,
        () => {
          cancelResponseCompletion();
          runTurnAbort.abort();
          queue.close();
        }, 2_000,
        {
          translatorBudget,
          replayCacheScope: parsed._reasoningReplayScope,
          ...(options.forceEmptyResponseId ? { responseId: "" } : {}),
          stallTimeoutSec: config.stallTimeoutSec,
          hideThinkingSummary: parsed.options.hideThinkingSummary,
          declaredToolNames,
          enforceDeclaredToolNames: inboundWire !== "chat" && inboundWire !== "anthropic",
          toolParameterSchemas,
          ...(options.onFirstOutput ? { onFirstOutput: options.onFirstOutput } : {}),
          ...(routedCompaction ? { compaction: true } : {}),
          // grok-build's strict decoder dies on the typed response.heartbeat frame; its
          // eventsource layer tolerates comment keep-alives. Codex needs the opposite.
          ...(logCtx.surface === "grok" ? { heartbeatStyle: "comment" as const } : {}),
          onUsage: usage => {
            // Raw adapter usage, pre wire-normalization: the bridged SSE now always carries
            // zero-default detail objects, so provenance must come from here (cache_detail_missing).
            transportState.bindKeyUsageFromBridge(usage);
          },
          onCompletedResponse: (response: Record<string, unknown>, providerState?: OcxProviderContinuationState) => {
            commitReasoningReplayServingRoute();
            rememberKiroDeliveredFinalAnswer(transportState.adapter.name, response);
            if (!routedCompaction) {
              rememberResponseState(
                parsed._rawBody,
                response,
                continuationStateForResponse(providerState),
                responseStateOptions(adapterNeedsForcedContinuation(transportState.adapter.name)),
              );
            }
            notifyResponseComplete(response);
          },
        },
      );
      const bridgeTurnAc = new AbortController();
      const trackedSse = trackStreamLifetime(sseStream, bridgeTurnAc, undefined, options.turnAdmissionLease);
      const response = new Response(trackedSse, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" },
      });
      runTurnAdapterSseResponses.add(response);
      return response;
    }

    await runTurn();
    const firstAttemptEvents = await queue.collect();
    let runTurnEvents: AdapterEvent[] = firstAttemptEvents;
    if (route.provider.authMode === "oauth" || (transportState.genericFailoverAccountId && isGenericOAuthFailoverEnabled(config, route.providerName))) {
      runTurnEvents = [];
      for await (const event of await preflightRunTurnFailover(
        (async function* () { yield* firstAttemptEvents; })(),
      )) runTurnEvents.push(event);
    }
    let events: AdapterEvent[];
    if (emptyCompletionGuardEnabled) {
      events = [];
      for await (const event of guardEmptyCompletionEventStream({
        firstEvents: (async function* () { yield* runTurnEvents; })(),
        continuation: runTurnRetrySource,
      })) events.push(event);
    } else {
      events = runTurnEvents;
    }
    if (options.comboAttempt) {
      const firstMeaningful = events.find(event => event.type !== "heartbeat");
      if (!firstMeaningful || firstMeaningful.type === "error") {
        const message = firstMeaningful?.type === "error"
          ? firstMeaningful.message
          : "Adapter ended before producing a response";
        return formatErrorResponse(502, "upstream_error", redactSecretString(message));
      }
    }
    let providerState: OcxProviderContinuationState | undefined;
    const json = buildResponseJSON(events, parsed._responseModelId ?? parsed.modelId, {
      translatorBudget,
      replayCacheScope: parsed._reasoningReplayScope,
      hideThinkingSummary: parsed.options.hideThinkingSummary,
      toolNsMap,
      declaredToolNames,
      enforceDeclaredToolNames: inboundWire !== "chat" && inboundWire !== "anthropic",
      toolParameterSchemas,
      freeformToolNames,
      toolSearchToolNames,
      ...(routedCompaction ? { compaction: true } : {}),
      onProviderState: state => { providerState = state; },
      onUsage: usage => {
        transportState.bindKeyUsageFromBridge(usage);
      },
    });
    if (!routedCompaction) {
      rememberKiroDeliveredFinalAnswer(transportState.adapter.name, json);
      rememberResponseState(
        parsed._rawBody,
        json,
        continuationStateForResponse(providerState),
        responseStateOptions(adapterNeedsForcedContinuation(transportState.adapter.name)),
      );
    }
    // #1926 gap 2: the buffered path queued its signature persists inside
    // buildResponseJSON; bound the durability window before the JSON becomes
    // externally visible.
    await awaitThoughtSignatureDurability();
    if (adapterResponseReachedServingTerminal(events, json)) {
      commitReasoningReplayServingRoute();
    }
    notifyResponseComplete(json);
    return new Response(JSON.stringify(json), { headers: { "Content-Type": "application/json" } });
}
