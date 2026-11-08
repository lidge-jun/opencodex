import { markProxyError, rememberProxyErrorMessage } from "../../lib/client-error-body";
import { supportsNativeResponsesCompactionTrigger } from "../../providers/openai-tiers";
import type { OcxConfig } from "../../types";
import type { RequestLogContext } from "../request-log";
import type {
  HandleResponsesOptions,
  ResponsesRequestContext,
  ResponsesAdmissionState,
  ResponsesDispatchers,
} from "./core-options";
import type { TranslatorBudget } from "../../lib/translator-budget";
import { prepareResponsesRequest } from "./request-prepare";
import { prepareResponsesTransport } from "./request-transport";
import { prepareResponsesSidecarAuth } from "./request-sidecar-auth";
import { createResponsesEffects } from "./response-effects";
import { createResponsesSendBudget } from "./request-send-budget";
import { executePassthroughResponse } from "./passthrough-execution";
import { executeResponsesSidecars } from "./sidecar-execution";
import { createResponsesCompletionPolicy } from "./completion-policy";
import { executeResponsesRunTurn } from "./run-turn-execution";
import { prepareAdapterExchange } from "./adapter-dispatch";
import { createAdapterContinuations } from "./adapter-continuation";
import { deliverAdapterResponse } from "./adapter-delivery";
import { releaseUpstreamHostAdmission } from "../../codex/upstream-host-health";
import { releaseCodexAuthContextProbeLease } from "../../codex/auth-context";
import { formatErrorResponse } from "../../bridge";
import { InvalidRetainedCompactionSummary, prepareCompactionRetention } from "./compaction-retention";
import { responsesHasInstructionImage } from "../../adapters/claude-cli/instruction-images";
import { markResponseNonReplayable } from "../../lib/upstream-retry";

/** Compose request phases while retaining the original admission-finally ownership. */
export async function handleResponsesInner(
  req: Request,
  config: OcxConfig,
  logCtx: RequestLogContext,
  options: HandleResponsesOptions & { translatorBudget: TranslatorBudget },
  requestDispatchers: ResponsesDispatchers,
): Promise<Response> {
  const requestContext: ResponsesRequestContext = { req, config, logCtx, options };
  const admissionState: ResponsesAdmissionState = {
    pendingHostAdmissionLease: null,
    authCtx: { kind: "main", accountId: null },
  };
  let retention: ReturnType<typeof prepareCompactionRetention>;
  let releasePendingSend = () => {};
  try {
    const requestState = await prepareResponsesRequest(requestContext, admissionState, requestDispatchers);
    if (requestState instanceof Response) return requestState;
    const transportState = await prepareResponsesTransport(requestContext, admissionState, requestState);
    if (transportState instanceof Response) return markProxyError(transportState);
    if (transportState.runTurnAdapter.name === "claude-cli") {
      const instructionImage = options.chatInstructionImage || options.responsesInstructionImage
        || responsesHasInstructionImage(requestState.parsed._rawBody)
        || requestState.parsed.context.messages.some(message => message.role === "developer"
          && Array.isArray(message.content) && message.content.some(part => part.type === "image"));
      if (instructionImage || options.responsesFileImage) {
        const message = instructionImage ? "Claude Code CLI does not support images in developer instructions."
          : "Claude Code CLI does not support file-backed image references.";
        const response = new Response(JSON.stringify({ error: {
          type: "invalid_request_error", code: "unsupported_input_modality", param: null,
          message,
        } }), { status: 400, headers: { "Content-Type": "application/json" } });
        rememberProxyErrorMessage(logCtx, message, { status: 400, type: "invalid_request_error", code: "unsupported_input_modality" });
        markProxyError(response);
        markResponseNonReplayable(response);
        return response;
      }
    }
    options.onCompactionRecoveryRoute?.(requestState.route);
    if (requestState.parsed._compactionRequest && options.compactionRecoveryKind !== "compaction-v1"
      && (requestState.parsed._portableCompaction || !supportsNativeResponsesCompactionTrigger(requestState.route.provider))) {
      retention = prepareCompactionRetention(requestState.parsed, config,
        requestState.route.staticPolicy.model.contextWindow ?? requestState.route.staticPolicy.model.maxInputTokens,
        options.translatorBudget, options.abortSignal ?? req.signal);
    }
    const execute = async (): Promise<Response> => {
      const sidecarState = await prepareResponsesSidecarAuth(requestContext, requestState, transportState);
      if (sidecarState instanceof Response) return markProxyError(sidecarState);
      const responseEffects = createResponsesEffects(
        requestContext,
        admissionState,
        requestState,
        sidecarState,
      );
      const sendBudgetState = createResponsesSendBudget(requestContext);
      if (sendBudgetState instanceof Response) return markProxyError(sendBudgetState);
      if ("passthrough" in transportState.adapter && transportState.adapter.passthrough && !sidecarState.routedCompaction) {
        const passthroughResult = await executePassthroughResponse(
          requestContext,
          admissionState,
          requestState,
          transportState,
          sidecarState,
          responseEffects,
          sendBudgetState,
        );
        if (passthroughResult instanceof Response) return passthroughResult;
        const unclaimedHop = sendBudgetState.pendingHopPermit;
        releasePendingSend = () => { if (sendBudgetState.pendingHopPermit === unclaimedHop) { unclaimedHop?.release(); sendBudgetState.pendingHopPermit = undefined; } };
      }
      const sidecarPlans = await executeResponsesSidecars(
        requestContext,
        requestState,
        transportState,
        sidecarState,
        responseEffects,
        sendBudgetState,
      );
      if (sidecarPlans instanceof Response) return sidecarPlans;
      const completionPolicy = createResponsesCompletionPolicy(requestContext, sidecarState);
      if (transportState.adapter.runTurn) return await executeResponsesRunTurn(
        requestContext,
        admissionState,
        requestState,
        transportState,
        sidecarState,
        responseEffects,
        sendBudgetState,
        completionPolicy,
      );
      const adapterExchange = await prepareAdapterExchange(
        requestContext,
        admissionState,
        requestState,
        transportState,
        responseEffects,
        sendBudgetState,
      );
      if (adapterExchange instanceof Response) return adapterExchange;
      const continuationState = createAdapterContinuations(
        requestContext,
        requestState,
        transportState,
        sidecarState,
        sendBudgetState,
        adapterExchange,
      );
      return await deliverAdapterResponse(
        requestContext,
        requestState,
        transportState,
        sidecarState,
        responseEffects,
        completionPolicy,
        adapterExchange,
        continuationState,
      );
    };
    const response = await execute();
    return retention ? retention.deliver(response) : response;
  } catch (error) {
    retention?.dispose();
    if (error instanceof InvalidRetainedCompactionSummary) return formatErrorResponse(502, "invalid_compaction_summary", error.message);
    throw error;
  } finally {
    releasePendingSend();
    if (admissionState.pendingHostAdmissionLease) {
      releaseUpstreamHostAdmission(admissionState.pendingHostAdmissionLease);
      releaseCodexAuthContextProbeLease(admissionState.authCtx);
    }
  }
}
