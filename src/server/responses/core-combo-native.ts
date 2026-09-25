/**
 * Native Chat candidates inside the combo loop (PF-07).
 *
 * The Chat ingress hands the combo a `ComboProtocolSource` only for a combo route with
 * `protocols.rollout.nativeChatCombos` on; without one nothing here runs. For the candidate the
 * combo is about to dispatch, the concrete route is settled the way the Chat ingress settles a
 * single route, and the native Chat lane's own eligibility rule decides whether the child goes
 * native. A native child runs `runNativeChatAttempt` (through the source) on the attempt the combo
 * already opened, with the combo's per-target budget, the client's abort signal and the turn
 * lease, built from a fresh copy of the source body; every other candidate keeps the bridge.
 * Under `unrepresentable: "reject"` a candidate whose path would drop a requested feature is never
 * picked, and a combo whose every enabled candidate is skipped answers the ingress refusal.
 *
 * No `./` sibling import on purpose: `core-options.ts` names this module's types, so an edge back
 * into the owner graph would close a cycle.
 */
import type { OcxConfig } from "../../types";
import type { RouteResult } from "../../router";
import type { DataPlaneAdmission } from "../auth-cors";
import type { AdmissionLease } from "../../lib/admission";
import type { RequestExecutionBudget } from "../../lib/request-execution-budget";
import type { TransientSendBudget } from "../../lib/upstream-retry";
import type { ResponsesTerminalStatus } from "../../bridge";
import type { NativeChatFinishLog } from "../chat-native";
import type { InferenceAttempt } from "../inference/attempt";
import type { ProtocolEnvelope } from "../../protocols/envelope";
import type { ProtocolFeature } from "../../protocols/features";
import type { PersistedUsageAttempt } from "../../usage/log";
import {
  finishRequestAttempt,
  sealRequestAttemptIdentity,
  type RequestLogContext,
} from "../request-log";
import { captureRouteStaticPolicy, routeConcreteModel } from "../../router";
import { comboDefaultEffort, concreteComboRequestBody, getCombo } from "../../combos";
import { supportedLadderFor } from "../effort-policy";
import { resolveWireProtocolOverride } from "../adapter-resolve";
import { resolveOpenCodeGoTransport } from "../../providers/opencode-go-transport";
import { getOrAllocateRequestSessionLane } from "../request-log-conversation";
import { assertRouteAllowedByScope, resolveAdmissionModelScope } from "../admission-model-scope";
import { isNativeChatRouteEligible } from "../chat-native-eligibility";
import { chatCompletionsErrorResponse } from "../../chat/outbound";
import { isRequestExecutionBudget } from "../../lib/request-execution-budget";
import { markResponseNonReplayable } from "../../lib/upstream-retry";
import { redactSecretString } from "../../lib/redact";
import { upstreamWireForAdapter } from "../../protocols/contract";
import { checkRepresentable, unrepresentableMessage } from "../../protocols/guard";
import { deliveryModeForLane, requestPathForLane } from "../../protocols/path";
import { resolveProtocolSettings } from "../../protocols/settings";
import { addProtocolEntryReason, markAttemptProtocolPath, markProtocolBlocked } from "../../protocols/trace";
import { markClientWire } from "../inference/client-wire";

type Rec = Record<string, unknown>;
type ComboTarget = { provider: string; model: string };

/** What the source needs to run one native child on the combo's open attempt. */
export interface NativeComboChildRun {
  route: RouteResult;
  /** A fresh copy of the source Chat body, never another candidate's rewritten one. */
  body: Rec;
  childLog: RequestLogContext;
  attemptHandle: InferenceAttempt;
  sendBudget: RequestExecutionBudget;
  turnAdmissionLease?: AdmissionLease;
  onFirstOutput: () => void;
  /** Reports to the combo's child callbacks; it never writes the parent's final row itself. */
  finishLog: NativeChatFinishLog;
}

/** Supplied by the Chat ingress for a combo route when `nativeChatCombos` is on. */
export interface ComboProtocolSource {
  readonly inbound: "chat";
  readonly envelope: ProtocolEnvelope;
  /** Runs `runNativeChatAttempt`; the response it returns is in the Chat wire. */
  dispatchNativeChild(input: NativeComboChildRun): Promise<Response>;
}

/** The native plan for one dispatch: the settled route and its own fresh body. */
export interface NativeComboChildPlan {
  route: RouteResult;
  body: Rec;
  sendBudget: RequestExecutionBudget;
}

export interface ComboProtocolLanes {
  /** Pick predicate. False only for a candidate the `reject` policy skips. */
  pickable(target: ComboTarget): boolean;
  /** The ingress refusal when every enabled candidate was skipped; otherwise undefined. */
  refusal(): Response | undefined;
  /** The native plan for the candidate about to dispatch, or undefined to keep the bridge. */
  nativeChild(
    target: ComboTarget,
    targetRoute: RouteResult,
    targetSendBudget: TransientSendBudget | undefined,
  ): NativeComboChildPlan | undefined;
}

interface CandidateVerdict {
  skip?: ProtocolFeature[];
}

export function createComboProtocolLanes(input: {
  source: ComboProtocolSource | undefined;
  req: Request;
  config: OcxConfig;
  logCtx: RequestLogContext;
  admission: DataPlaneAdmission | undefined;
  comboId: string;
  targets: readonly ComboTarget[];
}): ComboProtocolLanes | undefined {
  const { source, req, config, logCtx, admission, comboId, targets } = input;
  if (!source) return undefined;
  const envelope = source.envelope;
  const reject = resolveProtocolSettings(config).unrepresentable === "reject";
  const selector = (target: ComboTarget): string => `${target.provider}/${target.model}`;

  // The Chat ingress's own settlement of a single route, applied to the concrete target: the
  // key's model scope, the static policy captured for a Chat inbound, the wire override and the
  // OpenCode Go transport. A refusal here keeps the bridge, which reports it in its own shape.
  const settle = (target: ComboTarget, targetRoute: RouteResult): RouteResult | undefined => {
    try {
      const route: RouteResult = { ...targetRoute };
      assertRouteAllowedByScope(resolveAdmissionModelScope(config, admission), selector(target), route);
      const routedProvider = route.provider;
      route.staticPolicy = captureRouteStaticPolicy(
        route.providerName, route.modelId, routedProvider, route.staticPolicy.effectiveAlias, "chat",
      );
      const wireProvider = resolveWireProtocolOverride(route.providerName, route.modelId, routedProvider, "chat", route.staticPolicy);
      route.provider = resolveOpenCodeGoTransport(wireProvider, getOrAllocateRequestSessionLane(req), routedProvider);
      return route;
    } catch {
      return undefined;
    }
  };

  // Eligibility reads a body, and a body is a charged copy, so the adapter is checked first:
  // a candidate that can never go native costs no copy at all.
  const nativeBody = (target: ComboTarget, route: RouteResult | undefined): Rec | undefined => {
    if (!route || route.provider.adapter !== "openai-chat") return undefined;
    const body = envelope.freshBody();
    // The concrete selector, as the bridge child's body carries it; the wire model comes from
    // the route either way, and the pinned-effort lookup reads this.
    body.model = selector(target);
    return isNativeChatRouteEligible(route, body, config) ? body : undefined;
  };

  const verdicts = new Map<string, CandidateVerdict>();
  let skipRecorded = false;
  const judge = (target: ComboTarget): CandidateVerdict => {
    const key = selector(target);
    const cached = verdicts.get(key);
    if (cached) return cached;
    let verdict: CandidateVerdict = {};
    let targetRoute: RouteResult | undefined;
    try {
      targetRoute = routeConcreteModel(config, key);
    } catch {
      // Not evidence about the path; dispatch keeps the existing routing failure surface.
      targetRoute = undefined;
    }
    if (targetRoute) {
      const settled = settle(target, targetRoute);
      const native = nativeBody(target, settled) !== undefined;
      const upstream = native ? "chat" : upstreamWireForAdapter((settled ?? targetRoute).provider.adapter);
      const checked = checkRepresentable({
        inbound: "chat",
        requestPath: requestPathForLane("chat", native ? "native" : "bridge", upstream),
        features: envelope.features(),
        policy: "reject",
      });
      if (!checked.ok) {
        verdict = { skip: checked.features };
        if (!skipRecorded) {
          skipRecorded = true;
          addProtocolEntryReason(logCtx, "feature-unrepresentable");
        }
      }
    }
    verdicts.set(key, verdict);
    return verdict;
  };

  return {
    pickable: target => !reject || judge(target).skip === undefined,
    refusal: () => {
      if (!reject) return undefined;
      const enabled = targets.filter(target => {
        const provider = config.providers[target.provider];
        return provider !== undefined && provider.disabled !== true;
      });
      if (enabled.length === 0) return undefined;
      const skipped = enabled.map(judge);
      if (skipped.some(verdict => verdict.skip === undefined)) return undefined;
      const features = [...new Set(skipped.flatMap(verdict => verdict.skip ?? []))];
      // The same refusal the ingress gives a single route: 400 in the Chat shape, feature keys
      // only, a blocked trace, and no upstream send.
      markProtocolBlocked(logCtx, { inbound: "chat", reasonCodes: ["feature-unrepresentable"], features });
      logCtx.errorCode = "unsupported_feature";
      return markClientWire(chatCompletionsErrorResponse(
        400, unrepresentableMessage(features), "invalid_request_error", "unsupported_feature",
      ), "chat");
    },
    nativeChild: (target, targetRoute, targetSendBudget) => {
      // Without the request's execution budget a native child could not share its sends, so it
      // keeps the bridge rather than opening a tracker of its own.
      if (!isRequestExecutionBudget(targetSendBudget)) return undefined;
      const route = settle(target, targetRoute);
      const body = nativeBody(target, route);
      if (!route || !body) return undefined;
      applyComboEffort(body, config, comboId, target, targetRoute);
      return { route, body, sendBudget: targetSendBudget };
    },
  };
}

/**
 * The combo's reasoning-effort policy, applied to the Chat spelling of the same field.
 *
 * The bridge child gets it from `concreteComboRequestBody` on the Responses body; a native child
 * must not lose a forced or default effort just because it skipped that body. The same function
 * decides, through a one-field Responses view, so the two lanes cannot disagree.
 */
function applyComboEffort(
  body: Rec,
  config: OcxConfig,
  comboId: string,
  target: ComboTarget,
  targetRoute: RouteResult,
): void {
  const combo = getCombo(config, comboId);
  if (!combo) return;
  const hadEffort = Object.hasOwn(body, "reasoning_effort");
  const shaped = concreteComboRequestBody(
    hadEffort ? { reasoning: { effort: body.reasoning_effort } } : {},
    target,
    comboDefaultEffort(config, comboId),
    supportedLadderFor({ provider: targetRoute.provider, modelId: targetRoute.modelId }),
    combo.reasoningEffortMode,
    combo.defaultEffortMode,
  );
  const reasoning = shaped.reasoning;
  if (reasoning === undefined) {
    if (hadEffort) delete body.reasoning_effort;
    return;
  }
  const effort = (reasoning as { effort?: unknown }).effort;
  if (typeof effort === "string") body.reasoning_effort = effort;
}

/** The combo's child callbacks, gated so a discarded attempt never reaches the parent. */
export interface ComboChildCallbacks {
  onTerminal(status: ResponsesTerminalStatus): void;
  onCancel(): void;
  onResponseComplete(model: string): void;
}

/**
 * Run one native child on the attempt the combo opened, and mark its answer as Chat wire.
 *
 * The child's outcomes map onto the combo's existing child callbacks: a terminal or cancellation
 * after the response was handed over publishes through the gate (and so reaches the parent's
 * final-row owner only once the combo commits), while a failure answered before that is left to
 * the combo's ordinary failure path. A non-OK answer produced after output was observed is marked
 * non-replayable, so the combo stops instead of re-running a turn that already ran upstream.
 */
export async function dispatchNativeComboChild(input: {
  source: ComboProtocolSource;
  plan: NativeComboChildPlan;
  logCtx: RequestLogContext;
  childLog: RequestLogContext;
  attempt: PersistedUsageAttempt;
  startedAt: number;
  turnAdmissionLease?: AdmissionLease;
  onFirstOutput: () => void;
  callbacks: ComboChildCallbacks;
}): Promise<Response> {
  const { plan, logCtx, childLog, attempt, startedAt, callbacks } = input;
  childLog.providerAdapter = plan.route.provider.adapter;
  markAttemptProtocolPath(attempt, {
    mode: deliveryModeForLane("chat", "native", "chat"),
    requestPath: requestPathForLane("chat", "native", "chat"),
  });
  let outputSeen = false;
  const finishLog: NativeChatFinishLog = (status, message, closeReason = "non_stream") => {
    if (message) childLog.upstreamError = redactSecretString(message).slice(0, 500);
    if (closeReason !== "non_stream") {
      // A streamed body ends after the combo merged this child into the parent row, so what the
      // stream learned last is carried across here before the parent's row is written.
      if (childLog.usage !== undefined) logCtx.usage = childLog.usage;
      if (closeReason === "client_cancel") return callbacks.onCancel();
    }
    if (status < 400) {
      callbacks.onTerminal("completed");
      callbacks.onResponseComplete(plan.route.modelId);
      return;
    }
    if (closeReason === "terminal") {
      childLog.terminalHttpStatus = status;
      callbacks.onTerminal("failed");
    }
  };
  const attemptHandle: InferenceAttempt = {
    attempt,
    startedAt,
    seal: label => sealRequestAttemptIdentity(attempt, childLog.provider, childLog.providerAdapter ?? attempt.adapter, label),
    finish: (status, usage) => finishRequestAttempt(attempt, status, Date.now() - startedAt, usage),
  };
  const response = await input.source.dispatchNativeChild({
    route: plan.route,
    body: plan.body,
    childLog,
    attemptHandle,
    sendBudget: plan.sendBudget,
    ...(input.turnAdmissionLease ? { turnAdmissionLease: input.turnAdmissionLease } : {}),
    onFirstOutput: () => {
      outputSeen = true;
      input.onFirstOutput();
    },
    finishLog,
  });
  if (!response.ok && outputSeen) markResponseNonReplayable(response);
  return markClientWire(response, "chat");
}
