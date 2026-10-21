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
import { pickComboTarget, targetKey, type ComboPick } from "../../combos";
import type { NormalizedComboTarget } from "../../combos/types";
import type { OcxConfig } from "../../types";
import { recallComboTargetForLane } from "./combo-session-recall";

export const COMBO_TOOL_LOOP_PIN_REASON = "combo-tool-loop-pin";

function isToolOutputItem(item: unknown): boolean {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  const type = (item as { type?: unknown }).type;
  return typeof type === "string" && type.endsWith("_output");
}

/**
 * Whether this request resumes an assistant turn by returning tool results: its Responses
 * `input` (or Chat `messages`) ends with a tool output.
 */
export function isToolLoopContinuation(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const { input, messages } = body as { input?: unknown; messages?: unknown };
  if (Array.isArray(input)) return input.length > 0 && isToolOutputItem(input[input.length - 1]);
  if (Array.isArray(messages) && messages.length > 0) {
    const last = messages[messages.length - 1];
    return !!last && typeof last === "object" && (last as { role?: unknown }).role === "tool";
  }
  return false;
}

/**
 * The pick that keeps a tool loop on its previous target, or undefined to select normally.
 * Uses a non-mutating preview so a pinned request never disturbs round-robin rotation state.
 */
export function toolLoopPinnedPick(args: {
  config: OcxConfig;
  comboId: string;
  lane: string | undefined;
  body: unknown;
  eligible: (target: NormalizedComboTarget) => boolean;
  now?: number;
}): ComboPick | undefined {
  if (!isToolLoopContinuation(args.body)) return undefined;
  const previous = recallComboTargetForLane(args.config, args.lane, args.comboId);
  if (!previous) return undefined;
  const previousKey = targetKey(previous);
  const pick = pickComboTarget(args.config, args.comboId, {
    eligible: target => targetKey(target) === previousKey && args.eligible(target),
    now: args.now,
    preview: true,
  });
  return pick ? { ...pick, attempted: [previousKey] } : undefined;
}
