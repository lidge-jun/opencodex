import type { ResponsesRequestContext } from "./core-options";
import type { PreparedResponsesRequest } from "./request-prepare";
import type { ResponsesTransport } from "./request-transport";
import type { ResponsesSidecarAuth } from "./request-sidecar-auth";
import type { ResponsesEffects } from "./response-effects";
import type { ResponsesSendBudget } from "./request-send-budget";
import { formatErrorResponse } from "../../bridge";
import { planWebSearch, buildWebSearchTool, runWithWebSearch } from "../../web-search";
import {
  planImageBridge,
  planVideoBridge,
  IMAGE_GEN_TOOL_NAME,
  buildImageTool,
  VIDEO_GEN_TOOL_NAME,
  buildVideoTool,
  runWithImageBridge,
  clampImageMaxRounds,
} from "../../images";
import type { ProviderAdapter } from "../../adapters/base";
import type { OcxParsedRequest } from "../../types";
import { rotateProviderTransportOn429, rateLimitRetryPolicyFor } from "../../providers/key-failover";
import {
  GENERIC_OAUTH_MAX_FAILOVERS_PER_REQUEST,
  isGenericOAuthFailoverEnabled,
  rotateGenericOAuthAccountOn429,
  failoverAccountSnapshot,
} from "../../oauth/generic-account-failover";
import {
  ANTHROPIC_POOL_MAX_FAILOVERS_PER_REQUEST,
  rotateAnthropicAccountOn429,
  getAnthropicPoolAccessSnapshot,
  formatAnthropicProviderForLog,
} from "../../oauth/anthropic-routing";
import { resolveWireProtocolOverride } from "../adapter-resolve";
import { bindRouteReasoningReplayScope, adapterNeedsForcedContinuation } from "./core-replay";
import { namespacedToolName } from "../../types";
import { providerFetch } from "./fetch-helpers";
import type { AttemptRecoveryKind } from "../../usage/log";
import { recordAdapterReasoning, recordAdapterTier } from "../request-log";
import { normalizeLogConversationId } from "../request-log-conversation";
import { rememberResponseState } from "../../responses/state";
import { trackStreamLifetime } from "../lifecycle";

/** One responsibility of the Responses request pipeline; state owners are explicit. */
export async function executeResponsesSidecars(
  requestContext: Pick<ResponsesRequestContext, "config" | "options" | "logCtx">,
  requestState: Pick<
    PreparedResponsesRequest,
    | "parsed"
    | "route"
    | "inboundWire"
    | "selectedForwardHeaders"
    | "translatorBudget"
    | "rememberKiroDeliveredFinalAnswer"
    | "responseStateOptions"
  >,
  transportState: Pick<
    ResponsesTransport,
    | "adapter"
    | "genericFailoverAccountId"
    | "genericFailovers"
    | "applyFailoverSnapshot"
    | "anthropicPoolAccountId"
    | "anthropicPoolFailovers"
    | "anthropicSessionKey"
    | "commitResolvedOAuthSelection"
    | "resolveSelectionAdapter"
    | "oauthDispatch"
    | "noteRoutedAttemptSend"
    | "bindKeyUsageFromBridge"
  >,
  sidecarState: Pick<ResponsesSidecarAuth, "routedCompaction" | "openAiSidecar">,
  responseEffects: Pick<
    ResponsesEffects,
    | "commitReasoningReplayServingRoute"
    | "continuationStateForResponse"
    | "notifyResponseComplete"
    | "cancelResponseCompletion"
  >,
  sendBudgetState: Pick<ResponsesSendBudget, "reserveCredentialHop">,
) {
  const { config, options, logCtx } = requestContext;
  const {
    applyFailoverSnapshot,
    anthropicSessionKey,
    commitResolvedOAuthSelection,
    resolveSelectionAdapter,
    oauthDispatch,
  } = transportState;
  const {
    parsed,
    route,
    inboundWire,
    translatorBudget,
    rememberKiroDeliveredFinalAnswer,
    responseStateOptions,
  } = requestState;
  const { routedCompaction, openAiSidecar } = sidecarState;
  const { reserveCredentialHop } = sendBudgetState;
  const {
    commitReasoningReplayServingRoute,
    continuationStateForResponse,
    notifyResponseComplete,
    cancelResponseCompletion,
  } = responseEffects;


  // Tool results are PAIRED by call_id. parseRequest writes it into OcxToolResultMessage.toolCallId
  // (parser.ts:738/752) without validating it, because inputItemSchema's permissive catch-all
  // (schema.ts:106) accepts a tool item whose strict schema failed only for a missing call_id. A
  // translating adapter then consumes `toolCallId: string` holding undefined: kiro-wire.ts:32
  // TypeErrors, ollama-native.ts:334 throws, and anthropic.ts:775 sends
  // "[tool_result without adjacent tool_use: undefined]" upstream (issue #3259).
  //
  // This CANNOT move into the schema. parseRequest (:2812) runs before the passthrough branch
  // (:3719), so a parse-time rejection would also kill forward/key passthrough and routed
  // compaction — paths that never read context.messages, build from _rawBody, and already
  // degrade an unpaired output to "[tool output for unknown call]" on their own.
  //
  // Keyed on the adapter, not on position: routedCompaction skips the passthrough branch above
  // yet still builds from _rawBody (see the :3703 comment).
  if (!("passthrough" in transportState.adapter && transportState.adapter.passthrough)) {
    const unpaired = parsed.context.messages.find(
      message => message.role === "toolResult"
        && (typeof (message as { toolCallId?: unknown }).toolCallId !== "string"
          || (message as { toolCallId: string }).toolCallId.length === 0),
    );
    if (unpaired) {
      // Never interpolate the tool output: this message reaches the client and the logs.
      return formatErrorResponse(
        400,
        "invalid_request_error",
        "tool result requires a non-empty string call_id",
      );
    }
  }

  // Image / web-search sidecars: plan once, then dispatch with runTurn-aware priority.
  // Routed-compaction turns must NOT hit the image bridge: compaction clears tools/_webSearch but
  // leaves _imageGeneration, so planImageBridge would activate and return a normal Responses
  // completion instead of the synthetic compaction item Codex expects (#424).
  //
  // Web-search's loop only supports buildRequest/fetch/parseStream — NOT adapter.runTurn. Sending
  // Cursor/runTurn requests into runWithWebSearch produces empty HTTP failures. So:
  //   - non-runTurn: web-search wins over image when both eligible (documented priority)
  //   - runTurn: a search plan takes priority over media bridges and is executed
  //     by executeResponsesRunTurn; the fetch loop below remains fetch-only.
  // LOCAL PATCH (runturn-websearch): runTurn adapters run their own web-search
  // loop inside executeResponsesRunTurn (src/web-search/run-turn-loop.ts); the
  // fetch-path loop below stays non-runTurn-only.
  const wsPlan = !routedCompaction
    ? planWebSearch(config, parsed, false, route.provider, route.modelId, openAiSidecar, {
      admission: options.admission, codexAuthPolicy: options.codexAuthPolicy, providerName: route.providerName,
    })
    : undefined;
  const imgPlan = !routedCompaction ? await planImageBridge(config, parsed, route.provider) : undefined;
  const vidPlan = !routedCompaction ? await planVideoBridge(config, parsed, route.provider) : undefined;
  const canRunWebSearch = !!wsPlan && !transportState.adapter.runTurn;
  const rotateSidecarProviderOn429 = async (
    retryAfter: string | null,
    responseHeaders?: Headers,
    retryParsed?: OcxParsedRequest,
  ): Promise<ProviderAdapter | null> => {
    const rotated = rotateProviderTransportOn429(config, route.providerName, route.provider, {
      retryAfter,
      now: Date.now(),
      attemptedKey: route.provider.apiKey,
      promptCacheKey: parsed.options.promptCacheKey,
    });
    if (rotated) {
      route.provider = rotated;
    } else if (
      // A POSITIVE gate, not an early return. An early `return null` here made every later arm
      // unreachable: Anthropic never has a genericFailoverAccountId (isGenericFailoverProvider
      // excludes it), so its sidecar 429s died on this guard before the Anthropic arm below
      // could ever be considered.
      transportState.genericFailoverAccountId
      && transportState.genericFailovers < GENERIC_OAUTH_MAX_FAILOVERS_PER_REQUEST
      && isGenericOAuthFailoverEnabled(config, route.providerName)
    ) {
      // Intersection with the request's shared budget. The sidecar replay is dispatched by the
      // web-search/image loop and never reaches `onSendsConsumed`, so this reservation is the
      // charge; a refusal returns null and the caller keeps the real 429 it already has.
      const hop = reserveCredentialHop(
        "auth-recovery",
        `${route.providerName}|${route.modelId}|sidecar-oauth-429`,
      );
      if (!hop.allowed) return null;
      const nextAccountId = rotateGenericOAuthAccountOn429(
        config,
        route.providerName,
        transportState.genericFailoverAccountId,
        retryAfter,
        Date.now(),
        route.modelId,
      );
      if (!nextAccountId) {
        hop.permit?.release();
        return null;
      }
      try {
        const snapshot = await failoverAccountSnapshot(route.providerName, nextAccountId);
        transportState.genericFailovers += 1;
        if (!await applyFailoverSnapshot(snapshot, retryParsed)) {
          hop.permit?.release();
          return null;
        }
      } catch {
        hop.permit?.release();
        return null;
      }
      hop.permit?.use();
    } else if (
      // Anthropic's pool is excluded from generic failover, so without this arm a 429 inside a
      // web-search or image-bridge turn was terminal even with the pool fully enabled -- while
      // the very same 429 on the main response path rotated.
      transportState.anthropicPoolAccountId
      && transportState.anthropicPoolFailovers < ANTHROPIC_POOL_MAX_FAILOVERS_PER_REQUEST
    ) {
      // Same intersection for the Anthropic roster: its own per-request bound still applies,
      // and the shared budget decides whether this request may spend another send at all.
      const hop = reserveCredentialHop(
        "auth-recovery",
        `${route.providerName}|${route.modelId}|sidecar-anthropic-429`,
      );
      if (!hop.allowed) return null;
      const nextAccountId = rotateAnthropicAccountOn429(
        config,
        transportState.anthropicPoolAccountId,
        retryAfter,
        anthropicSessionKey,
        Date.now(),
        responseHeaders,
      );
      if (!nextAccountId) {
        hop.permit?.release();
        return null;
      }
      try {
        // Deliberately NOT applyFailoverSnapshot: that helper exists to pair per-account routing
        // metadata (Copilot origin, Antigravity project, Kiro context) with its bearer. Anthropic
        // carries none, and getAnthropicPoolAccessToken is what enforces its fail-closed
        // local-cli credential rule. Both existing Anthropic rotation sites apply the token the
        // same way.
        const admitted = await commitResolvedOAuthSelection(await getAnthropicPoolAccessSnapshot(nextAccountId));
        if (!admitted) throw new Error("OAuth selection changed during recovery");
        transportState.anthropicPoolAccountId = admitted.accountId;
        transportState.anthropicPoolFailovers += 1;
        route.provider = { ...route.provider, apiKey: admitted.accessToken };
        logCtx.provider = formatAnthropicProviderForLog("anthropic", admitted.accountId, config);
      } catch {
        hop.permit?.release();
        return null;
      }
      hop.permit?.use();
    } else {
      // No key pool, no generic OAuth roster, no Anthropic pool could produce a replacement
      // credential. The 429 is terminal for this sidecar turn.
      return null;
    }
    const rotatedAdapter = resolveSelectionAdapter(
      resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, inboundWire, route.staticPolicy),
      config.cacheRetention,
    );
    // The sidecar loops build each attempt from an iteration-local shallow copy of parsed, so a
    // rebind that lands only on the outer request never reaches the wire: the retry would pair
    // the new bearer with the previous account's Kiro routing metadata and continuation identity.
    // Rebind the exact request the rotated adapter will be built from (same pattern as the
    // continuation loop's nextParsed); when the hook ran without one, the outer bind below stands.
    if (retryParsed && retryParsed !== parsed) {
      bindRouteReasoningReplayScope({
        parsed: retryParsed,
        providerName: route.providerName,
        provider: route.provider,
        adapterName: rotatedAdapter.name,
      });
    }
    bindRouteReasoningReplayScope({
      parsed,
      providerName: route.providerName,
      provider: route.provider,
      adapterName: rotatedAdapter.name,
    });
    return rotatedAdapter;
  };
  if ((imgPlan || vidPlan) && wsPlan) {
    // Web search takes priority when both are active — the media bridge cannot run
    // alongside runWithWebSearch. Surface a runtime signal so the user knows their
    // configured video/image bridge was skipped for this turn, rather than silently
    // dropping a paid capability.
    if (vidPlan) console.warn("[videos] video bridge skipped: web search is active for this turn");
    if (imgPlan) console.warn("[images] image bridge skipped: web search is active for this turn");
  }
  if ((imgPlan || vidPlan) && !wsPlan) {
    // The image bridge detects a hosted image_generation tool and requires streaming.
    // The video bridge activates from config and injects a tool — it also needs streaming
    // (the loop returns SSE). For video-only (no imgPlan) on a non-streaming request, skip
    // the bridge entirely so enabling the feature doesn't break ordinary non-streaming traffic.
    if (!parsed.stream) {
      if (imgPlan) {
        return formatErrorResponse(400, "invalid_request_error", "image bridge requires stream=true");
      }
      // Video-only: skip bridge for non-streaming requests
    } else {
    // Replace any pre-existing image_gen/video_gen aliases instead of appending duplicate wire names.
    const priorTools = parsed.context.tools ?? [];
    const bridgeTools = [...priorTools.filter(t => {
      if (t.imageGeneration) return false;
      if (t.videoGeneration) return false;
      if (imgPlan && imgPlan.toolNames.has(t.name)) return false;
      if (imgPlan && t.namespace && imgPlan.toolNames.has(namespacedToolName(t.namespace, t.name))) return false;
      // Only strip unnamespaced video_gen aliases — a namespaced MCP video_gen is left alone.
      if (vidPlan && !t.namespace && vidPlan.toolNames.has(t.name)) return false;
      return true;
    })];
    const existingNames = new Set(bridgeTools.map(t => t.name));
    if (imgPlan && !existingNames.has(IMAGE_GEN_TOOL_NAME)) bridgeTools.push(buildImageTool());
    if (vidPlan && !existingNames.has(VIDEO_GEN_TOOL_NAME)) bridgeTools.push(buildVideoTool());
    parsed.context.tools = bridgeTools;
    // Hosted image_generation tool_choice / allowed_tools must target the synthetic function name.
    // Gate on imgPlan — in a video-only turn buildImageTool() was never injected, so rewriting
    // image_generation/image_gen aliases would add an undeclared tool that strict upstreams reject.
    const tc = parsed.options.toolChoice;
    if (imgPlan && tc && typeof tc === "object" && "allowedTools" in tc && Array.isArray(tc.allowedTools)) {
      const mapped = tc.allowedTools.map(name =>
        name === "image_generation" || name === "image_gen" || (imgPlan.toolNames.has(name) ?? false)
          ? IMAGE_GEN_TOOL_NAME
          : name,
      );
      parsed.options.toolChoice = { ...tc, allowedTools: [...new Set(mapped)] };
    } else if (imgPlan && tc && typeof tc === "object" && "name" in tc && typeof tc.name === "string"
      && (tc.name === "image_generation" || imgPlan.toolNames.has(tc.name))) {
      parsed.options.toolChoice = { ...tc, name: IMAGE_GEN_TOOL_NAME };
    }
    const imageProviderFetch = providerFetch(
      route.provider,
      options.codexWsRuntimeIdentity,
      { providerName: route.providerName, modelId: route.modelId },
    );
    const imgResponse = await runWithImageBridge({
      parsed, adapter: transportState.adapter,
      incomingMeta: { headers: requestState.selectedForwardHeaders, abortSignal: options.abortSignal, translatorBudget },
      ...(imgPlan ? { plan: imgPlan } : {}),
      ...(vidPlan ? { videoPlan: vidPlan } : {}),
      forwardHeaders: requestState.selectedForwardHeaders,
      onAttemptSend: (recovery?: AttemptRecoveryKind) =>
        transportState.noteRoutedAttemptSend(logCtx.usageLogInputTokens, recovery),
      abortSignal: options.abortSignal,
      maxRounds: imgPlan && vidPlan
        ? clampImageMaxRounds(Math.min(config.images?.maxRounds ?? 3, config.images?.videoMaxRounds ?? 2))
        : imgPlan
          ? clampImageMaxRounds(config.images?.maxRounds)
          : clampImageMaxRounds(config.images?.videoMaxRounds ?? 2),
      connectTimeoutMs: config.connectTimeoutMs ?? 200_000,
      stallTimeoutSec: config.stallTimeoutSec,
      waitForRequestSlot: imageProviderFetch.waitForPacing,
      fetchImpl: imageProviderFetch.unpacedFetch ?? imageProviderFetch,
      fetchForRequest: (request, iterParsed) => {
        const fetch = providerFetch(route.provider, options.codexWsRuntimeIdentity, {
          dispatchOverride: oauthDispatch(request, iterParsed),
          providerName: route.providerName, modelId: route.modelId,
        });
        return fetch.unpacedFetch ?? fetch;
      },
      onRequestBuilt: request => {
        recordAdapterReasoning(logCtx, request);
        recordAdapterTier(logCtx, request);
      },
      ...(vidPlan?.timeoutMs ? { videoTimeoutMs: vidPlan.timeoutMs } : {}),
      onUsage: usage => {
        // Cursor may assign _cursorConversationId inside the image loop's first runTurn;
        // backfill so Logs can filter/total that opening request (parity with the normal
        // runTurn branch).
        if (!logCtx.conversationId && parsed._cursorConversationId) {
          logCtx.conversationId = normalizeLogConversationId(parsed._cursorConversationId);
        }
        transportState.bindKeyUsageFromBridge(usage);
      },
      on429: rotateSidecarProviderOn429,
      retryOn429Policy: rateLimitRetryPolicyFor(route.provider),
      ...(options.onFirstOutput ? { onFirstOutput: options.onFirstOutput } : {}),
      ...(options.forceEmptyResponseId ? { forceEmptyResponseId: true } : {}),
      onCompletedResponse: (response, providerState) => {
        commitReasoningReplayServingRoute();
        rememberKiroDeliveredFinalAnswer(transportState.adapter.name, response);
        rememberResponseState(
          parsed._rawBody,
          response,
          continuationStateForResponse(providerState),
          responseStateOptions(adapterNeedsForcedContinuation(transportState.adapter.name)),
        );
        notifyResponseComplete(response);
      },
    });
    if (imgResponse.body) {
      const imgTurnAc = new AbortController();
      imgTurnAc.signal.addEventListener("abort", cancelResponseCompletion, { once: true });
      return new Response(trackStreamLifetime(imgResponse.body, imgTurnAc, undefined, options.turnAdmissionLease), {
        status: imgResponse.status,
        headers: imgResponse.headers,
      });
    }
    return imgResponse;
    } // end else (streaming bridge)
  }

  // Web-search sidecar: Codex enabled web_search but this is a routed (non-OpenAI) model that can't
  // run it server-side. Expose web_search as a function tool and run searches via the gpt-mini sidecar
  // through the ChatGPT passthrough, looping until the model answers. Otherwise take the normal path.
  // Placed BEFORE the runTurn early-return for non-runTurn adapters so dual-tool turns dispatch
  // through web-search instead of being swallowed. runTurn adapters never enter this branch.
  if (canRunWebSearch && wsPlan) {
    parsed.context.tools = [...(parsed.context.tools ?? []), buildWebSearchTool()];
    // Resolve the mutable route at send time: a 429 rotation replaces route.provider, so retaining
    // one pre-rotation providerFetch would keep the old credential and transport pin.
    const routedProviderFetch = ((input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
      providerFetch(route.provider, options.codexWsRuntimeIdentity, {
        providerName: route.providerName,
        modelId: route.modelId,
      })(input, init)) as typeof globalThis.fetch;
    const wsResponse = await runWithWebSearch({
      parsed, adapter: transportState.adapter,
      fetchForRequest: (request, iterParsed) => providerFetch(route.provider, options.codexWsRuntimeIdentity, {
        dispatchOverride: oauthDispatch(request, iterParsed),
        providerName: route.providerName, modelId: route.modelId,
      }),
      incomingMeta: {
        headers: requestState.selectedForwardHeaders,
        abortSignal: options.abortSignal,
        translatorBudget,
        providerFetch: routedProviderFetch,
      },
      backend: wsPlan.backend,
      forwardProvider: wsPlan.forwardSidecar?.provider,
      anthropicSidecar: wsPlan.anthropicSidecar,
      xaiSidecar: wsPlan.xaiSidecar,
      geminiSidecar: wsPlan.geminiSidecar,
      xaiSearchOptions: wsPlan.xaiSearchOptions,
      // The exa key never rides the plan: read it from config at unpack time (L9).
      ...(wsPlan.exaConfigured ? { exaApiKey: config.webSearchSidecar?.exaApiKey } : {}),
      hostedTool: wsPlan.hostedTool,
      selectedForwardHeaders: wsPlan.forwardSidecar?.headers ?? requestState.selectedForwardHeaders,
      settings: wsPlan.settings,
      maxSearches: wsPlan.maxSearches,
      forceEmptyResponseId: true,
      abortSignal: options.abortSignal,
      ...(options.onFirstOutput ? { onFirstOutput: options.onFirstOutput } : {}),
      onRequestBuilt: request => {
        recordAdapterReasoning(logCtx, request);
        recordAdapterTier(logCtx, request);
      },
      onAttemptSend: (recovery?: AttemptRecoveryKind) =>
        transportState.noteRoutedAttemptSend(logCtx.usageLogInputTokens, recovery),
      onUsage: usage => {
        transportState.bindKeyUsageFromBridge(usage);
      },
      recordSidecarOutcome: wsPlan.forwardSidecar?.recordOutcome,
      connectTimeoutMs: config.connectTimeoutMs ?? 200_000,
      routedModelStallTimeoutMs: wsPlan.routedModelStallTimeoutMs,
      stallTimeoutSec: wsPlan.stallTimeoutSec,
      streamRoutedModelOutput: wsPlan.streamRoutedModelOutput,
      on429: rotateSidecarProviderOn429,
      retryOn429Policy: rateLimitRetryPolicyFor(route.provider),
      onCompletedResponse: response => {
        commitReasoningReplayServingRoute();
        notifyResponseComplete(response);
      },
    });
    // Register the sidecar stream as an active turn so drainAndShutdown waits for (or aborts)
    // in-flight web-search turns instead of skipping them during graceful shutdown.
    if (wsResponse.body) {
      const wsTurnAc = new AbortController();
      wsTurnAc.signal.addEventListener("abort", cancelResponseCompletion, { once: true });
      return new Response(trackStreamLifetime(wsResponse.body, wsTurnAc, undefined, options.turnAdmissionLease), {
        status: wsResponse.status,
        headers: wsResponse.headers,
      });
    }
    return wsResponse;
  }

  return undefined;
}
