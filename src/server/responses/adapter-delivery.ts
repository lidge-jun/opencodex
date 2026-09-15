import type { ResponsesRequestContext } from "./core-options";
import type { PreparedResponsesRequest } from "./request-prepare";
import type { ResponsesTransport } from "./request-transport";
import type { ResponsesSidecarAuth } from "./request-sidecar-auth";
import type { ResponsesEffects } from "./response-effects";
import type { ResponsesCompletionPolicy } from "./completion-policy";
import type { AdapterExchange } from "./adapter-dispatch";
import type { AdapterContinuations } from "./adapter-continuation";
import { guardTerminalEventStream } from "./terminal-guard";
import { guardEmptyCompletionEventStream } from "./empty-completion-guard";
import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse } from "../../bridge";
import type { OcxProviderContinuationState, AdapterEvent } from "../../types";
import { rememberResponseState } from "../../responses/state";
import { trackStreamLifetime } from "../lifecycle";
import { awaitThoughtSignatureDurability } from "../../responses/thought-signature-replay";
import { adapterResponseReachedServingTerminal } from "./core-replay";

/** One responsibility of the Responses request pipeline; state owners are explicit. */
export async function deliverAdapterResponse(
  requestContext: Pick<ResponsesRequestContext, "logCtx" | "options" | "config">,
  requestState: Pick<
    PreparedResponsesRequest,
    | "parsed"
    | "translatorBudget"
    | "toolBridgeMaps"
    | "rememberKiroDeliveredFinalAnswer"
    | "responseStateOptions"
  >,
  transportState: Pick<ResponsesTransport, "activeAdapter">,
  sidecarState: Pick<ResponsesSidecarAuth, "routedCompaction">,
  responseEffects: Pick<
    ResponsesEffects,
    | "cancelResponseCompletion"
    | "commitReasoningReplayServingRoute"
    | "continuationStateForResponse"
    | "notifyResponseComplete"
  >,
  completionPolicy: Pick<ResponsesCompletionPolicy, "emptyCompletionGuardEnabled">,
  adapterExchange: Pick<AdapterExchange, "upstreamResponse" | "upstream" | "cleanupUpstreamAbort">,
  continuationState: Pick<AdapterContinuations, "terminalGuardEnabled" | "fetchTerminalGuardContinuation" | "fetchGuardedEmptyCompletionRetry">,
): Promise<Response> {
  const { logCtx, options, config } = requestContext;
  const {
    parsed,
    translatorBudget,
    toolBridgeMaps,
    rememberKiroDeliveredFinalAnswer,
    responseStateOptions,
  } = requestState;
  const { upstreamResponse, upstream, cleanupUpstreamAbort } = adapterExchange;
  const {
    terminalGuardEnabled,
    fetchTerminalGuardContinuation,
    fetchGuardedEmptyCompletionRetry,
  } = continuationState;
  const { emptyCompletionGuardEnabled } = completionPolicy;
  const {
    cancelResponseCompletion,
    commitReasoningReplayServingRoute,
    continuationStateForResponse,
    notifyResponseComplete,
  } = responseEffects;
  const { routedCompaction } = sidecarState;


  if (parsed.stream) {
    const initialEventStream = transportState.activeAdapter.parseStream(
      upstreamResponse,
      translatorBudget,
      logCtx.activeTierMetadata,
    );
    const eventStream = terminalGuardEnabled
      ? guardTerminalEventStream({
          parsed,
          firstEvents: initialEventStream,
          adapterName: transportState.activeAdapter.name,
          maxAutoContinuations: 1,
          continuation: fetchTerminalGuardContinuation,
        })
      : initialEventStream;
    // The empty-completion guard sits OUTSIDE the terminal guard: a completed
    // turn with no text and no tool call is retried with the IDENTICAL request
    // (fetchTerminalGuardContinuation(parsed) replays the cached byte-identical
    // request — same body, same headers, same signal).
    const guardedEventStream = emptyCompletionGuardEnabled
      ? guardEmptyCompletionEventStream({
          firstEvents: eventStream,
          continuation: fetchGuardedEmptyCompletionRetry,
        })
      : eventStream;
    const { toolNsMap, declaredToolNames, toolParameterSchemas, freeformToolNames, toolSearchToolNames } = toolBridgeMaps;
    const sseStream = bridgeToResponsesSSE(
      guardedEventStream, parsed._responseModelId ?? parsed.modelId, toolNsMap, freeformToolNames, toolSearchToolNames,
      () => { cancelResponseCompletion(); upstream.abort(); }, 2_000,
      {
        translatorBudget,
        replayCacheScope: parsed._reasoningReplayScope,
        ...(options.forceEmptyResponseId ? { responseId: "" } : {}),
        stallTimeoutSec: config.stallTimeoutSec,
        hideThinkingSummary: parsed.options.hideThinkingSummary,
        declaredToolNames,
      toolParameterSchemas,
        ...(options.onFirstOutput ? { onFirstOutput: options.onFirstOutput } : {}),
        ...(routedCompaction ? { compaction: true } : {}),
        // Same grok-surface split as the runTurn branch above.
        ...(logCtx.surface === "grok" ? { heartbeatStyle: "comment" as const } : {}),
        onUsage: usage => {
          // Raw adapter usage, pre wire-normalization (see the runTurn branch above).
          logCtx.usageFromBridge = true;
          if (usage) {
            logCtx.usage = usage;
            if (logCtx.activeAttempt) logCtx.activeAttempt.usage = usage;
          }
        },
        onCompletedResponse: (response: Record<string, unknown>, providerState?: OcxProviderContinuationState) => {
          commitReasoningReplayServingRoute();
          rememberKiroDeliveredFinalAnswer(transportState.activeAdapter.name, response);
          // Compaction turns must NOT enter the continuation cache: _rawBody still holds the full
          // PRE-compaction history, and a later previous_response_id expansion would rehydrate the
          // giant stale chain Codex just replaced.
          if (!routedCompaction) {
            rememberResponseState(
              parsed._rawBody,
              response,
              continuationStateForResponse(providerState),
              responseStateOptions(transportState.activeAdapter.name === "kiro"),
            );
          }
          notifyResponseComplete(response);
        },
      },
    );
    const bridgeTurnAc = new AbortController();
    const trackedSse = trackStreamLifetime(sseStream, bridgeTurnAc, cleanupUpstreamAbort, options.turnAdmissionLease);
    return new Response(trackedSse, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" },
    });
  }

  if (transportState.activeAdapter.parseResponse) {
    let events: AdapterEvent[];
    try {
      const initialEvents = await transportState.activeAdapter.parseResponse(
        upstreamResponse,
        translatorBudget,
        logCtx.activeTierMetadata,
      );
      let guardedEvents: AdapterEvent[];
      if (terminalGuardEnabled) {
        guardedEvents = [];
        for await (const event of guardTerminalEventStream({
          parsed,
          firstEvents: (async function* () { yield* initialEvents; })(),
          adapterName: transportState.activeAdapter.name,
          maxAutoContinuations: 1,
          continuation: fetchTerminalGuardContinuation,
        })) guardedEvents.push(event);
      } else {
        guardedEvents = initialEvents;
      }
      if (emptyCompletionGuardEnabled) {
        events = [];
        for await (const event of guardEmptyCompletionEventStream({
          firstEvents: (async function* () { yield* guardedEvents; })(),
          continuation: fetchGuardedEmptyCompletionRetry,
        })) events.push(event);
      } else {
        events = guardedEvents;
      }
    } finally {
      cleanupUpstreamAbort();
    }
    const { toolNsMap, declaredToolNames, toolParameterSchemas, freeformToolNames, toolSearchToolNames } = toolBridgeMaps;
    let providerState: OcxProviderContinuationState | undefined;
    const json = buildResponseJSON(events, parsed._responseModelId ?? parsed.modelId, {
      translatorBudget,
      replayCacheScope: parsed._reasoningReplayScope,
      hideThinkingSummary: parsed.options.hideThinkingSummary,
      toolNsMap,
      declaredToolNames,
      toolParameterSchemas,
      freeformToolNames,
      toolSearchToolNames,
      ...(routedCompaction ? { compaction: true } : {}),
      onProviderState: state => { providerState = state; },
      onUsage: usage => {
        logCtx.usageFromBridge = true;
        if (usage) {
          logCtx.usage = usage;
          if (logCtx.activeAttempt) logCtx.activeAttempt.usage = usage;
        }
      },
    });
    // See the streaming branch: compaction turns skip the continuation cache.
    if (!routedCompaction) {
      rememberKiroDeliveredFinalAnswer(transportState.activeAdapter.name, json);
      rememberResponseState(
        parsed._rawBody,
        json,
        continuationStateForResponse(providerState),
        responseStateOptions(transportState.activeAdapter.name === "kiro"),
      );
    }
    // #1926 gap 2: same buffered-path durability bound as the primary branch.
    await awaitThoughtSignatureDurability();
    if (adapterResponseReachedServingTerminal(events, json)) {
      commitReasoningReplayServingRoute();
    }
    notifyResponseComplete(json);
    return new Response(JSON.stringify(json), { headers: { "Content-Type": "application/json" } });
  }

  return formatErrorResponse(400, "invalid_request_error", "Non-streaming not supported by this adapter");
}
