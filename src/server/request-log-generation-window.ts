import type { RequestLogContext } from "./request-log";

/**
 * Generation window for the decode-rate estimate (#4038, #6309).
 *
 * `firstOutputMs` marks the first VISIBLE output delta. For a reasoning model that is the end of
 * the reasoning phase, yet `outputTokens` includes the reasoning tokens, so
 * `outputTokens / (durationMs - firstOutputMs)` divides the whole output by only part of the time
 * that produced it. The window recorded here starts when the model starts producing ANY output
 * item (reasoning included) and ends at the last output delta, so trailing stream bookkeeping
 * after the final token does not count either.
 *
 * Event vocabulary: Anthropic `content_block_start` / `content_block_delta`, and Responses
 * `response.output_item.added` / `response.*.delta`. Anything else leaves the window untouched.
 */
export function recordGenerationEvent(logCtx: RequestLogContext, type: unknown, now = Date.now()): void {
  if (typeof type !== "string" || !Number.isFinite(now)) return;
  if (type === "content_block_start" || type === "response.output_item.added") {
    logCtx.generationStartedAt ??= now;
  } else if (type === "content_block_delta" || (type.startsWith("response.") && type.endsWith(".delta"))) {
    logCtx.generationStartedAt ??= now;
    logCtx.lastOutputAt = now;
  }
}

/** Request-relative `genStartMs` / `lastOutputMs`, present only when both ends were observed. */
export function generationWindowFields(
  logCtx: Pick<RequestLogContext, "generationStartedAt" | "lastOutputAt">,
  requestStartedAt: number,
): { genStartMs?: number; lastOutputMs?: number } {
  const startedAt = logCtx.generationStartedAt;
  const lastAt = logCtx.lastOutputAt;
  if (startedAt === undefined || lastAt === undefined || !Number.isFinite(requestStartedAt)) return {};
  return {
    genStartMs: Math.max(0, startedAt - requestStartedAt),
    lastOutputMs: Math.max(0, lastAt - requestStartedAt),
  };
}
