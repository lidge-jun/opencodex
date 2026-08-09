/**
 * Shared bounded-JSON → Responses event sequence (#875): the same pure event
 * list used by the WebSocket bridge (sendResponsesJsonAsEvents) and by the
 * HTTP SSE synthesis for models whose reliability policy forces a bounded
 * JSON upstream. One algorithm, two serializations — no duplicated drift.
 */

export type ResponsesJsonEventFrame = Record<string, unknown>;

export type ResponsesJsonValidationResult =
  | { ok: true; response: Record<string, unknown> }
  | { ok: false; message: string };

export const MAX_SYNTHESIZED_OUTPUT_ITEMS = 10_000;

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function usageValidationError(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    return "upstream Responses JSON usage must be an object or null";
  }
  const usage = value as Record<string, unknown>;
  for (const field of ["input_tokens", "output_tokens"] as const) {
    if (!isTokenCount(usage[field])) {
      return "upstream Responses JSON usage token counts must be non-negative integers";
    }
  }
  if (usage.total_tokens !== undefined && !isTokenCount(usage.total_tokens)) {
    return "upstream Responses JSON usage token counts must be non-negative integers";
  }
  for (const field of ["input_tokens_details", "output_tokens_details"] as const) {
    const details = usage[field];
    if (details === undefined || details === null) continue;
    if (typeof details !== "object" || Array.isArray(details)) {
      return "upstream Responses JSON usage details must be objects when present";
    }
  }
  const inputDetails = usage.input_tokens_details;
  if (inputDetails && typeof inputDetails === "object" && !Array.isArray(inputDetails)) {
    for (const field of ["cached_tokens", "cache_write_tokens"] as const) {
      const count = (inputDetails as Record<string, unknown>)[field];
      if (count !== undefined && !isTokenCount(count)) {
        return "upstream Responses JSON usage details must contain non-negative integer token counts";
      }
    }
  }
  const outputDetails = usage.output_tokens_details;
  if (outputDetails && typeof outputDetails === "object" && !Array.isArray(outputDetails)) {
    const reasoningTokens = (outputDetails as Record<string, unknown>).reasoning_tokens;
    if (reasoningTokens !== undefined && !isTokenCount(reasoningTokens)) {
      return "upstream Responses JSON usage details must contain non-negative integer token counts";
    }
  }
  return null;
}

/** Validate the terminal Responses object before turning one snapshot into lifecycle events. */
export function validateResponsesJsonEventResponse(value: unknown): ResponsesJsonValidationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, message: "upstream Responses JSON must be an object" };
  }
  const response = value as Record<string, unknown>;
  if (typeof response.id !== "string" || !response.id.trim()) {
    return { ok: false, message: "upstream Responses JSON must include a non-empty id" };
  }
  if (response.object !== undefined && response.object !== "response") {
    return { ok: false, message: 'upstream Responses JSON object must be "response" when present' };
  }
  if (response.status !== "completed" && response.status !== "failed" && response.status !== "incomplete") {
    return { ok: false, message: "upstream Responses JSON must include a terminal status" };
  }
  if (!Array.isArray(response.output)) {
    return { ok: false, message: "upstream Responses JSON output must be an array" };
  }
  for (const item of response.output) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, message: "upstream Responses JSON output items must be objects" };
    }
    if (typeof (item as { type?: unknown }).type !== "string" || !(item as { type: string }).type.trim()) {
      return { ok: false, message: "upstream Responses JSON output items must include a non-empty type" };
    }
  }
  const usageError = usageValidationError(response.usage);
  if (usageError) return { ok: false, message: usageError };
  return { ok: true, response };
}

/**
 * The canonical minimal sequence Codex commits: response.created (empty
 * output, in_progress) → one response.output_item.done per output item → a
 * status-preserving terminal (completed / failed / incomplete).
 */
export function responsesJsonEventSequence(
  response: Record<string, unknown>,
  rewritePayload?: (payload: Record<string, unknown>) => Record<string, unknown>,
): ResponsesJsonEventFrame[] {
  const validation = validateResponsesJsonEventResponse(response);
  if (!validation.ok) throw new TypeError(validation.message);
  return [...iterateResponsesJsonEvents(validation.response, rewritePayload)];
}

function* iterateResponsesJsonEvents(
  response: Record<string, unknown>,
  rewritePayload?: (payload: Record<string, unknown>) => Record<string, unknown>,
): Generator<ResponsesJsonEventFrame> {
  const rewrite = rewritePayload ?? ((payload: Record<string, unknown>) => payload);
  const output = Array.isArray(response.output) ? response.output : [];
  if (output.length > MAX_SYNTHESIZED_OUTPUT_ITEMS) {
    throw new RangeError(
      `Responses JSON output contains ${output.length} items; maximum is ${MAX_SYNTHESIZED_OUTPUT_ITEMS}`,
    );
  }
  const finalStatus = response.status as "completed" | "failed" | "incomplete";
  yield rewrite({
    type: "response.created",
    response: { ...response, status: "in_progress", output: [] },
  });
  for (const [outputIndex, item] of output.entries()) {
    yield rewrite({
      type: "response.output_item.done",
      output_index: outputIndex,
      item,
    });
  }
  yield rewrite({
    type: `response.${finalStatus}`,
    response: { ...response, status: finalStatus },
  });
}

/**
 * Serialize the event sequence as one SSE body with exactly one
 * `data: [DONE]\n\n` trailer.
 */
export function responsesJsonToSseBody(
  response: Record<string, unknown>,
  rewritePayload?: (payload: Record<string, unknown>) => Record<string, unknown>,
): string {
  const frames = responsesJsonEventSequence(response, rewritePayload)
    .map(frame => `data: ${JSON.stringify(frame)}\n\n`);
  return `${frames.join("")}data: [DONE]\n\n`;
}

/** Stream synthesized SSE frames without retaining the expanded body in memory. */
export function responsesJsonToSseStream(
  response: Record<string, unknown>,
  rewritePayload?: (payload: Record<string, unknown>) => Record<string, unknown>,
): ReadableStream<Uint8Array> {
  const validation = validateResponsesJsonEventResponse(response);
  if (!validation.ok) throw new TypeError(validation.message);
  response = validation.response;
  const output = response.output as unknown[];
  if (output.length > MAX_SYNTHESIZED_OUTPUT_ITEMS) {
    throw new RangeError(
      `Responses JSON output contains ${output.length} items; maximum is ${MAX_SYNTHESIZED_OUTPUT_ITEMS}`,
    );
  }
  const frames = iterateResponsesJsonEvents(response, rewritePayload);
  const encoder = new TextEncoder();
  return new ReadableStream({
    pull(controller) {
      const next = frames.next();
      controller.enqueue(encoder.encode(
        next.done ? "data: [DONE]\n\n" : `data: ${JSON.stringify(next.value)}\n\n`,
      ));
      if (next.done) controller.close();
    },
  });
}
