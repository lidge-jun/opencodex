import { debugProviderDiagnostic } from "../../lib/debug";
import { isDebugEnabled } from "../../lib/debug-settings";
import {
  releaseTranslatedEvent,
  retainTranslatedEvent,
  type TranslatorBudget,
} from "../../lib/translator-budget";
import { resolveKiroApiRegion, resolveKiroRequestProfile } from "../../oauth/kiro";
import type {
  AdapterEvent,
  OcxParsedRequest,
  OcxProviderConfig,
} from "../../types";
import type { ProviderAdapter } from "../base";
import type { AdapterFetchContext, AdapterRequest } from "../base";
import type { RequestExecutionBudget } from "../../lib/request-execution-budget";
import { safeKiroHttpErrorMessage } from "../kiro-errors";
import { calibrateKiroEstimate } from "../kiro-calibration";
import { normalizeKiroImages } from "../kiro-images";
import type { KiroCompletionMode } from "../kiro-constants";
import { fetchKiroWithRetry } from "../kiro-retry";
import { fingerprint, invocationId, osTag } from "../kiro-wire";
import { hasTrailingDeliveredFinalAnswer } from "./conversation";
import { buildKiroPayload } from "./payload";
import {
  jsonStringSerializedUtf8Bytes,
  parseKiroStream,
  type KiroFallbackFactory,
} from "./stream";
import {
  estimateKiroInputTokens,
  estimateKiroLogInputTokens,
  estimateKiroPayloadInputTokens,
  kiroPayloadMessages,
  kiroUpstreamContextWindow,
} from "./usage";
import {
  AMZ_TARGET,
  KIRO_FALLBACK_SERIALIZATION_ENVELOPE_BYTES,
  KIRO_IDE_VERSION,
  kiroCliUserAgent,
  kiroRuntimeEndpoint,
  NODE_VERSION,
  SDK_VERSION,
  type KiroWireClient,
} from "./wire";

/** The physical-send observer an `AdapterFetchContext` may carry, and the record it receives. */
type KiroPhysicalSendObserver = NonNullable<AdapterFetchContext["onPhysicalSend"]>;
type KiroPhysicalSend = Parameters<KiroPhysicalSendObserver>[0];

// Adapter
export function createKiroAdapter(provider: OcxProviderConfig): ProviderAdapter {
  // Per-request closure (resolveAdapter builds a fresh adapter per request — server.ts:440 — so this
  // is race-free) carrying the heuristic input-token estimate from buildRequest into the stream.
  let inputTokens = 0;
  let contextInputEstimate = 0;
  let modelId: string | undefined;
  let contextWindow: number | undefined;
  let toolNameMap: Map<string, string> | undefined;
  let conversationId: string | undefined;
  let completionMode: KiroCompletionMode = "disabled";
  let requestSnapshot: OcxParsedRequest | undefined;
  let firstRequestBodyBytes = 0;
  let requestAbortSignal: AbortSignal | undefined;
  let requestExecutor: typeof globalThis.fetch | undefined;
  // Captured the same way as the abort signal, because the text-fallback rebuild below runs
  // outside the fetchResponse frame and used to construct a context without either (#4546).
  let requestSendBudget: RequestExecutionBudget | undefined;
  // Captured for the same reason, and needed for the same leg to be COUNTABLE rather than merely
  // bounded: the rebuild's sends were paid for out of the request budget but reported by nobody,
  // so no regression could pin how many requests one Kiro turn actually makes.
  let requestOnPhysicalSend: KiroPhysicalSendObserver | undefined;
  // One ordinal sequence across the whole turn. `fetchKiroWithRetry` numbers from 1 inside each
  // call, and the caller reads ordinal 1 as the send it already recorded itself; forwarding the
  // rebuild's raw ordinals would therefore drop its first send — the very send that makes the
  // fallback a second request rather than a continuation of the first.
  let physicalSendsObserved = 0;
  const forwardPhysicalSend = (
    send: KiroPhysicalSend,
    ordinalBase: number,
    defaultRecovery?: KiroPhysicalSend["recovery"],
  ): void => {
    const ordinal = ordinalBase + send.ordinal;
    if (ordinal > physicalSendsObserved) physicalSendsObserved = ordinal;
    const recovery = send.recovery ?? defaultRecovery;
    requestOnPhysicalSend?.({ ordinal, ...(recovery ? { recovery } : {}) });
  };

  const build = async (
    parsed: OcxParsedRequest,
    forcedCompletionMode?: KiroCompletionMode,
  ): Promise<{
    request: AdapterRequest;
    nameMap: Map<string, string>;
    conversationId: string;
    completionMode: KiroCompletionMode;
    inputTokens: number;
    contextInputEstimate: number;
  }> => {
    if (typeof provider.apiKey !== "string" || provider.apiKey.trim() === "") {
      throw new Error("kiro token missing — run ocx login kiro");
    }
    const region = resolveKiroApiRegion(parsed._kiroAuthContext);
    // Request-scoped: an AWS Builder ID account has no profile of its own and resolves to Kiro's
    // fixed service profile here, without that value ever becoming the account's stored identity.
    const requestProfile = resolveKiroRequestProfile(parsed._kiroAuthContext);
    const resolvedProfileArn = requestProfile.profileArn;
    const isApiKey = provider.apiKey.trim().startsWith("ksk_");
    const profileArn = isApiKey ? undefined : resolvedProfileArn;
    // Builder ID and Kiro API keys are accepted only on Kiro's CLI request path; enterprise
    // profiles retain the IDE-shaped request. Builder ID now carries a profile ARN, so a truthy
    // `profileArn` no longer implies "enterprise". The wire path reads the resolver's own verdict
    // rather than re-deriving it, so the accountless path — where the auth type comes from the
    // local import, not the request context — cannot send the fallback inside an IDE-shaped call.
    const isBuilderId = requestProfile.builderIdFallback;
    const wireClient: KiroWireClient = isApiKey || isBuilderId || !profileArn ? "cli" : "ide";
    const fp = fingerprint().slice(0, 64);
    const headers: Record<string, string> = wireClient === "cli" ? {
      authorization: `Bearer ${provider.apiKey}`,
      "content-type": "application/x-amz-json-1.0",
      accept: "*/*",
      "x-amz-target": AMZ_TARGET,
      "user-agent": kiroCliUserAgent(true),
      "x-amz-user-agent": kiroCliUserAgent(false),
      "x-amzn-codewhisperer-optout": "true",
      "amz-sdk-request": "attempt=1; max=3",
      "amz-sdk-invocation-id": invocationId(),
      ...(isApiKey ? { tokentype: "API_KEY" } : {}),
    } : {
      authorization: `Bearer ${provider.apiKey}`,
      "content-type": "application/x-amz-json-1.0",
      accept: "application/vnd.amazon.eventstream",
      "x-amz-target": AMZ_TARGET,
      "user-agent": `aws-sdk-js/${SDK_VERSION} ua/2.1 os/${osTag()} lang/js md/nodejs#${NODE_VERSION} api/codewhispererstreaming#${SDK_VERSION} m/E KiroIDE-${KIRO_IDE_VERSION}-${fp}`,
      "x-amz-user-agent": `aws-sdk-js/${SDK_VERSION} KiroIDE-${KIRO_IDE_VERSION}-${fp}`,
      "x-amzn-codewhisperer-optout": "true",
      "x-amzn-kiro-agent-mode": "vibe",
      "amz-sdk-invocation-id": invocationId(),
    };
    if (profileArn) headers["x-amzn-kiro-profile-arn"] = profileArn;
    const built = buildKiroPayload(parsed, profileArn, forcedCompletionMode, wireClient);
    await normalizeKiroImages(built.payload);
    // Apply what earlier turns of THIS conversation measured. An unseen conversation is
    // unchanged, so a first turn behaves exactly as it would without calibration.
    const rawContextInputEstimate = estimateKiroPayloadInputTokens(built.payload, parsed.modelId);
    const contextInputEstimate = calibrateKiroEstimate(built.conversationId, rawContextInputEstimate);
    const body = JSON.stringify(built.payload);
    // Every field below is evaluated before the call, so an unguarded call re-encodes the
    // whole request body on each request even when provider debug is off. Gate the details.
    if (isDebugEnabled()) {
      debugProviderDiagnostic("kiro", "request", {
        region,
        requestedModel: parsed.modelId,
        completionMode: built.completionMode,
        bodyBytes: new TextEncoder().encode(body).length,
        messageCount: kiroPayloadMessages(parsed).length,
        toolCount: parsed.context.tools?.length ?? 0,
        hasProfileArn: Boolean(profileArn),
        wireClient,
        hasPreviousResponseId: Boolean(parsed.previousResponseId),
      });
    }
    return {
      request: {
        url: kiroRuntimeEndpoint(provider, region),
        method: "POST",
        headers,
        body,
        usageLog: { inputTokens: estimateKiroLogInputTokens(parsed), estimated: true },
      },
      nameMap: built.nameMap,
      conversationId: built.conversationId,
      completionMode: built.completionMode,
      inputTokens: estimateKiroInputTokens(parsed),
      contextInputEstimate,
    };
  };

  const fallbackFactory: KiroFallbackFactory = async (
    returnedConversationId,
    assistantText,
    _sawReasoning,
    budget,
  ) => {
    if (!requestSnapshot) throw new Error("Kiro completion retry lost its request state");
    if (requestAbortSignal?.aborted) {
      throw requestAbortSignal.reason instanceof Error
        ? requestAbortSignal.reason
        : new DOMException("Kiro request was cancelled", "AbortError");
    }
    const retryParsed = structuredClone(requestSnapshot);
    retryParsed._providerContinuation = {
      ...(retryParsed._providerContinuation ?? {}),
      ...(returnedConversationId ? { kiro: { conversationId: returnedConversationId } } : {}),
    };
    // Reasoning is not replayable on the Kiro wire. Adding an empty assistant turn merely to mark
    // that reasoning existed creates REQUEST_BODY_INVALID; only visible text earns a replay turn.
    if (assistantText.trim()) {
      retryParsed.context.messages.push({
        role: "assistant",
        content: [{ type: "text" as const, text: assistantText }],
        phase: "commentary",
        model: retryParsed.modelId,
        timestamp: Date.now(),
      });
    }
    // The retry starts from the already measured first wire body, adds one JSON-escaped replay
    // string, and only changes bounded Kiro-owned fields (completion prompt/tool, history wrapper,
    // and <=256-byte conversation id). 64 KiB is a conservative envelope for those fixed fields.
    // Reserve that complete upper bound while the first-attempt collectors are still charged so a
    // near-cap turn fails before build() can materialize the retry payload or serialized body.
    const retryBodyUpperBound = firstRequestBodyBytes
      + jsonStringSerializedUtf8Bytes(assistantText)
      + KIRO_FALLBACK_SERIALIZATION_ENVELOPE_BYTES;
    const retryBodyReservation = budget.reserveTransient(retryBodyUpperBound, { kind: "request_copies" });
    let retryBodyBytes = 0;
    let retryBodyRetained = false;
    let requestBodyReleased = false;
    const releaseRequestBody = () => {
      if (requestBodyReleased) return;
      requestBodyReleased = true;
      if (retryBodyRetained) budget.releaseRetained(retryBodyBytes, { kind: "request_copies" });
      else retryBodyReservation.release();
    };
    try {
      const retry = await build(retryParsed, "text_fallback");
      retryBodyBytes = Buffer.byteLength(retry.request.body);
      if (retryBodyBytes > retryBodyUpperBound) {
        throw new Error("Kiro retry serialization exceeded its pre-admitted upper bound");
      }
      retryBodyReservation.commitRetained();
      retryBodyRetained = true;
      budget.releaseRetained(retryBodyUpperBound - retryBodyBytes, { kind: "request_copies" });
      // Fixed before the rebuild dispatches, so the leg's ordinals continue the first attempt's
      // sequence even though this call's own counter restarts at 1.
      const fallbackOrdinalBase = physicalSendsObserved;
      const response = await fetchKiroWithRetry(retry.request, {
        abortSignal: requestAbortSignal,
        ...(requestExecutor ? { executor: requestExecutor } : {}),
        allowGatewayRotation: !_sawReasoning && !assistantText.trim(),
        returnRawErrors: true,
        stream: true,
        // The text-fallback rebuild used to construct a fresh context and drop the budget,
        // so everything after the first send escaped the per-request cap.
        ...(requestSendBudget ? { sendBudget: requestSendBudget } : {}),
        // And reported nothing, so the sends it paid for were invisible. Its own first send is
        // the completion retry itself: the first attempt produced progress without a final
        // answer, which is the same recovery class the generic empty-completion guard records.
        ...(requestOnPhysicalSend
          ? { onPhysicalSend: (send: KiroPhysicalSend) => forwardPhysicalSend(send, fallbackOrdinalBase, "empty-completion") }
          : {}),
      });
      return {
        response,
        abortSignal: requestAbortSignal,
        inputTokens: retry.inputTokens,
        contextInputEstimate: retry.contextInputEstimate,
        nameMap: retry.nameMap,
        conversationId: retry.conversationId,
        releaseRequestBody,
      };
    } catch (error) {
      releaseRequestBody();
      throw error;
    }
  };

  return {
    name: "kiro",
    // A replayed history that already ENDS with a delivered final answer has nothing to ask Kiro.
    // Before this hook the adapter still appended a trailing user turn — a neutral acknowledgement,
    // but structurally still a prompt — and performed a real inference, so the model answered the
    // closed task again and the finished turn behaved like a still-open goal.
    //
    // Suppressing the completion contract (above) removed the instruction to complete; it could not
    // remove the inference. This is the boundary: no request is built, nothing is sent, and no token
    // estimate is recorded.
    //
    // The forced-fallback build is deliberately NOT consulted here: this hook runs on the inbound
    // turn only, and the adapter-owned bounded retry passes "text_fallback" through `build`
    // directly, never through this path.
    localTerminal(parsed: OcxParsedRequest) {
      return hasTrailingDeliveredFinalAnswer(kiroPayloadMessages(parsed), parsed)
        ? { reason: "kiro_final_answer_already_delivered" }
        : undefined;
    },

    async buildRequest(parsed: OcxParsedRequest, incoming) {
      const built = await build(parsed);
      modelId = parsed.modelId;
      contextWindow = kiroUpstreamContextWindow(parsed.modelId);
      inputTokens = built.inputTokens;
      contextInputEstimate = built.contextInputEstimate;
      toolNameMap = built.nameMap;
      conversationId = built.conversationId;
      completionMode = built.completionMode;
      requestSnapshot = structuredClone(parsed);
      firstRequestBodyBytes = Buffer.byteLength(built.request.body);
      requestAbortSignal = incoming?.abortSignal;
      return built.request;
    },

    parseStream(response: Response, budget: TranslatorBudget): AsyncGenerator<AdapterEvent> {
      return parseKiroStream(
        response,
        budget,
        modelId,
        inputTokens,
        contextWindow,
        toolNameMap,
        conversationId,
        completionMode,
        completionMode === "required" ? fallbackFactory : undefined,
        contextInputEstimate,
      );
    },

    fetchResponse(request: AdapterRequest, ctx?: AdapterFetchContext): Promise<Response> {
      // The normal Responses path supplies cancellation at fetch time rather than build time.
      // Keep it for the adapter-owned bounded continuation so cancelling the client turn aborts
      // both the first Kiro request and its one allowed completion retry.
      if (ctx?.abortSignal) requestAbortSignal = ctx.abortSignal;
      requestExecutor = ctx?.executor;
      if (ctx?.sendBudget) requestSendBudget = ctx.sendBudget;
      if (ctx?.onPhysicalSend) requestOnPhysicalSend = ctx.onPhysicalSend;
      // Reset per fetch call, because `ordinal` is defined within one call and the caller records
      // ordinal 1 of each new attempt itself. The text fallback that follows this attempt then
      // continues THIS attempt's sequence rather than an earlier one's.
      physicalSendsObserved = 0;
      // Routed through the same forwarder as the fallback so both legs share one ordinal
      // sequence; a context without an observer is passed through untouched.
      return fetchKiroWithRetry(request, requestOnPhysicalSend
        ? { ...ctx, returnRawErrors: true, onPhysicalSend: (send: KiroPhysicalSend) => forwardPhysicalSend(send, 0) }
        : { ...ctx, returnRawErrors: true });
    },

    formatErrorBody(status: number, headers: Headers, payloadText: string): string {
      return safeKiroHttpErrorMessage(status, headers, payloadText);
    },

    // Kiro always returns an event stream, including for non-streaming Responses requests. Drain
    // the decoder into a budget-owned batch so an upstream stream cannot grow this array without
    // bound while the caller waits for the complete JSON response.
    async parseResponse(response: Response, budget: TranslatorBudget): Promise<AdapterEvent[]> {
      const events: AdapterEvent[] = [];
      try {
        for await (const e of parseKiroStream(
          response,
          budget,
          modelId,
          inputTokens,
          contextWindow,
          toolNameMap,
          conversationId,
          completionMode,
          completionMode === "required" ? fallbackFactory : undefined,
          contextInputEstimate,
        )) {
          retainTranslatedEvent(e, budget, events.at(-1));
          events.push(e);
        }
        return events;
      } catch (error) {
        for (const event of events) releaseTranslatedEvent(event, budget);
        throw error;
      }
    },
  };
}
