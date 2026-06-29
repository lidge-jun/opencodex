import { redactSecretString } from "../redact";

/** Gemini/Vertex finishReason values that mean the turn was cut off, not cleanly stopped. */
const TRUNCATION_REASONS = new Set(["MAX_TOKENS", "MALFORMED_FUNCTION_CALL"]);

export function isVertexTruncationReason(finishReason: string | undefined): boolean {
  return finishReason !== undefined && TRUNCATION_REASONS.has(finishReason);
}

export function vertexTruncationErrorMessage(reason?: string): string {
  const suffix = reason ? ` (${redactSecretString(reason).slice(0, 160)})` : "";
  return `Vertex AI response truncated upstream before the turn completed${suffix}`;
}
