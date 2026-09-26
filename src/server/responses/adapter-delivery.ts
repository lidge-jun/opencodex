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
import {
  readResponseBodyWithInactivity,
  readResponseStreamWithInactivity,
  ResponseBodyInactivityError,
} from "../../lib/response-body-inactivity";
import { resolveStallTimeoutMs } from "../../stall-timeout";
import { clientEncoderForDelivery, deliverClientEncodedResponse } from "../inference/client-encoder-delivery";

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
  transportState: Pick<ResponsesTransport, "activeAdapter" | "bindKeyUsageFromBridge">,
  sidecarState: Pick<ResponsesSidecarAuth, "routedCompaction">,
  responseEffects: Pick<
    ResponsesEffects,
    | "cancelResponseCompletion"
    | "commitReasoningReplayServingRoute"
    | "continuationStateForResponse"
    | "notifyResponseComplete"
  >,
  completionPolicy: Pick<ResponsesCompletionPolicy, "emptyCompletionGuardEnabled">,
  adapterExchange: Pick<AdapterExchange, "upstreamResponse" | "upstream" | "cleanupUpstreamAbort" | "localUpstream">,
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
  const { upstreamResponse, upstream, cleanupUpstreamAbort, localUpstream } = adapterExchange;
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
  const bodyInactivityMs = resolveStallTimeoutMs(config.stallTimeoutSec, { localUpstream });


  if (parsed.stream) {
    // The continuation legs classify a stalled body themselves; the initial stream needs the
    // same mapping or the bridge catch reports this upstream timeout as a 500 proxy_error.
    const initialEventStream = (async function* (): AsyncGenerator<AdapterEvent> {
      try {
        for await (const event of readResponseStreamWithInactivity(
          upstreamResponse,
          upstream.signal,
          bodyInactivityMs,
          response => transportState.activeAdapter.parseStream(response, translatorBudget, logCtx.activeTierMetadata),
        )) {
          options.onCompactionRecoveryAdapterEvent?.(event);
          yield event;
        }
      } catch (error) {
        if (error instanceof ResponseBodyInactivityError) {
          yield {
            type: "error",
            message: "Upstream response body stalled before completing",
            status: 504,
            errorType: "upstream_error",
          };
          return;
        }
        throw error;
      }
    })();
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
    // One completion owner for both deliveries: the bridge calls it from its terminal, the
    // direct client encoder from the fold of the same events.
    const onCompletedResponse = (response: Record<string, unknown>, providerState?: OcxProviderContinuationState) => {
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
    };
    const clientEncoder = clientEncoderForDelivery(options, logCtx, !!routedCompaction, transportState.activeAdapter.name);
    if (clientEncoder) {
      return deliverClientEncodedResponse({
        encoder: clientEncoder,
        events: guardedEventStream,
        logCtx,
        translatorBudget,
        responseModelId: parsed._responseModelId ?? parsed.modelId,
        adapterName: transportState.activeAdapter.name,
        fold: {
          replayCacheScope: parsed._reasoningReplayScope,
          hideThinkingSummary: parsed.options.hideThinkingSummary,
          toolNsMap, declaredToolNames, toolParameterSchemas, freeformToolNames, toolSearchToolNames,
        },
        stallTimeoutSec: config.stallTimeoutSec,
        localUpstream,
        turnAdmissionLease: options.turnAdmissionLease,
        ...(options.onFirstOutput ? { onFirstOutput: options.onFirstOutput } : {}),
        stopUpstream: () => { cancelResponseCompletion(); upstream.abort(); },
        onStreamDone: cleanupUpstreamAbort,
        onCompletedResponse,
        bindUsage: usage => transportState.bindKeyUsageFromBridge(usage),
      });
    }
    const sseStream = bridgeToResponsesSSE(
      guardedEventStream, parsed._responseModelId ?? parsed.modelId, toolNsMap, freeformToolNames, toolSearchToolNames,
      () => { cancelResponseCompletion(); upstream.abort(); }, 2_000,
      {
        translatorBudget,
        replayCacheScope: parsed._reasoningReplayScope,
        ...(options.forceEmptyResponseId ? { responseId: "" } : {}),
        stallTimeoutSec: config.stallTimeoutSec,
        localUpstream,
        hideThinkingSummary: parsed.options.hideThinkingSummary,
        declaredToolNames,
        enforceDeclaredToolNames: options.inboundWire !== "chat" && options.inboundWire !== "anthropic",
      toolParameterSchemas,
        ...(options.onFirstOutput ? { onFirstOutput: options.onFirstOutput } : {}),
        ...(routedCompaction ? { compaction: true } : {}),
        // Same grok-surface split as the runTurn branch above.
        ...(logCtx.surface === "grok" ? { heartbeatStyle: "comment" as const } : {}),
        onUsage: usage => {
          // Raw adapter usage, pre wire-normalization (see the runTurn branch above).
          transportState.bindKeyUsageFromBridge(usage);
        },
        onCompletedResponse,
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
      const initialEvents = await readResponseBodyWithInactivity(
        upstreamResponse,
        upstream.signal,
        bodyInactivityMs,
        response => transportState.activeAdapter.parseResponse!(response, translatorBudget, logCtx.activeTierMetadata),
      );
      for (const event of initialEvents) options.onCompactionRecoveryAdapterEvent?.(event);
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
    } catch (error) {
      if (error instanceof ResponseBodyInactivityError) {
        return formatErrorResponse(504, "upstream_error", "Upstream response body stalled before completing");
      }
      throw error;
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
      enforceDeclaredToolNames: options.inboundWire !== "chat" && options.inboundWire !== "anthropic",
      toolParameterSchemas,
      freeformToolNames,
      toolSearchToolNames,
      ...(routedCompaction ? { compaction: true } : {}),
      onProviderState: state => { providerState = state; },
      onUsage: usage => {
        transportState.bindKeyUsageFromBridge(usage);
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
