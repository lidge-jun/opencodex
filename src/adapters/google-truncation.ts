import { redactSecretString } from "../lib/redact";
import type { AdapterEvent, OcxUsage } from "../types";

/** Gemini/Vertex finishReason values that mean the turn was cut off, not cleanly stopped. */
const TRUNCATION_REASONS = new Set(["MAX_TOKENS", "MALFORMED_FUNCTION_CALL"]);

export function isVertexTruncationReason(finishReason: string | undefined): boolean {
  return finishReason !== undefined && TRUNCATION_REASONS.has(finishReason);
}

export function vertexTruncationErrorMessage(reason?: string): string {
  const suffix = reason ? ` (${redactSecretString(reason).slice(0, 160)})` : "";
  return `Vertex AI response truncated upstream before the turn completed${suffix}`;
}

/**
 * Whether a finished turn must fail closed. A truncation reason arriving mid tool call always
 * does. MALFORMED_FUNCTION_CALL fails closed even with zero started calls: the malformed call
 * is dropped upstream and usually never materializes as a part, so the turn is incomplete
 * despite looking empty. MAX_TOKENS with no started call stays a plain token-limit stop.
 */
export function isVertexTruncatedTurn(finishReason: string | undefined, toolCallsStarted: number): boolean {
  if (!isVertexTruncationReason(finishReason)) return false;
  return toolCallsStarted > 0 || finishReason === "MALFORMED_FUNCTION_CALL";
}

/**
 * The fail-closed terminal for a truncated Vertex turn. MALFORMED_FUNCTION_CALL with zero started
 * calls means the model's only tool call was dropped upstream and nothing actionable was emitted,
 * so the turn is marked replay-safe for the opt-in empty-completion guard (#6876). A truncation
 * after a started call is never replay-safe: the client may already hold part of it.
 *
 * The reported usage rides on the error so a replayed turn meters both billable attempts.
 */
export function vertexTruncationErrorEvent(
  finishReason: string | undefined,
  toolCallsStarted: number,
  usage?: OcxUsage,
): Extract<AdapterEvent, { type: "error" }> {
  return {
    type: "error",
    message: vertexTruncationErrorMessage(finishReason),
    ...(usage ? { usage } : {}),
    ...(finishReason === "MALFORMED_FUNCTION_CALL" && toolCallsStarted === 0 ? { replaySafeBeforeOutput: true } : {}),
  };
}
