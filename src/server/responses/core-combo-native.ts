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
import type { AdmissionModelScope } from "../admission-model-scope";
import type { AdmissionLease } from "../../lib/admission";
import type { RequestExecutionBudget, SingleUseDispatchPermit } from "../../lib/request-execution-budget";
import type { TransientSendBudget } from "../../lib/upstream-retry";
import type { ResponsesTerminalStatus } from "../../bridge";
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
import { comboDefaultEffort, concreteComboRequestBody, getCombo, type JevDecision } from "../../combos";
import { supportedLadderFor } from "../effort-policy";
import { applyDroidReasoningDefault } from "../droid-reasoning-default";
import { resolveWireProtocolOverride } from "../adapter-resolve";
import { resolveOpenCodeGoTransport } from "../../providers/opencode-go-transport";
import { getOrAllocateRequestSessionLane } from "../request-log-conversation";
import { assertRouteAllowedByScope } from "../admission-model-scope";
import { isNativeChatRouteEligible } from "../chat-native-eligibility";
import { isNativeMessagesRouteEligible, type NativeMessagesSelector } from "../messages-native-eligibility";
import { chatCompletionsErrorResponse } from "../../chat/outbound";
import { anthropicErrorResponse } from "../../claude/outbound";
import type { FinalRequestLogMeta } from "../inference/final-log";
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

/** Records the outcome on whichever final row owns this attempt; the first call wins. */
export type NativeComboChildFinishLog = (
  status: number,
  message?: string,
  closeReasonOrMeta?: "non_stream" | "terminal" | "client_cancel" | FinalRequestLogMeta,
) => void;

export type NativeChatFinishLog = NativeComboChildFinishLog;

/** What the source needs to run one native child on the combo's open attempt. */
export interface NativeComboChildRun {
  route: RouteResult;
  /** A fresh copy of the source body, never another candidate's rewritten one. */
  body: Rec;
  childLog: RequestLogContext;
  attemptHandle: InferenceAttempt;
  sendBudget: RequestExecutionBudget;
  comboDispatchPermit?: SingleUseDispatchPermit;
  turnAdmissionLease?: AdmissionLease;
  onFirstOutput: () => void;
  /** Reports to the combo's child callbacks; it never writes the parent's final row itself. */
  finishLog: NativeComboChildFinishLog;
}

/** Supplied by the Chat or Messages ingress for a combo route when native combo candidates are active. */
export interface ComboProtocolSource {
  readonly inbound: "chat" | "messages";
  /** The request facts the standalone Messages path judges eligibility with (selector-keyed effort pins). */
  readonly selector?: NativeMessagesSelector;
  readonly envelope: ProtocolEnvelope;
  /** Runs native child attempt; the response it returns is in the child's wire. */
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
    initialDecision?: Pick<JevDecision, "effort">,
  ): NativeComboChildPlan | undefined;
}

interface CandidateVerdict {
  skip?: ProtocolFeature[];
}

/** Build opt-in native eligibility and child plans; only the initial plan applies a JEV choice. */
export function createComboProtocolLanes(input: {
  source: ComboProtocolSource | undefined;
  req: Request;
  config: OcxConfig;
  logCtx: RequestLogContext;
  /** The request's resolved model-scope snapshot; internal callers carry the caller's scope. */
  admissionScope: AdmissionModelScope | undefined;
  droidDefaultEffort?: string;
  comboId: string;
  targets: readonly ComboTarget[];
}): ComboProtocolLanes | undefined {
  const { source, req, config, logCtx, admissionScope, droidDefaultEffort, comboId, targets } = input;
  if (!source) return undefined;
  const envelope = source.envelope;
  const reject = resolveProtocolSettings(config).unrepresentable === "reject";
  const selector = (target: ComboTarget): string => `${target.provider}/${target.model}`;

  // The ingress's own settlement of a single route, applied to the concrete target: the
  // key's model scope, the static policy captured for an inbound wire, the wire override and the
  // OpenCode Go transport. A refusal here keeps the bridge, which reports it in its own shape.
  const settle = (target: ComboTarget, targetRoute: RouteResult): RouteResult | undefined => {
    try {
      const route: RouteResult = { ...targetRoute };
      assertRouteAllowedByScope(admissionScope, selector(target), route);
      const routedProvider = route.provider;
      const inboundWire = source.inbound === "messages" ? "anthropic" : "chat";
      route.staticPolicy = captureRouteStaticPolicy(
        route.providerName, route.modelId, routedProvider, route.staticPolicy.effectiveAlias, inboundWire,
      );
      const wireProvider = resolveWireProtocolOverride(route.providerName, route.modelId, routedProvider, inboundWire, route.staticPolicy);
      route.provider = resolveOpenCodeGoTransport(wireProvider, getOrAllocateRequestSessionLane(req), routedProvider);
      return route;
    } catch {
      return undefined;
    }
  };

  // Eligibility reads a body, and a body is a charged copy, so the adapter is checked first:
  // a candidate that can never go native costs no copy at all.
  const nativeBody = (target: ComboTarget, route: RouteResult | undefined): Rec | undefined => {
    if (!route) return undefined;
    if (source.inbound === "chat") {
      if (route.provider.adapter !== "openai-chat") return undefined;
      const body = envelope.freshBody();
      body.model = selector(target);
      return isNativeChatRouteEligible(route, body, config) ? body : undefined;
    }
    if (source.inbound === "messages") {
      if (route.provider.adapter !== "anthropic") return undefined;
      const body = envelope.freshBody();
      body.model = selector(target);
      return isNativeMessagesRouteEligible(route, body, config, source.selector) ? body : undefined;
    }
    return undefined;
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
      const upstream = native ? source.inbound : upstreamWireForAdapter((settled ?? targetRoute).provider.adapter);
      const checked = checkRepresentable({
        inbound: source.inbound,
        requestPath: requestPathForLane(source.inbound, native ? "native" : "bridge", upstream),
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
      // The same refusal the ingress gives a single route: 400 in the inbound shape, feature keys
      // only, a blocked trace, and no upstream send.
      markProtocolBlocked(logCtx, { inbound: source.inbound, reasonCodes: ["feature-unrepresentable"], features });
      logCtx.errorCode = "unsupported_feature";
      return markClientWire(
        source.inbound === "messages"
          ? anthropicErrorResponse(400, unrepresentableMessage(features), "invalid_request_error")
          : chatCompletionsErrorResponse(
              400, unrepresentableMessage(features), "invalid_request_error", "unsupported_feature",
            ),
        source.inbound,
      );
    },
    nativeChild: (target, targetRoute, targetSendBudget, initialDecision) => {
      // Without the request's execution budget a native child could not share its sends, so it
      // keeps the bridge rather than opening a tracker of its own.
      if (!isRequestExecutionBudget(targetSendBudget)) return undefined;
      const route = settle(target, targetRoute);
      const body = nativeBody(target, route);
      if (!route || !body) return undefined;
      applyDroidReasoningDefault(body, droidDefaultEffort, {
        provider: targetRoute.provider,
        modelId: targetRoute.modelId,
      });
      // Native Messages has no effort rewrite yet: keep the bridge when combo effort policy applies.
      if (source.inbound === "messages"
        && (initialDecision !== undefined || comboDefaultEffort(config, comboId) != null)) return undefined;
      if (source.inbound === "chat") {
        if (initialDecision) {
          // A validated JEV choice owns only this first dispatch, including explicit no-effort.
          // Do not run ordinary force defaults for null: they require a non-null default.
          delete body.service_tier;
          delete body.thinking_budget;
          delete body.thinking;
          const reasoning = body.reasoning;
          if (reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)) {
            const preserved = { ...reasoning as Rec };
            delete preserved.effort;
            if (Object.keys(preserved).length > 0) body.reasoning = preserved;
            else delete body.reasoning;
          }
          if (initialDecision.effort === null) delete body.reasoning_effort;
          else body.reasoning_effort = initialDecision.effort;
        } else applyComboEffort(body, config, comboId, target, targetRoute);
      }
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
 * Run one native child on the attempt the combo opened, and mark its answer as client wire.
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
  comboDispatchPermit?: SingleUseDispatchPermit;
  logCtx: RequestLogContext;
  childLog: RequestLogContext;
  attempt: PersistedUsageAttempt;
  startedAt: number;
  turnAdmissionLease?: AdmissionLease;
  onFirstOutput: () => void;
  callbacks: ComboChildCallbacks;
}): Promise<Response> {
  const { plan, logCtx, childLog, attempt, startedAt, callbacks, source } = input;
  childLog.providerAdapter = plan.route.provider.adapter;
  const pathHop = source.inbound;
  markAttemptProtocolPath(attempt, {
    mode: deliveryModeForLane(source.inbound, "native", source.inbound),
    requestPath: requestPathForLane(source.inbound, "native", source.inbound),
    responsePath: [pathHop, pathHop],
  });
  let outputSeen = false;
  const finishLog: NativeComboChildFinishLog = (
    status: number,
    message?: string,
    closeReasonOrMeta: "non_stream" | "terminal" | "client_cancel" | FinalRequestLogMeta = "non_stream",
  ) => {
    const meta: FinalRequestLogMeta = typeof closeReasonOrMeta === "string"
      ? { closeReason: closeReasonOrMeta }
      : closeReasonOrMeta;
    const closeReason = meta.closeReason ?? "non_stream";
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
    if (meta.terminalStatus) {
      childLog.terminalHttpStatus = status;
      callbacks.onTerminal(meta.terminalStatus);
    } else if (closeReason === "terminal") {
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
  markAttemptProtocolPath(attemptHandle, {
    mode: deliveryModeForLane(source.inbound, "native", source.inbound),
    requestPath: requestPathForLane(source.inbound, "native", source.inbound),
    responsePath: [pathHop, pathHop],
  });
  const response = await input.source.dispatchNativeChild({
    route: plan.route,
    body: plan.body,
    childLog,
    attemptHandle,
    sendBudget: plan.sendBudget,
    comboDispatchPermit: input.comboDispatchPermit,
    ...(input.turnAdmissionLease ? { turnAdmissionLease: input.turnAdmissionLease } : {}),
    onFirstOutput: () => {
      outputSeen = true;
      input.onFirstOutput();
    },
    finishLog,
  });
  if (!response.ok && outputSeen) markResponseNonReplayable(response);
  return markClientWire(response, source.inbound);
}
