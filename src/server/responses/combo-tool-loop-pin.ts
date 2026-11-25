/**
 * Combo target pinning for an in-flight tool loop (#7298).
 *
 * A combo picks a target per request. A tool loop is several requests that together form one
 * assistant turn: the model emits a call, the client runs it, and the next request carries the
 * result back. Re-picking between those requests hands the second half of a turn to a model that
 * did not produce the first half. That is wasteful at best (a cold prompt cache, a different
 * plan) and a hard failure at worst: DeepSeek's thinking mode refuses a tool continuation whose
 * call carries no reasoning it can read, and a GPT turn never leaves one.
 *
 * So a continuation whose input ends in a tool output keeps the target that completed the lane's
 * previous turn, as long as that target is still selectable right now: enabled, still in the
 * combo, out of cooldown and passing every per-request eligibility filter the caller supplies.
 * When it is not, normal selection (and normal failover) runs, and the strict serializers make
 * the foreign history acceptable instead: see `backfillBareToolCallTurnReasoning` and the Chat
 * adapter's reasoning placeholder.
 *
 * A new user message is never pinned; re-deciding per user turn is what a combo is for.
 */
import { createHash } from "node:crypto";
import { getCombo, pickComboTarget, targetKey, type ComboPick } from "../../combos";
import { comboTargetUnavailableCause } from "../../combos/resolve";
import { routeConcreteModel, type RouteResult } from "../../router";
import type { NormalizedComboTarget } from "../../combos/types";
import type { OcxConfig } from "../../types";
import { recallComboTargetForLane } from "./combo-session-recall";
import { sessionLaneIdFromRequest } from "../request-log-conversation";

export const COMBO_TOOL_LOOP_PIN_REASON = "combo-tool-loop-pin";

/** The lane a tool loop is pinned to. A quota-only Combo serving a Claude bridge pool session keys it by that session. */
export function comboToolLoopLane(headers: Headers, quotaOnly: boolean, claudeBridgePoolSession?: string): string | undefined {
  return quotaOnly && claudeBridgePoolSession ? `claude-bridge:${claudeBridgePoolSession}` : sessionLaneIdFromRequest(headers);
}

/** Match the serving wire, destination, Codex account and account mode across a config reload without retaining its URL. */
export function comboToolLoopRouteIdentity(route: RouteResult): string {
  const { providerName, modelId, provider, codexAccountId, codexAccountMode } = route;
  return createHash("sha256").update(JSON.stringify([
    providerName, modelId, provider.adapter, provider.authMode, provider.baseUrl,
    provider.responsesPath, provider.chatCompletionsPath, provider.modelAdapters?.[modelId],
    provider.googleMode, provider.project, provider.location, codexAccountId, codexAccountMode,
  ])).digest("hex");
}

/** Whether `selector` still resolves to the route a pinned continuation recorded. A selector that no longer resolves does not. */
export function pinnedRouteStillResolves(config: OcxConfig, selector: string, routeIdentity: string | undefined): boolean {
  try {
    return comboToolLoopRouteIdentity(routeConcreteModel(config, selector)) === routeIdentity;
  } catch {
    return false;
  }
}

/** Whether the live config still lists `target` in Combo `comboId`. A pinned continuation needs both to remain. */
export function comboStillHasTarget(config: OcxConfig, comboId: string, target: Pick<NormalizedComboTarget, "provider" | "model">): boolean {
  return getCombo(config, comboId)?.targets.some(candidate => targetKey(candidate) === targetKey(target)) === true;
}

function isToolOutputItem(item: unknown): boolean {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  const type = (item as { type?: unknown }).type;
  return typeof type === "string" && type.endsWith("_output");
}

/**
 * Whether this request resumes an assistant turn by returning tool results: its Responses
 * `input` (or Chat `messages`) ends with a tool output. Developer items a client appends after the
 * results do not start a new turn.
 */
export function isToolLoopContinuation(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const { input, messages } = body as { input?: unknown; messages?: unknown };
  const lastTurnItem = (items: unknown[]): unknown => items.findLast(item =>
    !item || typeof item !== "object" || (item as { role?: unknown }).role !== "developer");
  if (Array.isArray(input)) return isToolOutputItem(lastTurnItem(input));
  if (Array.isArray(messages)) {
    const last = lastTurnItem(messages);
    return !!last && typeof last === "object" && (last as { role?: unknown }).role === "tool";
  }
  return false;
}

/**
 * The previous target, a confirmed quota stop, or undefined to select normally.
 * Uses a non-mutating preview so a pinned request never disturbs round-robin rotation state.
 */
export function toolLoopPinnedPick(args: {
  config: OcxConfig;
  comboId: string;
  lane: string | undefined;
  body: unknown;
  eligible: (target: NormalizedComboTarget) => boolean;
  /** Quota-only verdict on the destination a target resolves to, after redirects. */
  quotaExhausted?: (target: NormalizedComboTarget, now: number) => boolean;
  now?: number;
}): ComboPick | "quota-exhausted" | undefined {
  if (!isToolLoopContinuation(args.body)) return undefined;
  const previous = recallComboTargetForLane(args.config, args.lane, args.comboId);
  if (!previous) return undefined;
  const previousKey = targetKey(previous);
  const combo = getCombo(args.config, args.comboId);
  const pinnedTarget = combo?.targets.find(target => targetKey(target) === previousKey);
  if (combo?.quotaOnlyFallback) {
    if (!previous.routeIdentity
      || !pinnedRouteStillResolves(args.config, `${previous.provider}/${previous.model}`, previous.routeIdentity)) return undefined;
  }
  if (combo?.quotaOnlyFallback && pinnedTarget
    && comboTargetUnavailableCause(args.config, args.comboId, pinnedTarget, undefined, args.now, args.quotaExhausted) === "quota") {
    return "quota-exhausted";
  }
  const pick = pickComboTarget(args.config, args.comboId, {
    // This is a continuation of a previously selected target, outside the new-turn order.
    exclude: combo?.quotaOnlyFallback ? combo.targets.map(targetKey).filter(key => key !== previousKey) : undefined,
    eligible: target => targetKey(target) === previousKey && args.eligible(target),
    quotaExhausted: args.quotaExhausted,
    now: args.now,
    preview: true,
  });
  if (pick) pick.attempted = [previousKey];
  return pick ?? undefined;
}
