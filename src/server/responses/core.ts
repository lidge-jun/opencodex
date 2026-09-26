import type { OcxConfig } from "../../types";
import type { RequestLogContext } from "../request-log";
import type {
  HandleResponsesOptions,
  ResponsesRequestContext,
  ResponsesAdmissionState,
  ResponsesDispatchers,
} from "./core-options";
import { createTranslatorBudget } from "../../lib/translator-budget";
import { captureExplicitOpenAiCallerAuth } from "../../providers/openai-sidecar";
import { captureCallerDirectAuth } from "../../providers/caller-authorization";
import { createInferenceSendBudget } from "../inference/context";
import { finalizeOwnedTranslatorBudget, finalizeAccountLease } from "./core-lifetime";
import type { TranslatorBudget } from "../../lib/translator-budget";
import { executeComboResponses } from "./core-combo";
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

/** Public Responses entry and compatibility exports. Implementations live with their owners. */

/**
 * Route one `/v1/responses` request through the adapter pipeline: recovery loop, passthrough
 * wire, image/web-search bridges, and the terminal-guard continuation.
 */
export async function handleResponses(
  req: Request,
  config: OcxConfig,
  logCtx: RequestLogContext,
  options: HandleResponsesOptions = {},
): Promise<Response> {
  const ownsBudget = options.translatorBudget === undefined;
  const translatorBudget = options.translatorBudget ?? createTranslatorBudget();
  const accountLoad = { lease: null as import("../../oauth/kiro-account-load").AccountLease | null };
  const abortSignal = options.abortSignal ?? req.signal;
  const release = () => { accountLoad.lease?.release(); accountLoad.lease = null; abortSignal.removeEventListener("abort", release); };
  abortSignal.addEventListener("abort", release, { once: true });
  try {
    const response = await handleResponsesInner(req, config, logCtx, {
      ...options,
      openAiSidecarAuth: options.openAiSidecarAuth === undefined
        ? captureExplicitOpenAiCallerAuth(req.headers, config) : options.openAiSidecarAuth,
      nativeCallerAuth: options.nativeCallerAuth === undefined
        ? captureExplicitOpenAiCallerAuth(req.headers, config) : options.nativeCallerAuth,
      callerDirectAuth: options.callerDirectAuth === undefined
        ? captureCallerDirectAuth(req.headers, config) : options.callerDirectAuth,
      // Capture before combo replay rebuilds the Request headers; children carry options.
      visionDescribeTerminal: options.visionDescribeTerminal === true
        || req.headers.get("x-opencodex-vision-describe") === "1",
      translatorBudget,
      accountLoad,
      // Once at ingress, spend observer included: a combo child inherits the parent's holder.
      sendBudget: options.sendBudget ?? createInferenceSendBudget(req, logCtx),
    });
    const finalResponse = ownsBudget ? finalizeOwnedTranslatorBudget(response, translatorBudget) : response;
    if (!accountLoad.lease) { release(); return finalResponse; }
    return finalizeAccountLease(finalResponse, release);
  } catch (error) {
    release();
    if (ownsBudget) translatorBudget.dispose();
    throw error;
  }
}

export async function handleComboResponses(
  req: Request,
  rawBody: unknown,
  comboId: string,
  config: OcxConfig,
  logCtx: RequestLogContext,
  options: HandleResponsesOptions & { translatorBudget: TranslatorBudget },
): Promise<Response> {
  return executeComboResponses(
    req,
    rawBody,
    comboId,
    config,
    logCtx,
    options,
    requestDispatchers,
  );
}

/** Compose request phases while retaining the original admission-finally ownership. */
async function handleResponsesInner(
  req: Request,
  config: OcxConfig,
  logCtx: RequestLogContext,
  options: HandleResponsesOptions & { translatorBudget: TranslatorBudget },
): Promise<Response> {
  const requestContext: ResponsesRequestContext = { req, config, logCtx, options };
  const admissionState: ResponsesAdmissionState = {
    pendingHostAdmissionLease: null,
    authCtx: { kind: "main", accountId: null },
  };
  try {
    const requestState = await prepareResponsesRequest(requestContext, admissionState, requestDispatchers);
    if (requestState instanceof Response) return requestState;
    const transportState = await prepareResponsesTransport(requestContext, admissionState, requestState);
    if (transportState instanceof Response) return transportState;
    const sidecarState = await prepareResponsesSidecarAuth(requestContext, requestState, transportState);
    if (sidecarState instanceof Response) return sidecarState;
    const responseEffects = createResponsesEffects(
      requestContext,
      admissionState,
      requestState,
      sidecarState,
    );
    const sendBudgetState = createResponsesSendBudget(requestContext);
    if (sendBudgetState instanceof Response) return sendBudgetState;
    if ("passthrough" in transportState.adapter && transportState.adapter.passthrough && !sidecarState.routedCompaction) {
      return await executePassthroughResponse(
        requestContext,
        admissionState,
        requestState,
        transportState,
        sidecarState,
        responseEffects,
        sendBudgetState,
      );
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
  } finally {
    if (admissionState.pendingHostAdmissionLease) {
      releaseUpstreamHostAdmission(admissionState.pendingHostAdmissionLease);
      releaseCodexAuthContextProbeLease(admissionState.authCtx);
    }
  }
}

const requestDispatchers: ResponsesDispatchers = { handleResponses, handleComboResponses };

export { adapterNeedsForcedContinuation } from "./core-replay";
export {
  sidecarOutcomeRecorder, codexLogAccountId, usesCodexForwardPoolAuth, preAuthUpstreamHostCircuitKey,
  upstreamHostCircuitOpenResponse, shouldRetryCodexPoolAccountQuota, shouldRetryCodexScopedQuotaOnAlternate,
  shouldRetryCodexPoolAccountTransient, codexAccountGatedCanonicalWireModel, codexForwardTerminalOutcomeRecorder,
} from "./core-codex-account";
export { shouldAttemptOpaqueBlobRecovery } from "./core-opaque-recovery";
export { readDisplaySafeErrorText, decodeRequestErrorResponse, comboUnavailableResponse, clientCancelledResponse } from "./core-errors";
export type { ConsumedComboFailure, HandleResponsesOptions } from "./core-options";
export {
  sanitizedRetryAfter, consumeComboFailure, usageFromComboFailureText, createChildPassthroughCallbackGate,
  buildComboChildHeaders,
} from "./core-combo-failure";
export { UPSTREAM_JSON_BODY_READ_OPTIONS, linkAbortSignal } from "./core-lifetime";
export { poolCredentialRefreshIncompleteResponse } from "./core-auth";
export { applyServiceTierGate } from "./core-normalize";
export { DEFAULT_SHADOW_SOURCE_MODELS, isShadowSourceModel, shadowSourceModels } from "../../lib/shadow-call";
