import type { OcxUsage } from "../../types";
import { isPlainObject } from "./internal";

/** Read the Responses `usage` block, if the gateway sent one. */
export function usageFromResponsesPayload(payload: unknown): OcxUsage | undefined {
  if (!isPlainObject(payload) || !isPlainObject(payload.usage)) return undefined;
  const usage = payload.usage;
  const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  // openai/codex#41980: the raw usage object is wire data a rebuilt response.completed must keep —
  // unknown keys (subscription metadata, future counters) ride along even when the token counts
  // themselves are zero or absent (metadata-only usage).
  const knownKeys = new Set(["input_tokens", "output_tokens", "total_tokens", "input_tokens_details", "output_tokens_details"]);
  const hasExtras = Object.keys(usage).some(key => !knownKeys.has(key))
    || (isPlainObject(usage.input_tokens_details)
      && Object.keys(usage.input_tokens_details).some(key => key !== "cached_tokens" && key !== "cache_write_tokens"
        && key !== "cache_write_1h_tokens"))
    || (isPlainObject(usage.output_tokens_details)
      && Object.keys(usage.output_tokens_details).some(key => key !== "reasoning_tokens"));
  if (inputTokens === 0 && outputTokens === 0 && !hasExtras) return undefined;
  const inputDetails = isPlainObject(usage.input_tokens_details) ? usage.input_tokens_details : undefined;
  const outputDetails = isPlainObject(usage.output_tokens_details) ? usage.output_tokens_details : undefined;
  return {
    inputTokens,
    outputTokens,
    ...(typeof usage.total_tokens === "number" ? { totalTokens: usage.total_tokens } : {}),
    ...(typeof inputDetails?.cached_tokens === "number" ? { cachedInputTokens: inputDetails.cached_tokens } : {}),
    ...(typeof inputDetails?.cache_write_tokens === "number" ? { cacheCreationInputTokens: inputDetails.cache_write_tokens } : {}),
    ...(typeof inputDetails?.cache_write_1h_tokens === "number"
      ? { cacheCreation1hInputTokens: inputDetails.cache_write_1h_tokens } : {}),
    ...(typeof outputDetails?.reasoning_tokens === "number" ? { reasoningOutputTokens: outputDetails.reasoning_tokens } : {}),
    ...(hasExtras ? { rawUsage: { ...usage } } : {}),
  };
}
