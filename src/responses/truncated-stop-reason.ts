/**
 * Whether a `done` event's `stopReason` means the turn was cut short rather than finishing, and
 * which Responses `incomplete_details.reason` it maps to.
 *
 * `stopReason` is an open-ended string and adapters do not agree on a vocabulary: openai-chat and
 * google normalize to `max_tokens`/`content_filter`, Command Code forwards the raw provider or AI
 * SDK value (`length`, `content-filter`, `error`), and Anthropic forwards `stop_reason` verbatim
 * (`refusal`, `model_context_window_exceeded`, ...). A guard that matched only the two canonical
 * strings let those turns read as completed — and, on a compaction turn, install a half-written
 * summary as replacement history (#422).
 *
 * Classifying here keeps that decision independent of which adapter produced the event, and keeps
 * suppression and terminal status in agreement: a turn whose compaction item is withheld must not
 * also report success, or codex-rs receives a completed response with zero compaction items and
 * fatals.
 *
 * Unknown reasons are deliberately NOT truncated. This must never turn a healthy turn into a
 * failure, and an unrecognized value is far more likely an ordinary stop.
 */
type TruncationKind = "max_output_tokens" | "content_filter";

const TRUNCATED_STOP_REASONS = new Map<string, TruncationKind>([
  // canonical (openai-chat, google)
  ["max_tokens", "max_output_tokens"],
  ["content_filter", "content_filter"],
  // raw OpenAI / Command Code (AI SDK) finish reasons
  ["length", "max_output_tokens"],
  ["content-filter", "content_filter"],
  // raw Anthropic stop reasons
  ["max_output_tokens", "max_output_tokens"],
  ["model_context_window_exceeded", "max_output_tokens"],
  ["refusal", "content_filter"],
  // Anthropic documents `pause_turn` as a long-running turn that the client is expected to
  // CONTINUE. Whatever was produced so far is by definition unfinished, so it must not be
  // installed as replacement history.
  ["pause_turn", "max_output_tokens"],
  // raw Gemini / Vertex finish reasons
  ["malformed_function_call", "content_filter"],
  ["malformed_response", "content_filter"],
  ["unexpected_tool_call", "content_filter"],
  ["safety", "content_filter"],
  ["recitation", "content_filter"],
  ["blocklist", "content_filter"],
  ["prohibited_content", "content_filter"],
  ["spii", "content_filter"],
  ["image_safety", "content_filter"],
  ["language", "content_filter"],
  // Kiro
  ["model_context_window_exceeded_exception", "max_output_tokens"],
]);

/** The `incomplete_details.reason` a truncated stop maps to, or undefined for a normal stop. */
export function truncationReasonFor(stopReason: string | undefined): TruncationKind | undefined {
  if (stopReason === undefined) return undefined;
  return TRUNCATED_STOP_REASONS.get(stopReason.trim().toLowerCase());
}

export function isTruncatedStopReason(stopReason: string | undefined): boolean {
  return truncationReasonFor(stopReason) !== undefined;
}
