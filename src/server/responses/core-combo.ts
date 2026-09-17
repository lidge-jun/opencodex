import { isDeclaredReasoningEffort } from "../../reasoning-effort";
import { recordAttemptRequestedEffort } from "../request-log";
import {
  CODEX_TEXT_GUARDED_BUDGET_POLICY,
  deriveRequestExecutionBudget,
  isRequestExecutionBudget,
} from "../../lib/request-execution-budget";
import type {
  RequestExecutionBudgetPolicy,
  RequestExecutionBudget,
} from "../../lib/request-execution-budget";
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
  targetIncompatibleResponse,
  unreadableEncryptedAgentTaskResponse,
} from "./core-errors";
import {
  buildComboChildHeaders,
  createChildPassthroughCallbackGate,
  consumeComboFailure,
} from "./core-combo-failure";
import {
  linkRequestSessionLane,
  reasoningReplayConversationIdFromResponsesRequest,
  sessionIdHeaderFromRequest,
  sessionLaneIdFromRequest,
} from "../request-log-conversation";
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
import { mandatoryResponsesReasoningReplayUnavailable } from "./core-replay";

/**
 * Sends one combo target may run on its own before the ladder moves on. A target is a whole
 * request as far as its own provider is concerned, so this is the guarded profile's base
 * allowance rather than a separate number to keep in sync.
 */
export const COMBO_TARGET_BASE_SENDS = CODEX_TEXT_GUARDED_BUDGET_POLICY.baseSendAllowance;


/**
 * A combo's execution policy is DECLARED by the combo, not inherited from the single-target
 * profile.
 *
 * `maxTargetTransitions: 1` and `maxAlternateTargetSends: 1` describe an account move, and
 * applying them to a combo would refuse the second hop of a three-target combo -- which is why
 * combo was left off `reserveDispatch` when the per-request split landed. The transitions a
 * combo may make are exactly the targets it declares minus the one it starts on. What stays
 * capped is the TOTAL: the first target's full ladder, one send for every further declared
 * target, and the one shared final-recovery reserve. A one-target combo reduces to the guarded
 * profile exactly, and a three-target combo whose every target fails hard reaches upstream six
 * times instead of the twelve #4546 measured.
 */
export function comboExecutionBudgetPolicy(declaredTargets: number): RequestExecutionBudgetPolicy {
  const targets = Math.max(1, Math.trunc(declaredTargets));
  const hops = targets - 1;
  const reserve = CODEX_TEXT_GUARDED_BUDGET_POLICY.finalRecoveryAllowance;
  const total = COMBO_TARGET_BASE_SENDS + hops + reserve;
  return {
    maxTotalModelSends: total,
    baseSendAllowance: total - reserve,
    finalRecoveryAllowance: reserve,
    maxAlternateTargetSends: Math.max(1, hops),
    maxTargetTransitions: Math.max(1, hops),
  };
}


/**
 * A budget scope that keeps its own recovery ledgers but spends the SAME request-wide counter.
 *
 * The sharing has to happen inside the factory. Redefining `used` as an accessor onto the parent
 * only shared what callers read from the outside: `remainingBaseSends`, the total check and the
 * reserve test all consult the factory's own private counter, which an overridden property
 * cannot reach. Each derived scope therefore admitted dispatches as though the request had spent
 * nothing, and the per-target holdback below -- expressed against `maxTotalModelSends` -- had
 * nothing to hold back from.
 *
 * `deriveRequestExecutionBudget` binds the scope to the parent's real ledger, including pending
 * externally-counted bookings and the durable-spend observer, all of which must travel together.
 * A pending booking is a send already counted in the total and waiting for its reporter, and the
 * observer books by watching that same counter move (#4707) -- so a scope that spent the counter
 * without carrying the observer would move it without booking, and this combo's child sends
 * would go missing from the spend ledger. The reserve, alternate-target and transition ledgers
 * stay per-scope on purpose: a combo target's account failover is its own recovery decision,
 * while the request total still bounds every target together.
 */
export function deriveSendBudgetScope(
  parent: RequestExecutionBudget,
  policy: RequestExecutionBudgetPolicy,
): RequestExecutionBudget {
  return deriveRequestExecutionBudget(parent, policy);
}


/**
 * The ladder one combo target may run, expressed as an allowance on the request-wide counter.
 *
 * `used + COMBO_TARGET_BASE_SENDS` gives this target its own ladder from wherever the request
 * already stands, and the clamp holds back one send for each target still declared after it: a
 * first target that 5xx-streaks must not eat the send the last declared target is entitled to.
 * That guarantee is the difference between a per-target policy and a shared pool the first
 * target drains.
 */
export function comboTargetSendBudget(
  comboScope: RequestExecutionBudget,
  targetsDeclaredAfterThisOne: number,
): RequestExecutionBudget {
  const policy = comboScope.policy;
  const heldForLaterTargets = Math.max(0, targetsDeclaredAfterThisOne);
  const ceiling = Math.max(1, policy.maxTotalModelSends - heldForLaterTargets);
  return deriveSendBudgetScope(comboScope, {
    maxTotalModelSends: policy.maxTotalModelSends,
    baseSendAllowance: Math.min(ceiling, comboScope.used + COMBO_TARGET_BASE_SENDS),
    finalRecoveryAllowance: policy.finalRecoveryAllowance,
    // Within one target the account-move shape is unchanged: three same-account sends plus one
    // alternate is the recovery live traffic depends on, and a combo does not widen it.
    maxAlternateTargetSends: CODEX_TEXT_GUARDED_BUDGET_POLICY.maxAlternateTargetSends,
    maxTargetTransitions: CODEX_TEXT_GUARDED_BUDGET_POLICY.maxTargetTransitions,
  });
}


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
  const reasoningReplayConversationId = reasoningReplayConversationIdFromResponsesRequest({
    clientThreadId: inboundClientThreadId,
    threadIdHeader: req.headers.get("thread-id"),
    sessionIdHeader: sessionIdHeaderFromRequest(req.headers),
  });
  const reasoningReplayEligible = (target: (typeof combo.targets)[number]): boolean => {
    try {
      const route = routeConcreteModel(config, `${target.provider}/${target.model}`);
      const unavailable = mandatoryResponsesReasoningReplayUnavailable({
        body,
        clientThreadId: reasoningReplayConversationId,
        providerName: route.providerName,
        provider: route.provider,
        adapterName: route.provider.adapter,
        modelId: route.modelId,
      });
      return !unavailable;
    } catch {
      // Routing failures are not evidence of replay incompatibility. Keep the target eligible so
      // the existing selection and dispatch path preserves its original routing failure surface.
      return true;
    }
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
  const targetEligible = (target: (typeof combo.targets)[number]): boolean =>
    payloadEligible(target) && reasoningReplayEligible(target);
  const onlyReplayIncompatibleTargetsRemain = (excluded: Iterable<string> = []): boolean => {
    const excludedKeys = new Set(excluded);
    const remaining = combo.targets.filter(target => {
      const provider = config.providers[target.provider];
      return provider?.disabled !== true
        && !excludedKeys.has(targetKey(target))
        && payloadEligible(target);
    });
    return remaining.length > 0 && remaining.every(target => !reasoningReplayEligible(target));
  };
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
    eligible: targetEligible,
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
    if (onlyReplayIncompatibleTargetsRemain()) return targetIncompatibleResponse();
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
    // The first target seeds the ledger's target identity and charges nothing; every later one
    // is a real transition, refused once the declared hops, the alternate-target ledger or the
    // request total are spent. `countedExternally` is required: the child charges its own
    // physical sends, and charging here as well would halve the cap without saying so.
    const hopDecision = comboSendScope?.reserveDispatch({
      sendClass: firstComboTarget ? "initial" : "combo-failover",
      targetKey: `${pick.target.provider}/${pick.target.model}`,
      countedExternally: true,
    });
    if (hopDecision && hopDecision.allowed) hopDecision.permit.use();
    else if (hopDecision && !firstComboTarget) {
      // Out of budget is not this target's failure. The established exhaustion contract is to
      // return the last real upstream answer with its status, headers and any quota body
      // intact rather than to mint a synthetic error, and a later target only exists because
      // an earlier one already recorded one.
      if (lastFailedChildLog) adoptFailedChildLog(lastFailedChildLog);
      break;
    }
    const targetSendBudget = comboSendScope
      ? comboTargetSendBudget(comboSendScope, combo.targets.length - 1 - comboTargetsDispatched)
      : options.sendBudget;
    comboTargetsDispatched += 1;
    const childLog: RequestLogContext = {
      model: pick.target.model,
      provider: pick.target.provider,
      ...(logCtx.conversationId ? { conversationId: logCtx.conversationId } : {}),
      ...(logCtx.surface ? { surface: logCtx.surface } : {}),
    };
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
    childLog.activeAttempt = attempt;
    if (originalRequestedEffort !== undefined) {
      childLog.requestedEffort = originalRequestedEffort;
      recordAttemptRequestedEffort(childLog);
    }
    childLog.activeAttemptStartedAt = started;
    childLog.attempts = logCtx.attempts ??= [];
    childLog.attempts.push(attempt);
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
      const currentTargetProvider = pick.target.provider;
      const deferCodexResetDerivedCooldown = combo.strategy === "failover"
        && combo.targets.slice(pick.targetIndex + 1).some(target =>
          target.provider === currentTargetProvider
          && targetEligible(target)
          && !isComboTargetInCooldown(comboId, target),
        );
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
      restoreOriginalRequestedEffort(childLog);
    } catch (error) {
      callbackGate.discard();
      if (options.abortSignal?.aborted) {
        retainCancelledAttempt();
        return clientCancelledResponse();
      }
      finishRequestAttempt(attempt, 502, Date.now() - started, childLog.usage);
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
        finishRequestAttempt(attempt, 502, Date.now() - started, childLog.usage);
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
      finishRequestAttempt(attempt, 502, Date.now() - started, childLog.usage);
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
      eligible: targetEligible,
      status: failure.response.status,
      code: failure.upstreamCode,
      message: failure.classificationText,
    });
    // Same target selector as the exclusionary pick below, minus `exclude`: the only
    // difference is deliberate and is the whole point of the single-target retry.
    const retryAfterCooldown = () =>
      pickWithWait({
        eligible: targetEligible,
        now: failureNow,
      });
    if (nextPick) {
      pick = nextPick;
    } else {
      pick = await pickWithWait({
        exclude: pick.attempted,
        eligible: targetEligible,
        now: failureNow,
      });
      // A single-target combo with waitForCooldownMs has no alternate target to fail over to,
      // but can recover if it waits for its brief cooldown. The initial attempt accumulated into
      // pick.attempted, so the first pickWithWait above excluded it. retryAfterCooldown below is
      // the same selector with `exclude` deliberately dropped, so the single cooled target
      // becomes eligible again once its cooldown expires.
      // Termination is double-guarded:
      // 1) comboSendScope?.reserveDispatch refuses a second failover hop via comboExecutionBudgetPolicy
      //    (maxAlternateTargetSends: 1 for a single declared target).
      // 2) comboTargetsDispatched <= 1 bounds it locally so the retry never loops or waits unnecessarily
      //    even if sendBudget scope is absent.
      if (
        !pick
        && combo.targets.length === 1
        && combo.waitForCooldownMs > 0
        && comboTargetsDispatched <= 1
        && !options.abortSignal?.aborted
      ) {
        pick = await retryAfterCooldown();
      }
    }
    if (!pick) {
      if (options.abortSignal?.aborted) return clientCancelledResponse();
      if (onlyReplayIncompatibleTargetsRemain(attemptedTargets)) {
        adoptFailedChildLog(childLog);
        return targetIncompatibleResponse();
      }
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
