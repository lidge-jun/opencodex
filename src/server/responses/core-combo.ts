import { isRequestExecutionBudget } from "../../lib/request-execution-budget";
import { isDeclaredReasoningEffort } from "../../reasoning-effort";
import { recordAttemptRequestedEffort } from "../request-log";
import type { OcxConfig } from "../../types";
import type { RequestLogContext } from "../request-log";
import type { HandleResponsesOptions, ResponsesDispatchers, ConsumedComboFailure } from "./core-options";
import type { TranslatorBudget } from "../../lib/translator-budget";
import {
  getCombo,
  comboRequestHasImageInput,
  pickComboTargetWithWait,
  targetKey,
  concreteComboRequestBody,
  comboDefaultEffort,
  isComboTargetInCooldown,
  noteComboSuccess,
  comboFailureDecision,
  advanceComboAfterFailure,
  comboFailureCooldownScope,
} from "../../combos";
import { formatErrorResponse } from "../../bridge";
import {
  expandPreviousResponseInput,
  previousResponseScopeMismatch,
  previousResponseReplayFailure,
  previousResponseProviderState,
} from "../../responses/state";
import { hasUnreadableEncryptedAgentTask } from "./encrypted-payload";
import { routeConcreteModel, comboRouteDecisionTrace } from "../../router";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import type { AgentTaskRecoveryFailureReason } from "./agent-task-recovery";
import {
  agentTaskRecoveryConfig,
  discardEncryptedAgentTaskRecovery,
  recoverEncryptedAgentTaskWithResult,
} from "./agent-task-recovery";
import { isThreadSpawnRequest, supportedLadderFor } from "../effort-policy";
import {
  clientCancelledResponse,
  comboUnavailable,
  unreadableEncryptedAgentTaskResponse,
} from "./core-errors";
import {
  buildComboChildHeaders,
  createChildPassthroughCallbackGate,
  consumeComboFailure,
} from "./core-combo-failure";
import { linkRequestSessionLane, sessionLaneIdFromRequest } from "../request-log-conversation";
import type { CodexAuthContext } from "../../codex/auth-context";
import type { ResponsesTerminalStatus } from "../../bridge";
import { beginRequestAttempt, sealRequestAttemptIdentity, finishRequestAttempt } from "../request-log";
import { rememberComboForLane } from "./combo-session-recall";
import { runTurnAdapterSseResponses } from "./core-lifetime";
import {
  isNativePassthroughSseResponse,
  isEagerRelaySseResponse,
  markNativePassthroughSseResponse,
  markEagerRelaySseResponse,
} from "../relay";
import { preflightComboStreamResponse } from "./combo-stream-preflight";
import { streamingContextOverflowResponse, jsonContextOverflowResponse } from "./context-overflow";

import { comboExecutionBudgetPolicy, deriveSendBudgetScope, comboTargetSendBudget } from "./combo-send-budget";
export { COMBO_TARGET_BASE_SENDS, comboExecutionBudgetPolicy, deriveSendBudgetScope, comboTargetSendBudget } from "./combo-send-budget";


export async function executeComboResponses(
  req: Request,
  rawBody: unknown,
  comboId: string,
  config: OcxConfig,
  logCtx: RequestLogContext,
  options: HandleResponsesOptions & { translatorBudget: TranslatorBudget },
  requestDispatchers: ResponsesDispatchers,
): Promise<Response> {
  const requestedModel = typeof (rawBody as { model?: unknown } | null)?.model === "string"
    ? (rawBody as { model: string }).model
    : `combo/${comboId}`;
  Object.assign(logCtx, {
    requestedModel,
    model: requestedModel,
    provider: "combo",
    comboId,
  });
  const combo = getCombo(config, comboId);
  if (!combo) {
    return formatErrorResponse(404, "invalid_request_error", `Unknown combo: ${comboId}`);
  }
  // The ladder's own scope, derived from what this combo DECLARES. It shares the request-wide
  // counter with the holder that arrived on options -- a combo child already inherited that
  // counter, but nothing read it as a limit across targets -- while its transition and
  // alternate-target ledgers come from the target list rather than from the single-target
  // account-move profile (#4546).
  const comboSendScope = isRequestExecutionBudget(options.sendBudget)
    ? deriveSendBudgetScope(options.sendBudget, comboExecutionBudgetPolicy(combo.targets.length))
    : undefined;
  // Expand previous_response_id before image policy and child dispatch so a
  // continuation that only references prior images still fails closed when
  // imageInput is disabled (and so targets see the full replayed input).
  const inboundClientThreadId = req.headers.get("x-codex-parent-thread-id")?.trim() || undefined;
  const body = expandPreviousResponseInput(rawBody, inboundClientThreadId);
  const scopeMismatch = previousResponseScopeMismatch(body);
  if (scopeMismatch) {
    console.warn("[opencodex] dropped a previous_response_id with a mismatched client task scope; continuing fresh");
  }
  if (previousResponseReplayFailure(body)) {
    return formatErrorResponse(
      400,
      "previous_response_not_found",
      "Continuation state is unavailable or corrupt; resend the full conversation without previous_response_id.",
    );
  }
  // Missing state returns the original body without a failure marker. Reject
  // that unresolved continuation for image-disabled combos so a target cannot
  // resolve prior images out of band. A successful expansion yields a new
  // object (still carrying previous_response_id) and must not be treated as
  // unresolved — text-only stored continuations remain allowed.
  const requestedPreviousId = typeof (rawBody as { previous_response_id?: unknown } | null)?.previous_response_id === "string"
    ? (rawBody as { previous_response_id: string }).previous_response_id.trim()
    : "";
  const unresolvedPrevious = requestedPreviousId.length > 0 && body === rawBody;
  if (combo.imageInput === "disabled" && unresolvedPrevious) {
    return formatErrorResponse(
      400,
      "previous_response_not_found",
      "Continuation state is unavailable or corrupt; resend the full conversation without previous_response_id.",
    );
  }
  if (combo.imageInput === "disabled" && comboRequestHasImageInput(body)) {
    return formatErrorResponse(400, "invalid_request_error", `Combo "${comboId}" does not accept image input`);
  }
  const comboReplaySnapshot = {
    sourceBody: body,
    previousResponseInputExpanded: body !== rawBody
      && typeof (body as { previous_response_id?: unknown }).previous_response_id === "string",
    providerContinuation: !scopeMismatch && body !== rawBody && requestedPreviousId
      ? previousResponseProviderState(requestedPreviousId)
      : undefined,
    recoveredPlaintext: false,
  };
  const adoptFailedChildLog = (childLog: RequestLogContext): void => {
    // Attempts remain the complete physical history; the logical row mirrors the most recent
    // failed target so an exhausted combo still has useful top-level reasoning diagnostics.
    Object.assign(logCtx, childLog, {
      requestedModel,
      model: requestedModel,
      provider: "combo",
      comboId,
      routeDecision: logCtx.routeDecision,
      attempts: logCtx.attempts,
      activeAttempt: undefined,
      activeAttemptStartedAt: undefined,
    });
  };

  const unreadableEncryptedAgentTask = hasUnreadableEncryptedAgentTask(
    (body as { input?: unknown } | undefined)?.input,
  );
  const canDecryptUnreadableAgentTask = (target: (typeof combo.targets)[number]): boolean => {
    const provider = config.providers[target.provider];
    if (!provider || provider.disabled === true) return false;
    try {
      const route = routeConcreteModel(config, `${target.provider}/${target.model}`);
      return isCanonicalOpenAiForwardProvider(route.provider);
    } catch {
      return false;
    }
  };
  let comboPayloadReadable = false;
  const payloadEligible = (target: (typeof combo.targets)[number]): boolean =>
    comboPayloadReadable || !unreadableEncryptedAgentTask || canDecryptUnreadableAgentTask(target);
  let encryptedTaskRecoveryAttempted = false;
  let recoveryFailureReason: AgentTaskRecoveryFailureReason | undefined;
  let storedPool401ReplayDispatched = false;
  const recoverUnreadableEncryptedTask = async (): Promise<boolean> => {
    if (encryptedTaskRecoveryAttempted) return false;
    encryptedTaskRecoveryAttempted = true;
    const recovery = agentTaskRecoveryConfig(config);
    if (
      (options.inboundWire ?? "responses") !== "responses"
      || !isThreadSpawnRequest(req.headers)
      || !recovery
      || options.comboAttempt
    ) {
      discardEncryptedAgentTaskRecovery(
        req,
        (body as { input?: unknown } | undefined)?.input,
        config,
        { parentThreadId: inboundClientThreadId },
      );
      return false;
    }
    let recovered = false;
    try {
      const result = await recoverEncryptedAgentTaskWithResult(
        req,
        (body as { input?: unknown } | undefined)?.input,
        recovery,
        config,
        { parentThreadId: inboundClientThreadId, abortSignal: options.abortSignal },
      );
      recovered = result.recovered;
      recoveryFailureReason = result.recovered ? undefined : result.reason;
    } catch {
      recovered = false;
      recoveryFailureReason = undefined;
    }
    // Recovery has the same in-place input mutation contract as the direct routed path.
    if (
      !recovered
      || hasUnreadableEncryptedAgentTask((body as { input?: unknown } | undefined)?.input)
    ) {
      discardEncryptedAgentTaskRecovery(
        req,
        (body as { input?: unknown } | undefined)?.input,
        config,
        { parentThreadId: inboundClientThreadId },
      );
      return false;
    }
    comboPayloadReadable = true;
    comboReplaySnapshot.recoveredPlaintext = true;
    return true;
  };
  const initialNow = Date.now();
  const pickWithWait = (pickOptions: {
    exclude?: Iterable<string>;
    eligible?: (target: NonNullable<typeof combo>["targets"][number]) => boolean;
    now?: number;
  }) => pickComboTargetWithWait(config, comboId, {
    ...pickOptions,
    waitForCooldownMs: combo.waitForCooldownMs,
    abortSignal: options.abortSignal,
  });
  let pick = await pickWithWait({
    eligible: payloadEligible,
    now: initialNow,
  });

  if (unreadableEncryptedAgentTask && !pick) {
    pick = await pickWithWait({ now: initialNow });
    if (!pick) {
      discardEncryptedAgentTaskRecovery(
        req,
        (body as { input?: unknown } | undefined)?.input,
        config,
        { parentThreadId: inboundClientThreadId },
      );
      return options.abortSignal?.aborted
        ? clientCancelledResponse()
        : comboUnavailable(comboId);
    }
    if (!(await recoverUnreadableEncryptedTask())) {
      return options.abortSignal?.aborted
        ? clientCancelledResponse()
        : unreadableEncryptedAgentTaskResponse(recoveryFailureReason);
    }
  }

  if (!pick) {
    return options.abortSignal?.aborted
      ? clientCancelledResponse()
      : comboUnavailable(comboId);
  }
  // One immutable combo selection trace, before any child dispatch; child
  // adoption below must never replace it with a concrete child route trace.
  logCtx.routeDecision = comboRouteDecisionTrace(config, comboId, pick, requestedModel);

  const originalReasoning = body && typeof body === "object" && !Array.isArray(body)
    ? (body as { reasoning?: unknown }).reasoning
    : undefined;
  const originalRequestedEffortValue = originalReasoning && typeof originalReasoning === "object" && !Array.isArray(originalReasoning)
    ? (originalReasoning as { effort?: unknown }).effort
    : undefined;
  const originalRequestedEffort = typeof originalRequestedEffortValue === "string"
    && isDeclaredReasoningEffort(originalRequestedEffortValue)
    ? originalRequestedEffortValue
    : undefined;
  const restoreOriginalRequestedEffort = (childLog: RequestLogContext): void => {
    if (originalRequestedEffort === undefined) return;
    const normalizedRequestedEffort = childLog.requestedEffort;
    const transitionIndex = normalizedRequestedEffort?.indexOf("->") ?? -1;
    childLog.requestedEffort = transitionIndex >= 0
      ? `${originalRequestedEffort}${normalizedRequestedEffort!.slice(transitionIndex)}`
      : originalRequestedEffort;
    recordAttemptRequestedEffort(childLog);
  };

  let lastFailure: Response | null = null;
  // Dispatched targets, not attempted picks: it indexes the declared target list so the clamp
  // below can tell how many targets are still entitled to a send.
  let comboTargetsDispatched = 0;
  // The child log behind `lastFailure`. The natural end of the ladder adopts it inside the
  // no-more-targets branch; a budget refusal ends the ladder one iteration later, where that
  // iteration's own `childLog` is already out of scope.
  let lastFailedChildLog: RequestLogContext | undefined;
  // The exhausted-combo mapping below runs outside the loop, where `failure.upstreamCode`
  // is gone, so carry the loop's own classification decision instead of re-deriving a
  // weaker one from the status alone (#4149).
  let lastFailureClassifiesOverflow = false;
  while (pick) {
    if (options.abortSignal?.aborted) return clientCancelledResponse();
    const firstComboTarget = comboTargetsDispatched === 0;
    // Reserve the first send without confirming dispatch. Children normally settle the booking
    // through their physical-send owner; a local refusal must be able to return an unused one.
    const hopDecision = comboSendScope?.reserveDispatch({
      sendClass: firstComboTarget ? "initial" : "combo-failover",
      targetKey: `${pick.target.provider}/${pick.target.model}`,
      countedExternally: true,
    });
    if (hopDecision && !hopDecision.allowed && !firstComboTarget) {
      // Out of budget is not this target's failure. The established exhaustion contract is to
      // return the last real upstream answer with its status, headers and any quota body
      // intact rather than to mint a synthetic error, and a later target only exists because
      // an earlier one already recorded one.
      if (lastFailedChildLog) adoptFailedChildLog(lastFailedChildLog);
      break;
    }
    let observedAttempt: ReturnType<typeof beginRequestAttempt> | undefined;
    let observedChildLog: RequestLogContext | undefined;
    let childEntered = false;
    let returnedStatus: number | undefined;
    try {
      const targetSendBudget = comboSendScope
        ? comboTargetSendBudget(comboSendScope, combo.targets.length - 1 - comboTargetsDispatched, hopDecision?.allowed ? hopDecision.permit : undefined)
        : options.sendBudget;
      comboTargetsDispatched += 1;
      const childLog: RequestLogContext = {
        model: pick.target.model,
        provider: pick.target.provider,
        ...(logCtx.conversationId ? { conversationId: logCtx.conversationId } : {}),
        ...(logCtx.surface ? { surface: logCtx.surface } : {}),
      };
      observedChildLog = childLog;
      const targetRoute = routeConcreteModel(config, `${pick.target.provider}/${pick.target.model}`);
      const childBody = concreteComboRequestBody(
        body,
        pick.target,
        comboDefaultEffort(config, comboId),
        supportedLadderFor({ provider: targetRoute.provider, modelId: targetRoute.modelId }),
        combo.reasoningEffortMode,
        combo.defaultEffortMode,
      );
      const childHeaders = buildComboChildHeaders(req.headers);
      const childRequest = new Request(req.url, {
        method: req.method,
        headers: childHeaders,
        body: JSON.stringify(childBody),
      });
      linkRequestSessionLane(req, childRequest);
      let resolvedAuth: CodexAuthContext | undefined;
      let terminalRecorder: ((status: ResponsesTerminalStatus, httpStatusOverride?: number) => void) | undefined;
      const started = Date.now();
      const attempt = beginRequestAttempt(
        (logCtx.attempts?.length ?? 0) + 1,
        pick.target.provider,
        pick.target.model,
        config.providers[pick.target.provider]!.adapter,
      );
      observedAttempt = attempt;
      childLog.activeAttempt = attempt;
      if (originalRequestedEffort !== undefined) {
        childLog.requestedEffort = originalRequestedEffort;
        recordAttemptRequestedEffort(childLog);
      }
      let attemptRetained = false;
      const retainCancelledAttempt = (): void => {
        if (attemptRetained) return;
        sealRequestAttemptIdentity(
          attempt,
          childLog.provider,
          childLog.providerAdapter ?? attempt.adapter,
          childLog.accountLogLabel,
        );
        finishRequestAttempt(attempt, 499, Date.now() - started, childLog.usage);
        (logCtx.attempts ??= []).push(attempt);
        attemptRetained = true;
      };
      const completedTarget = { provider: pick.target.provider, model: pick.target.model };
      const writerGeneration = pick.writerGeneration;
      let consumedChildFailure: ConsumedComboFailure | undefined;
      const callbackGate = createChildPassthroughCallbackGate({
        ...options,
        onResponseComplete: model => {
          // The live config can change while the child is streaming. Never retain credentials.
          const currentCombo = getCombo(config, comboId);
          const provider = config.providers[completedTarget.provider];
          if (Object.hasOwn(config.providers, completedTarget.provider)
            && provider && provider.disabled !== true
            && currentCombo?.targets.some(target => targetKey(target) === targetKey(completedTarget))) {
            rememberComboForLane(sessionLaneIdFromRequest(req.headers), comboId, completedTarget, model, writerGeneration);
          }
          options.onResponseComplete?.(model);
        },
        onNativePassthroughTerminal: status => {
          // A committed stream can acquire terminal metadata after preflight copied
          // the child log. Publish it before the outer logger finalizes, but only
          // through the gate: discarded attempts must never affect the parent.
          // Undefined child fields must preserve metadata already inspected by WS.
          if (childLog.terminalHttpStatus !== undefined) logCtx.terminalHttpStatus = childLog.terminalHttpStatus;
          if (childLog.terminalIncompleteReason !== undefined) logCtx.terminalIncompleteReason = childLog.terminalIncompleteReason;
          if (childLog.terminalErrorCode !== undefined) logCtx.terminalErrorCode = childLog.terminalErrorCode;
          if (childLog.upstreamError !== undefined) logCtx.upstreamError = childLog.upstreamError;
          options.onNativePassthroughTerminal?.(status);
        },
      });
      let response: Response;
      try {
        if (options.abortSignal?.aborted) {
          callbackGate.discard();
          retainCancelledAttempt();
          return clientCancelledResponse();
        }
        const currentTargetProvider = pick.target.provider;
        const deferCodexResetDerivedCooldown = combo.strategy === "failover"
          && combo.targets.slice(pick.targetIndex + 1).some(target =>
            target.provider === currentTargetProvider
            && payloadEligible(target)
            && !isComboTargetInCooldown(comboId, target),
          );
        childEntered = true;
        response = await requestDispatchers.handleResponses(childRequest, config, childLog, {
          ...options,
          // After the spread: the child must run on THIS target's ladder, not on the holder the
          // parent arrived with.
          sendBudget: targetSendBudget,
          comboAttempt: true,
          comboReplaySnapshot,
          deferCodexResetDerivedCooldown,
          // Attempt-relative TTFT is recorded HERE (not via childLog.firstOutputMs — a later
          // Object.assign(logCtx, childLog) would overwrite the request-relative value).
          onFirstOutput: () => {
            if (attempt.firstOutputMs === undefined) {
              attempt.firstOutputMs = Math.max(0, Date.now() - started);
            }
            options.onFirstOutput?.();
          },
          onCodexAuthContextResolved: value => { resolvedAuth = value; },
          setTerminalOutcomeRecorder: value => { terminalRecorder = value; },
          onConsumedComboFailure: value => { consumedChildFailure = value; },
          onStoredPool401ReplayDispatched: () => { storedPool401ReplayDispatched = true; },
          onNativePassthroughTerminal: callbackGate.onTerminal,
          onNativePassthroughCancel: callbackGate.onCancel,
          onResponseComplete: callbackGate.onResponseComplete,
        });
        returnedStatus = response.status;
        restoreOriginalRequestedEffort(childLog);
      } catch (error) {
        callbackGate.discard();
        if (options.abortSignal?.aborted) {
          retainCancelledAttempt();
          return clientCancelledResponse();
        }
        throw error;
      }

      if (options.abortSignal?.aborted) {
        callbackGate.discard();
        retainCancelledAttempt();
        return clientCancelledResponse();
      }

      if (response.ok && !runTurnAdapterSseResponses.has(response)) {
        const nativePassthrough = isNativePassthroughSseResponse(response);
        const eagerRelay = isEagerRelaySseResponse(response);
        let preflight;
        try {
          preflight = await preflightComboStreamResponse(response, childLog);
        } catch (error) {
          callbackGate.discard();
          if (options.abortSignal?.aborted) {
            retainCancelledAttempt();
            return clientCancelledResponse();
          }
          throw error;
        }
        if (preflight.kind === "failed") {
          callbackGate.discard();
          terminalRecorder?.("failed", preflight.response.status);
          response = preflight.response;
        } else {
          response = preflight.response;
          if (nativePassthrough) markNativePassthroughSseResponse(response);
          if (eagerRelay) markEagerRelaySseResponse(response);
        }
      }

      if (response.ok) {
        sealRequestAttemptIdentity(
          attempt,
          childLog.provider,
          childLog.providerAdapter ?? attempt.adapter,
          childLog.accountLogLabel,
        );
        (logCtx.attempts ??= []).push(attempt);
        attemptRetained = true;
        noteComboSuccess(comboId, combo, pick.target, pick.writerGeneration);
        Object.assign(logCtx, childLog, {
          requestedModel,
          model: requestedModel,
          provider: "combo",
          comboId,
          routeDecision: logCtx.routeDecision,
          attempts: logCtx.attempts,
          activeAttempt: attempt,
          activeAttemptStartedAt: started,
          resolvedModel: childLog.resolvedModel ?? childLog.model,
        });
        options.onCodexAuthContextResolved?.(resolvedAuth);
        options.setTerminalOutcomeRecorder?.(terminalRecorder);
        callbackGate.commit();
        return response;
      }

      callbackGate.discard();
      if (response.status === 499) {
        retainCancelledAttempt();
        return clientCancelledResponse();
      }
      let failure: ConsumedComboFailure;
      try {
        failure = consumedChildFailure
          ?? await consumeComboFailure(response, options.abortSignal);
      } catch (error) {
        if (options.abortSignal?.aborted) {
          retainCancelledAttempt();
          return clientCancelledResponse();
        }
        throw error;
      }
      if (options.abortSignal?.aborted) {
        retainCancelledAttempt();
        return clientCancelledResponse();
      }
      sealRequestAttemptIdentity(
        attempt,
        childLog.provider,
        childLog.providerAdapter ?? attempt.adapter,
        childLog.accountLogLabel,
      );
      finishRequestAttempt(
        attempt,
        failure.response.status,
        Date.now() - started,
        failure.usage,
      );
      (logCtx.attempts ??= []).push(attempt);
      attemptRetained = true;
      lastFailure = failure.response;
      lastFailedChildLog = childLog;
      const failureDecision = comboFailureDecision(failure.response.status, failure.classificationText, {
        code: failure.upstreamCode,
      });
      const wantsStream = (rawBody as { stream?: unknown } | null)?.stream === true;
      // Local byte admission has its own diagnostic; do not relabel it as an upstream refusal.
      const classifyOverflow = failure.response.status === 413
        && (wantsStream || (failure.upstreamCode !== "outbound_body_too_large"
          && failure.upstreamCode !== "translation_buffer_limit"));
      lastFailureClassifiesOverflow = classifyOverflow;
      if (storedPool401ReplayDispatched) {
        if (failureDecision === "hop" && unreadableEncryptedAgentTask && !comboPayloadReadable) {
          const recoveredTarget = await pickWithWait({
            exclude: pick.attempted,
            eligible: target => {
              try {
                const route = routeConcreteModel(config, `${target.provider}/${target.model}`);
                return route.codexAccountMode === undefined
                  && !isCanonicalOpenAiForwardProvider(route.provider);
              } catch {
                return false;
              }
            },
          });
          if (options.abortSignal?.aborted) return clientCancelledResponse();
          if (recoveredTarget && await recoverUnreadableEncryptedTask()) {
            pick = recoveredTarget;
            continue;
          }
          if (options.abortSignal?.aborted) return clientCancelledResponse();
        }
        // Keep the spent Pool budget sticky even after a recovered routed child:
        // no later failure may reopen ordinary combo/native account hopping.
        adoptFailedChildLog(childLog);
        if (classifyOverflow && failureDecision === "stop") {
          return wantsStream
            ? streamingContextOverflowResponse(requestedModel, options.translatorBudget)
            : jsonContextOverflowResponse();
        }
        return lastFailure;
      }
      if (failureDecision === "stop") {
        adoptFailedChildLog(childLog);
        if (classifyOverflow) {
          return wantsStream
            ? streamingContextOverflowResponse(requestedModel, options.translatorBudget)
            : jsonContextOverflowResponse();
        }
        return lastFailure;
      }
      console.warn(
        `[combo] ${comboId}: ${targetKey(pick.target)} failed with ${failure.response.status} after ${Date.now() - started}ms`,
      );
      const failureNow = Date.now();
      const attemptedTargets = pick.attempted;
      const nextPick = advanceComboAfterFailure(config, pick, {
        retryAfter: failure.retryAfter,
        resetAt: failure.resetAt,
        cooldownMs: combo.cooldownMs,
        now: failureNow,
        cooldownScope: comboFailureCooldownScope(failure.response.status, failure.classificationText, {
          code: failure.upstreamCode,
        }),
        eligible: payloadEligible,
        status: failure.response.status,
        code: failure.upstreamCode,
        message: failure.classificationText,
      });
      if (nextPick) {
        pick = nextPick;
      } else {
        pick = await pickWithWait({
          exclude: pick.attempted,
          eligible: payloadEligible,
          now: failureNow,
        });
      }
      if (!pick) {
        if (options.abortSignal?.aborted) return clientCancelledResponse();
        if (unreadableEncryptedAgentTask && !comboPayloadReadable) {
          const recoveredTarget = await pickWithWait({
            exclude: attemptedTargets,
            now: failureNow,
          });
          if (recoveredTarget && await recoverUnreadableEncryptedTask()) {
            pick = recoveredTarget;
            continue;
          }
        }
        // Waiting or recovery may have observed cancellation after the check above.
        if (options.abortSignal?.aborted) return clientCancelledResponse();
        adoptFailedChildLog(childLog);
      }
    } finally {
      if (hopDecision?.allowed) {
        // Some runTurn/sidecar transports only report an attempt or return a live stream.
        // Preserve their existing conservative charge, and an entered child's ambiguous
        // throw/abort. Refund preparation failures and failed children with no observed send.
        if ((observedAttempt?.sendCount ?? 0) > 0
          || (observedChildLog?.activeAttempt?.sendCount ?? 0) > 0
          || observedChildLog?.attempts?.some(childAttempt => childAttempt.sendCount > 0)
          || (returnedStatus !== undefined && returnedStatus >= 200 && returnedStatus < 300)
          || (childEntered && (returnedStatus === undefined || returnedStatus === 499))) {
          hopDecision.permit.use();
        }
        hopDecision.permit.release();
      }
    }
  }
  if (
    lastFailure?.status === 413
    && lastFailureClassifiesOverflow
  ) {
    return (rawBody as { stream?: unknown } | null)?.stream === true
      ? streamingContextOverflowResponse(requestedModel, options.translatorBudget)
      : jsonContextOverflowResponse();
  }
  return lastFailure!;
}
