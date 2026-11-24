import { redactSecretString } from "../lib/redact";
import { withProviderFailureFacts } from "../lib/failure-detail";
import type { AdapterEvent, OcxUsage } from "../types";

/** Gemini/Vertex finishReason values that mean the turn was cut off, not cleanly stopped. */
const TRUNCATION_REASONS = new Set(["MAX_TOKENS", "MALFORMED_FUNCTION_CALL"]);

export function isVertexTruncationReason(finishReason: string | undefined): boolean {
  return finishReason !== undefined && TRUNCATION_REASONS.has(finishReason);
}

export function vertexTruncationErrorMessage(reason?: string): string {
  return googleTruncationErrorMessage("Vertex AI", reason);
}

/** The provider-facing label for a Google mode, used in fail-closed messages. */
export function googleModeLabel(mode: string | undefined): string {
  return mode === "vertex" ? "Vertex AI" : mode === "cloud-code-assist" ? "Antigravity" : "Gemini API";
}

export function googleTruncationErrorMessage(label: string, reason?: string): string {
  const suffix = reason ? ` (${redactSecretString(reason).slice(0, 160)})` : "";
  return `${label} response truncated upstream before the turn completed${suffix}`;
}

/** Finishes that mean the model's output was dropped upstream; they fail only when nothing visible arrived. */
const DROPPED_OUTPUT_REASONS = new Set(["UNEXPECTED_TOOL_CALL", "MALFORMED_RESPONSE"]);

/**
 * Whether a finished Google turn must fail closed, on every Google mode. MAX_TOKENS after a started
 * call and MALFORMED_FUNCTION_CALL keep their rule (below). UNEXPECTED_TOOL_CALL and MALFORMED_RESPONSE
 * fail only when no text or call reached the client, as CPA's zero-output guard decides.
 */
export function isGoogleTruncatedTurn(finishReason: string | undefined, toolCallsStarted: number, sawVisibleOutput = false): boolean {
  if (finishReason === undefined) return false;
  if (isVertexTruncationReason(finishReason)) return isVertexTruncatedTurn(finishReason, toolCallsStarted);
  return DROPPED_OUTPUT_REASONS.has(finishReason) && toolCallsStarted === 0 && !sawVisibleOutput;
}

/** Finishes reported to the client as a content filter. */
const GOOGLE_CONTENT_FILTER_FINISHES = new Set([
  "SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "MALFORMED_RESPONSE",
]);

export function googleStopReason(finishReason: string | undefined): "max_tokens" | "content_filter" | undefined {
  if (finishReason === "MAX_TOKENS") return "max_tokens";
  return finishReason !== undefined && GOOGLE_CONTENT_FILTER_FINISHES.has(finishReason) ? "content_filter" : undefined;
}

/** A prompt Google refused before generating: non-retryable, naming only the closed reason enum. */
export function googlePromptBlockedEvent(label: string, blockReason: string, usage?: OcxUsage): Extract<AdapterEvent, { type: "error" }> {
  const reason = /^[A-Z_]{1,40}$/.test(blockReason) ? blockReason : "OTHER";
  // invalid_prompt is a terminal refusal for Codex and a hard stop for combos, as the image route's 400 is.
  return { type: "error", message: `${label} blocked the prompt (${reason})`, status: 400, errorType: "invalid_request_error", code: "invalid_prompt", retryable: false, ...(usage ? { usage } : {}) };
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
  label = "Vertex AI",
): Extract<AdapterEvent, { type: "error" }> {
  // The request log keeps the closed finish reason that ended the turn (#8446); the wire event is unchanged.
  return withProviderFailureFacts({
    type: "error",
    message: googleTruncationErrorMessage(label, finishReason),
    // An explicit status, so the HTTP outcome no longer depends on words in the message.
    status: 502,
    errorType: "upstream_error",
    ...(usage ? { usage } : {}),
    // A zero-call failure emitted nothing actionable, so the opt-in empty-completion guard may replay it.
    ...(toolCallsStarted === 0 && finishReason !== "MAX_TOKENS" ? { replaySafeBeforeOutput: true } : {}),
  } as const, { finishReason });
}
