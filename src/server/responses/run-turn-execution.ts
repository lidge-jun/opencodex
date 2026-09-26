import type { ResponsesRequestContext, ResponsesAdmissionState } from "./core-options";
import type { PreparedResponsesRequest } from "./request-prepare";
import type { ResponsesTransport } from "./request-transport";
import type { ResponsesSidecarAuth } from "./request-sidecar-auth";
import type { ResponsesEffects } from "./response-effects";
import type { ResponsesSendBudget } from "./request-send-budget";
import type { ResponsesCompletionPolicy } from "./completion-policy";
import { linkAbortSignal, runTurnAdapterSseResponses } from "./core-lifetime";
import { createAdapterEventQueue, preflightAdapterEvents, type AdapterEventPreflight } from "../../adapters/run-turn-queue";
import {
  bindRouteReasoningReplayScope,
  adapterNeedsForcedContinuation,
  adapterResponseReachedServingTerminal,
} from "./core-replay";
import { noteAttemptRecoveryWithheld, sealRequestAttemptIdentity, recordAttemptCredentialSource } from "../request-log";
import { releaseProviderRequestSlot, waitForProviderRequestSlot, RequestPacingQueueOverloadError, type ProviderRequestSlot } from "../../providers/request-pacing";
import type { AdapterEventQueue } from "../../adapters/run-turn-queue";
import type { AttemptRecoveryKind } from "../../usage/log";
import { providerFetch } from "./fetch-helpers";
import { normalizeLogConversationId } from "../request-log-conversation";
import { normalizeDeclaredToolName, type AdapterEvent, type OcxProviderContinuationState } from "../../types";
import { adapterFailureFromMessage, SEND_BUDGET_EXHAUSTED_CODE } from "../../lib/errors";
import { SendBudgetExhaustedError, markResponseNonReplayable } from "../../lib/upstream-retry";
import {
  hasEligibleGenericOAuthFailoverTarget,
  isGenericOAuthFailoverEnabled,
  rotateGenericOAuthAccountOn429,
  failoverAccountSnapshot,
} from "../../oauth/generic-account-failover";
import { resolveWireProtocolOverride } from "../adapter-resolve";
import { formatErrorResponse, bridgeToResponsesSSE, buildResponseJSON } from "../../bridge";
import { redactSecretString } from "../../lib/redact";
import { adapterFailureFromEvent } from "../../bridge/internal";
import { resolveClientRetryAfter } from "../../lib/retry-after";
import { DEFAULT_STALL_TIMEOUT_SEC, resolveStallTimeoutSec } from "../../stall-timeout";
import { jsonUtf8Bytes } from "../../lib/json-byte-size";
import { isTranslatorBudgetExceededError } from "../../lib/translator-budget";
import {
  guardEmptyCompletionEventStream,
  observeEmptyCompletion,
  emptyCompletionNotice,
} from "./empty-completion-guard";
import { rememberResponseState } from "../../responses/state";
import { trackStreamLifetime } from "../lifecycle";
import { awaitThoughtSignatureDurability } from "../../responses/thought-signature-replay";
import { undeclaredToolCallMessage } from "../responses-undeclared-tool-guard";
// LOCAL PATCH (runturn-websearch)
import { planWebSearch } from "../../web-search";
import { runTurnWebSearchInitialParsed, runTurnWebSearchLoop } from "../../web-search/run-turn-loop";
import { WEB_SEARCH_TOOL_NAME } from "../../web-search/synthetic-tool";

// LOCAL PATCH (runturn-websearch): top-level fields route binding or the
// adapter itself may write during a turn. Iteration-local `turnParsed` objects
// are shallow copies of `parsed`, so these are mirrored both directions around
// each runTurn dispatch — clones would otherwise keep stale route state and
// adapter-written values (e.g. Cursor's conversation id) would be lost.
const RUNTURN_WS_ROUTE_STATE_KEYS = [
  "_cursorIdentityScope",
  "_cursorConversationId",
  "_cursorClientThreadId",
  "_kiroAuthContext",
  "_providerContinuation",
  "_providerContinuationOwner",
  "_providerContinuationCandidate",
  "_stripReasoningEncryptedContent",
  "_dropForeignReasoningItemIds",
  "_reasoningReplayScope",
] as const;

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
    | "genericFailoverLimit"
    | "applyFailoverSnapshot"
    | "resolveSelectionAdapter"
    | "adapter"
    | "noteRoutedAttemptSend"
    | "bindKeyUsageFromBridge"
  >,
  sidecarState: Pick<ResponsesSidecarAuth, "routedCompaction" | "openAiSidecar">,
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

  // LOCAL PATCH (runturn-websearch): resolving the OpenAI search credential can
  // hold the account's sole cooldown-recovery probe lease. The fetch path hands
  // it back through the bridge's onFinalize; runTurn owns no such hook, so this
  // turn releases it on every exit — normal end, error, cancel, and every
  // pre-response failure below. After an executed search the outcome recorder
  // already settled the lease, making each release a generation-bound no-op.
  const releaseSearchProbeLease = (): void => {
    sidecarState.openAiSidecar?.releaseProbeLease?.();
  };
  // When Codex declared hosted web_search and a sidecar plan resolves, drive
  // the routed model through the same search interception the fetch-path loop
  // runs — injected as a function tool, calls intercepted, results appended to
  // the message history between runTurn dispatches.
  let wsPlan: ReturnType<typeof planWebSearch>;
  try {
    wsPlan = !routedCompaction
      ? planWebSearch(config, parsed, false, route.provider, route.modelId, sidecarState.openAiSidecar, {
        admission: options.admission, codexAuthPolicy: options.codexAuthPolicy, providerName: route.providerName,
      })
      : undefined;
  } catch (error) {
    releaseSearchProbeLease();
    throw error;
  }

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
    let initialPacingSlot: ProviderRequestSlot;
    try {
      initialPacingSlot = await waitForProviderRequestSlot(route.providerName, route.provider, route.modelId, runTurnAbort.signal);
    } catch (error) {
      cleanupRunTurnAbort();
      queue.close();
      releaseSearchProbeLease();
      throw error;
    }
    // One attempt of the runTurn transport, against an explicit queue. The
    // empty-completion guard re-invokes the IDENTICAL turn (same parsed request,
    // same forwarded headers, same abort signal) through a fresh queue, so the
    // attempt body must not capture the first queue. Each attempt consumes its
    // own provider pacing slot (#1584): retries are paced like first attempts.
    // LOCAL PATCH (runturn-websearch): dispatch sequence. A 429 preflight
    // rotation replays the turn while the abandoned attempt may still be
    // in-flight; only the latest dispatch may merge adapter-written route
    // state back onto `parsed`, or the superseded attempt would restore the
    // failed account's cursor/continuation over the rotation's rebind.
    let runTurnAttemptSeq = 0;
    const runTurnAttempt = async (
      targetQueue: AdapterEventQueue,
      recovery?: AttemptRecoveryKind,
      pacingSlotAcquired = false,
      // LOCAL PATCH (runturn-websearch): iteration-local parsed — later search
      // rounds carry the grown message history and adjusted tool list while
      // selection/replay binding stays on the request's own parsed object.
      turnParsed: PreparedResponsesRequest["parsed"] = parsed,
      preacquiredSlot?: ProviderRequestSlot,
    ): Promise<void> => {
      const attemptSeq = ++runTurnAttemptSeq;
      let pacingSlot = preacquiredSlot;
      const emit = (event: AdapterEvent) => {
        options.onCompactionRecoveryAdapterEvent?.(event);
        targetQueue.push(event);
      };
      try {
        if (!pacingSlotAcquired) {
          pacingSlot = await waitForProviderRequestSlot(route.providerName, route.provider, route.modelId, runTurnAbort.signal);
        }
        await refreshRunTurnSelection();
        // LOCAL PATCH (runturn-websearch): refreshRunTurnSelection binds route
        // state onto `parsed`; mirror it onto the iteration-local copy the
        // adapter actually receives.
        {
          const routeState: Record<string, unknown> = {};
          for (const k of RUNTURN_WS_ROUTE_STATE_KEYS) routeState[k] = parsed[k];
          Object.assign(turnParsed, routeState);
        }
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
            pacingSlot,
            turnScopedPacing: true,
          },
        );
        await transportState.runTurnAdapter.runTurn?.(
          turnParsed,
          {
            headers: requestState.selectedForwardHeaders,
            abortSignal: runTurnAbort.signal,
            translatorBudget,
            providerFetch: runTurnProviderFetch,
            pacingSlot,
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
          emit,
        );
        // LOCAL PATCH (runturn-websearch): adapters may write conversation/
        // continuation state onto the object they received; merge it back so
        // the next iteration's copy and request-level consumers observe it.
        // Skipped once a newer attempt has dispatched: this attempt was
        // abandoned by a 429 rotation, so its account's route state is stale
        // and writing it back would undo the rotation's rebind.
        if (attemptSeq === runTurnAttemptSeq) {
          const routeState: Record<string, unknown> = {};
          for (const k of RUNTURN_WS_ROUTE_STATE_KEYS) routeState[k] = turnParsed[k];
          Object.assign(parsed, routeState);
        }
      } catch (err) {
        emit(err instanceof RequestPacingQueueOverloadError
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
        releaseProviderRequestSlot(pacingSlot);
        // Cursor assigns a stable conversation id inside runTurn on the first headerless
        // turn; backfill so Logs can filter/total that opening request (#330 / #522).
        if (!logCtx.conversationId && parsed._cursorConversationId) {
          logCtx.conversationId = normalizeLogConversationId(parsed._cursorConversationId);
        }
        targetQueue.close();
      }
    };
    // LOCAL PATCH (runturn-websearch): the first iteration carries the
    // synthetic web_search tool; later iterations get their own queue so the
    // search loop can buffer each turn's events before deciding to intercept.
    const wsFirstParsed = wsPlan ? runTurnWebSearchInitialParsed(parsed) : parsed;
    const runTurn = async (): Promise<void> => runTurnAttempt(queue, undefined, true, wsFirstParsed, initialPacingSlot);
    const runTurnFailoverArmed = () =>
      route.provider.authMode === "oauth"
      || !!(transportState.genericFailoverAccountId
        && isGenericOAuthFailoverEnabled(config, route.providerName));
    const dispatchSearchIteration = (iterParsed: PreparedResponsesRequest["parsed"]): AsyncIterable<AdapterEvent> => {
      const iterQueue = createAdapterEventQueue({
        onBacklogExceeded: () => runTurnAbort.abort(),
      });
      void runTurnAttempt(iterQueue, undefined, false, iterParsed);
      const stream = iterQueue.stream();
      if (!runTurnFailoverArmed()) return stream;
      // LOCAL PATCH (runturn-websearch): a post-search iteration can open on a
      // 429 too — the search cells already reached the client, so only this
      // answer call rotates. Preflight replays it on the next account with the
      // grown history intact; a mid-stream error still ends the turn as before.
      return (async function* () {
        yield* await preflightRunTurnFailover(stream, iterParsed);
      })();
    };
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
        || transportState.genericFailovers >= transportState.genericFailoverLimit
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
        // The activation quorum deliberately ignores cooldowns. Attribute a withheld recovery
        // only when the non-mutating selector proves a usable alternate exists right now.
        if (hasEligibleGenericOAuthFailoverTarget(
          route.providerName, transportState.genericFailoverAccountId, Date.now(), route.modelId,
        )) noteAttemptRecoveryWithheld(logCtx.activeAttempt, "rotation-send-budget");
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
      // LOCAL PATCH (runturn-websearch): replayed attempts re-dispatch this
      // request — the grown-history iteration for post-search legs, the
      // tool-injected first request elsewhere.
      replayParsed: PreparedResponsesRequest["parsed"] = wsFirstParsed,
      deadlineAt?: number,
    ): Promise<AsyncIterable<AdapterEvent>> => {
      let source = firstSource;
      let latestRetryAttempt: Promise<void> | undefined;
      let deferPendingPermitCleanup = false;
      try {
        while (true) {
          const preflight = await preflightAdapterEvents(source, undefined, deadlineAt === undefined
            ? undefined
            : { maxWaitMs: deadlineAt - Date.now() });
          if (preflight.timedOut) {
            const pendingPermit = sendBudgetState.pendingHopPermit;
            if (pendingPermit && latestRetryAttempt) {
              // The timed-out replay may still be waiting for its first physical dispatch.
              // Keep its reservation available until the adapter claims it; if the attempt ends
              // before claiming, refund it then rather than charging a later send twice.
              deferPendingPermitCleanup = true;
              const releaseIfUnclaimed = () => {
                if (sendBudgetState.pendingHopPermit !== pendingPermit) return;
                sendBudgetState.pendingHopPermit = undefined;
                pendingPermit.release();
              };
              void latestRetryAttempt.then(releaseIfUnclaimed, releaseIfUnclaimed);
            }
            return preflight.stream;
          }
          if (preflight.replayUnsafe
            || !preflight.error
            || !(await rotateRunTurnAdapterOnPreflight429(preflight.error))) {
            return preflight.stream;
          }
          const retryQueue = createAdapterEventQueue({
            onBacklogExceeded: () => runTurnAbort.abort(),
          });
          latestRetryAttempt = runTurnAttempt(retryQueue, "oauth-account-429", false, replayParsed);
          void latestRetryAttempt;
          source = retryQueue.stream();
        }
      } finally {
        // On ordinary exit the replay's first event proves its first-send reservation was reached.
        // A timed-out replay may not have dispatched yet, so that path defers cleanup above.
        if (!deferPendingPermitCleanup) sendBudgetState.pendingHopPermit = undefined;
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
    const enforceDeclaredToolNames = inboundWire !== "chat" && inboundWire !== "anthropic";
    const classifyUndeclaredFirstTool = (
      event: AdapterEvent,
    ): Extract<AdapterEvent, { type: "error" }> | undefined => {
      if (!enforceDeclaredToolNames || event.type !== "tool_call_start") return undefined;
      // This tool is declared to the adapter by the private search loop.
      if (wsPlan && event.name === WEB_SEARCH_TOOL_NAME) return undefined;
      const effectiveName = normalizeDeclaredToolName(event.name, declaredToolNames);
      if (declaredToolNames.has(effectiveName)) return undefined;
      return {
        type: "error",
        status: 502,
        errorType: "upstream_error",
        message: undeclaredToolCallMessage(effectiveName),
      };
    };
    const grokDevinPreflight = !options.comboAttempt && logCtx.surface === "grok" && inboundWire === "responses"
      && transportState.runTurnAdapter.name === "devin";
    const grokRateLimitResponse = (preflight: AdapterEventPreflight): Response | undefined => {
      if (preflight.replayUnsafe || preflight.error?.status !== 429
        || preflight.error.code === SEND_BUDGET_EXHAUSTED_CODE) return;
      const { httpStatus, error } = adapterFailureFromEvent(preflight.error);
      cancelResponseCompletion();
      runTurnAbort.abort();
      queue.close();
      cleanupRunTurnAbort();
      releaseSearchProbeLease();
      return formatErrorResponse(httpStatus, error.type, error.message, {
        code: error.code,
        retryAfter: resolveClientRetryAfter({ status: httpStatus, message: error.message }),
      });
    };
    if (parsed.stream) {
      try {
      void runTurn();
      let eventSource: AsyncIterable<AdapterEvent> = queue.stream();
      const stallTimeoutSec = wsPlan?.stallTimeoutSec ?? config.stallTimeoutSec;
      // A disabled watchdog (0) is not a zero preflight: it would commit SSE before Devin's first
      // event and deliver a pre-output 429 in-stream. Fall back to the default finite bound.
      const preflightDeadlineAt = grokDevinPreflight
        ? Date.now() + (resolveStallTimeoutSec(stallTimeoutSec) || DEFAULT_STALL_TIMEOUT_SEC) * 1_000
        : undefined;
      if (runTurnFailoverArmed()) {
        // Preflight holds only heartbeats and the first meaningful event. A first-event 429 can be
        // replayed transparently; after any output reaches the bridge, a later error stays terminal.
        eventSource = await preflightRunTurnFailover(eventSource, wsFirstParsed, preflightDeadlineAt);
      }
      if (grokDevinPreflight) {
        const preflight = await preflightAdapterEvents(eventSource, undefined, {
          maxWaitMs: (preflightDeadlineAt ?? Date.now()) - Date.now(),
        });
        eventSource = preflight.stream;
        const refusal = grokRateLimitResponse(preflight);
        if (refusal) return refusal;
      }
      if (options.comboAttempt) {
        const preflight = await preflightAdapterEvents(eventSource, classifyUndeclaredFirstTool);
        if (preflight.error || preflight.empty) {
          runTurnAbort.abort();
          queue.close();
          const message = preflight.error?.message ?? "Adapter ended before producing a response";
          const failure = formatErrorResponse(502, "upstream_error", redactSecretString(message));
          // A replay-unsafe heartbeat means the adapter already ran a local side effect, so the
          // combo must not send this turn to another target: the failure stays with this child.
          if (preflight.replayUnsafe) markResponseNonReplayable(failure);
          releaseSearchProbeLease();
          return failure;
        }
        eventSource = preflight.stream;
      }
      // LOCAL PATCH (runturn-websearch): intercept web_search calls across
      // iterations; terminal output keeps flowing through the same queue/bridge.
      if (wsPlan) {
        eventSource = runTurnWebSearchLoop(eventSource, {
          parsed,
          plan: wsPlan,
          translatorBudget,
          emptyCompletionRetry: emptyCompletionGuardEnabled,
          forwardProvider: wsPlan.forwardSidecar?.provider,
          forwardHeaders: wsPlan.forwardSidecar?.headers ?? requestState.selectedForwardHeaders,
          ...(wsPlan.exaConfigured ? { exaApiKey: config.webSearchSidecar?.exaApiKey } : {}),
          recordSidecarOutcome: wsPlan.forwardSidecar?.recordOutcome,
          abortSignal: runTurnAbort.signal,
          dispatch: dispatchSearchIteration,
        });
      }
      // LOCAL PATCH (runturn-websearch): the empty-completion retry replays
      // the ORIGINAL parsed request — no synthetic tool, no gathered results —
      // so it must not fire while the search loop owns the turn. An empty
      // forced answer is recovered inside runTurnWebSearchLoop instead.
      const guardedSource = emptyCompletionGuardEnabled && !wsPlan
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
          stallTimeoutSec,
          hideThinkingSummary: parsed.options.hideThinkingSummary,
          declaredToolNames,
          enforceDeclaredToolNames,
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
      // LOCAL PATCH (runturn-websearch): sidecar resolution may hold the
      // account's cooldown-recovery probe. Hand it back when the stream ends —
      // completion, failure, or client cancel; a search that ran already
      // settled it through recordOutcome, so this release is a safe no-op then.
      const trackedSse = trackStreamLifetime(sseStream, bridgeTurnAc, releaseSearchProbeLease, options.turnAdmissionLease);
      const response = new Response(trackedSse, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" },
      });
      runTurnAdapterSseResponses.add(response);
      return response;
      } catch (error) {
        // Every pre-response exit hands the probe lease back too: a turn that
        // never started streaming has no later owner to release it.
        releaseSearchProbeLease();
        throw error;
      }
    }

    try {
    await runTurn();
    const firstAttemptEvents = await queue.collect();
    let runTurnEvents: AdapterEvent[] = firstAttemptEvents;
    if (runTurnFailoverArmed()) {
      runTurnEvents = [];
      for await (const event of await preflightRunTurnFailover(
        (async function* () { yield* firstAttemptEvents; })(),
      )) runTurnEvents.push(event);
    }
    if (grokDevinPreflight) {
      const preflight = await preflightAdapterEvents((async function* () { yield* runTurnEvents; })());
      const refusal = grokRateLimitResponse(preflight);
      if (refusal) return refusal;
    }
    let events: AdapterEvent[];
    // LOCAL PATCH (runturn-websearch): same exclusion as the streaming branch —
    // a search-aware retry runs inside runTurnWebSearchLoop, not the raw guard.
    if (emptyCompletionGuardEnabled && !wsPlan) {
      events = [];
      for await (const event of guardEmptyCompletionEventStream({
        firstEvents: (async function* () { yield* runTurnEvents; })(),
        continuation: runTurnRetrySource,
      })) events.push(event);
    } else {
      events = runTurnEvents;
    }
    // This collector outlives each search iteration, including live-output
    // events that the loop no longer owns. Keep its lease until JSON is built.
    let searchOutputBytes = 0;
    try {
      // LOCAL PATCH (runturn-websearch): buffered path runs the same interception
      // loop; iterations dispatch through the same attempt body on fresh queues.
      if (wsPlan) {
        const searched: AdapterEvent[] = [];
        let retainedReplayUnsafe = false;
        for await (const event of runTurnWebSearchLoop(
          (async function* () { yield* events; })(),
          {
            parsed,
            plan: wsPlan,
            translatorBudget,
            emptyCompletionRetry: emptyCompletionGuardEnabled,
            forwardProvider: wsPlan.forwardSidecar?.provider,
            forwardHeaders: wsPlan.forwardSidecar?.headers ?? requestState.selectedForwardHeaders,
            ...(wsPlan.exaConfigured ? { exaApiKey: config.webSearchSidecar?.exaApiKey } : {}),
            recordSidecarOutcome: wsPlan.forwardSidecar?.recordOutcome,
            abortSignal: runTurnAbort.signal,
            dispatch: dispatchSearchIteration,
          },
        )) {
          if (event.type === "heartbeat") {
            if (!event.replayUnsafe || retainedReplayUnsafe) continue;
            retainedReplayUnsafe = true;
          }
          if (event.type === "error" && event.code === "translation_buffer_limit") runTurnAbort.abort();
          const bytes = jsonUtf8Bytes(event) + 1;
          translatorBudget.chargeRetained(bytes, { kind: "retained_collectors" });
          searchOutputBytes += bytes;
          searched.push(event);
        }
        events = searched;
      }
      if (options.comboAttempt) {
        const firstMeaningfulIndex = events.findIndex(event => event.type !== "heartbeat");
        const firstMeaningful = firstMeaningfulIndex === -1 ? undefined : events[firstMeaningfulIndex];
        // Same boundary as the streaming preflight: a replay-unsafe heartbeat means the adapter
        // already ran a local side effect, so an undeclared tool call after it keeps the bridge's
        // fail-closed refusal instead of becoming a hop that sends the turn to another target.
        const replayUnsafe = events
          .slice(0, firstMeaningfulIndex === -1 ? events.length : firstMeaningfulIndex)
          .some(event => event.type === "heartbeat" && event.replayUnsafe === true);
        const classifiedError = firstMeaningful && !replayUnsafe
          ? classifyUndeclaredFirstTool(firstMeaningful)
          : undefined;
        if (!firstMeaningful || firstMeaningful.type === "error" || classifiedError) {
          const message = classifiedError?.message ?? (firstMeaningful?.type === "error"
            ? firstMeaningful.message
            : "Adapter ended before producing a response");
          const failure = formatErrorResponse(502, "upstream_error", redactSecretString(message));
          if (replayUnsafe) markResponseNonReplayable(failure);
          return failure;
        }
      }
      let providerState: OcxProviderContinuationState | undefined;
      const json = buildResponseJSON(events, parsed._responseModelId ?? parsed.modelId, {
        translatorBudget,
        replayCacheScope: parsed._reasoningReplayScope,
        hideThinkingSummary: parsed.options.hideThinkingSummary,
        toolNsMap,
        declaredToolNames,
        enforceDeclaredToolNames,
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
    } catch (error) {
      if (!isTranslatorBudgetExceededError(error)) throw error;
      runTurnAbort.abort();
      return formatErrorResponse(502, "upstream_error", "upstream translation buffer exceeded the safe limit", {
        code: "translation_buffer_limit",
      });
    } finally {
      translatorBudget.releaseRetained(searchOutputBytes, { kind: "retained_collectors" });
    }
    } finally {
      // The buffered turn ends inside this function, so its every exit —
      // JSON response, combo failure, or thrown error — hands the lease back.
      releaseSearchProbeLease();
    }
}
