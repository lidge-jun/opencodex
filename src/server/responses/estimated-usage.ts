import { estimateTokens } from "../../lib/token-estimate";
import type { SsePayloadRewrite } from "../sse-payload-rewrite";

/**
 * Response header marking estimated usage (#7427). `true`: the JSON body's usage is an estimate.
 * `when-missing`: the stream's usage is estimated wherever the provider omitted it.
 */
export const ESTIMATED_USAGE_HEADER = "x-opencodex-usage-estimated";

/** Terminal events whose `response.usage` a client reads for context accounting. */
const TERMINAL_TYPES = new Set(["response.completed", "response.incomplete"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Text a model produced in a Responses `output` array: messages, refusals, tool input, summaries. */
function outputText(output: unknown): string {
  if (!Array.isArray(output)) return "";
  const parts: string[] = [];
  for (const item of output) {
    if (!isRecord(item)) continue;
    for (const field of ["arguments", "input", "name"] as const) {
      if (typeof item[field] === "string") parts.push(item[field] as string);
    }
    for (const list of [item.content, item.summary]) {
      if (!Array.isArray(list)) continue;
      for (const part of list) {
        if (!isRecord(part)) continue;
        if (typeof part.text === "string") parts.push(part.text);
        if (typeof part.refusal === "string") parts.push(part.refusal);
      }
    }
  }
  return parts.join("\n");
}

/**
 * The response with an estimated `usage` when the provider sent none, or `undefined` when it has
 * usage already or is not a response object. Input comes from the request estimate, output from
 * the response's own output items. A client's context meter reads it; OpenCodex's cost, spend and
 * quota accounting never does, because they read the provider's original body.
 */
export function withEstimatedUsage(
  response: unknown, inputTokens: number, modelId: string,
): Record<string, unknown> | undefined {
  // Only a Responses object with output; error bodies and partial events are left alone.
  if (!isRecord(response) || isRecord(response.usage) || !Array.isArray(response.output)) return undefined;
  const input = Math.max(0, Math.round(inputTokens));
  const output = estimateTokens(outputText(response.output), modelId);
  return { ...response, usage: { input_tokens: input, output_tokens: output, total_tokens: input + output } };
}

/** SSE payload rewrite for opted-in native routes; `onApplied` fires once per estimated terminal. */
export function createEstimatedUsagePayloadRewrite(
  inputTokens: () => number, modelId: string, onApplied?: () => void,
): SsePayloadRewrite {
  return payload => {
    if (!payload.includes("\"response.")) return payload;
    let parsed: unknown;
    try { parsed = JSON.parse(payload); } catch { return payload; }
    if (!isRecord(parsed) || typeof parsed.type !== "string" || !TERMINAL_TYPES.has(parsed.type)) return payload;
    const response = withEstimatedUsage(parsed.response, inputTokens(), modelId);
    if (!response) return payload;
    onApplied?.();
    return JSON.stringify({ ...parsed, response });
  };
}

/** The JSON body with estimated usage, or `undefined` when it already had usage or is not JSON. */
export function estimatedUsageJson(json: string, inputTokens: number, modelId: string): string | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return undefined; }
  const response = withEstimatedUsage(parsed, inputTokens, modelId);
  return response ? JSON.stringify(response) : undefined;
}
