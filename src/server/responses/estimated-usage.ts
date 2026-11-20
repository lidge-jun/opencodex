import { estimateTokens } from "../../lib/token-estimate";
import { responsesCompletionError } from "../../lib/errors";
import type { SsePayloadRewrite } from "../sse-payload-rewrite";
import type { HandleResponsesOptions } from "./core-options";
import type { OcxProviderConfig } from "../../types";

/**
 * Response header marking estimated usage (#7427). `true`: the JSON body's usage is an estimate.
 * `when-missing`: the stream's usage is estimated wherever the provider omitted it.
 */
export const ESTIMATED_USAGE_HEADER = "x-opencodex-usage-estimated";

/** Terminal events whose `response.usage` a client reads for context accounting. */
const TERMINAL_TYPES = new Set(["response.completed", "response.incomplete"]);
/** Response statuses that end a turn with output a client counts; failed and running ones do not. */
const TERMINAL_STATUSES = new Set(["completed", "incomplete"]);

/**
 * Whether this turn may carry an estimate: the provider opted in, and the client spoke HTTP
 * Responses. The Chat Completions and Claude Messages bridges and the WebSocket ingress rebuild
 * their own usage fields from the response and would pass an estimate on without the marker, so
 * they never get one. An internal decision call (JEV) settles spend from its response body, so it
 * never gets one either.
 */
export function estimatesMissingUsage(
  provider: Pick<OcxProviderConfig, "estimateMissingUsage">,
  options: Pick<HandleResponsesOptions, "inboundWire" | "inboundTransport" | "internalDecisionCall">,
): boolean {
  return provider.estimateMissingUsage === true
    && (options.inboundWire ?? "responses") === "responses"
    && options.inboundTransport !== "websocket"
    && options.internalDecisionCall !== true;
}

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
  response: unknown, inputTokens: number, modelId: string, streamedOutputTokens?: number,
): Record<string, unknown> | undefined {
  // Only a finished Responses object with output; error bodies, failed turns and partial events
  // are left alone even when they arrive with HTTP 200.
  if (!isRecord(response) || isRecord(response.usage) || !Array.isArray(response.output)) return undefined;
  if (typeof response.status !== "string" || !TERMINAL_STATUSES.has(response.status)) return undefined;
  if (response.error !== undefined && response.error !== null) return undefined;
  const input = Math.max(0, Math.round(inputTokens));
  // A terminal that closes with an empty list counts the items streamed before it instead.
  const output = response.output.length === 0 && streamedOutputTokens !== undefined
    ? streamedOutputTokens
    : estimateTokens(outputText(response.output), modelId);
  return { ...response, usage: { input_tokens: input, output_tokens: output, total_tokens: input + output } };
}

/**
 * SSE payload rewrite for opted-in native routes; `onApplied` fires once per estimated terminal.
 * Each `response.output_item.done` adds its estimate to one running count, so a terminal whose
 * `output` is empty is still estimated without the stream retaining any item.
 */
export function createEstimatedUsagePayloadRewrite(
  inputTokens: () => number, modelId: string, onApplied?: () => void,
): SsePayloadRewrite {
  let streamedOutputTokens = 0;
  return payload => {
    // Cheap gate: only finished items and terminal events are parsed, never every delta.
    const itemDone = payload.includes("response.output_item.done");
    if (!itemDone && !payload.includes("response.completed") && !payload.includes("response.incomplete")) return payload;
    let parsed: unknown;
    try { parsed = JSON.parse(payload); } catch { return payload; }
    if (!isRecord(parsed) || typeof parsed.type !== "string") return payload;
    if (parsed.type === "response.output_item.done") {
      streamedOutputTokens += estimateTokens(outputText([parsed.item]), modelId);
      return payload;
    }
    if (!TERMINAL_TYPES.has(parsed.type) || responsesCompletionError(parsed) != null) return payload;
    const response = withEstimatedUsage(parsed.response, inputTokens(), modelId, streamedOutputTokens);
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
