/**
 * The Antigravity direct lane for the Messages ingress (`protocols.rollout.antigravityDirect`).
 *
 * The Messages ingress translates before it routes: the route is decided on the translated body's
 * resolved model. So the lane is planned ahead of translation on the settings-only body
 * (`anthropicSettingsTranslation`), whose model is that same resolved model, against a preview of
 * the route; the conversation is decoded straight into the IR only when that preview is an
 * eligible Antigravity route. The ingress then routes the settings-only body as usual and keeps
 * the lane only if the settled route is still the one the plan was made for; otherwise it builds
 * the full bridge translation, as it would have without the switch.
 *
 * Refusals stay the bridge's by construction: a settings error, or an undecodable proxy envelope
 * (which the bridge retries through the native projection), returns no plan and the ingress takes
 * its ordinary translation path, which answers exactly as before. Any other decode error is one
 * the translator's walk raises with the same message at the same point
 * (`tests/responses/protocol-messages-ir-parity.test.ts`).
 */
import { anthropicSettingsTranslation, AnthropicRequestError, type ClaudeCacheKeySource } from "../claude/inbound";
import { messagesToResponsesTranslation } from "../protocols/codecs/messages";
import {
  MALFORMED_REASONING_SIGNATURE,
  messagesConversationToIr,
  messagesRouteEvidence,
  withDirectMessagesConversation,
  type MessagesIrConversation,
} from "../protocols/codecs/messages-ir";
import { resolveProtocolSettings } from "../protocols/settings";
import type { TranslatorBudget } from "../lib/translator-budget";
import type { PolicyRequestEvidence } from "../routing/evaluator";
import { previewRouteModel, type RouteResult } from "../router";
import type { OcxClaudeCodeConfig, OcxConfig } from "../types";
import { antigravityMessagesDeclineReason, type AntigravityDirectDeclineReason } from "./antigravity-direct-eligibility";
import { cacheDiagnosticsObserving } from "./request-log";
import type { DirectRequestOption } from "./responses/core-options";

type Rec = Record<string, unknown>;

export interface MessagesDirectPlan {
  /** The concrete route the plan was made for. */
  providerName: string;
  modelId: string;
  /** The settings-only Responses body the core receives, and its prompt-cache key provenance. */
  settingsBody: Rec;
  cacheKeySource: ClaudeCacheKeySource;
  conversation: MessagesIrConversation;
  /** What the core would have read from the bridge body for policy routing. */
  evidence: PolicyRequestEvidence;
}

/**
 * Plan the direct lane for a Messages body, or return `undefined` to translate as before. Throws
 * only what the translator's conversation walk throws for the same body.
 */
export function planMessagesAntigravityDirect(
  body: unknown,
  cc: OcxClaudeCodeConfig | undefined,
  config: OcxConfig,
  budget: TranslatorBudget,
): MessagesDirectPlan | undefined {
  if (!resolveProtocolSettings(config).rollout.antigravityDirect) return undefined;
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  let settings: ReturnType<typeof anthropicSettingsTranslation>;
  let route: RouteResult;
  try {
    settings = anthropicSettingsTranslation(body, cc);
    route = previewRouteModel(config, settings.body.model as string);
  } catch {
    return undefined;
  }
  const model = settings.body.model as string;
  if (!messagesDirectRouteHolds(route, body as Rec, model, config)) return undefined;
  let conversation: MessagesIrConversation;
  try {
    conversation = messagesConversationToIr(body, cc, budget, model);
  } catch (err) {
    if (err instanceof AnthropicRequestError && err.message === MALFORMED_REASONING_SIGNATURE) return undefined;
    throw err;
  }
  return {
    providerName: route.providerName,
    modelId: route.modelId,
    settingsBody: settings.body,
    cacheKeySource: settings.cacheKeySource,
    conversation,
    evidence: messagesRouteEvidence(body),
  };
}

/** Whether a route may carry this body on the direct lane, judged as the ingress judges it. */
export function messagesDirectRouteHolds(
  route: Pick<RouteResult, "providerName" | "modelId" | "provider" | "combo" | "routeKind">,
  body: Rec,
  model: string,
  config: OcxConfig,
): boolean {
  return antigravityMessagesDeclineReason(route, body, model, config, { cacheDiagnostics: cacheDiagnosticsObserving() }) === undefined;
}

/** Whether the route the ingress settled is still the one `plan` was made for, and still eligible. */
export function messagesDirectPlanHolds(plan: MessagesDirectPlan, route: RouteResult, body: Rec, config: OcxConfig): boolean {
  return route.providerName === plan.providerName && route.modelId === plan.modelId
    && messagesDirectRouteHolds(route, body, plan.settingsBody.model as string, config);
}

/**
 * The lane's decline for a bridged request's trace, when it says something about this route: with
 * the switch off or a non-Antigravity target the path already explains the bridge.
 */
export function messagesDirectTraceDecline(
  route: RouteResult,
  body: unknown,
  model: string,
  config: OcxConfig,
): AntigravityDirectDeclineReason | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const reason = antigravityMessagesDeclineReason(route, body as Rec, model, config, { cacheDiagnostics: cacheDiagnosticsObserving() });
  return reason === "rollout-disabled" || reason === "not-migrated" ? undefined : reason;
}

/**
 * The core option for a planned request. The bridge conversation is translated at most once, and
 * only if the core asks for it (a reroute, or an ambiguous-reset judgment).
 */
export function messagesDirectRequestOption(
  plan: MessagesDirectPlan,
  body: unknown,
  cc: OcxClaudeCodeConfig | undefined,
  budget: TranslatorBudget,
): DirectRequestOption {
  let bridge: Rec | undefined;
  return {
    protocol: "messages",
    providerName: plan.providerName,
    modelId: plan.modelId,
    evidence: plan.evidence,
    decode: base => withDirectMessagesConversation(
      base,
      plan.conversation,
      modelId => messagesConversationToIr(body, cc, budget, modelId),
    ),
    bridgeConversation: () => {
      bridge ??= messagesToResponsesTranslation(body, cc, budget).body;
      return {
        input: bridge.input,
        ...(bridge.instructions !== undefined ? { instructions: bridge.instructions } : {}),
        ...(bridge.tools !== undefined ? { tools: bridge.tools } : {}),
      };
    },
  };
}

