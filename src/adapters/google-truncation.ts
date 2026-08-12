import { redactSecretString } from "../lib/redact";

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
