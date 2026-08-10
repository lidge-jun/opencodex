/**
 * Shared bounded-JSON → Responses event sequence (#875): the same pure event
 * list used by the WebSocket bridge (sendResponsesJsonAsEvents) and by the
 * HTTP SSE synthesis for models whose reliability policy forces a bounded
 * JSON upstream. One algorithm, two serializations — no duplicated drift.
 */

export type ResponsesJsonEventFrame = Record<string, unknown>;

export const MAX_SYNTHESIZED_OUTPUT_ITEMS = 10_000;

/**
 * The canonical minimal sequence Codex commits: response.created (empty
 * output, in_progress) → one response.output_item.done per output item → a
 * status-preserving terminal (completed / failed / incomplete).
 */
export function responsesJsonEventSequence(
  response: Record<string, unknown>,
  rewritePayload?: (payload: Record<string, unknown>) => Record<string, unknown>,
): ResponsesJsonEventFrame[] {
  return [...iterateResponsesJsonEvents(response, rewritePayload)];
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
  const finalStatus = response.status === "failed" || response.status === "incomplete"
    ? response.status
    : "completed";
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
  const output = Array.isArray(response.output) ? response.output : [];
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
