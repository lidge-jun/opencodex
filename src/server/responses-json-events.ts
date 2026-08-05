/**
 * Shared bounded-JSON → Responses event sequence (#875): the same pure event
 * list used by the WebSocket bridge (sendResponsesJsonAsEvents) and by the
 * HTTP SSE synthesis for models whose reliability policy forces a bounded
 * JSON upstream. One algorithm, two serializations — no duplicated drift.
 */

export type ResponsesJsonEventFrame = Record<string, unknown>;

/**
 * The canonical minimal sequence Codex commits: response.created (empty
 * output, in_progress) → one response.output_item.done per output item → a
 * status-preserving terminal (completed / failed / incomplete).
 */
export function responsesJsonEventSequence(
  response: Record<string, unknown>,
  rewritePayload?: (payload: Record<string, unknown>) => Record<string, unknown>,
): ResponsesJsonEventFrame[] {
  const rewrite = rewritePayload ?? ((payload: Record<string, unknown>) => payload);
  const output = Array.isArray(response.output) ? response.output : [];
  const finalStatus = response.status === "failed" || response.status === "incomplete"
    ? response.status
    : "completed";
  return [
    rewrite({
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    }),
    ...output.map((item, outputIndex) => rewrite({
      type: "response.output_item.done",
      output_index: outputIndex,
      item,
    })),
    rewrite({
      type: `response.${finalStatus}`,
      response: { ...response, status: finalStatus },
    }),
  ];
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
